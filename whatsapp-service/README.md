# Serviço WhatsApp da Ponto X

Serviço interno: Worker (Cloudflare) → Cloudflare Tunnel → este serviço Node → WhatsApp Web (Baileys).
Instalação no PC da loja: veja `../docs/whatsapp-pc-loja.md`.

## Variáveis (arquivo `.env`, nunca no Git)

Veja `.env.example`. `WA_SERVICE_TOKEN` e `WA_SERVICE_TENANT_SECRET` precisam ter no mínimo 32 caracteres, ser diferentes entre si e ser iguais aos secrets de mesmo nome na Cloudflare.

## Como as chamadas são autenticadas

Toda rota, exceto `/health`, exige:

- `Authorization: Bearer <WA_SERVICE_TOKEN>`
- `X-WA-Store-Id: <UUID da loja>`
- `X-WA-Timestamp: <Unix timestamp em segundos>`
- `X-WA-Store-Signature: base64url(HMAC-SHA256("<store_id>.<timestamp>", WA_SERVICE_TENANT_SECRET))`

A assinatura expira em 60 segundos. O serviço escuta só em `127.0.0.1`; quem o expõe é o Cloudflare Tunnel.

## Comportamento

- A sessão do WhatsApp fica no Supabase (`wa_auth`): ao religar o PC o serviço reconecta sozinho, sem QR novo.
- O QR é pedido pelo painel (Loja > WhatsApp), nunca existe QR global.
- A fila (`wa_outbox`) é at-least-once: após uma queda entre envio e confirmação, uma mensagem pode se repetir.
- Resposta automática opcional em Loja > WhatsApp (`stores.whatsapp_settings.auto_reply`).
- Código copiado de `mercearia-garatucaia-delivery/whatsapp-service` (referência histórica); segredos, número e túnel são só da Ponto X.
