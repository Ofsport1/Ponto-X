# Ponto X — Delivery

## Contexto e regras permanentes

Este é o site de pedidos online da Ponto X (hamburgueria), projeto próprio e
independente: Worker, Supabase e repositório GitHub separados de qualquer
outro projeto da Ultrion. Em 2026-09-29 este projeto foi criado a partir de
uma cópia do `mercearia-garatucaia-delivery` (onde a Ponto X era uma segunda
loja dentro do mesmo Worker/banco), removendo o que era específico da
Garatucaia. O `worker.js` ainda carrega a máquina multi-loja original (veja
"Multi-loja / herança" abaixo) — isso é dívida técnica conhecida, não um
requisito deste projeto.

- Responder sempre em português.
- Preservar a arquitetura e o que já funciona; não reescrever do zero sem necessidade.
- Antes de alterar, informar exatamente quais arquivos serão modificados.
- Nunca colocar `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD`, `ULTRION_PASSWORD`, `WHATSAPP_TOKEN`, `WA_SERVICE_TOKEN`, `VAPID_PRIVATE_KEY_JWK` ou qualquer outro segredo no frontend, no repositório ou no GitHub.
- Toda mudança publicada deve ser commitada e enviada ao GitHub. Antes de publicar, conferir `git status` e não publicar se houver alterações locais não previstas.
- Nunca reaproveitar segredos do projeto `mercearia-garatucaia-delivery` (Garatucaia): todos os segredos daqui são próprios e novos.

## Arquitetura e arquivos principais

- Frontend sem framework: `index.html` + `app.js` + `styles.css` (cardápio, carrinho, checkout e acompanhamento em `/?pedido=<uuid>`); `admin.html` + `admin.js` (painel, PDV e gestão); `sw.js`, manifests e assets públicos.
- Backend: `worker.js`, Cloudflare Worker com Static Assets; somente `/api/*` passa pelo Worker.
- Banco: Supabase próprio da Ponto X; schema em `supabase/schema.sql`. Preencher aqui a URL do projeto assim que for criado (Etapa 2 da migração).
- RLS deve permanecer ligado em todas as tabelas, sem políticas públicas: acesso ao banco somente pelo Worker com chave secreta.
- Bucket público de fotos: `product-photos`. Fotos locais públicas ficam em `assets/produtos/`.
- Tabelas com dados de loja devem ter `store_id`; tabela nova com esse campo precisa entrar em `STORE_SCOPED_TABLES` no Worker. Filhos sem `store_id` só podem ser acessados depois de validar o pai.
- Listas Supabase podem exceder 1000 linhas: usar `fetchAllRows()` no Worker.
- Preços e totais são sempre recalculados no servidor a partir do banco; nunca confiar no carrinho do navegador.

## Modelo do cardápio e pedidos

- Ordem: `products.sort_order`; categorias não são ordenadas alfabeticamente. Variações ficam em `product_variants` e, quando existem, o cliente deve escolher uma.
- Destaques: `products.featured`/`featured_order`, na seção "⭐ Mais Vendidos", sem remover o produto da categoria.
- Status: `received` → `accepted` → `preparing` → `out_for_delivery` → `delivered`, ou `cancelled`. `accepted_at`, prazo e notificações devem acompanhar a etapa. `stores.auto_accept` pode fazer novos pedidos nascerem aceitos; se desligado, aparece "Aceitar pedido".
- O cliente e o entregador veem somente `orders.public_code` (código aleatório de 5 dígitos). `order_number` e `daily_number` são internos do painel/caixa; não mostrar ao cliente, no push, na notinha nem no cartão público.
- `daily_number` reinicia diariamente no fuso de São Paulo pelo trigger/advisory lock, mas não é informação pública.
- Prazo usa `stores.delivery_minutes`/`pickup_minutes`, contado de `created_at`; horário usa `stores.hours`, `auto_hours`, fuso de São Paulo e suporta fechamento após meia-noite. Loja fechada só aceita pedido agendado quando `accept_scheduled` estiver ativo.
- Entrega usa `delivery_zones`, taxa por bairro, `streets`/quadras quando cadastradas e `orders.delivery_zone`/`delivery_street`. Checkout exige bairro quando há zonas ativas. Regras de bairro e rotas ficam em `stores.delivery_rules`.
- Pedido do painel (`POST /api/admin/orders`) reutiliza `createOrder` com `fromAdmin`, pode ser balcão/WhatsApp/telefone, mas as validações de preço e integridade continuam no servidor.
- Carrinho usa localStorage; conta do cliente usa as mesmas chaves herdadas do projeto original (`garatucaia-customer`/`garatucaia-orders`/`garatucaia-chill` no código — nomes internos, não aparecem para o cliente; renomear é limpeza futura, não bloqueante). Reconhecimento por WhatsApp retorna somente primeiro nome e endereço mascarado; nunca buscar cliente por nome.
- Voz apenas monta o carrinho e sempre exige conferência; nunca finaliza automaticamente. No iOS, grava/transcreve com Workers AI; nos demais, usa reconhecimento do navegador.
- `linePrice()` deve permanecer equivalente em Worker, app e painel: promoções e preço por quantidade (`bulk_qty`/`bulk_price_cents`) só valem quando o preço promocional é menor. Produtos por peso usam `sold_by_weight`/`kg_price_cents`; o valor estimado pode ser corrigido pela equipe antes do pagamento.
- Engradado gelado: `chill_fee_cents`, item `chilled`; a taxa é calculada no servidor e o nome do item indica "GELADO".
- Combos usam `product_components` como receita; ainda não há baixa de estoque automática. Produto com opções exige opção do combo.

## Pagamento, fiado e caixa

- Formas: `pix`, `dinheiro`, `debito`, `credito` (compatibilidade com `cartao`) e `fiado`. Pagamento ocorre na entrega/retirada; não há gateway.
- Divisão: `orders.payment_split` é uma lista de até duas partes `{method,cents}` cuja soma deve ser o total; `payment_method` é a primeira. Troco é calculado sobre a parte em dinheiro.
- Desconto (`discount_cents`) só pode ser concedido pelo painel; desconto zera a divisão anterior. Cancelamento exige motivo (`CANCEL_REASONS`, `cancel_reason`, `cancelled_by`). Entregar marca como pago automaticamente.
- PDV usa `cash_sessions`/`cash_movements`; cada caixa vê e altera apenas o que abriu. Fechamento usa `pdv_closings`, pedidos entregues ainda não fechados, prévia e RPC transacional com lock; pedido fechado não pode mais ser alterado.
- Fiado é somente da equipe, nunca do site nem do entregador. `customers.credit_enabled`, `credit_limit_cents` e `credit_balance_cents` são administrados somente por admin. `customer_credit_entries` é livro append-only: não permitir UPDATE, DELETE ou TRUNCATE; saldo só muda por lançamento. Gatilho `orders_sync_credit` deve manter pedido e fiado consistentes; limite ou permissão inválidos fazem a operação inteira falhar. `request_id` impede lançamento duplicado.
- Venda no fiado não entra na gaveta; recebimento de dívida entra no período do caixa. Notinha de fiado tem linha de assinatura.
- Cupom térmico: Arial negrito, preto puro, tamanho padrão 14; impressão 58/80 mm por iframe/`window.print`. Impressão silenciosa requer Chrome com `--kiosk-printing` e estação configurada (ver `painel-impressora.cmd`).

## Usuários, privacidade e autorização

- Papéis: `admin`, `caixa` e `entregador`. PIN de staff tem 4–6 dígitos, hash PBKDF2 e bloqueio após 5 erros por 5 minutos. Sessão guarda `uid`, nome, papel e loja.
- Admin vê tudo. Caixa não vê faturamento, totais financeiros, custo/ticket de clientes, usuários, auditoria, configurações da loja, VIP/aniversário, promoções ou caixa de outra pessoa; pode alterar somente o permitido (por exemplo, disponibilidade e observação). Entregador vê apenas "Minhas entregas"; qualquer outra rota admin deve responder 403. Essas restrições precisam existir no Worker, não somente na interface.
- Despacho de entrega exige conferência dos itens, endereço/rua e entregador quando disponível; grava `courier_*` e `dispatched_by`. Entregador confirma conferência antes de entregar; divergência notifica o dono.
- Push separa `audience=owner` e `audience=courier`; notificações de entregador nunca expõem nome ou valor do cliente. Push do cliente só é ligado ao próprio pedido/customer e respeita o fluxo de consentimento.
- Auditoria via `audit()`/`audit_log` é obrigatória para preço/produto, loja/bairros, usuários, pagamento, desconto, estorno, cancelamento, despacho/conferência/entrega, fiado e caixa. Auditoria é somente para admin.
- Dados de endereço, hábitos e cadastro do cliente devem ser minimizados e mascarados onde apropriado. Dispositivo da equipe nunca deve virar cliente.

## Clientes e recursos de comunicação

- `customers` é identificado por WhatsApp normalizado; perfil pode guardar endereços, aniversário, destaque (`highlight`) e métricas. "Fiel" é nível automático; `is_vip` é marcação manual do dono, com benefício aplicado no servidor (`fee_waived='vip'`).
- Aniversário (`MM-DD`) só vale conforme `birthday_settings`, carência, janela e limite de uma concessão a cada 300 dias; não acumula com desconto manual.
- Carrinho abandonado, repetir pedido, sugestões e marketing só enviam mensagem quando houver autorização. Promoção pelo painel é somente admin e auditada.
- Web Push usa chave pública em `vars` e privada em secret/local `.vapid.json` — **par próprio da Ponto X**, gerado na Etapa 3 da migração (nunca reaproveitar o da Garatucaia). O painel pode cadastrar o dispositivo e o cron agrupa alertas de pedidos atrasados/aguardando aceite. Atualização de versão usa `CF_VERSION_METADATA`; menu confere a cada 3 minutos e painel a cada 20 segundos, sem interromper formulário.
- **WhatsApp automático (QR/Baileys) ainda não está configurado nesta loja.** Por enquanto o WhatsApp é só o link manual `wa.me` (sem `WA_SERVICE_URL`/`WA_SERVICE_TOKEN` no `wrangler.jsonc`); o código que suporta o modo automático (`wa_outbox`, `wa_auth`, rotas `/api/admin/wa-qr`, etc.) continua no Worker e no schema por herança, mas fica inerte até um número/servidor próprios serem configurados (ver `whatsapp-service/` no projeto `mercearia-garatucaia-delivery` como referência de como montar isso quando chegar a hora). Nunca colocar tokens no código.

## Multi-loja / herança

Este `worker.js` foi copiado do projeto `mercearia-garatucaia-delivery`, que
atende várias lojas num Worker só. Aqui só existe (e só deve existir) **uma
linha em `stores`**, com slug `pontox`. A máquina multi-loja
(`envForHost`, `currentStoreId`, `getStore`, `STORE_SCOPED_TABLES`,
`scopeToStore`, `STORE_BRANDS`) continua no código e funciona normalmente
com uma loja só — não precisa ser removida para o site funcionar, mas também
não deve ser usada para hospedar uma segunda loja aqui: se a Ultrion precisar
de outro cliente, o padrão é um projeto novo (como este), não uma segunda
linha em `stores` deste banco. Simplificar esse código para single-tenant de
verdade é limpeza futura, não bloqueante.

- `ADMIN_PASSWORD` é o login administrador desta loja (única).
- `ULTRION_PASSWORD` é secret opcional de suporte, sempre auditado.
- Nome, logo, cores, perfil/rodapé, regras de entrega, fotos, título, manifests e URLs ficam em `STORE_BRANDS`/`stores.profile`, hoje só com a entrada da Ponto X.

## Segredos, configuração e deploy

- Segredos Cloudflare: `SUPABASE_SECRET_KEY`, `SESSION_SECRET`, `ADMIN_PASSWORD`, opcional `ULTRION_PASSWORD`. `WHATSAPP_TOKEN`/`WA_SERVICE_TOKEN`/`VAPID_PRIVATE_KEY_JWK` só quando/se o WhatsApp automático ou o Web Push forem configurados. `SUPABASE_URL` é variável em `wrangler.jsonc`; valores secretos só via `wrangler secret`/bulk.
- `git push` não publica. Publicar = `npx wrangler deploy` nesta pasta; `publicar.cmd` valida árvore limpa, faz `git pull --ff-only` e usa `npx.cmd wrangler deploy`.
- Antes de qualquer deploy: revisar diff, executar testes/lint relevantes, verificar `git status`, confirmar que nenhum segredo ou alteração fora do escopo entrou, fazer commit com a atribuição exigida e só então publicar.
- Não desativar RLS, não expor chave secreta, não confiar em autorização feita apenas pelo frontend e não apagar produtos históricos quando o requisito for apenas deixá-los inativos.

## Referências de manutenção

- Schema e migrations: `supabase/`.
- Configuração de deploy/domínio/crons: `wrangler.jsonc`.
- Este projeto nasceu de uma migração a partir de `mercearia-garatucaia-delivery` (2026-09-29); consultar aquele repositório só como referência histórica — nunca compartilhar segredos, banco ou deploy entre os dois.
