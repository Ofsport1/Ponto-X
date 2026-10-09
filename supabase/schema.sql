-- Schema do delivery (projeto Supabase njejnymkszyvvipfaxth).
-- Idempotente: pode ser rodado de novo sem quebrar nada.
-- Todas as tabelas têm RLS ligado e SEM políticas: só o Worker (chave secreta)
-- acessa os dados. A chave pública não lê nem grava nada.

create extension if not exists pgcrypto;

-- stores: pensando numa eventual expansão multi-loja no futuro.
-- Por enquanto só tem uma linha (a Mercearia Garatucaia).
create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

alter table stores add column if not exists whatsapp text;
alter table stores add column if not exists delivery_fee_cents integer not null default 0 check (delivery_fee_cents >= 0);
alter table stores add column if not exists min_order_cents integer not null default 0 check (min_order_cents >= 0);
alter table stores add column if not exists is_open boolean not null default true;

insert into stores (name)
select 'Mercearia Garatucaia'
where not exists (select 1 from stores);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  description text,
  category text not null default 'Geral',
  price_cents integer not null check (price_cents >= 0),
  image_url text,
  available boolean not null default true,
  created_at timestamptz not null default now()
);

alter table products add column if not exists sort_order integer not null default 0;

create index if not exists products_store_idx on products(store_id);

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  customer_name text not null,
  customer_phone text not null,
  delivery_type text not null default 'delivery' check (delivery_type in ('delivery','pickup')),
  address text,
  payment_method text not null default 'dinheiro' check (payment_method in ('dinheiro','cartao','pix')),
  notes text,
  status text not null default 'received' check (status in ('received','preparing','out_for_delivery','delivered','cancelled')),
  total_cents integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table orders add column if not exists subtotal_cents integer not null default 0;
alter table orders add column if not exists delivery_fee_cents integer not null default 0;
alter table orders add column if not exists change_for_cents integer;
-- Pagamento dividido: [{"method":"pix","cents":2000},{"method":"dinheiro","cents":2199}] (soma = total_cents).
-- Null = tudo em payment_method. Com divisão, payment_method = forma da primeira parte.
alter table orders add column if not exists payment_split jsonb;
alter table orders add column if not exists order_number bigint generated always as identity;

create index if not exists orders_store_idx on orders(store_id);
create index if not exists orders_status_idx on orders(status);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id) on delete set null,
  product_name text not null,
  unit_price_cents integer not null,
  quantity integer not null default 1 check (quantity > 0),
  subtotal_cents integer not null
);

create index if not exists order_items_order_idx on order_items(order_id);

alter table stores enable row level security;
alter table products enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;

-- Bucket público pra foto dos produtos (o cardápio é público).
-- Upload/remoção só pelo Worker, com a chave secreta.
insert into storage.buckets (id, name, public)
values ('product-photos', 'product-photos', true)
on conflict (id) do nothing;

-- Variações do produto (ex.: Carvão 2,5 kg / 5 kg, sabores).
-- Produto com variações: o cliente escolhe uma, e o preço vem da variação.
-- products.price_cents passa a guardar o menor preço (pra mostrar "a partir de").
create table if not exists product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  available boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists product_variants_product_idx on product_variants(product_id);
alter table product_variants enable row level security;

alter table order_items add column if not exists variant_id uuid references product_variants(id) on delete set null;
alter table order_items add column if not exists variant_name text;

-- Destaque: produto aparece também na seção "⭐ Mais Vendidos", no topo do cardápio,
-- sem sair da própria categoria.
alter table products add column if not exists featured boolean not null default false;
alter table products add column if not exists featured_order integer not null default 0;

-- Clientes: identificados pelo WhatsApp (só dígitos, sem o 55). Cada pedido cria
-- ou atualiza o cliente e fica ligado a ele (orders.customer_id). Estatísticas e
-- nível (Novo / Frequente / VIP / Elite) são calculados no Worker a partir dos pedidos.
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  phone text not null,
  name text not null,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, phone)
);
alter table customers enable row level security;

alter table orders add column if not exists customer_id uuid references customers(id) on delete set null;
create index if not exists orders_customer_idx on orders(customer_id);

-- Pedido: origem, situação do pagamento e fechamento.
-- Entregue sem pagamento marcado vira pago (pagamento é na entrega); cancelado nunca fica pago.
alter table orders add column if not exists source text not null default 'site' check (source in ('site','balcao','whatsapp','telefone'));
alter table orders add column if not exists payment_status text not null default 'pending' check (payment_status in ('pending','paid'));
alter table orders add column if not exists paid_at timestamptz;
alter table orders add column if not exists closed_at timestamptz;
create index if not exists orders_created_idx on orders(store_id, created_at desc);
create index if not exists orders_paid_idx on orders(store_id, paid_at);

-- Caixa: entra na conferência tudo que foi pago (paid_at) entre a abertura e o fechamento.
create table if not exists cash_sessions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  opened_at timestamptz not null default now(),
  opening_cents integer not null default 0 check (opening_cents >= 0),
  closed_at timestamptz,
  expected_cash_cents integer,
  expected_card_cents integer,
  expected_pix_cents integer,
  counted_cash_cents integer,
  counted_card_cents integer,
  counted_pix_cents integer,
  sales_total_cents integer,
  sangrias_cents integer,
  suprimentos_cents integer,
  notes text
);
create unique index if not exists cash_sessions_one_open on cash_sessions(store_id) where closed_at is null;
alter table cash_sessions enable row level security;

create table if not exists cash_movements (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references cash_sessions(id) on delete cascade,
  type text not null check (type in ('sangria','suprimento')),
  amount_cents integer not null check (amount_cents > 0),
  description text,
  created_at timestamptz not null default now()
);
create index if not exists cash_movements_session_idx on cash_movements(session_id);
alter table cash_movements enable row level security;

-- Horário de funcionamento (abre/fecha sozinho quando auto_hours = true), impressora e WhatsApp.
alter table stores add column if not exists auto_hours boolean not null default true;
alter table stores add column if not exists hours jsonb not null default '[
  {"day":0,"enabled":true,"open":"08:00","close":"22:00"},
  {"day":1,"enabled":true,"open":"08:00","close":"22:00"},
  {"day":2,"enabled":true,"open":"08:00","close":"22:00"},
  {"day":3,"enabled":true,"open":"08:00","close":"22:00"},
  {"day":4,"enabled":true,"open":"08:00","close":"22:00"},
  {"day":5,"enabled":true,"open":"08:00","close":"22:00"},
  {"day":6,"enabled":true,"open":"08:00","close":"22:00"}]'::jsonb;
alter table stores add column if not exists print_settings jsonb not null default '{}'::jsonb;
alter table stores add column if not exists whatsapp_templates jsonb not null default '{}'::jsonb;
alter table stores add column if not exists whatsapp_settings jsonb not null default '{}'::jsonb;

-- Taxa de entrega por bairro (sem bairro ativo, vale stores.delivery_fee_cents).
create table if not exists delivery_zones (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  fee_cents integer not null default 0 check (fee_cents >= 0),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists delivery_zones_store_idx on delivery_zones(store_id);
alter table delivery_zones enable row level security;

alter table orders add column if not exists delivery_zone text;

-- Histórico de mensagens automáticas do WhatsApp (API oficial da Meta).
-- Configuração em stores.whatsapp_settings: mode ('manual' | 'api'), phone_number_id, waba_id, auto_send {etapa: bool}.
-- O token de acesso da Meta fica no secret WHATSAPP_TOKEN do Cloudflare (nunca no banco nem no site).
create table if not exists whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  phone text not null,
  template text not null,
  status text not null check (status in ('sent','error')),
  wa_message_id text,
  error text,
  created_at timestamptz not null default now()
);
create index if not exists whatsapp_messages_store_idx on whatsapp_messages(store_id, created_at desc);
alter table whatsapp_messages enable row level security;

-- Clientes importados do Olá Click em 2026-09-23 (source = 'olaclick').
-- legacy_orders_count = pedidos feitos lá (conta para o nível do cliente; o valor gasto não veio).
alter table customers add column if not exists email text;
alter table customers add column if not exists delivery_zone text;
alter table customers add column if not exists source text not null default 'site';
alter table customers add column if not exists olaclick_id text;
alter table customers add column if not exists legacy_orders_count integer not null default 0;
create unique index if not exists customers_olaclick_idx on customers(olaclick_id) where olaclick_id is not null;

-- "Leve junto": produtos sugeridos no carrinho (gelo, carvão, petiscos). Marcado no painel.
alter table products add column if not exists suggest boolean not null default false;

-- Aparelhos do dono que recebem o aviso "pedido novo" (Web Push; chave privada no secret VAPID_PRIVATE_KEY_JWK).
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  device text,
  created_at timestamptz not null default now()
);
alter table push_subscriptions enable row level security;

-- Débito e crédito separados ('cartao' fica aceito só para pedidos antigos).
alter table orders drop constraint if exists orders_payment_method_check;
alter table orders add constraint orders_payment_method_check
  check (payment_method in ('dinheiro','cartao','debito','credito','pix'));

-- Desconto dado pelo painel (total = subtotal + taxa - desconto).
alter table orders add column if not exists discount_cents integer not null default 0 check (discount_cents >= 0);

-- Usuários do painel (login por nome + PIN; hash PBKDF2 feito no Worker).
-- 5 PINs errados seguidos bloqueiam o usuário por 5 minutos.
create table if not exists staff (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  role text not null default 'caixa' check (role in ('admin','caixa','entregador')),
  pin_hash text not null,
  active boolean not null default true,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists staff_store_idx on staff(store_id);
alter table staff enable row level security;

-- Fechamento PDV: resumo financeiro de um período, finalizado uma vez.
-- payments = {"pix":..,"dinheiro":..,"debito":..,"credito":..,"cartao":..} em centavos.
create table if not exists pdv_closings (
  id uuid primary key default gen_random_uuid(),
  number bigint generated always as identity,
  store_id uuid not null references stores(id) on delete cascade,
  period_from date not null,
  period_to date not null,
  orders_count integer not null,
  products_cents integer not null,
  delivery_fees_cents integer not null,
  discounts_cents integer not null,
  total_cents integer not null,
  payments jsonb not null,
  received_cents integer not null,
  divergence_cents integer not null,
  finalized_at timestamptz not null default now(),
  finalized_by_id uuid references staff(id) on delete set null,
  finalized_by_name text not null
);
create index if not exists pdv_closings_store_idx on pdv_closings(store_id, finalized_at desc);
alter table pdv_closings enable row level security;

-- Pedido que entrou num fechamento fica preso a ele (nunca entra em outro e não muda mais).
alter table orders add column if not exists pdv_closing_id uuid references pdv_closings(id);
create index if not exists orders_pdv_closing_idx on orders(pdv_closing_id);

-- Finaliza de uma vez só (transação): trava os pedidos, confere que nenhum já foi
-- fechado nem mudou de situação, grava o fechamento e marca os pedidos.
create or replace function finalize_pdv_closing(p_closing jsonb, p_order_ids uuid[])
returns pdv_closings
language plpgsql
set search_path = public
as $$
declare
  v_closing pdv_closings;
  v_store uuid := (p_closing->>'store_id')::uuid;
  v_ok integer;
begin
  if coalesce(array_length(p_order_ids, 1), 0) = 0 then
    raise exception 'PDV_EMPTY';
  end if;

  perform 1 from orders where id = any(p_order_ids) for update;

  select count(*) into v_ok
  from orders
  where id = any(p_order_ids)
    and store_id = v_store
    and status = 'delivered'
    and pdv_closing_id is null;

  if v_ok <> array_length(p_order_ids, 1) then
    raise exception 'PDV_STALE';
  end if;

  insert into pdv_closings (
    store_id, period_from, period_to, orders_count, products_cents, delivery_fees_cents,
    discounts_cents, total_cents, payments, received_cents, divergence_cents,
    finalized_by_id, finalized_by_name
  ) values (
    v_store,
    (p_closing->>'period_from')::date,
    (p_closing->>'period_to')::date,
    (p_closing->>'orders_count')::integer,
    (p_closing->>'products_cents')::integer,
    (p_closing->>'delivery_fees_cents')::integer,
    (p_closing->>'discounts_cents')::integer,
    (p_closing->>'total_cents')::integer,
    p_closing->'payments',
    (p_closing->>'received_cents')::integer,
    (p_closing->>'divergence_cents')::integer,
    nullif(p_closing->>'finalized_by_id', '')::uuid,
    p_closing->>'finalized_by_name'
  ) returning * into v_closing;

  update orders set pdv_closing_id = v_closing.id where id = any(p_order_ids);

  return v_closing;
end;
$$;

-- Só o Worker (chave secreta) pode chamar.
revoke execute on function finalize_pdv_closing(jsonb, uuid[]) from public, anon, authenticated;

-- Nova etapa "Aceito" entre "Recebido" e "Em preparação".
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('received','accepted','preparing','out_for_delivery','delivered','cancelled'));
alter table orders add column if not exists accepted_at timestamptz;

-- Cancelamento com motivo obrigatório (e quem cancelou).
alter table orders add column if not exists cancel_reason text;
alter table orders add column if not exists cancelled_by text;

-- Prazo prometido (minutos desde o pedido) e o que já foi avisado ao dono pelos alertas automáticos (cron).
alter table stores add column if not exists delivery_minutes integer not null default 45 check (delivery_minutes between 5 and 240);
alter table stores add column if not exists pickup_minutes integer not null default 20 check (pickup_minutes between 5 and 240);
alter table stores add column if not exists alert_state jsonb not null default '{}'::jsonb;

-- Ruas de cada bairro (o cliente escolhe no checkout; a fila de entregas agrupa por rua).
alter table delivery_zones add column if not exists streets text[] not null default '{}';
alter table orders add column if not exists delivery_street text;

-- Despacho com conferência dupla: o caixa confere os itens e escolhe o entregador;
-- o entregador confirma no celular dele o que pegou (ou aponta diferença).
alter table orders add column if not exists courier_id uuid references staff(id) on delete set null;
alter table orders add column if not exists courier_name text;
alter table orders add column if not exists dispatched_at timestamptz;
alter table orders add column if not exists dispatched_by text;
alter table orders add column if not exists courier_confirmed_at timestamptz;
alter table orders add column if not exists courier_issue text;
create index if not exists orders_courier_idx on orders(courier_id, status);

-- Auditoria: quem fez o quê (preço, cancelamento, desconto, estorno, despacho, caixa...).
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  created_at timestamptz not null default now(),
  user_id uuid,
  user_name text not null,
  action text not null,
  entity text,
  entity_id uuid,
  summary text not null,
  details jsonb
);
create index if not exists audit_log_store_idx on audit_log(store_id, created_at desc);
alter table audit_log enable row level security;

-- Cliente VIP (marcado pelo dono): entrega grátis.
alter table customers add column if not exists is_vip boolean not null default false;

-- Aniversário (só dia e mês, "MM-DD"). birthday_set_at evita "virar aniversariante" na hora para ganhar desconto.
alter table customers add column if not exists birthday text check (birthday is null or birthday ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$');
alter table customers add column if not exists birthday_set_at timestamptz;

-- Cliente autorizou receber lembretes/novidades pelo WhatsApp.
alter table customers add column if not exists marketing_opt_in boolean not null default false;
alter table customers add column if not exists opt_in_at timestamptz;

-- Por que o pedido teve desconto ('painel' | 'aniversario') / ficou sem taxa ('vip').
alter table orders add column if not exists discount_reason text;
alter table orders add column if not exists fee_waived text;
create index if not exists orders_discount_reason_idx on orders(customer_id, discount_reason);

-- Presente de aniversário (desconto automático uma vez por ano, perto do aniversário).
alter table stores add column if not exists birthday_settings jsonb not null default
  '{"enabled": true, "type": "percent", "value": 10, "max_cents": 2000, "days_before": 3, "days_after": 3, "min_days_registered": 30}'::jsonb;

-- Preço por quantidade ("engradado"): levando bulk_qty unidades, sai por bulk_price_cents.
alter table products add column if not exists bulk_qty integer check (bulk_qty is null or bulk_qty between 2 and 100);
alter table products add column if not exists bulk_price_cents integer check (bulk_price_cents is null or bulk_price_cents >= 0);
alter table product_variants add column if not exists bulk_qty integer check (bulk_qty is null or bulk_qty between 2 and 100);
alter table product_variants add column if not exists bulk_price_cents integer check (bulk_price_cents is null or bulk_price_cents >= 0);

-- Custo (opcional) para o lucro estimado do resumo diário; sem custo, usa a margem padrão da loja.
alter table products add column if not exists cost_cents integer check (cost_cents is null or cost_cents >= 0);
alter table product_variants add column if not exists cost_cents integer check (cost_cents is null or cost_cents >= 0);
alter table order_items add column if not exists cost_cents integer;
alter table stores add column if not exists default_margin_percent integer not null default 30 check (default_margin_percent between 0 and 100);

-- Carrinho abandonado: salvo quando o cliente já digitou o WhatsApp no checkout e não finalizou.
create table if not exists abandoned_carts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  phone text not null,
  customer_name text,
  items jsonb not null,
  subtotal_cents integer not null default 0,
  marketing_opt_in boolean not null default false,
  updated_at timestamptz not null default now(),
  reminded_at timestamptz,
  recovered_order_id uuid references orders(id) on delete set null,
  unique (store_id, phone)
);
create index if not exists abandoned_carts_store_idx on abandoned_carts(store_id, updated_at desc);
alter table abandoned_carts enable row level security;

-- Tentativas da senha do painel (por IP e no geral), para bloquear chute de senha.
create table if not exists login_throttle (
  key text primary key,
  failures integer not null default 0,
  window_start timestamptz not null default now(),
  locked_until timestamptz
);
alter table login_throttle enable row level security;

-- Registra UMA tentativa (antes de conferir a senha) e diz se ela pode seguir. Atômica.
create or replace function login_attempt(p_key text, p_max integer, p_lock_minutes integer, p_window_minutes integer)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  r login_throttle;
begin
  insert into login_throttle (key) values (p_key) on conflict (key) do nothing;
  select * into r from login_throttle where key = p_key for update;

  if r.locked_until is not null and r.locked_until > now() then
    return false;
  end if;

  if r.window_start < now() - make_interval(mins => p_window_minutes) or r.locked_until is not null then
    r.failures := 0;
    r.window_start := now();
  end if;

  r.failures := r.failures + 1;

  if r.failures > p_max then
    update login_throttle set failures = 0, window_start = now(), locked_until = now() + make_interval(mins => p_lock_minutes) where key = p_key;
    return false;
  end if;

  update login_throttle set failures = r.failures, window_start = r.window_start, locked_until = null where key = p_key;
  return true;
end;
$$;

revoke execute on function login_attempt(text, integer, integer, integer) from public, anon, authenticated;

-- Quem recebe cada aviso: 'owner' (dono/caixa: tudo) ou 'courier' (entregador: só pedido novo e entrega dele).
alter table push_subscriptions add column if not exists audience text not null default 'owner' check (audience in ('owner','courier'));
alter table push_subscriptions add column if not exists staff_id uuid references staff(id) on delete cascade;
create index if not exists push_subscriptions_audience_idx on push_subscriptions(store_id, audience);

-- Código aleatório do pedido (5 dígitos) para cliente e entregador; o número em ordem (order_number) fica só no painel.
alter table orders add column if not exists public_code text not null default ((floor(random() * 90000) + 10000)::int)::text;
create index if not exists orders_public_code_idx on orders(store_id, public_code);

-- Número do pedido no dia (volta para 1 todo dia, no fuso de São Paulo). Vai na nota impressa.
alter table orders add column if not exists daily_number integer;

create or replace function set_order_daily_number()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_day date := (coalesce(new.created_at, now()) at time zone 'America/Sao_Paulo')::date;
begin
  -- Um pedido de cada vez por loja (dois pedidos juntos nunca pegam o mesmo número).
  perform pg_advisory_xact_lock(hashtext('daily_number:' || new.store_id::text));

  select coalesce(max(daily_number), 0) + 1 into new.daily_number
  from orders
  where store_id = new.store_id
    and (created_at at time zone 'America/Sao_Paulo')::date = v_day;

  return new;
end;
$$;

drop trigger if exists orders_daily_number on orders;
create trigger orders_daily_number before insert on orders
  for each row execute function set_order_daily_number();

-- Cliente em destaque (nome em dourado no painel e no cardápio).
alter table customers add column if not exists highlight boolean not null default false;

-- Avisos no celular do cliente (andamento do pedido) e promoções.
alter table push_subscriptions drop constraint if exists push_subscriptions_audience_check;
alter table push_subscriptions add constraint push_subscriptions_audience_check check (audience in ('owner','courier','customer'));
alter table push_subscriptions add column if not exists customer_id uuid references customers(id) on delete cascade;
alter table push_subscriptions add column if not exists order_id uuid references orders(id) on delete cascade;
create index if not exists push_subscriptions_customer_idx on push_subscriptions(customer_id);
alter table push_subscriptions add column if not exists promos boolean not null default false;
create index if not exists push_subscriptions_promos_idx on push_subscriptions(store_id, promos) where promos;

-- Quem abriu o caixa (funcionário vê só o próprio caixa e o histórico dele).
alter table cash_sessions add column if not exists opened_by_id uuid references staff(id) on delete set null;
alter table cash_sessions add column if not exists opened_by_name text;

-- Engradado gelado: valor a mais por engradado (null = sem opção). Produto com bulk_qty: por engradado completo;
-- produto que já é um engradado (sem bulk_qty): por unidade.
alter table products add column if not exists chill_fee_cents integer check (chill_fee_cents is null or chill_fee_cents >= 0);

-- Pedido mínimo por categoria na ENTREGA (ex.: cigarros). match = trecho do nome da categoria.
alter table stores add column if not exists category_min_orders jsonb not null default '[{"match": "cigarro", "label": "cigarros", "min_cents": 2000}]'::jsonb;

-- Promoção com horário: preço promocional vale entre promo_starts_at e promo_ends_at (vazio = sem limite naquele lado).
alter table products add column if not exists promo_price_cents integer check (promo_price_cents is null or promo_price_cents >= 0);
alter table products add column if not exists promo_starts_at timestamptz;
alter table products add column if not exists promo_ends_at timestamptz;

-- Promoção fixa por dia da semana (0=domingo..6=sábado). Vazio/null = vale todo dia, dentro do horário acima.
alter table products add column if not exists promo_weekdays smallint[];

-- Pedido com a loja fechada: fica aguardando a abertura (só se o dono ligar essa opção).
alter table stores add column if not exists accept_scheduled boolean not null default false;
alter table orders add column if not exists scheduled boolean not null default false;

-- Avaliação do pedido pelo cliente (uma por pedido, só depois de entregue).
create table if not exists order_reviews (
  order_id uuid primary key references orders(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  rating integer not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz not null default now()
);
create index if not exists order_reviews_store_idx on order_reviews(store_id, created_at desc);
alter table order_reviews enable row level security;

-- Buscas do cardápio que não acharam nada (aba Sugestões).
create table if not exists search_logs (
  id bigserial primary key,
  store_id uuid not null references stores(id) on delete cascade,
  term text not null,
  created_at timestamptz not null default now()
);
create index if not exists search_logs_store_idx on search_logs(store_id, created_at desc);
alter table search_logs enable row level security;

-- "Colocou no carrinho" por aparelho anônimo (carrinhos iniciados x pedidos; muito adicionado, pouco comprado).
create table if not exists cart_events (
  id bigserial primary key,
  store_id uuid not null references stores(id) on delete cascade,
  product_id uuid references products(id) on delete cascade,
  device text not null,
  created_at timestamptz not null default now()
);
create index if not exists cart_events_store_idx on cart_events(store_id, created_at desc);
alter table cart_events enable row level security;

-- Cupom de compensação (atraso grande / cancelamento por culpa da loja). Só nasce quando o
-- dono confirma no painel; é aplicado sozinho no próximo pedido do cliente.
create table if not exists coupons (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  reason text,
  source_order_id uuid references orders(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now(),
  used_order_id uuid references orders(id) on delete set null,
  used_at timestamptz
);
create unique index if not exists coupons_source_order_uniq on coupons(source_order_id) where source_order_id is not null;
create index if not exists coupons_customer_open_idx on coupons(customer_id) where used_order_id is null;
alter table coupons enable row level security;

-- Decisão do dono sobre a sugestão de cupom de um pedido: 'dismissed' ou 'created'.
alter table orders add column if not exists coupon_decision text;

-- Produto inativo (available = false) sempre tem motivo: 'estoque' ou 'preco' (erro/conferência de preço).
-- O cliente não vê produto inativo; conferência de preço também bloqueia a venda pelo painel.
alter table products add column if not exists inactive_reason text check (inactive_reason is null or inactive_reason in ('estoque','preco'));
alter table products add column if not exists inactive_since timestamptz;

-- Foto própria da variação (ex.: Red Bull Tradicional / Tropical). Vazio = usa a foto do produto.
alter table product_variants add column if not exists image_url text;

-- WhatsApp da loja (QR Code): fila de envio (uma mensagem por pedido + etapa) e sessão do Baileys.
create table if not exists wa_outbox (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  order_id uuid references orders(id) on delete set null,
  event text not null,
  phone text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','skipped')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  wa_message_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint wa_outbox_order_event_key unique (order_id, event)
);
create index if not exists wa_outbox_pending_idx on wa_outbox(status, next_attempt_at);
alter table wa_outbox enable row level security;

create table if not exists wa_auth (
  id text primary key,
  data text not null,
  updated_at timestamptz not null default now()
);
alter table wa_auth enable row level security;

-- 2026-09-24: Fechamento PDV com horário (período = data + hora, fuso de São Paulo).
alter table pdv_closings add column if not exists period_from_time text, add column if not exists period_to_time text;
-- finalize_pdv_closing passou a gravar period_from_time/period_to_time (HH:MM, fuso de São Paulo).
create or replace function finalize_pdv_closing(p_closing jsonb, p_order_ids uuid[])
returns pdv_closings
language plpgsql
set search_path = public
as $$
declare
  v_closing pdv_closings;
  v_store uuid := (p_closing->>'store_id')::uuid;
  v_ok integer;
begin
  if coalesce(array_length(p_order_ids, 1), 0) = 0 then
    raise exception 'PDV_EMPTY';
  end if;

  perform 1 from orders where id = any(p_order_ids) for update;

  select count(*) into v_ok
  from orders
  where id = any(p_order_ids)
    and store_id = v_store
    and status = 'delivered'
    and pdv_closing_id is null;

  if v_ok <> array_length(p_order_ids, 1) then
    raise exception 'PDV_STALE';
  end if;

  insert into pdv_closings (
    store_id, period_from, period_to, period_from_time, period_to_time, orders_count, products_cents, delivery_fees_cents,
    discounts_cents, total_cents, payments, received_cents, divergence_cents,
    finalized_by_id, finalized_by_name
  ) values (
    v_store,
    (p_closing->>'period_from')::date,
    (p_closing->>'period_to')::date,
    nullif(p_closing->>'period_from_time', ''),
    nullif(p_closing->>'period_to_time', ''),
    (p_closing->>'orders_count')::integer,
    (p_closing->>'products_cents')::integer,
    (p_closing->>'delivery_fees_cents')::integer,
    (p_closing->>'discounts_cents')::integer,
    (p_closing->>'total_cents')::integer,
    p_closing->'payments',
    (p_closing->>'received_cents')::integer,
    (p_closing->>'divergence_cents')::integer,
    nullif(p_closing->>'finalized_by_id', '')::uuid,
    p_closing->>'finalized_by_name'
  ) returning * into v_closing;

  update orders set pdv_closing_id = v_closing.id where id = any(p_order_ids);

  return v_closing;
end;
$$;
revoke execute on function finalize_pdv_closing(jsonb, uuid[]) from public, anon, authenticated;

-- 2026-09-24: aceite automático (pedido já nasce 'accepted', com accepted_at). Loja > Geral.
alter table stores add column if not exists auto_accept boolean not null default true;

-- 2026-09-26: composição do combo (o que sai do estoque quando o combo é vendido).
-- Ainda não há controle de estoque: a tabela só guarda a receita, para o estoque futuro baixar tudo junto.
-- variant_id = opção do combo a que a linha vale (vazio = todas as opções). Ex.: Combo Gin QN
-- (todas) → 1 Gin QN + 2 Gelo de Coco + 2 copões; (Baly Tropical) → 1 Energético Baly 2 L / Tropical.
create table if not exists product_components (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  variant_id uuid references product_variants(id) on delete cascade,
  component_product_id uuid not null references products(id) on delete cascade,
  component_variant_id uuid references product_variants(id) on delete cascade,
  qty integer not null default 1 check (qty between 1 and 99),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint product_components_not_self check (component_product_id <> product_id)
);
create index if not exists product_components_product_idx on product_components(product_id);
create index if not exists product_components_component_idx on product_components(component_product_id);
alter table product_components enable row level security;

-- ============================================================
-- 2026-09-26: FIADO (crediário). Livro do fiado que só recebe lançamentos novos.

-- 1) Forma de pagamento "fiado"
alter table orders drop constraint if exists orders_payment_method_check;
alter table orders add constraint orders_payment_method_check
  check (payment_method in ('dinheiro','cartao','debito','credito','pix','fiado'));

-- 2) Cliente com fiado liberado, limite e saldo (o saldo só muda pelo livro do fiado)
alter table customers add column if not exists credit_enabled boolean not null default false;
alter table customers add column if not exists credit_limit_cents integer not null default 0
  check (credit_limit_cents >= 0 and credit_limit_cents <= 100000000);
alter table customers add column if not exists credit_balance_cents integer not null default 0;

-- 3) Livro do fiado. amount_cents > 0 aumenta o que o cliente deve; < 0 diminui.
--    Saldo negativo = crédito a favor do cliente.
create table if not exists customer_credit_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete restrict,
  customer_id uuid not null references customers(id) on delete restrict,
  kind text not null check (kind in ('compra','estorno_compra','pagamento','ajuste','estorno')),
  amount_cents integer not null check (amount_cents <> 0),
  method text check (method is null or method in ('dinheiro','pix','debito','credito')),
  order_id uuid,            -- sem FK de propósito: o lançamento nunca some junto com o pedido
  order_number bigint,
  reverses_entry_id uuid references customer_credit_entries(id) on delete restrict,
  note text,
  created_by_id uuid,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  balance_after_cents integer not null default 0,
  request_id uuid           -- gerado no navegador: clique duplo não lança duas vezes
);
alter table customer_credit_entries add column if not exists request_id uuid;
create unique index if not exists cce_request_once on customer_credit_entries(request_id) where request_id is not null;
create index if not exists cce_customer_idx on customer_credit_entries(customer_id, created_at);
create index if not exists cce_order_idx on customer_credit_entries(order_id) where order_id is not null;
create index if not exists cce_store_idx on customer_credit_entries(store_id, created_at);
create unique index if not exists cce_reverses_once on customer_credit_entries(reverses_entry_id) where reverses_entry_id is not null;
alter table customer_credit_entries enable row level security;

-- Quem fez (nome e id do usuário do painel), enviado pelo Worker em base64 nos cabeçalhos.
create or replace function credit_actor_name() returns text language plpgsql stable as $$
declare h json; v text;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then h := null; end;
  v := h->>'x-garatucaia-actor';
  if v is null or v = '' then return 'Sistema'; end if;
  begin return convert_from(decode(v, 'base64'), 'UTF8'); exception when others then return 'Sistema'; end;
end $$;

create or replace function credit_actor_id() returns uuid language plpgsql stable as $$
declare h json; v text;
begin
  begin h := current_setting('request.headers', true)::json; exception when others then return null; end;
  v := h->>'x-garatucaia-actor-id';
  if v ~ '^[0-9a-fA-F-]{36}$' then return v::uuid; end if;
  return null;
end $$;

-- Validação de cada lançamento + saldo corrente (trava o cliente para não haver corrida).
create or replace function credit_entry_before_insert() returns trigger
language plpgsql set search_path = public as $$
declare c customers; r customer_credit_entries; new_balance integer;
begin
  select * into c from customers where id = new.customer_id for update;
  if not found then raise exception 'FIADO_CLIENTE: cliente não encontrado'; end if;
  if c.store_id <> new.store_id then raise exception 'FIADO_CLIENTE: cliente de outra loja'; end if;

  new.created_at := now();
  new.created_by_name := coalesce(nullif(trim(new.created_by_name), ''), credit_actor_name());
  new.created_by_id := coalesce(new.created_by_id, credit_actor_id());

  if new.kind in ('compra', 'estorno_compra') then
    if new.order_id is null then raise exception 'FIADO_DADOS: lançamento de compra sem pedido'; end if;
    if new.kind = 'compra' and new.amount_cents < 0 then raise exception 'FIADO_DADOS: compra negativa'; end if;
    if new.kind = 'estorno_compra' and new.amount_cents > 0 then raise exception 'FIADO_DADOS: estorno de compra positivo'; end if;
    new.method := null;
  elsif new.kind = 'pagamento' then
    if new.amount_cents > 0 then raise exception 'FIADO_DADOS: pagamento precisa diminuir a dívida'; end if;
    if new.method is null then raise exception 'FIADO_DADOS: informe a forma do pagamento'; end if;
  elsif new.kind = 'ajuste' then
    if length(coalesce(trim(new.note), '')) < 3 then raise exception 'FIADO_DADOS: ajuste precisa de motivo'; end if;
    new.method := null;
  elsif new.kind = 'estorno' then
    select * into r from customer_credit_entries where id = new.reverses_entry_id;
    if not found then raise exception 'FIADO_DADOS: lançamento a estornar não existe'; end if;
    if r.customer_id <> new.customer_id then raise exception 'FIADO_DADOS: estorno de outro cliente'; end if;
    if r.kind not in ('pagamento', 'ajuste') then raise exception 'FIADO_DADOS: compra do fiado se desfaz pelo pedido (estorno ou cancelamento)'; end if;
    if length(coalesce(trim(new.note), '')) < 3 then raise exception 'FIADO_DADOS: estorno precisa de motivo'; end if;
    new.amount_cents := -r.amount_cents;
    new.method := r.method;
  end if;

  new_balance := c.credit_balance_cents + new.amount_cents;

  -- Compra no fiado: só com fiado liberado e dentro do limite
  -- (ou usando crédito a favor, sem ficar devendo).
  if new.kind = 'compra' and new_balance > 0 then
    if not c.credit_enabled then
      raise exception 'FIADO_NAO_LIBERADO: % não tem fiado liberado', c.name;
    end if;
    if new_balance > c.credit_limit_cents then
      raise exception 'FIADO_LIMITE: limite de % estourado (deve %, limite %, esta compra %)',
        c.name, c.credit_balance_cents, c.credit_limit_cents, new.amount_cents;
    end if;
  end if;

  new.balance_after_cents := new_balance;

  perform set_config('garatucaia.credit_ledger', '1', true);
  update customers set credit_balance_cents = new_balance, updated_at = now() where id = c.id;
  perform set_config('garatucaia.credit_ledger', '0', true);

  return new;
end $$;

drop trigger if exists credit_entry_before_insert on customer_credit_entries;
create trigger credit_entry_before_insert before insert on customer_credit_entries
  for each row execute function credit_entry_before_insert();

-- Nada no livro do fiado pode ser alterado ou apagado (nem pelo sistema).
create or replace function credit_entry_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'FIADO_PROTEGIDO: o livro do fiado não permite alterar nem apagar lançamentos (use estorno)';
end $$;

drop trigger if exists credit_entry_no_update on customer_credit_entries;
create trigger credit_entry_no_update before update or delete on customer_credit_entries
  for each row execute function credit_entry_immutable();
drop trigger if exists credit_entry_no_truncate on customer_credit_entries;
create trigger credit_entry_no_truncate before truncate on customer_credit_entries
  for each statement execute function credit_entry_immutable();

-- O saldo do cliente só muda pelo livro do fiado.
create or replace function customers_guard_credit_balance() returns trigger language plpgsql as $$
begin
  if new.credit_balance_cents is distinct from old.credit_balance_cents
     and coalesce(current_setting('garatucaia.credit_ledger', true), '0') <> '1' then
    raise exception 'FIADO_PROTEGIDO: o saldo do fiado só muda por lançamento';
  end if;
  return new;
end $$;

drop trigger if exists customers_guard_credit_balance on customers;
create trigger customers_guard_credit_balance before update on customers
  for each row execute function customers_guard_credit_balance();

-- Quanto do pedido foi no fiado (inteiro ou a parte do pagamento dividido).
create or replace function order_fiado_cents(o orders) returns integer language sql immutable as $$
  select case
    when o.payment_status <> 'paid' or o.status = 'cancelled' then 0
    when jsonb_typeof(o.payment_split) = 'array' then
      coalesce((select sum((p->>'cents')::integer) from jsonb_array_elements(o.payment_split) p where p->>'method' = 'fiado'), 0)
    when o.payment_method = 'fiado' then o.total_cents
    else 0 end
$$;

-- Pedido e livro do fiado sempre batendo: pago no fiado => compra lançada; estorno,
-- cancelamento ou troca de forma => estorno da compra. Se estourar o limite, o pedido NÃO muda.
create or replace function orders_sync_credit() returns trigger
language plpgsql set search_path = public as $$
declare want integer; rec record; have integer;
begin
  if tg_op = 'DELETE' then
    for rec in select customer_id, sum(amount_cents)::integer net from customer_credit_entries
               where order_id = old.id and kind in ('compra','estorno_compra') group by customer_id loop
      if rec.net <> 0 then
        insert into customer_credit_entries (store_id, customer_id, kind, amount_cents, order_id, order_number, note)
        values (old.store_id, rec.customer_id, 'estorno_compra', -rec.net, old.id, old.order_number, 'Pedido apagado');
      end if;
    end loop;
    return old;
  end if;

  want := order_fiado_cents(new);

  -- Lançado para outro cliente (cadastro trocado): devolve lá.
  for rec in select customer_id, sum(amount_cents)::integer net from customer_credit_entries
             where order_id = new.id and kind in ('compra','estorno_compra')
               and customer_id is distinct from new.customer_id group by customer_id loop
    if rec.net <> 0 then
      insert into customer_credit_entries (store_id, customer_id, kind, amount_cents, order_id, order_number, note)
      values (new.store_id, rec.customer_id, 'estorno_compra', -rec.net, new.id, new.order_number, 'Pedido passou para outro cliente');
    end if;
  end loop;

  select coalesce(sum(amount_cents), 0)::integer into have from customer_credit_entries
   where order_id = new.id and kind in ('compra','estorno_compra') and customer_id = new.customer_id;

  if want = have then return new; end if;

  if new.customer_id is null then
    if want > 0 then raise exception 'FIADO_SEM_CLIENTE: fiado precisa de cliente com WhatsApp cadastrado'; end if;
    return new;
  end if;

  insert into customer_credit_entries (store_id, customer_id, kind, amount_cents, order_id, order_number, note)
  values (new.store_id, new.customer_id,
          case when want > have then 'compra' else 'estorno_compra' end,
          want - have, new.id, new.order_number,
          case when want > have then null
               when new.status = 'cancelled' then 'Pedido cancelado'
               when new.payment_status <> 'paid' then 'Pagamento desmarcado'
               else 'Forma de pagamento alterada' end);
  return new;
end $$;

drop trigger if exists orders_sync_credit on orders;
create trigger orders_sync_credit after insert or update of payment_status, payment_method, payment_split, total_cents, status, customer_id on orders
  for each row execute function orders_sync_credit();
drop trigger if exists orders_sync_credit_delete on orders;
create trigger orders_sync_credit_delete before delete on orders
  for each row execute function orders_sync_credit();

revoke all on customer_credit_entries from anon, authenticated;
revoke execute on function order_fiado_cents(orders) from public, anon, authenticated;

-- Caminho fixo nas funções (recomendação do Supabase) e backups antigos protegidos.
alter function credit_actor_name() set search_path = public;
alter function credit_actor_id() set search_path = public;
alter function credit_entry_immutable() set search_path = public;
alter function customers_guard_credit_balance() set search_path = public;
alter function order_fiado_cents(orders) set search_path = public;
do $$ begin
  if to_regclass('public.backup_produtos_duplicados_20260924') is not null then
    execute 'alter table backup_produtos_duplicados_20260924 enable row level security';
    execute 'revoke all on backup_produtos_duplicados_20260924 from anon, authenticated';
  end if;
  if to_regclass('public.backup_pedidos_teste_20260924b') is not null then
    execute 'alter table backup_pedidos_teste_20260924b enable row level security';
    execute 'revoke all on backup_pedidos_teste_20260924b from anon, authenticated';
  end if;
end $$;

-- 2026-09-28: produto vendido por kg. O cliente vê o preço estimado (opções de peso) e a equipe
-- lança o valor da balança por item (antes de pagar). estimated_cents guarda o estimado original.
alter table products add column if not exists sold_by_weight boolean not null default false;
alter table order_items add column if not exists by_weight boolean not null default false;
alter table order_items add column if not exists estimated_cents integer;
alter table order_items add column if not exists weighed_by text;
alter table order_items add column if not exists weighed_at timestamptz;
-- Preço do quilo (cardápio mostra "R$ X /kg" nos produtos vendidos por kg).
alter table products add column if not exists kg_price_cents integer check (kg_price_cents is null or kg_price_cents > 0);

-- Multi-loja (2026-09-28, passo 1): cada loja é achada pelo endereço do site.
alter table public.stores add column if not exists slug text;
alter table public.stores add column if not exists domains text[] not null default '{}';
create unique index if not exists stores_slug_key on public.stores (slug) where slug is not null;
create index if not exists stores_domains_idx on public.stores using gin (domains);

-- Multi-loja (passo 3a): dados do rodapé do cardápio no cadastro da loja.
alter table public.stores add column if not exists profile jsonb not null default '{}'::jsonb;

-- Multi-loja (passo 3b): apelidos de bairro / bairros "grandes" / caminhos de entrega por loja.
-- {"broad": [...], "aliases": {"nome": [...]}, "routes": [{"name": "...", "stops": [[...], ...]}]}. Vazio = sem regras.
alter table public.stores add column if not exists delivery_rules jsonb not null default '{}'::jsonb;

-- 2026-09-30: complemento de verdade ("Turbine seu lanche"), no lugar de decidir pelo nome
-- conter "adicional". Migra quem já usava essa convenção, sem perder nenhum já cadastrado.
alter table products add column if not exists is_addon boolean not null default false;
update products set is_addon = true where is_addon = false and name ilike '%adicional%';

-- 2026-10-01: "Retirar o cheddar". Produto que vem com cheddar por cima (batata dos combos,
-- Batata Maluca): o cliente pode pedir sem, e o item sai no pedido como "(SEM CHEDDAR)".
alter table products add column if not exists removable_cheddar boolean not null default false;

-- Resposta automática do WhatsApp (2026-10-08): registra cada resposta enviada sozinha ao cliente
-- (no máximo uma a cada X horas por cliente; X = stores.whatsapp_settings.auto_reply.interval_hours).
create table if not exists public.wa_auto_replies (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  phone text not null,
  replied_on date not null, -- só informativo (dia em São Paulo)
  status text not null default 'sending' check (status in ('sending','sent','failed','skipped')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists wa_auto_replies_phone_idx on public.wa_auto_replies (store_id, phone, created_at desc);
alter table public.wa_auto_replies enable row level security;

-- 2026-10-08: pedido na mesa (cliente na lanchonete). Só o painel lança; o número da mesa é obrigatório.
-- delivery_type passa a aceitar 'dinein' e o número da mesa fica em table_label.
alter table orders add column if not exists table_label text;
alter table orders drop constraint if exists orders_delivery_type_check;
alter table orders add constraint orders_delivery_type_check check (delivery_type in ('delivery','pickup','dinein'));
