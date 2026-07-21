/**
 * lib/waha/ingest.ts — pipeline de ingestão WAHA compartilhado pelos dois route
 * handlers de webhook (`/waha` global e `/waha/[token]` per-tenant).
 *
 * Fonte única da verdade para: parse de identidade WhatsApp, resolução de
 * contato/conversa e persistência de mensagem. Resolução é ATÔMICA via RPC
 * (fn_upsert_wa_contact / fn_upsert_wa_conversation) — o padrão check-then-act
 * antigo criava um contato/conversa novo a cada mensagem porque o WAHA NOWEB
 * emite `message` E `message.any` para a mesma mensagem (corrida). Ver migration
 * 0027 para o modelo de identidade canônica.
 */
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { audit } from "@/lib/audit";
import type { createAdminClient } from "@/lib/supabase/admin";
import { ackToStatus } from "@/lib/types/messaging";
import { type Acquisition, parseMetaAdReferral } from "@/lib/waha/ad-referral";
import { type EntryStageCandidate, pickEntryStage } from "@/lib/waha/entry-stage";
import { verifyHmacSha512 } from "@/lib/waha/hmac";

type Admin = ReturnType<typeof createAdminClient>;

interface Session {
  id: string;
  organization_id: string;
}

export interface WahaPayload {
  id?: string;
  from?: string;
  to?: string;
  fromMe?: boolean;
  body?: string;
  type?: string;
  hasMedia?: boolean;
  ack?: number;
  ackName?: string;
  participant?: string;
  author?: string;
  status?: string;
  timestamp?: number;
  mediaUrl?: string;
  mimetype?: string;
  _data?: {
    notifyName?: string;
    pushName?: string;
  } & Record<string, unknown>;
  /** Objeto de referral de anúncio Click-to-WhatsApp — shape varia por engine WAHA. */
  referral?: unknown;
}

export interface WahaEnvelope {
  event?: string;
  session?: string;
  payload?: WahaPayload;
}

export type ChatIdentity =
  | { kind: "phone"; phone: string; lid: null }
  | { kind: "lid"; phone: null; lid: string } // lid = somente dígitos
  | { kind: "group"; phone: null; lid: null };

/**
 * Resolve um chatId WAHA em identidade canônica:
 *  - `{number}@c.us` | `@s.whatsapp.net` -> phone E.164 ("+55...")
 *  - `{lid}@lid` -> lid (somente dígitos; número protegido pelo WhatsApp)
 *  - `@g.us` | formato desconhecido -> group (skip binding CRM)
 */
export function parseChatId(chatId: string): ChatIdentity {
  if (chatId.endsWith("@g.us")) return { kind: "group", phone: null, lid: null };
  if (chatId.endsWith("@lid")) {
    return { kind: "lid", phone: null, lid: chatId.replace(/@.*$/, "") };
  }
  if (chatId.endsWith("@c.us") || chatId.endsWith("@s.whatsapp.net")) {
    const digits = chatId.replace(/@.*$/, "").replace(/^\+/, "");
    return { kind: "phone", phone: "+" + digits, lid: null };
  }
  return { kind: "group", phone: null, lid: null };
}

const STOP_RX = /\b(STOP|PARAR|SAIR|UNSUBSCRIBE)\b/i;

// Reexportado p/ compatibilidade: a implementação vive em lib/waha/hmac.ts (pura,
// testável sem a cadeia de env). Ver checkWahaSignature logo abaixo.
export { verifyHmacSha512 };

export type HmacMode = "verified" | "skipped_no_secret";
export interface HmacCheck {
  /** false só quando HÁ segredo configurado e a assinatura não bate. */
  ok: boolean;
  mode: HmacMode;
}

/**
 * Resolve o segredo do HMAC e verifica a assinatura do webhook WAHA.
 *
 * Precedência: segredo POR SESSÃO (channel_sessions.webhook_secret_encrypted,
 * usado no modelo per-tenant) > `WAHA_HMAC_SECRET` do ambiente (o mesmo valor
 * de WHATSAPP_HOOK_HMAC no container do WAHA, modelo de instância única).
 *
 * Antes da correção, a linha da sessão nascia com um placeholder de 1 byte
 * (`Buffer.from([0])` no onboarding) e o env NUNCA era lido — então a validação
 * era pulada SEMPRE e o endpoint público aceitava qualquer corpo. Agora só se
 * pula quando não existe segredo em lugar nenhum (dev), e isso vira log de aviso.
 *
 * O segredo em si nunca é logado — só o modo e o tamanho da assinatura recebida.
 */
export async function checkWahaSignature(
  admin: Admin,
  sessionSecretCiphertext: unknown,
  rawBody: string,
  signatureHeader: string | null,
): Promise<HmacCheck> {
  let secret = "";

  try {
    const dec = await admin.rpc("fn_decrypt_oauth" as never, {
      ciphertext: sessionSecretCiphertext,
    } as never);
    if (!dec.error && typeof dec.data === "string" && dec.data.length >= 4) {
      secret = dec.data;
    }
  } catch {
    // Segredo por sessão indisponível (placeholder / cripto ausente) — cai no env.
  }

  if (!secret) {
    const fromEnv = process.env.WAHA_HMAC_SECRET ?? "";
    if (fromEnv.length >= 4) secret = fromEnv;
  }

  if (!secret) {
    console.warn(
      "[waha.webhook] HMAC não verificado: nenhum segredo configurado " +
        "(defina WAHA_HMAC_SECRET no app e WHATSAPP_HOOK_HMAC no WAHA). " +
        "O endpoint está aceitando webhooks sem autenticação.",
    );
    return { ok: true, mode: "skipped_no_secret" };
  }

  return { ok: verifyHmacSha512(rawBody, signatureHeader, secret), mode: "verified" };
}

function previewFromMessage(p: WahaPayload): string {
  if (p.body) return p.body.slice(0, 280);
  if (p.type) return `[${p.type}]`;
  return "";
}

/**
 * Mapeia o `type` cru do WAHA NOWEB para o vocabulário de messages.type do CRM
 * (check constraint messages_type_check). WAHA usa `chat` p/ texto, `ptt` p/
 * áudio de voz, `vcard` p/ contato, etc. Sem esse mapa o INSERT viola a
 * constraint e a mensagem some. O type cru fica em metadata.raw_type.
 */
const WA_TYPE_MAP: Record<string, string> = {
  chat: "text",
  text: "text",
  ptt: "audio",
  audio: "audio",
  image: "image",
  video: "video",
  document: "document",
  sticker: "sticker",
  location: "location",
  vcard: "contact",
  contact: "contact",
  multi_vcard: "contact",
  reaction: "reaction",
};

function mapWahaMessageType(raw: string | undefined): string {
  if (!raw) return "text";
  // Fallback "text": só chegamos ao insert com body/mídia presente (guarda acima),
  // então tratar tipo desconhecido como texto não perde a mensagem.
  return WA_TYPE_MAP[raw.toLowerCase()] ?? "text";
}

function notifyNameOf(p: WahaPayload): string | null {
  return p._data?.notifyName ?? p._data?.pushName ?? null;
}

interface UpsertContactResult {
  contactId: string;
  wasInserted: boolean;
}

/**
 * Upsert atômico de contato pela identidade canônica. Retorna null se a
 * identidade for de grupo ou a RPC falhar. `wasInserted` distingue contato NOVO
 * (first-touch) de reencontro — usado p/ capturar origem e auto-criar lead só
 * na primeira aparição. A RPC agora retorna tabela (contact_id, was_inserted).
 */
async function upsertContact(
  admin: Admin,
  orgId: string,
  parsed: ChatIdentity,
  chatId: string,
  notifyName: string | null,
): Promise<UpsertContactResult | null> {
  if (parsed.kind === "group") return null;
  const { data, error } = await admin.rpc("fn_upsert_wa_contact" as never, {
    p_org: orgId,
    p_kind: parsed.kind,
    p_phone: parsed.kind === "phone" ? parsed.phone : null,
    p_lid: parsed.kind === "lid" ? parsed.lid : null,
    p_chat_id: chatId,
    p_notify: notifyName,
  } as never);
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_contact failed", error.message);
    return null;
  }
  // Função retorna SETOF: supabase-js entrega array de linhas.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { contact_id?: string; was_inserted?: boolean }
    | null
    | undefined;
  if (!row?.contact_id) return null;
  return { contactId: row.contact_id, wasInserted: row.was_inserted === true };
}

/**
 * Grava a origem de aquisição no contato (first-touch, atômico, nunca sobrescreve).
 * Só chamado p/ contato recém-criado com origem de anúncio detectada.
 */
async function captureAcquisition(
  admin: Admin,
  orgId: string,
  contactId: string,
  acq: Acquisition,
): Promise<void> {
  const { error } = await admin.rpc("fn_capture_contact_acquisition" as never, {
    p_contact: contactId,
    p_org: orgId,
    p_channel: acq.channel,
    p_acquisition: acq as unknown as Record<string, unknown>,
  } as never);
  if (error) console.error("[waha.ingest] fn_capture_contact_acquisition failed", error.message);
}

/**
 * Lê a aquisição JÁ persistida no contato. Necessário porque o lead pode nascer
 * numa mensagem posterior à que capturou a origem (ou no evento gêmeo da corrida
 * message/message.any) — sem isso um contato de anúncio cairia na etapa comum.
 */
async function storedAcquisition(
  admin: Admin,
  orgId: string,
  contactId: string,
): Promise<Acquisition | null> {
  const { data } = await admin
    .from("contacts")
    .select("source_metadata")
    .eq("organization_id", orgId)
    .eq("id", contactId)
    .maybeSingle();
  const acq = (data?.source_metadata as { acquisition?: unknown } | null)?.acquisition;
  return acq && typeof acq === "object" ? (acq as Acquisition) : null;
}

/**
 * Resolve a etapa de entrada do pipeline default.
 *  - anúncio  => coluna dedicada 'novo_meta_ads' (0054);
 *  - comum    => etapa ABERTA de menor `position`, excluindo 'novo_meta_ads'
 *                (0055 garante que seja 'Novo contato' no pipeline default).
 * Sem slug hardcoded no caminho comum: pipeline custom cai na sua própria
 * primeira etapa aberta. Anúncio sem a coluna dedicada faz fallback p/ a comum.
 */
async function resolveEntryStage(
  admin: Admin,
  pipelineId: string,
  isAdOrigin: boolean,
): Promise<string | null> {
  const { data } = await admin
    .from("crm_stages")
    .select("id, slug, position, is_archived, is_won, is_lost")
    .eq("pipeline_id", pipelineId)
    .eq("is_archived", false)
    .order("position", { ascending: true });
  return pickEntryStage((data ?? []) as unknown as EntryStageCandidate[], isAdOrigin);
}

/**
 * Garante EXATAMENTE um lead aberto para o contato (Correção 2).
 *
 * Idempotência é por código, não por constraint: `crm_leads` modela Pedido
 * (status open/won/lost) e cliente recorrente tem vários leads legítimos ao
 * longo do tempo — uma unique por contato quebraria recompra. Aqui: se já há
 * lead `status='open'`, não cria outro e NUNCA move o existente.
 *
 * Chamado DEPOIS do insert da mensagem justamente para herdar o portão atômico
 * de `unique (organization_id, external_id)`: o WAHA emite `message` E
 * `message.any` p/ a mesma mensagem, e um check-then-act aqui duplicaria lead.
 *
 * Tolerante: qualquer falha vira log — nunca quebra a ingestão da mensagem.
 */
async function ensureLeadForContact(
  admin: Admin,
  session: Session,
  contactId: string,
  freshAcquisition: Acquisition | null,
  title: string,
  requestId: string,
): Promise<void> {
  try {
    const { data: openLead } = await admin
      .from("crm_leads")
      .select("id")
      .eq("organization_id", session.organization_id)
      .eq("contact_id", contactId)
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (openLead) return; // já tem lead ativo => nada a fazer, e não move

    const { data: pipeline } = await admin
      .from("crm_pipelines")
      .select("id")
      .eq("organization_id", session.organization_id)
      .eq("is_default", true)
      .eq("is_archived", false)
      .maybeSingle();
    if (!pipeline) {
      console.error(
        "[waha.ingest] ensureLeadForContact: org sem pipeline default",
        session.organization_id,
      );
      return;
    }

    // Origem desta mensagem (first-touch recém-capturado) ou a já persistida.
    const acq = freshAcquisition ?? (await storedAcquisition(admin, session.organization_id, contactId));

    const stageId = await resolveEntryStage(admin, pipeline.id as string, !!acq);
    if (!stageId) {
      console.error(
        "[waha.ingest] ensureLeadForContact: pipeline sem etapa aberta",
        pipeline.id,
      );
      return;
    }

    await createLeadHandler(
      admin,
      {
        organization_id: session.organization_id,
        actor: { type: "webhook_source", id: session.id },
        requestId,
      },
      {
        pipeline_id: pipeline.id,
        stage_id: stageId,
        title,
        contact_id: contactId,
        source: acq ? acq.channel : "whatsapp",
        source_metadata: acq
          ? { acquisition: acq as unknown as Record<string, unknown> }
          : {},
        // external_id só p/ anúncio: alimenta uniq_crm_leads_org_source_external.
        // Lead comum fica null de propósito — com contact_id ali, a unique
        // bloquearia a recompra legítima do mesmo cliente.
        external_id: acq ? (acq.click_id ?? contactId) : null,
        tags: [],
        currency: "BRL",
      } as Parameters<typeof createLeadHandler>[2],
    );
  } catch (err) {
    console.error(
      "[waha.ingest] ensureLeadForContact failed",
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function upsertConversation(
  admin: Admin,
  orgId: string,
  contactId: string,
  sessionId: string,
): Promise<string | null> {
  const { data, error } = await admin.rpc("fn_upsert_wa_conversation" as never, {
    p_org: orgId,
    p_contact: contactId,
    p_session: sessionId,
  } as never);
  if (error) {
    console.error("[waha.ingest] fn_upsert_wa_conversation failed", error.message);
    return null;
  }
  return (data as string) ?? null;
}

async function markConversation(
  admin: Admin,
  convId: string,
  direction: "inbound" | "outbound",
  preview: string,
  at: string,
): Promise<void> {
  const { error } = await admin.rpc("fn_mark_conversation_message" as never, {
    p_conv: convId,
    p_direction: direction,
    p_preview: preview,
    p_at: at,
  } as never);
  if (error) console.error("[waha.ingest] fn_mark_conversation_message failed", error.message);
}

/**
 * Mensagem recebida (fromMe=false). Contato = remetente (`from`).
 */
async function handleInbound(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.from ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return; // grupos não fazem binding CRM
  if (!p.id || !chatId) return;
  // WAHA emite eventos vazios p/ status/read-receipt/presence — não viram mensagem.
  if (!p.body && !p.mediaUrl && !p.hasMedia) return;

  const notifyName = notifyNameOf(p);
  const upserted = await upsertContact(admin, session.organization_id, parsed, chatId, notifyName);
  if (!upserted) return;
  const { contactId, wasInserted } = upserted;

  // Origem Click-to-WhatsApp (Meta Ads): captura só p/ contato NOVO (first-touch)
  // e sem quebrar o fluxo se o referral vier ausente/inesperado (parser tolerante).
  // A gravação é atômica no banco (só escreve se ainda não há 'acquisition'), então
  // o evento gêmeo message/message.any não sobrescreve. O LEAD nasce mais abaixo,
  // depois do portão de idempotência da mensagem — ver ensureLeadForContact.
  let acquisition: Acquisition | null = null;
  if (wasInserted) {
    acquisition = parseMetaAdReferral(p);
    if (acquisition) {
      await captureAcquisition(admin, session.organization_id, contactId, acquisition);
    }
  }

  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { data: insertedMessage, error: insertErr } = await admin
    .from("messages")
    .insert({
      organization_id: session.organization_id,
      conversation_id: conversationId,
      channel_session_id: session.id,
      contact_id: contactId,
      external_id: p.id,
      type: mapWahaMessageType(p.type),
      direction: "inbound",
      status: "delivered",
      ack: p.ack ?? null,
      body: p.body ?? null,
      media_url: p.mediaUrl ?? null,
      media_mime: p.mimetype ?? null,
      sent_via: "external_device",
      sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
      delivered_at: now,
      metadata: { raw_type: p.type, ack_name: p.ackName },
    })
    .select("id")
    .maybeSingle();

  // Idempotência: 23505 = unique (organization_id, external_id) já ingerido.
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] message insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await markConversation(admin, conversationId, "inbound", previewFromMessage(p), now);

  // Lead do funil: exatamente um aberto por contato, para TODO contato (anúncio ou
  // comum). Fica aqui de propósito — depois do 23505 da mensagem, que é o único
  // portão atômico que garante que só UM dos eventos gêmeos (message/message.any)
  // chegue até aqui. Antes disso, o check-then-act de "já existe lead?" duplicaria.
  await ensureLeadForContact(
    admin,
    session,
    contactId,
    acquisition,
    notifyName ?? (parsed.kind === "phone" ? parsed.phone : chatId) ?? "Contato WhatsApp",
    requestId,
  );

  if (p.body && STOP_RX.test(p.body)) {
    await admin
      .from("contacts")
      .update({ is_blocked: true, blocked_reason: "stop_keyword", blocked_at: now })
      .eq("id", contactId);
    await audit({
      action: "contact.blocked",
      organizationId: session.organization_id,
      resourceType: "contact",
      requestId,
      metadata: { reason: "stop_keyword", contact_id: contactId },
    });
  }

  await audit({
    action: "message.received",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id },
  });

  // Dispara o agent-dispatcher worker (fire-and-forget; falha não quebra o 200).
  if (insertedMessage?.id) {
    const inboundMessageId = insertedMessage.id;
    admin
      .rpc("emit_event" as never, {
        p_event_type: "ai_agent.dispatch_requested",
        p_entity_kind: "message",
        p_entity_id: inboundMessageId,
        p_payload: {
          organization_id: session.organization_id,
          conversation_id: conversationId,
          contact_id: contactId,
          channel_session_id: session.id,
          inbound_message_id: inboundMessageId,
        },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit dispatch_requested failed", error.message);
      });

    admin
      .rpc("emit_event" as never, {
        p_event_type: "message.received",
        p_entity_kind: "message",
        p_entity_id: inboundMessageId,
        p_payload: {
          conversation_id: conversationId,
          contact_id: contactId,
          channel_session_id: session.id,
          body_preview: (p.body ?? "").slice(0, 280),
        },
        p_metadata: { source: "waha_webhook", request_id: requestId },
        p_organization_id: session.organization_id,
      } as never)
      .then(({ error }) => {
        if (error) console.error("[waha.ingest] emit message.received failed", error.message);
      });
  }
}

/**
 * fromMe=true: operador respondeu direto do WhatsApp dele (não pelo composer).
 * Contato = destinatário (`to`). `from` é o próprio número do operador — nunca
 * vira contato. Registrado como outbound p/ o operador ver o histórico completo.
 */
async function handleOutboundFromUserPhone(
  admin: Admin,
  session: Session,
  p: WahaPayload,
  requestId: string,
): Promise<void> {
  const chatId = p.to ?? "";
  const parsed = parseChatId(chatId);
  if (parsed.kind === "group") return;
  if (!p.id || !chatId) return;
  if (!p.body && !p.mediaUrl && !p.hasMedia) return;

  // Outbound (operador respondeu pelo celular): sem captura de origem — a origem de
  // anúncio é first-touch do INBOUND. Só adapta o novo retorno da RPC.
  const upserted = await upsertContact(admin, session.organization_id, parsed, chatId, notifyNameOf(p));
  if (!upserted) return;
  const contactId = upserted.contactId;
  const conversationId = await upsertConversation(admin, session.organization_id, contactId, session.id);
  if (!conversationId) return;

  const now = new Date().toISOString();
  const { error: insertErr } = await admin.from("messages").insert({
    organization_id: session.organization_id,
    conversation_id: conversationId,
    channel_session_id: session.id,
    contact_id: contactId,
    external_id: p.id,
    type: mapWahaMessageType(p.type),
    direction: "outbound",
    status: "sent",
    ack: p.ack ?? null,
    body: p.body ?? null,
    media_url: p.mediaUrl ?? null,
    media_mime: p.mimetype ?? null,
    sent_via: "external_device",
    sent_at: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : now,
    metadata: { raw_type: p.type, fromMe: true },
  });
  if (insertErr && insertErr.code !== "23505") {
    console.error("[waha.ingest] outbound insert failed", insertErr.message);
    return;
  }
  if (insertErr?.code === "23505") return;

  await markConversation(admin, conversationId, "outbound", previewFromMessage(p), now);

  await audit({
    action: "message.sent",
    organizationId: session.organization_id,
    resourceType: "message",
    requestId,
    metadata: { conversation_id: conversationId, type: p.type, external_id: p.id, from_user_phone: true },
  });
}

async function handleAck(admin: Admin, session: Session, p: WahaPayload): Promise<void> {
  if (!p.id) return;
  const ack = p.ack ?? 0;
  const status = ackToStatus(ack);
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { ack, status };
  if (ack >= 2) update.delivered_at = now;
  if (ack >= 3) update.read_at = now;

  await admin
    .from("messages")
    .update(update)
    .eq("organization_id", session.organization_id)
    .eq("external_id", p.id);
}

interface SessionStatusRow extends Session {
  is_warmup_complete: boolean | null;
  warmup_started_at: string | null;
}

async function handleSessionStatus(
  admin: Admin,
  session: SessionStatusRow,
  p: WahaPayload,
): Promise<void> {
  const status = (p.status ?? "").toUpperCase() || null;
  if (!status) return;
  const allowed = new Set(["STARTING", "SCAN_QR_CODE", "WORKING", "STOPPED", "FAILED"]);
  if (!allowed.has(status)) return;
  const now = new Date().toISOString();

  const update: Record<string, unknown> = { status, last_status_change_at: now };
  if (status === "WORKING" && session.warmup_started_at && !session.is_warmup_complete) {
    update.is_warmup_complete = true;
    update.warmup_completed_at = now;
  }
  await admin.from("channel_sessions").update(update).eq("id", session.id);
}

/**
 * Roteador único de eventos WAHA. Os dois route handlers convergem aqui após
 * resolver a sessão e validar HMAC.
 */
export async function dispatchWahaEvent(
  admin: Admin,
  session: SessionStatusRow,
  envelope: WahaEnvelope,
  requestId: string,
): Promise<void> {
  const eventType = envelope.event ?? "unknown";
  const payload = envelope.payload ?? {};

  if (eventType === "message" || eventType === "message.any") {
    if (payload.fromMe) {
      await handleOutboundFromUserPhone(admin, session, payload, requestId);
    } else {
      await handleInbound(admin, session, payload, requestId);
    }
  } else if (eventType === "message.ack") {
    await handleAck(admin, session, payload);
  } else if (eventType === "session.status" || eventType === "state.change") {
    await handleSessionStatus(admin, session, payload);
  }
}
