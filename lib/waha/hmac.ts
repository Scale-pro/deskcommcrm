/**
 * lib/waha/hmac.ts — verificação PURA da assinatura HMAC dos webhooks do WAHA.
 *
 * Isolada de ingest.ts para ser testável sem puxar a cadeia de env/supabase
 * (mesmo padrão de ad-referral.ts e entry-stage.ts).
 *
 * Formato (WAHA Plus): o container assina o CORPO BRUTO da requisição com
 * HMAC-SHA512 usando `WHATSAPP_HOOK_HMAC` e envia o resultado em hexadecimal no
 * header `X-Webhook-Hmac` (o algoritmo vem em `X-Webhook-Hmac-Algorithm`).
 * O corpo tem de ser o texto exatamente como chegou — reserializar o JSON muda
 * espaçamento/ordem e invalida a assinatura.
 *
 * Comparação com `timingSafeEqual` para não vazar informação por tempo de resposta.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Header onde o WAHA envia a assinatura. */
export const WAHA_SIGNATURE_HEADER = "x-webhook-hmac";

/**
 * true somente se a assinatura recebida corresponder ao HMAC-SHA512 hex do corpo
 * bruto com o segredo dado. Assinatura ausente, de tamanho diferente ou não-hex
 * retorna false — nunca lança.
 */
export function verifyHmacSha512(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
  const got = signatureHeader.replace(/^sha512=/i, "").trim();
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

/** Assina um corpo — usado em testes e para reproduzir o cálculo manualmente. */
export function signHmacSha512(rawBody: string, secret: string): string {
  return createHmac("sha512", secret).update(rawBody, "utf8").digest("hex");
}
