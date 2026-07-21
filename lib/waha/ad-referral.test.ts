import { describe, expect, it } from "vitest";

import { type AdReferralSource, parseMetaAdReferral } from "./ad-referral";

/**
 * Parte 1 (Meta Ads / Click-to-WhatsApp) — o objeto referral varia por engine
 * WAHA e nunca pôde ser testado com clique real. Estes testes congelam o
 * contrato de TOLERÂNCIA: shapes conhecidos são capturados; qualquer coisa
 * ausente/estranha vira null SEM lançar (a ingestão de mensagem segue intacta).
 */
describe("parseMetaAdReferral", () => {
  it("captura referral no shape Cloud-API (_data.referral snake_case)", () => {
    const p: AdReferralSource = {
      _data: {
        referral: {
          ctwa_clid: "CTWA_ABC",
          source_id: "120210000",
          source_url: "https://fb.me/xyz",
          source_type: "ad",
          headline: "Promo de inverno",
          body: "Fale agora",
          media_type: "image",
        },
      },
    };
    const acq = parseMetaAdReferral(p);
    expect(acq).not.toBeNull();
    expect(acq!.channel).toBe("meta_ads");
    expect(acq!.click_id).toBe("CTWA_ABC");
    expect(acq!.click_id_param).toBe("ctwa_clid");
    expect(acq!.ad.source_id).toBe("120210000");
    expect(acq!.ad.headline).toBe("Promo de inverno");
    expect(acq!.conversions_api).toEqual({ status: "pending", sent_at: null });
    expect(typeof acq!.detected_at).toBe("string");
  });

  it("captura shape camelCase (ctwaContext: sourceUrl/sourceId/title)", () => {
    const p: AdReferralSource = {
      _data: { ctwaContext: { ctwaClid: "CLID9", sourceId: "AD9", sourceUrl: "https://x", title: "Oi" } },
    };
    const acq = parseMetaAdReferral(p);
    expect(acq!.click_id).toBe("CLID9");
    expect(acq!.ad.source_id).toBe("AD9");
    expect(acq!.ad.headline).toBe("Oi");
  });

  it("captura referral no top-level do payload", () => {
    const acq = parseMetaAdReferral({ referral: { source_url: "https://only-url" } });
    expect(acq).not.toBeNull();
    expect(acq!.ad.source_url).toBe("https://only-url");
    expect(acq!.click_id).toBeNull();
    expect(acq!.click_id_param).toBeNull();
  });

  it("mensagem normal sem referral => null (estado Não Rastreada)", () => {
    expect(parseMetaAdReferral({ body: "oi" } as unknown as AdReferralSource)).toBeNull();
  });

  it("referral presente mas SEM identificador útil => null", () => {
    expect(parseMetaAdReferral({ _data: { referral: { foo: "bar" } } })).toBeNull();
  });

  it("referral em formato inesperado (string / array / número) => null, não lança", () => {
    expect(parseMetaAdReferral({ referral: "nope" } as unknown as AdReferralSource)).toBeNull();
    expect(parseMetaAdReferral({ referral: [1, 2, 3] } as unknown as AdReferralSource)).toBeNull();
    expect(parseMetaAdReferral({ _data: { referral: 42 } } as unknown as AdReferralSource)).toBeNull();
  });

  it("payload vazio => null", () => {
    expect(parseMetaAdReferral({})).toBeNull();
  });
});
