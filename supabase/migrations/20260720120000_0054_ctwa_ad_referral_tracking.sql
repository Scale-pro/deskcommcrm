-- 0054 — Rastreamento de origem de aquisição (Parte 1: Meta Ads / Click-to-WhatsApp)
--
-- O QUÊ: captura a origem de contatos que chegam via anúncio Click-to-WhatsApp do
-- Meta (ctwa_clid, ad id, source_url, headline) na PRIMEIRA mensagem (first-touch),
-- persiste em contacts.source / contacts.source_metadata.acquisition, e auto-cria um
-- lead numa coluna de entrada dedicada ('Novo · Meta Ads') do pipeline default.
--
-- POR QUÊ: fecha o gap de atribuição (antes o objeto referral do WhatsApp chegava no
-- webhook e era descartado). Schema de source_metadata.acquisition é AGNÓSTICO DE CANAL
-- (discriminador `channel`: meta_ads hoje; google_ads/outros encaixam no mesmo shape
-- depois — base do dashboard "Origem das Conversas"). "Não Rastreada" = ausência da
-- chave `acquisition`. click_id genérico + conversions_api.status='pending' deixam o
-- envio futuro pro Meta Conversions API (e Google Enhanced Conversions) sem remodelagem.
--
-- Idempotente e portável em psql puro. Sem BEGIN/COMMIT (o runner envolve em transação).

-- ---------------------------------------------------------------------------
-- 1) Seed: coluna de entrada 'Novo · Meta Ads' no pipeline default de novos orgs.
--    position 500 => fica ANTES de 'Carrinho abandonado' (1000).
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

  insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
  values (new.id, v_pipeline_id, 'Novo · Meta Ads', 'novo_meta_ads', 500, false, false);

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
-- 2) Backfill: adiciona 'novo_meta_ads' a pipelines default JÁ existentes que não a
--    têm. Idempotente (not exists). Genérico p/ qualquer clone (não hardcoda ids).
-- ---------------------------------------------------------------------------
insert into public.crm_stages (organization_id, pipeline_id, name, slug, position, is_won, is_lost)
select p.organization_id, p.id, 'Novo · Meta Ads', 'novo_meta_ads', 500, false, false
from public.crm_pipelines p
where p.is_default = true
  and not exists (
    select 1 from public.crm_stages s
    where s.pipeline_id = p.id and s.slug = 'novo_meta_ads'
  );

-- ---------------------------------------------------------------------------
-- 3) fn_upsert_wa_contact: assinatura (args) INALTERADA — só o RETURN passa de uuid
--    p/ tabela (contact_id, was_inserted). was_inserted = (xmax = 0) distingue insert
--    de update no upsert, para o ingest capturar origem/criar lead só p/ contato NOVO.
--    Grants por assinatura seguem válidos (não recriados aqui).
-- ---------------------------------------------------------------------------
drop function if exists public.fn_upsert_wa_contact(uuid, text, text, text, text, text);
create or replace function public.fn_upsert_wa_contact(
  p_org uuid, p_kind text, p_phone text, p_lid text, p_chat_id text, p_notify text
) returns table (contact_id uuid, was_inserted boolean)
language plpgsql security definer set search_path = public as $$
begin
  return query
  insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
  values (p_org, case when p_kind = 'phone' then p_phone end, 'whatsapp', '{}'::jsonb, '{}'::text[],
    case when p_kind = 'lid' then jsonb_build_object('waha_lid', p_lid, 'notify_name', nullif(p_notify, ''))
      else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
    nullif(p_notify, ''))
  on conflict (organization_id, wa_identity) where wa_identity is not null and is_merged_into is null
  do update set display_name = coalesce(contacts.display_name, excluded.display_name), updated_at = now()
  returning contacts.id, (xmax = 0);
end; $$;

revoke all on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) from public;
revoke execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) from anon;
grant execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4) fn_capture_contact_acquisition: grava origem de aquisição no contato de forma
--    ATÔMICA e FIRST-TOUCH (nunca sobrescreve se source_metadata já tem 'acquisition').
--    `source` recebe o canal (genérico: meta_ads, google_ads, ...). Retorna se gravou.
-- ---------------------------------------------------------------------------
create or replace function public.fn_capture_contact_acquisition(
  p_contact uuid, p_org uuid, p_channel text, p_acquisition jsonb
) returns boolean language plpgsql security definer set search_path = public as $$
declare v_updated boolean := false;
begin
  update public.contacts
     set source = p_channel,
         source_metadata = source_metadata || jsonb_build_object('acquisition', p_acquisition),
         updated_at = now()
   where id = p_contact
     and organization_id = p_org
     and not (source_metadata ? 'acquisition')
   returning true into v_updated;
  return coalesce(v_updated, false);
end; $$;

revoke all on function public.fn_capture_contact_acquisition(uuid, uuid, text, jsonb) from public;
revoke execute on function public.fn_capture_contact_acquisition(uuid, uuid, text, jsonb) from anon;
grant execute on function public.fn_capture_contact_acquisition(uuid, uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5) Índices para o dashboard "Origem das Conversas" e p/ o futuro Conversions API.
--    (a) agrupamento por canal / lookup de contatos rastreados por org.
--    (b) fila de envio pendente ao Conversions API (status='pending').
-- ---------------------------------------------------------------------------
create index if not exists idx_contacts_acq_channel
  on public.contacts (organization_id, (source_metadata #>> '{acquisition,channel}'))
  where source_metadata ? 'acquisition';

create index if not exists idx_contacts_acq_capi_pending
  on public.contacts (organization_id)
  where (source_metadata #>> '{acquisition,conversions_api,status}') = 'pending';
