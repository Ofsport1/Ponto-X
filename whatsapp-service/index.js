// Serviço do WhatsApp da loja (conectado por QR Code), rodando no servidor da Oracle.
//
// Painel (Worker da Cloudflare) → este serviço → WhatsApp Web.
// - O Worker grava cada aviso na fila wa_outbox (uma linha por pedido + etapa, nunca repete).
// - Este serviço lê a fila, envia pelo WhatsApp da loja, tenta de novo quando falha e anota o erro.
// - A sessão do WhatsApp fica no Supabase (wa_auth): reiniciou, volta conectado sozinho.
// - Toda chamada precisa do token próprio (WA_SERVICE_TOKEN); sem ele, nada responde.
// - Resposta automática (opcional, por loja): quando um cliente manda mensagem e a loja ainda não respondeu
//   sozinha para ele nas últimas X horas (padrão 5), responde com o texto configurado em Loja > WhatsApp
//   (stores.whatsapp_settings.auto_reply), depois de alguns segundos. Fora isso o serviço não lê nem guarda conversas.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHmac, timingSafeEqual } from 'node:crypto';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { db } from './supabase.js';
import { clearSupabaseAuthState, hasSupabaseAuthState, useSupabaseAuthState } from './supabase-auth.js';

const {
  WA_SERVICE_TOKEN,
  WA_SERVICE_TENANT_SECRET,
  PORT = '3000',
  HOST = '127.0.0.1',
} = process.env;
const TEST_MODE = process.env.WA_SERVICE_TEST === '1';

if (!TEST_MODE && (!WA_SERVICE_TOKEN || WA_SERVICE_TOKEN.length < 32 || !WA_SERVICE_TENANT_SECRET || WA_SERVICE_TENANT_SECRET.length < 32)) {
  console.error('Faltam WA_SERVICE_TOKEN e WA_SERVICE_TENANT_SECRET (mínimo 32 caracteres) no arquivo .env');
  process.exit(1);
}

const logger = pino({ level: 'warn' });

// Pausa entre mensagens (evita cara de robô para o WhatsApp) e tentativas quando falha.
const SEND_GAP_MS = [2500, 5000];
const RETRY_MINUTES = [1, 3, 10, 30, 60];
const MAX_ATTEMPTS = RETRY_MINUTES.length;
// Aviso que ficou preso mais que isso (ex.: WhatsApp desconectado a noite toda) não é mais enviado.
const STALE_HOURS = 6;
// O QR fica disponível por 5 minutos depois de pedir "Conectar".
const QR_WINDOW_MS = 5 * 60 * 1000;

const sessions = new Map();

function sessionFor(storeId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(storeId || ''))) throw new Error('store_id inválido.');
  if (!sessions.has(storeId)) sessions.set(storeId, {
    storeId,
    sock: null,
    state: 'close', // close | connecting | qr | open | logged_out
    qr: null,
    me: null,
    lastError: null,
    qrRequestedAt: 0,
    stopping: false,
    retry: 0,
    processing: false,
    kickAgain: false,
    generation: 0,
    pendingReplies: new Map(), // chat → { cancelled } (resposta automática esperando os segundos)
    lastOut: new Map(), // chat → hora da última mensagem enviada por nós/pelo celular da loja
    replyHour: { hour: '', count: 0 },
  });
  return sessions.get(storeId);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ---------------- Conexão com o WhatsApp ---------------- */

// Já tem um WhatsApp pareado (leu o QR alguma vez e não saiu)?
async function hasSession(storeId) {
  return hasSupabaseAuthState(storeId);
}

async function connect(storeId) {
  const wa = sessionFor(storeId);
  if (wa.sock) return;

  const generation = ++wa.generation;
  wa.stopping = false;
  wa.state = 'connecting';

  const { state, saveCreds } = await useSupabaseAuthState(storeId);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: Browsers.ubuntu('Delivery WhatsApp'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  wa.sock = sock;

  sock.ev.on('creds.update', () => saveCreds().catch(err => console.error('saveCreds', err.message)));

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (generation !== wa.generation || wa.sock !== sock || type !== 'notify') return;
    for (const message of messages || []) {
      handleInbound(storeId, message).catch(err => console.error('handleInbound', storeId, err.message));
    }
  });

  sock.ev.on('connection.update', async update => {
    if (generation !== wa.generation || wa.sock !== sock) return;
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // QR só enquanto a loja estiver tentando conectar (evita ficar gerando QR para sempre).
      if (Date.now() - wa.qrRequestedAt > QR_WINDOW_MS) {
        wa.lastError = 'O QR Code expirou. Clique em "Conectar WhatsApp" de novo.';
        await stopSocket(storeId);
        wa.state = 'close';
        return;
      }

      wa.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      wa.state = 'qr';
    }

    if (connection === 'open') {
      wa.state = 'open';
      wa.qr = null;
      wa.lastError = null;
      wa.retry = 0;
      wa.me = { id: sock.user?.id || null, name: sock.user?.name || sock.user?.verifiedName || null };
      console.log(`WhatsApp conectado (${storeId}):`, wa.me.id);
      processOutbox(storeId).catch(err => console.error('processOutbox', storeId, err.message));
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      wa.sock = null;
      wa.qr = null;

      if (wa.stopping) return;

      if (code === DisconnectReason.loggedOut) {
        // Saiu pelo celular ("Dispositivos conectados → Sair"): apaga a sessão.
        wa.state = 'logged_out';
        wa.me = null;
        wa.lastError = 'O WhatsApp foi desconectado pelo celular. Conecte de novo pelo QR Code.';
        await clearSupabaseAuthState(storeId).catch(err => console.error('clearSession', err.message));
        return;
      }

      // Caiu (internet, reinício do WhatsApp, logo depois de ler o QR...): volta sozinho.
      wa.state = 'connecting';
      wa.lastError = lastDisconnect?.error?.message || null;
      const wait = code === DisconnectReason.restartRequired ? 500 : Math.min(60000, 2000 * 2 ** wa.retry++);
      setTimeout(() => connect(storeId).catch(err => console.error('reconnect', err.message)), wait);
    }
  });
}

async function stopSocket(storeId) {
  const wa = sessionFor(storeId);
  const sock = wa.sock;
  wa.stopping = true;
  wa.generation += 1;
  wa.sock = null;
  wa.qr = null;

  if (sock) {
    try { sock.end(undefined); } catch {}
  }
}

async function logout(storeId) {
  const wa = sessionFor(storeId);
  const sock = wa.sock;
  wa.stopping = true;
  wa.generation += 1;

  if (sock && wa.state === 'open') {
    try { await sock.logout(); } catch {}
  }

  await stopSocket(storeId);
  await clearSupabaseAuthState(storeId);
  wa.state = 'logged_out';
  wa.me = null;
  wa.lastError = null;
}

/* ---------------- Número do cliente → conta do WhatsApp ---------------- */

// Celular brasileiro: tenta com e sem o 9 extra (algumas contas antigas foram criadas sem ele).
async function resolveJid(storeId, phone) {
  const wa = sessionFor(storeId);
  let digits = String(phone || '').replace(/\D/g, '');

  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.length < 12) return null;

  const tries = [digits];
  const local = digits.slice(4);

  if (digits.startsWith('55') && local.length === 9 && local.startsWith('9')) tries.push(digits.slice(0, 4) + local.slice(1));
  if (digits.startsWith('55') && local.length === 8) tries.push(`${digits.slice(0, 4)}9${local}`);

  for (const number of tries) {
    const [result] = await wa.sock.onWhatsApp(number);
    if (result?.exists) return result.jid;
  }

  return null;
}

async function sendText(storeId, phone, text) {
  const wa = sessionFor(storeId);
  const jid = await resolveJid(storeId, phone);

  if (!jid) {
    const err = new Error('Este número não tem WhatsApp.');
    err.noWhatsapp = true;
    throw err;
  }

  const sent = await wa.sock.sendMessage(jid, { text });
  return sent?.key?.id || null;
}

/* ---------------- Resposta automática (primeira mensagem do dia) ---------------- */

// Tempos (em ms). Os testes diminuem a escala para não esperar de verdade.
const autoReplyTiming = { scale: 1, typingMs: [1200, 2500] };
const REPLY_MAX_AGE_MS = 120 * 1000; // mensagem velha (chegou enquanto estava desconectado) não recebe resposta
const REPLY_RECENT_OUT_MS = 10 * 60 * 1000; // já falamos com o cliente há pouco: não responde
const REPLY_MAX_PER_HOUR = 100; // trava de segurança por loja
const IGNORED_CONTENT = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'messageContextInfo', 'pollUpdateMessage', 'keepInChatMessage', 'encReactionMessage']);
const configCache = new Map();

export function setAutoReplyTiming(options = {}) {
  Object.assign(autoReplyTiming, options);
}

// Os testes mudam a configuração de uma loja entre um caso e outro.
export function clearAutoReplyCache() {
  configCache.clear();
}

// Dia no fuso de São Paulo (AAAA-MM-DD): só informativo na tabela (a regra é "a cada X horas").
export function dayInSaoPaulo(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(date);
}

async function autoReplyConfig(storeId) {
  const cached = configCache.get(storeId);
  if (cached && Date.now() - cached.at < 30000) return cached.value;

  const [row] = await db(`stores?select=name,domains,whatsapp_settings&id=eq.${encodeURIComponent(storeId)}`);
  const settings = row?.whatsapp_settings || {};
  const reply = settings.auto_reply || {};
  const domain = (row?.domains || []).find(d => !/^www\./.test(d)) || (row?.domains || [])[0] || '';
  const text = String(reply.text || '').trim();

  const value = settings.mode === 'qr' && reply.enabled === true && text
    ? {
      text,
      delay: Math.min(60, Math.max(2, Math.round(Number(reply.delay_seconds) || 5))),
      intervalHours: Math.min(72, Math.max(1, Number(reply.interval_hours) || 5)),
      name: row.name || '',
      link: domain ? `https://${domain}` : (process.env.SITE_URL || ''),
    }
    : null;

  configCache.set(storeId, { at: Date.now(), value });
  return value;
}

// {loja} = nome da loja, {link} = endereço do delivery.
export function fillAutoReply(text, { name = '', link = '' } = {}) {
  return text.replaceAll('{loja}', name).replaceAll('{link}', link).replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
}

// Identifica o cliente: número (jid normal) ou, quando o WhatsApp só entrega o identificador novo (@lid), o próprio @lid.
function inboundContact(key) {
  const asPhone = jid => (/^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid || '') || [])[1] || null;
  const phone = asPhone(key.remoteJid) || asPhone(key.remoteJidAlt);
  if (phone) return { chat: key.remoteJid, id: phone };

  const lid = /^(\d{5,20})(?::\d+)?@lid$/.exec(key.remoteJid || '');
  return lid ? { chat: key.remoteJid, id: `lid:${lid[1]}` } : null;
}

export async function handleInbound(storeId, message) {
  const wa = sessionFor(storeId);
  const key = message?.key;
  if (!key?.remoteJid || !message.message) return;

  const contact = inboundContact(key);
  if (!contact) return; // grupos, status, listas de transmissão, canais…

  // Mensagem nossa (do serviço ou do celular da loja): lembra que já falamos e cancela a resposta que estava esperando.
  if (key.fromMe) {
    wa.lastOut.set(contact.chat, Date.now());
    if (wa.lastOut.size > 500) for (const [chat, at] of wa.lastOut) if (Date.now() - at > REPLY_RECENT_OUT_MS) wa.lastOut.delete(chat);
    const pending = wa.pendingReplies.get(contact.chat);
    if (pending) pending.cancelled = true;
    return;
  }

  const stamp = Number(message.messageTimestamp?.low ?? message.messageTimestamp) || 0;
  if (stamp && Date.now() - stamp * 1000 > REPLY_MAX_AGE_MS) return;

  const kinds = Object.keys(message.message).filter(kind => !IGNORED_CONTENT.has(kind));
  if (!kinds.length) return;

  if (wa.me?.id && contact.id === String(wa.me.id).split(/[:@]/)[0]) return; // conversa com o próprio número da loja

  const config = await autoReplyConfig(storeId);
  if (!config) return;

  if (Date.now() - (wa.lastOut.get(contact.chat) || 0) < REPLY_RECENT_OUT_MS) return;
  if (wa.pendingReplies.has(contact.chat)) return;

  const hour = new Date().toISOString().slice(0, 13);
  if (wa.replyHour.hour !== hour) wa.replyHour = { hour, count: 0 };
  if (wa.replyHour.count >= REPLY_MAX_PER_HOUR) return;

  // Reserva o chat já (antes de qualquer espera): várias mensagens seguidas geram uma resposta só.
  const pending = { cancelled: false };
  wa.pendingReplies.set(contact.chat, pending);

  let row;

  try {
    // Já respondemos sozinhos para este cliente nas últimas X horas? Então não repete.
    const since = new Date(Date.now() - config.intervalHours * 3600000).toISOString();
    const recent = await db(`wa_auto_replies?select=id&store_id=eq.${encodeURIComponent(storeId)}&phone=eq.${encodeURIComponent(contact.id)}&created_at=gte.${encodeURIComponent(since)}&limit=1`);

    if (recent?.length) {
      wa.pendingReplies.delete(contact.chat);
      return;
    }

    [row] = await db('wa_auto_replies', {
      method: 'POST',
      body: JSON.stringify({ store_id: storeId, phone: contact.id, replied_on: dayInSaoPaulo() }),
    });
  } catch (err) {
    wa.pendingReplies.delete(contact.chat);
    throw err;
  }

  wa.replyHour.count += 1;

  const finish = patch => db(`wa_auto_replies?id=eq.${row.id}&store_id=eq.${encodeURIComponent(storeId)}`, { method: 'PATCH', body: JSON.stringify(patch) }).catch(err => console.error('wa_auto_replies', err.message));

  try {
    // Espera alguns segundos (com um pouco de variação) para não parecer robô.
    const wait = config.delay * 1000 * (0.8 + Math.random() * 0.4) * autoReplyTiming.scale;
    await sleep(wait);

    if (pending.cancelled) return void await finish({ status: 'skipped', error: 'A loja respondeu antes.' });
    if (wa.state !== 'open' || !wa.sock) return void await finish({ status: 'failed', error: 'WhatsApp desconectado.' });

    await wa.sock.sendPresenceUpdate('composing', contact.chat).catch(() => {});
    await sleep((autoReplyTiming.typingMs[0] + Math.random() * (autoReplyTiming.typingMs[1] - autoReplyTiming.typingMs[0])) * autoReplyTiming.scale);

    if (pending.cancelled) return void await finish({ status: 'skipped', error: 'A loja respondeu antes.' });

    await wa.sock.sendMessage(contact.chat, { text: fillAutoReply(config.text, config) });
    await finish({ status: 'sent', sent_at: new Date().toISOString() });
  } catch (err) {
    await finish({ status: 'failed', error: String(err.message || err).slice(0, 300) });
  } finally {
    wa.pendingReplies.delete(contact.chat);
    wa.sock?.sendPresenceUpdate?.('paused', contact.chat)?.catch?.(() => {});
  }
}

/* ---------------- Fila de envio (wa_outbox) ---------------- */

async function processOutbox(storeId) {
  const wa = sessionFor(storeId);
  if (wa.processing) {
    wa.kickAgain = true;
    return;
  }

  wa.processing = true;

  try {
    do {
      wa.kickAgain = false;

      if (wa.state !== 'open') break;

      const now = new Date().toISOString();
      const due = await db(`wa_outbox?select=*&store_id=eq.${encodeURIComponent(storeId)}&status=eq.pending&next_attempt_at=lte.${encodeURIComponent(now)}&order=created_at.asc&limit=20`);

      for (const msg of due) {
        if (wa.state !== 'open') break;

        // Reserva a mensagem (se outro processo já pegou, pula).
        const claimed = await db(`wa_outbox?id=eq.${msg.id}&store_id=eq.${encodeURIComponent(storeId)}&status=eq.pending`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'sending', next_attempt_at: new Date(Date.now() + 10 * 60000).toISOString() }),
        });

        if (!claimed.length) continue;

        if (Date.now() - new Date(msg.created_at).getTime() > STALE_HOURS * 3600000) {
          await db(`wa_outbox?id=eq.${msg.id}&store_id=eq.${encodeURIComponent(storeId)}`, { method: 'PATCH', body: JSON.stringify({ status: 'skipped', last_error: `Ficou mais de ${STALE_HOURS}h na fila (WhatsApp desconectado); não foi enviado para não chegar atrasado.` }) });
          continue;
        }

        try {
          const id = await sendText(storeId, msg.phone, msg.body);
          await db(`wa_outbox?id=eq.${msg.id}&store_id=eq.${encodeURIComponent(storeId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'sent', sent_at: new Date().toISOString(), wa_message_id: id, attempts: msg.attempts + 1, last_error: null }),
          });
        } catch (err) {
          const attempts = msg.attempts + 1;
          const final = err.noWhatsapp || attempts >= MAX_ATTEMPTS;

          await db(`wa_outbox?id=eq.${msg.id}&store_id=eq.${encodeURIComponent(storeId)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              status: err.noWhatsapp ? 'skipped' : final ? 'failed' : 'pending',
              attempts,
              last_error: String(err.message || err).slice(0, 500),
              next_attempt_at: new Date(Date.now() + (RETRY_MINUTES[attempts - 1] || 60) * 60000).toISOString(),
            }),
          });
        }

        await sleep(SEND_GAP_MS[0] + Math.random() * (SEND_GAP_MS[1] - SEND_GAP_MS[0]));
      }
    } while (wa.kickAgain);
  } catch (err) {
    console.error('processOutbox', storeId, err.message);
  } finally {
    wa.processing = false;
  }
}

// Mensagem que ficou "enviando" quando o serviço caiu volta para a fila.
async function recoverStuck(storeId) {
  const now = new Date().toISOString();
  await db(`wa_outbox?store_id=eq.${encodeURIComponent(storeId)}&status=eq.sending&next_attempt_at=lt.${encodeURIComponent(now)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'pending' }),
  }).catch(err => console.error('recoverStuck', err.message));
}

/* ---------------- HTTP (só com o token) ---------------- */

function authorized(req, storeId) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;

  const given = Buffer.from(match[1]);
  const expected = Buffer.from(WA_SERVICE_TOKEN);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  if (!/^[0-9a-f-]{36}$/i.test(String(storeId || ''))) return false;
  const timestamp = req.headers['x-wa-timestamp'] || '';
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!/^\d+$/.test(timestamp) || !Number.isFinite(age) || age > 60) return false;
  const signature = createHmac('sha256', WA_SERVICE_TENANT_SECRET).update(`${storeId}.${timestamp}`).digest('base64url');
  const supplied = Buffer.from(req.headers['x-wa-store-signature'] || '');
  const expectedSignature = Buffer.from(signature);
  return supplied.length === expectedSignature.length && timingSafeEqual(supplied, expectedSignature);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) throw new Error('Corpo grande demais.');
  }
  return raw ? JSON.parse(raw) : {};
}

function statusPayload(storeId) {
  const wa = sessionFor(storeId);
  return {
    store_id: storeId,
    state: wa.state,
    me: wa.me,
    qr: wa.state === 'qr' ? wa.qr : null,
    last_error: wa.lastError,
  };
}

function storeIdFrom(req) {
  const value = req.headers['x-wa-store-id'];
  return Array.isArray(value) ? value[0] : String(value || '').trim();
}

async function bootstrapSessions() {
  const stores = await db('stores?select=id');

  await Promise.all(stores
    .map(row => row?.id)
    .filter(storeId => /^[0-9a-f-]{36}$/i.test(String(storeId || '')))
    .map(async storeId => {
      sessionFor(storeId);
      await recoverStuck(storeId);
      if (await hasSession(storeId)) {
        await connect(storeId);
      }
    }));
}

export { authorized, statusPayload, storeIdFrom, sessionFor };

const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');

  if (url.pathname === '/health') return send(res, 200, { ok: true });

  const storeId = storeIdFrom(req);
  if (!authorized(req, storeId)) return send(res, 401, { error: 'Não autorizado.' });

  try {
    const wa = sessionFor(storeId);

    if (req.method === 'GET' && url.pathname === '/status') {
      return send(res, 200, statusPayload(storeId));
    }

    if (req.method === 'POST' && url.pathname === '/connect') {
      wa.qrRequestedAt = Date.now();
      wa.lastError = null;
      wa.stopping = false;
      if (wa.state === 'logged_out' || wa.state === 'close') wa.state = 'connecting';
      await connect(storeId);
      await sleep(2500); // dá tempo do primeiro QR aparecer
      return send(res, 200, statusPayload(storeId));
    }

    if (req.method === 'POST' && url.pathname === '/restart') {
      wa.qrRequestedAt = Date.now();
      await stopSocket(storeId);
      await connect(storeId);
      await sleep(2500);
      return send(res, 200, statusPayload(storeId));
    }

    if (req.method === 'POST' && url.pathname === '/logout') {
      await logout(storeId);
      return send(res, 200, statusPayload(storeId));
    }

    if (req.method === 'POST' && url.pathname === '/kick') {
      processOutbox(storeId).catch(err => console.error('processOutbox', storeId, err.message));
      return send(res, 200, { ok: true, store_id: storeId });
    }

    if (req.method === 'POST' && url.pathname === '/test') {
      const body = await readBody(req);
      if (wa.state !== 'open') return send(res, 409, { error: 'O WhatsApp não está conectado.' });
      const text = String(body.text || '').slice(0, 2000);
      if (!text) return send(res, 400, { error: 'Mensagem vazia.' });
      if (!body.phone) return send(res, 400, { error: 'Telefone ausente.' });
      const id = await sendText(storeId, body.phone, text);
      return send(res, 200, { ok: true, id, store_id: storeId });
    }

    return send(res, 404, { error: 'Rota não encontrada.' });
  } catch (err) {
    console.error(req.method, url.pathname, storeId, err.message);
    return send(res, 500, { error: err.message || 'Erro no serviço do WhatsApp.' });
  }
});

if (isMainModule) server.listen(Number(PORT), HOST, async () => {
  console.log(`Serviço do WhatsApp ouvindo em ${HOST}:${PORT}`);

  bootstrapSessions().catch(err => console.error('bootstrapSessions', err.message));

  setInterval(() => {
    for (const [storeId, wa] of sessions) {
      recoverStuck(storeId)
        .then(() => {
          if (wa.state === 'open') return processOutbox(storeId);
          return undefined;
        })
        .catch(err => console.error('queueTimer', storeId, err.message));
    }
  }, 20000);
});

process.on('unhandledRejection', err => console.error('unhandledRejection', err?.message || err));
