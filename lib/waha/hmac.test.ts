import { describe, expect, it } from "vitest";

import { signHmacSha512, verifyHmacSha512, WAHA_SIGNATURE_HEADER } from "./hmac";

/**
 * Correção 1 — antes, a linha da sessão nascia com um placeholder de 1 byte e o
 * WAHA_HMAC_SECRET do ambiente nunca era lido, então a verificação era SEMPRE
 * pulada e o endpoint público aceitava qualquer corpo. Estes testes congelam o
 * contrato de verificação: só passa quem assinou o corpo BRUTO com o segredo.
 */
const SECRET = "b7f3c1a9e2d84f6b0c5a1e9d3f7b2c8a4e6d0f1b3c5a7e9d2f4b6c8a0e1d3f5b";
const BODY = JSON.stringify({ event: "message", session: "org_1234abcd", payload: { id: "X1" } });

describe("verifyHmacSha512", () => {
  it("assinatura válida do corpo bruto => true", () => {
    expect(verifyHmacSha512(BODY, signHmacSha512(BODY, SECRET), SECRET)).toBe(true);
  });

  it("aceita o prefixo 'sha512=' (algumas versões prefixam)", () => {
    expect(verifyHmacSha512(BODY, `sha512=${signHmacSha512(BODY, SECRET)}`, SECRET)).toBe(true);
  });

  it("assinatura ausente => false (requisição sem header é rejeitada)", () => {
    expect(verifyHmacSha512(BODY, null, SECRET)).toBe(false);
    expect(verifyHmacSha512(BODY, "", SECRET)).toBe(false);
  });

  it("segredo errado => false", () => {
    expect(verifyHmacSha512(BODY, signHmacSha512(BODY, "outro_segredo"), SECRET)).toBe(false);
  });

  it("corpo adulterado => false (é isso que impede injeção de mensagem falsa)", () => {
    const assinatura = signHmacSha512(BODY, SECRET);
    const adulterado = JSON.stringify({
      event: "message",
      session: "org_1234abcd",
      payload: { id: "X1", body: "mensagem injetada" },
    });
    expect(verifyHmacSha512(adulterado, assinatura, SECRET)).toBe(false);
  });

  it("reserializar o JSON invalida a assinatura (prova que o corpo BRUTO importa)", () => {
    const assinatura = signHmacSha512(BODY, SECRET);
    const reserializado = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verifyHmacSha512(reserializado, assinatura, SECRET)).toBe(false);
  });

  it("lixo no header (tamanho errado / não-hex) => false, sem lançar", () => {
    expect(verifyHmacSha512(BODY, "abc", SECRET)).toBe(false);
    expect(verifyHmacSha512(BODY, "z".repeat(128), SECRET)).toBe(false);
    expect(() => verifyHmacSha512(BODY, "z".repeat(128), SECRET)).not.toThrow();
  });

  it("o header esperado é x-webhook-hmac", () => {
    expect(WAHA_SIGNATURE_HEADER).toBe("x-webhook-hmac");
  });
});
