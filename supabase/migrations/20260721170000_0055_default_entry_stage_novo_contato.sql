-- 0055 — Etapa de entrada comum 'Novo contato' no pipeline default
--
-- O QUÊ: cria a coluna de entrada 'Novo contato' (slug novo_contato, position 750)
-- no pipeline default — para orgs novas (via seed) e para as já existentes (backfill).
--
-- POR QUÊ: até aqui o ingest WAHA só criava lead quando a mensagem vinha de anúncio
-- (coluna novo_meta_ads). Contato comum entrava no CRM sem lead nenhum. A correção do
-- ingest passa a criar lead para TODO contato novo, e precisa de uma etapa de entrada
-- semanticamente correta. A regra de seleção no código é GENÉRICA (menor position entre
-- as etapas abertas, excluindo novo_meta_ads) — esta migration apenas garante que a
-- etapa de menor posição seja "Novo contato" e não "Carrinho abandonado", que descreve
-- outra situação. Orgs com pipeline custom seguem funcionando: a regra genérica cai na
-- etapa aberta de menor posição que existir.
--
-- POSIÇÕES no pipeline default: 500 Novo · Meta Ads | 750 Novo contato | 1000 Carrinho
-- abandonado | 2000 Aguardando pagamento | ... (mantidas as demais).
--
-- Idempotente e portável em psql puro. Sem BEGIN/COMMIT (o runner envolve em transação).
-- Não apaga nem move nada: apenas insere a etapa quando ela não existe.

-- ---------------------------------------------------------------------------
-- 1) Seed: 'Novo contato' no pipeline default de organizações NOVAS.
-- ---------------------------------------------------------------------------
create or replace function public.fn_seed_default_pipeline_for_org() returns trigger
    language plpgsql
    set search_path to 'public', 'pg_temp'
    as $$
declare
  v_pipeline_id uuid;
  v_position numeric := 1000;
  r record;
begin
  insert into public.crm_pipelines (organization_id, name, slug, is_default, position)
  values (new.id, 'Pedidos', 'pedidos', true, 1000)
  returning id into v_pipeline_id;

  -- Entrada dedicada de anúncio (0054) e entrada comum (0055).
  insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
  values
    (new.id, v_pipeline_id, 'Novo · Meta Ads', 'novo_meta_ads', 500, false, false),
    (new.id, v_pipeline_id, 'Novo contato',    'novo_contato',  750, false, false);

  for r in
    select * from (values
      ('Carrinho abandonado',  'carrinho_abandonado',  false, false),
      ('Aguardando pagamento', 'aguardando_pagamento', false, false),
      ('Pago',                 'pago',                 true,  false),
      ('Em separacao',         'em_separacao',         false, false),
      ('Enviado',              'enviado',              false, false),
      ('Entregue',             'entregue',             false, false),
      ('Pos-venda',            'pos_venda',            false, false),
      ('Cancelado',            'cancelado',            false, true)
    ) as t(stage_name, stage_slug, won, lost)
  loop
    insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
    values (new.id, v_pipeline_id, r.stage_name, r.stage_slug, v_position, r.won, r.lost);
    v_position := v_position + 1000;
  end loop;

  return new;
end$$;

-- ---------------------------------------------------------------------------
-- 2) Backfill: 'Novo contato' em pipelines default JÁ existentes que não a têm.
--    Idempotente (not exists + uniq_crm_stages_pipeline_slug). Genérico p/ qualquer
--    clone: não hardcoda ids de organização nem de pipeline.
-- ---------------------------------------------------------------------------
insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
select p.organization_id, p.id, 'Novo contato', 'novo_contato', 750, false, false
from public.crm_pipelines p
where p.is_default = true
  and not exists (
    select 1 from public.crm_stages s
    where s.pipeline_id = p.id and s.slug = 'novo_contato'
  );

-- ---------------------------------------------------------------------------
-- 3) Índice de apoio à seleção da etapa de entrada pelo ingest (menor position
--    entre as abertas de um pipeline). Sem unicidade: é só ordenação.
-- ---------------------------------------------------------------------------
create index if not exists idx_crm_stages_pipeline_open_position
  on public.crm_stages (pipeline_id, position)
  where is_archived = false and is_won = false and is_lost = false;
