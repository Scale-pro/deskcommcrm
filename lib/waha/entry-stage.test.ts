import { describe, expect, it } from "vitest";

import { AD_ENTRY_SLUG, type EntryStageCandidate, pickEntryStage } from "./entry-stage";

/**
 * Correção 2 — o ingest passou a criar lead para TODO contato novo, não só os de
 * anúncio. Estes testes congelam a regra de destino do card: anúncio vai para a
 * coluna dedicada; comum vai para a etapa aberta de menor position, NUNCA para a
 * de anúncio e NUNCA para uma etapa de ganho/perda/arquivada.
 */

/** Pipeline default pós-migrations 0054/0055. */
function defaultPipelineStages(): EntryStageCandidate[] {
  return [
    { id: "s-meta", slug: AD_ENTRY_SLUG, position: 500, is_archived: false, is_won: false, is_lost: false },
    { id: "s-novo", slug: "novo_contato", position: 750, is_archived: false, is_won: false, is_lost: false },
    { id: "s-carrinho", slug: "carrinho_abandonado", position: 1000, is_archived: false, is_won: false, is_lost: false },
    { id: "s-aguard", slug: "aguardando_pagamento", position: 2000, is_archived: false, is_won: false, is_lost: false },
    { id: "s-pago", slug: "pago", position: 3000, is_archived: false, is_won: true, is_lost: false },
    { id: "s-cancel", slug: "cancelado", position: 8000, is_archived: false, is_won: false, is_lost: true },
  ];
}

describe("pickEntryStage", () => {
  it("lead comum vai para a etapa aberta de menor position ('Novo contato', 750)", () => {
    expect(pickEntryStage(defaultPipelineStages(), false)).toBe("s-novo");
  });

  it("lead de anúncio vai para a coluna dedicada, mesmo não sendo a de menor position", () => {
    expect(pickEntryStage(defaultPipelineStages(), true)).toBe("s-meta");
  });

  it("lead comum NUNCA cai na coluna de anúncio, mesmo se ela for a primeira", () => {
    // Pipeline sem 'novo_contato' (org que só rodou a 0054): a de anúncio é a
    // de menor position, mas o caminho comum tem de pular para 'carrinho'.
    const semNovoContato = defaultPipelineStages().filter((s) => s.slug !== "novo_contato");
    expect(pickEntryStage(semNovoContato, false)).toBe("s-carrinho");
  });

  it("anúncio sem a coluna dedicada faz fallback para a etapa comum (não perde o lead)", () => {
    const semMeta = defaultPipelineStages().filter((s) => s.slug !== AD_ENTRY_SLUG);
    expect(pickEntryStage(semMeta, true)).toBe("s-novo");
  });

  it("ignora etapas de ganho, perda e arquivadas", () => {
    const stages: EntryStageCandidate[] = [
      { id: "arq", slug: "antiga", position: 100, is_archived: true, is_won: false, is_lost: false },
      { id: "won", slug: "pago", position: 200, is_archived: false, is_won: true, is_lost: false },
      { id: "lost", slug: "cancelado", position: 300, is_archived: false, is_won: false, is_lost: true },
      { id: "ok", slug: "primeira_aberta", position: 400, is_archived: false, is_won: false, is_lost: false },
    ];
    expect(pickEntryStage(stages, false)).toBe("ok");
    expect(pickEntryStage(stages, true)).toBe("ok");
  });

  it("pipeline custom (sem nenhum slug conhecido) usa a primeira etapa aberta", () => {
    const custom: EntryStageCandidate[] = [
      { id: "c2", slug: "negociando", position: 2000, is_archived: false, is_won: false, is_lost: false },
      { id: "c1", slug: "triagem", position: 1000, is_archived: false, is_won: false, is_lost: false },
    ];
    expect(pickEntryStage(custom, false)).toBe("c1");
    expect(pickEntryStage(custom, true)).toBe("c1");
  });

  it("sem etapa aberta elegível => null (chamador não cria lead solto)", () => {
    expect(pickEntryStage([], false)).toBeNull();
    expect(
      pickEntryStage(
        [{ id: "won", slug: "pago", position: 1, is_archived: false, is_won: true, is_lost: false }],
        false,
      ),
    ).toBeNull();
    // Só a coluna de anúncio existe e a origem é comum => não há destino comum.
    expect(
      pickEntryStage(
        [{ id: "m", slug: AD_ENTRY_SLUG, position: 500, is_archived: false, is_won: false, is_lost: false }],
        false,
      ),
    ).toBeNull();
  });

  it("ordena por position numérica, não alfabética", () => {
    const stages: EntryStageCandidate[] = [
      { id: "b", slug: "b", position: 900, is_archived: false, is_won: false, is_lost: false },
      { id: "a", slug: "a", position: 1000, is_archived: false, is_won: false, is_lost: false },
    ];
    expect(pickEntryStage(stages, false)).toBe("b");
  });
});
