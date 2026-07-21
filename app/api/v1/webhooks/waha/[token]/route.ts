/**
 * POST /api/v1/webhooks/waha/[token]
 *
 * Rota per-tenant canônica de produção: cada channel_session tem um
 * webhook_path_token único url-safe. Pipeline: lookup por token -> verifica
 * HMAC SHA512 -> loga em webhook_events_log -> dispatchWahaEvent (ingestão
 * compartilhada, ver lib/waha/ingest.ts).
 *
 * Idempotência e resolução atômica de contato/conversa vivem no módulo
 * compartilhado — este handler só faz auth + roteamento.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkWahaSignature, dispatchWahaEvent, type WahaEnvelope } from "@/lib/waha/ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteCtx {
  params: Promise<{ token: string }>;
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  if (!token || token.length < 8) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  const rawBody = await req.text();
  let envelope: WahaEnvelope;
  try {
    envelope = JSON.parse(rawBody) as WahaEnvelope;
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const admin = createAdminClient();

  const { data: session, error: sessErr } = await admin
    .from("channel_sessions")
    .select(
      "id, organization_id, waha_session_name, webhook_secret_encrypted, status, is_warmup_complete, warmup_started_at",
    )
    .eq("webhook_path_token", token)
    .maybeSingle();

  if (sessErr) {
    return fail("internal_error", sessErr.message, 500, { requestId });
  }
  if (!session) {
    return fail("not_found", "unknown webhook token", 404, { requestId });
  }

  // HMAC — segredo por sessão, senão WAHA_HMAC_SECRET do ambiente. Só pula quando
  // não há segredo em lugar nenhum (dev); checkWahaSignature avisa no log nesse caso.
  const sigHeader = req.headers.get("x-webhook-hmac");
  const hmac = await checkWahaSignature(
    admin,
    session.webhook_secret_encrypted,
    rawBody,
    sigHeader,
  );
  const hmacSkipped = hmac.mode === "skipped_no_secret";
  const validSignature = hmac.mode === "verified" && hmac.ok;

  if (!hmac.ok) {
    await audit({
      action: "nuvemshop.webhook_invalid_signature",
      organizationId: session.organization_id,
      metadata: {
        provider: "waha",
        session: session.waha_session_name,
        event: envelope.event,
        // Nunca logar o segredo nem a assinatura inteira.
        signature_present: !!sigHeader,
        signature_len: sigHeader?.length ?? 0,
      },
    });
    return fail("unauthenticated", "invalid_signature", 401, { requestId });
  }

  const eventType = envelope.event ?? "unknown";
  const externalId = envelope.payload?.id ?? null;

  const headersJson: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("authorization")) return;
    if (key.toLowerCase() === "cookie") return;
    headersJson[key] = value;
  });
  await admin.from("webhook_events_log").insert({
    organization_id: session.organization_id,
    channel_session_id: session.id,
    provider: "waha",
    webhook_path_token: token,
    http_method: "POST",
    headers: headersJson,
    raw_body: rawBody,
    payload_parsed: envelope as unknown as Record<string, unknown>,
    signature_header: sigHeader ?? null,
    valid_signature: validSignature || hmacSkipped,
    event_type: eventType,
    external_id: externalId,
    status: "received",
    attempts: 0,
  });

  try {
    await dispatchWahaEvent(admin, session, envelope, requestId);
  } catch (err) {
    console.error("[waha.webhook] handler failed", err);
  }

  return ok({ accepted: true }, { requestId });
}
