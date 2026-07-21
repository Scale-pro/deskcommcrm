/**
 * lib/waha/entry-stage.ts — regra PURA de escolha da etapa de entrada do funil
 * para leads criados automaticamente pela ingestão do WhatsApp.
 *
 * Isolada de ingest.ts pelo mesmo motivo de ad-referral.ts: ser testável sem
 * puxar a cadeia de env/supabase (lib/env.ts lança se faltar variável).
 *
 * Regra (Correção 2, sem slug hardcoded no caminho comum):
 *  - origem de anúncio => coluna dedicada 'novo_meta_ads' quando ela existir;
 *  - caso contrário     => etapa ABERTA de menor `position`, excluindo a de anúncio.
 *
 * Etapa "aberta" = não arquivada, não is_won, não is_lost. A migration 0055 põe
 * 'Novo contato' em 750 no pipeline default para que o caminho comum caia nela e
 * não em 'Carrinho abandonado' (1000), que descreve outra situação. Pipelines
 * custom seguem funcionando: cai na primeira etapa aberta que existir.
 */

/** Slug da coluna de entrada dedicada a anúncios Click-to-WhatsApp (migration 0054). */
export const AD_ENTRY_SLUG = "novo_meta_ads";

export interface EntryStageCandidate {
  id: string;
  slug: string;
  position: number;
  is_archived: boolean;
  is_won: boolean;
  is_lost: boolean;
}

/**
 * Escolhe a etapa de entrada. Retorna null quando o pipeline não tem nenhuma
 * etapa aberta elegível — o chamador trata como erro (não cria lead solto).
 */
export function pickEntryStage(
  stages: EntryStageCandidate[],
  isAdOrigin: boolean,
): string | null {
  const open = stages.filter((s) => !s.is_archived && !s.is_won && !s.is_lost);

  if (isAdOrigin) {
    const adStage = open.find((s) => s.slug === AD_ENTRY_SLUG);
    if (adStage) return adStage.id;
    // Sem a coluna dedicada (pipeline custom / backfill não rodou): cai no comum.
    // A origem continua salva no contato — só o destino do card muda.
  }

  const common = open
    .filter((s) => s.slug !== AD_ENTRY_SLUG)
    .sort((a, b) => a.position - b.position)[0];

  return common?.id ?? null;
}
