-- Taxas de entrega por bairro da Ponto X.
-- Rodar no SQL Editor do Supabase da Ponto X (projeto qknjjsdblasejgpbowjs).
-- Pode rodar mais de uma vez: bairro que já existe (mesmo nome) é ignorado, não duplica.
-- Para mudar o valor de um bairro que já existe, edite pelo painel (Loja > Bairros) ou use UPDATE.

with loja as (
  select id from stores where slug = 'pontox'
),
novos(name, fee_cents, sort_order) as (
  values
    ('Monsuaba',           800,  1),
    ('Caputera',           800,  2),
    ('Água Santa',         800,  3),
    ('Morro do Moreno',    300,  4),
    ('Village',            500,  5),
    ('Lambicada',          500,  6),
    ('Camorim Grande',     800,  7),
    ('Camorim Pequeno',   1200,  8),
    ('Praia do Machado',   500,  9),
    ('Verolme',            500, 10),
    ('BNH',                500, 11)
)
insert into delivery_zones (store_id, name, fee_cents, active, sort_order)
select loja.id, n.name, n.fee_cents, true, n.sort_order
from loja, novos n
where not exists (
  select 1 from delivery_zones z
  where z.store_id = loja.id and lower(z.name) = lower(n.name)
);

-- Conferir:
-- select name, fee_cents / 100.0 as taxa, active from delivery_zones
-- where store_id = (select id from stores where slug = 'pontox') order by sort_order;
