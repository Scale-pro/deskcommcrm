/**
 * lib/waha/ad-referral.ts — parser PURO (sem I/O) da origem de aquisição vinda
 * de anúncios Click-to-WhatsApp do Meta. Isolado do ingest.ts pra ser testável
 * sem puxar a cadeia de env/supabase — mesmo princípio de lib/webhooks/inbound.ts.
 *
 * Shape AGNÓSTICO DE CANAL — `channel` discrimina (meta_ads hoje; google_ads e
 * outros encaixam depois no MESMO campo). "Não Rastreada" = ausência deste objeto.
 * `click_id` genérico + `conversions_api.status` deixam o envio futuro pro Meta
 * Conversions API (ctwa_clid) e Google Enhanced Conversions (gclid) sem remodelar.
 */

export interface Acquisition {
  channel: string; // "meta_ads" | "google_ads" | ...
  medium: string | null; // como chegou (ex.: "whatsapp" p/ click-to-whatsapp)
  detected_at: string; // ISO-8601 UTC
  click_id: string | null; // valor do click id (ctwa_clid, gclid, ...)
  click_id_param: string | null; // qual parâmetro é (ex.: "ctwa_clid")
  ad: {
    source_id: string | null; // id do anúncio/campanha
    source_url: string | null;
    source_type: string | null; // "ad" | "post" | ...
    headline: string | null;
    body: string | null;
    media_type: string | null;
  };
  conversions_api: { status: "pending"; sent_at: null }; // reservado p/ envio futuro
  raw: Record<string, unknown>; // referral original — nada se perde
}

/** Subconjunto estrutural do WahaPayload que o parser lê (evita import circular). */
export interface AdReferralSource {
  referral?: unknown;
  _data?: ({ notifyName?: string; pushName?: string } & Record<string, unknown>) | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Primeiro alias presente como string não-vazia (ou número coagido). */
function pickStr(obj: Record<string, unknown>, aliases: string[]): string | null {
  for (const a of aliases) {
    const v = obj[a];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/**
 * Extrai a origem de anúncio Click-to-WhatsApp de um payload WAHA, de forma
 * TOLERANTE: o objeto referral varia por engine (NOWEB/WEBJS) e nunca pôde ser
 * testado com clique real aqui. Se vier ausente, em formato inesperado, ou sem
 * nenhum identificador útil, retorna null — o fluxo normal de mensagem segue
 * intacto (nunca lança). Só produz Acquisition com ao menos 1 campo significativo.
 */
export function parseMetaAdReferral(p: AdReferralSource): Acquisition | null {
  try {
    const data = p._data ?? undefined;
    const candidates: unknown[] = [
      p.referral,
      data?.referral,
      data?.ctwaContext,
      data?.ctwa_context,
      data?.adReplyMetadata,
      data?.quotedAd,
    ];
    const ref = candidates.find(isPlainObject);
    if (!ref) return null;

    const clickId = pickStr(ref, ["ctwa_clid", "ctwaClid", "click_id", "clickId"]);
    const sourceId = pickStr(ref, ["source_id", "sourceId", "ad_id", "adId", "adID"]);
    const sourceUrl = pickStr(ref, ["source_url", "sourceUrl", "url"]);
    const sourceType = pickStr(ref, ["source_type", "sourceType", "type"]);
    const headline = pickStr(ref, ["headline", "title", "headLine"]);
    const body = pickStr(ref, ["body", "description", "caption"]);
    const mediaType = pickStr(ref, ["media_type", "mediaType"]);

    // Sem nenhum identificador significativo => trata como não-rastreado.
    if (!clickId && !sourceId && !sourceUrl) return null;

    return {
      channel: "meta_ads",
      medium: "whatsapp",
      detected_at: new Date().toISOString(),
      click_id: clickId,
      click_id_param: clickId ? "ctwa_clid" : null,
      ad: {
        source_id: sourceId,
        source_url: sourceUrl,
        source_type: sourceType,
        headline,
        body,
        media_type: mediaType,
      },
      conversions_api: { status: "pending", sent_at: null },
      raw: ref,
    };
  } catch {
    return null; // tolerância dura: origem nunca quebra a ingestão de mensagem
  }
}
