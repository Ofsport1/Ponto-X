function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function toBase64Url(bytes) {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function textToBase64Url(text) {
  return toBase64Url(new TextEncoder().encode(text));
}

function base64UrlToText(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));

  return toBase64Url(new Uint8Array(signature));
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';

  for (const part of cookie.split(';').map(v => v.trim())) {
    const idx = part.indexOf('=');

    if (idx < 0) continue;

    if (part.slice(0, idx) === name) {
      return part.slice(idx + 1);
    }
  }

  return null;
}

const SESSION_COOKIE = 'admin_session';
const SESSION_HOURS = 12;

// user: quem entrou ({ uid, name, urole }). Login pela senha do painel = "Dono" (admin, sem uid).
async function createAdminSession(secret, user = {}) {
  const payload = {
    role: 'admin',
    uid: user.uid || null,
    name: user.name || 'Administrador',
    urole: user.urole || 'admin',
    staff_key: user.staff_key || null,
    sid: user.sid || null,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * SESSION_HOURS,
  };

  const encoded = textToBase64Url(JSON.stringify(payload));
  const signature = await sign(encoded, secret);

  return `${encoded}.${signature}`;
}

async function getAdminSession(request, secret) {
  const token = getCookie(request, SESSION_COOKIE);

  if (!token) return null;

  const [encoded, signature] = token.split('.');

  if (!encoded || !signature) return null;

  if (!(await safeEqual(signature, await sign(encoded, secret), secret))) return null;

  try {
    const payload = JSON.parse(base64UrlToText(encoded));

    if (payload.role !== 'admin' || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    // Sessões antigas (antes dos usuários) não têm nome: eram do dono.
    return { ...payload, name: payload.name || 'Administrador', urole: payload.urole || 'admin' };
  } catch {
    return null;
  }
}

/* ----- PIN dos usuários (PBKDF2-SHA256, formato pbkdf2$iterações$sal$hash) ----- */

const PIN_ITERATIONS = 100000;

async function derivePin(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);

  return toBase64Url(new Uint8Array(bits));
}

async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  return `pbkdf2$${PIN_ITERATIONS}$${toBase64Url(salt)}$${await derivePin(pin, salt, PIN_ITERATIONS)}`;
}

async function checkPin(pin, stored, secret) {
  const [kind, iterations, salt, hash] = String(stored || '').split('$');

  if (kind !== 'pbkdf2' || !hash) return false;

  return safeEqual(await derivePin(pin, base64UrlToBytes(salt), Number(iterations)), hash, secret);
}

const validPin = pin => /^\d{4,6}$/.test(String(pin || ''));

// Compara duas strings sem vazar tempo (compara os HMACs, que têm o mesmo tamanho).
async function safeEqual(a, b, secret) {
  const [ha, hb] = await Promise.all([sign(String(a), secret), sign(String(b), secret)]);

  let diff = ha.length ^ hb.length;

  for (let i = 0; i < Math.min(ha.length, hb.length); i++) {
    diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  }

  return diff === 0;
}

function todaySaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Multi-loja: tabelas que têm store_id. Toda leitura/alteração/exclusão nelas fica presa à loja
// da requisição (o filtro store_id é colocado aqui, mesmo que a consulta tenha esquecido) e toda
// inclusão é gravada na loja atual. Tabelas "filhas" sem store_id (order_items, product_variants,
// cash_movements) dependem de o pai (pedido, produto, caixa) ter sido conferido antes.
const STORE_SCOPED_TABLES = new Set([
  'abandoned_carts', 'audit_log', 'cart_events', 'cash_sessions', 'coupons', 'customer_credit_entries',
  'customers', 'delivery_zones', 'order_reviews', 'orders', 'pdv_closings', 'product_components',
  'products', 'push_subscriptions', 'search_logs', 'staff', 'staging_products', 'wa_outbox', 'whatsapp_messages',
]);

async function scopeToStore(env, path, options) {
  const table = String(path).match(/^([a-z_]+)(?:\?|$)/)?.[1];
  if (!table || !STORE_SCOPED_TABLES.has(table)) return { path, options };
  if (!env.__storeScoped) throw new Error(`Consulta em ${table} sem loja definida.`);

  const storeId = await currentStoreId(env);
  const method = String(options.method || 'GET').toUpperCase();
  const wrongStore = row => row && typeof row === 'object' && row.store_id != null && row.store_id !== storeId;

  if (options.body && typeof options.body === 'string' && (method === 'POST' || method === 'PATCH')) {
    const parsed = JSON.parse(options.body);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (rows.some(wrongStore)) throw new Error('Tentativa de gravar dados em outra loja.');
    if (method === 'POST') rows.forEach(row => { if (row && typeof row === 'object') row.store_id = storeId; });
    options = { ...options, body: JSON.stringify(parsed) };
  }

  if (method !== 'POST') {
    const current = String(path).match(/[?&]store_id=([^&]*)/);
    if (current) {
      if (current[1] !== `eq.${storeId}`) throw new Error('Consulta de outra loja bloqueada.');
    } else {
      path += `${path.includes('?') ? '&' : '?'}store_id=eq.${storeId}`;
    }
  }

  return { path, options };
}

async function supabaseFetch(env, path, options = {}) {
  ({ path, options } = await scopeToStore(env, path, options));
  const headers = new Headers(options.headers || {});

  headers.set('apikey', env.SUPABASE_SECRET_KEY);
  headers.set('Authorization', `Bearer ${env.SUPABASE_SECRET_KEY}`);

  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers,
  });
}

// O Supabase devolve no máximo 1000 linhas por consulta: busca em páginas até acabar.
async function fetchAllRows(env, path, fallbackMessage, pageSize = 1000) {
  const all = [];

  for (let offset = 0; ; offset += pageSize) {
    const response = await supabaseFetch(env, `${path}&limit=${pageSize}&offset=${offset}`);
    const rows = await readJsonResponse(response, fallbackMessage);
    all.push(...rows);

    if (rows.length < pageSize) return all;
  }
}

async function readJsonResponse(response, fallbackMessage) {
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    console.error('Supabase error', response.status, data);
    throw new Error(fallbackMessage);
  }

  return data;
}

// Erro que vai direto para a tela (com o status certo), sem virar "erro interno".
class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Mensagens do banco sobre o fiado (gatilhos do livro do fiado) em português claro.
function fiadoFriendly(text) {
  let raw = String(text || '');
  try { raw = JSON.parse(raw).message || raw; } catch { /* texto puro */ }
  const m = raw.match(/FIADO_[A-Z_]+:[^"]*/);
  if (!m) return null;
  const msg = m[0];
  if (msg.startsWith('FIADO_NAO_LIBERADO')) return 'Este cliente não tem fiado liberado. O administrador libera no cadastro do cliente (📒 Fiado).';
  if (msg.startsWith('FIADO_LIMITE')) {
    const n = msg.match(/deve (-?\d+), limite (\d+), esta compra (\d+)/);
    return n
      ? `Limite do fiado estourado: o cliente deve ${money(Number(n[1]))}, o limite é ${money(Number(n[2]))} e esta compra no fiado é ${money(Number(n[3]))}.`
      : 'Limite do fiado estourado.';
  }
  if (msg.startsWith('FIADO_SEM_CLIENTE')) return 'Fiado precisa de cliente com WhatsApp cadastrado (preencha o WhatsApp do cliente).';
  return msg.replace(/^FIADO_[A-Z_]+:\s*/, '').trim();
}

// Como readJsonResponse, mas mostra o motivo quando o banco recusa por causa do fiado.
async function readFiadoResponse(response, fallbackMessage) {
  if (response.ok) return response.json().catch(() => null);
  const text = await response.text().catch(() => '');
  console.error('Supabase error', response.status, text);
  const friendly = fiadoFriendly(text);
  throw friendly ? new UserError(friendly, 409) : new Error(fallbackMessage);
}

// Quem está fazendo a mudança: o banco grava no livro do fiado (nome em base64 por causa dos acentos).
function actorHeaders(session) {
  const bytes = new TextEncoder().encode(String(session?.name || 'Sistema').slice(0, 80));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return {
    'x-garatucaia-actor': btoa(bin),
    ...(session?.uid && validUuid(session.uid) ? { 'x-garatucaia-actor-id': session.uid } : {}),
  };
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ''));
}

// Identificador da versão publicada (muda a cada deploy). O site e o painel
// comparam com o que carregaram e se recarregam sozinhos quando muda.
function appVersion(env) {
  return env.CF_VERSION_METADATA?.id || null;
}

function cleanText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function toCents(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n < 0) return null;

  return Math.round(n);
}

// Por enquanto o sistema tem uma loja só; a coluna store_id já existe pra
// uma eventual expansão multi-loja.
/* ---------------- Multi-loja: qual loja é esta? ---------------- */

// Cada requisição (e cada rodada do cron) trabalha com um "env" próprio que sabe a loja:
// pelo endereço do site (stores.domains) ou, no cron, pelo id. Endereço desconhecido
// (workers.dev, testes) = loja principal (a mais antiga), como era antes do multi-loja.
function envForHost(env, host, request) {
  const scoped = Object.create(env);
  scoped.__storeScoped = true;
  scoped.STORE_HOST = String(host || '').toLowerCase().replace(/:\d+$/, '');
  // Endereço de teste (sem domínio próprio): cookie "loja" com o apelido (stores.slug), gravado pelo ?loja= do site.
  const selected = request ? new URL(request.url).searchParams.get('loja') : null;
  scoped.STORE_SLUG = String(selected ?? (request && getCookie(request, 'loja')) ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return scoped;
}

function envForStore(env, storeId) {
  const scoped = Object.create(env);
  scoped.__storeScoped = true;
  scoped.STORE_ID = storeId;
  return scoped;
}

async function defaultStoreId(env) {
  if (!env.__defaultStoreId) {
    env.__defaultStoreId = (async () => {
      const [row] = await readJsonResponse(await supabaseFetch(env, 'stores?select=id&order=created_at.asc&limit=1'), 'Não foi possível carregar a loja.');
      if (!row) throw new Error('Loja não encontrada.');
      return row.id;
    })();
  }
  return env.__defaultStoreId;
}

async function currentStoreId(env) {
  if (env.STORE_ID) return env.STORE_ID;

  if (!env.__storeId) {
    env.__storeId = (async () => {
      if (env.STORE_HOST && /^[a-z0-9.-]+$/.test(env.STORE_HOST)) {
        const filter = encodeURIComponent(`{"${env.STORE_HOST}"}`);
        const [row] = await readJsonResponse(await supabaseFetch(env, `stores?select=id&domains=cs.${filter}&limit=1`), 'Não foi possível carregar a loja.');
        if (row) { env.STORE_DOMAIN_MATCH = true; return row.id; }
      }
      if (env.STORE_SLUG) {
        const [row] = await readJsonResponse(await supabaseFetch(env, `stores?select=id&slug=eq.${env.STORE_SLUG}&limit=1`), 'Não foi possível carregar a loja.');
        if (row) return row.id;
        throw new Error('Loja não encontrada. Confira o endereço ou o código da loja.');
      }
      return defaultStoreId(env);
    })();
    // Se falhar (rede), a próxima chamada tenta de novo.
    env.__storeId.catch(() => { env.__storeId = null; });
  }
  return env.__storeId;
}

async function isDefaultStore(env) {
  return (await currentStoreId(env)) === (await defaultStoreId(env));
}

async function getStore(env) {
  const storeId = await currentStoreId(env);
  const response = await supabaseFetch(env, `stores?select=*&id=eq.${storeId}`);
  const rows = await readJsonResponse(response, 'Não foi possível carregar a loja.');

  if (!rows || !rows[0]) {
    throw new Error('Loja não encontrada.');
  }

  return rows[0];
}

// Todas as lojas (cron: alertas e resumo do dia rodam uma vez por loja).
async function allStoreIds(env) {
  const rows = await readJsonResponse(await supabaseFetch(env, 'stores?select=id&order=created_at.asc'), 'Não foi possível carregar as lojas.');
  return rows.map(r => r.id);
}

/* ---------------- Horário de funcionamento ---------------- */

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// Dia da semana (0 = domingo) e minutos desde a meia-noite, no horário de São Paulo.
function nowInSaoPaulo(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(date)
      .map(p => [p.type, p.value])
  );
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);

  return { day, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return h * 60 + m;
}

function validHours(hours) {
  return Array.isArray(hours) && hours.length === 7 && hours.every((h, i) =>
    h && h.day === i && typeof h.enabled === 'boolean' && /^\d{2}:\d{2}$/.test(h.open) && /^\d{2}:\d{2}$/.test(h.close)
    && toMinutes(h.open) < 1440 && toMinutes(h.close) <= 1440);
}

// Está dentro do horário? Suporta fechar depois da meia-noite (ex.: 18:00 às 02:00).
function withinHours(hours, now = nowInSaoPaulo()) {
  const today = hours[now.day];
  const yesterday = hours[(now.day + 6) % 7];

  if (today?.enabled) {
    const open = toMinutes(today.open);
    const close = toMinutes(today.close);

    if (close > open ? now.minutes >= open && now.minutes < close : now.minutes >= open) return true;
  }

  // Madrugada: horário de ontem que atravessa a meia-noite.
  if (yesterday?.enabled && toMinutes(yesterday.close) <= toMinutes(yesterday.open)) {
    return now.minutes < toMinutes(yesterday.close);
  }

  return false;
}

// Com horário automático ligado, vale o horário; desligado, vale o botão abrir/fechar.
function effectiveOpen(store) {
  return store.auto_hours && validHours(store.hours) ? withinHours(store.hours) : store.is_open;
}

// Texto da próxima abertura, ex.: "hoje às 08:00", "amanhã às 08:00", "sábado às 08:00".
function nextOpeningText(store) {
  if (!store.auto_hours || !validHours(store.hours)) return null;

  const now = nowInSaoPaulo();

  for (let offset = 0; offset < 8; offset++) {
    const day = (now.day + offset) % 7;
    const h = store.hours[day];

    if (!h.enabled) continue;
    if (offset === 0 && toMinutes(h.open) <= now.minutes) continue;

    const when = offset === 0 ? 'hoje' : offset === 1 ? 'amanhã' : WEEKDAYS[day];
    return `${when} às ${h.open}`;
  }

  return null;
}

function closingTimeToday(store) {
  if (!store.auto_hours || !validHours(store.hours)) return null;

  const h = store.hours[nowInSaoPaulo().day];
  return h.enabled ? h.close : null;
}

async function getDeliveryZones(env, storeId, onlyActive) {
  const response = await supabaseFetch(
    env,
    `delivery_zones?select=*&store_id=eq.${storeId}${onlyActive ? '&active=eq.true' : ''}&order=sort_order.asc,name.asc`
  );
  return readJsonResponse(response, 'Não foi possível carregar as taxas de entrega.');
}

// Dados públicos da loja (rodapé do cardápio): stores.profile. Vazio = não mostra.
const PROFILE_TEXT_FIELDS = { instagram: 60, tagline: 120, address_line1: 120, address_line2: 120, maps_query: 200 };

const STORE_DEFAULT_HIDDEN_CATEGORIES = {
  pontox: ['Varejos'],
};

function hiddenCategories(store) {
  const raw = store.profile && typeof store.profile === 'object' ? store.profile : {};
  const configured = Array.isArray(raw.hidden_categories)
    ? raw.hidden_categories.map(value => cleanText(value, 60).trim()).filter(Boolean)
    : [];
  const defaults = STORE_DEFAULT_HIDDEN_CATEGORIES[store.slug] || [];
  return [...new Set([...defaults, ...configured])].slice(0, 30);
}

const STORE_FEATURE_DEFAULTS = {
  chill: true,
  bulk: true,
  weight: true,
  category_min_orders: true,
  smart_suggestions: true,
};

function storeFeatures(store) {
  const raw = store.profile && typeof store.profile === 'object' ? store.profile : {};
  const configured = raw.features && typeof raw.features === 'object' ? raw.features : {};
  const defaults = store.slug === 'pontox' ? STORE_FEATURE_DEFAULTS : Object.fromEntries(Object.keys(STORE_FEATURE_DEFAULTS).map(key => [key, false]));
  return Object.fromEntries(Object.keys(STORE_FEATURE_DEFAULTS).map(key => [key, configured[key] === undefined ? defaults[key] : Boolean(configured[key])]));
}

function storeProfile(store) {
  const raw = store.profile && typeof store.profile === 'object' ? store.profile : {};
  const profile = {};
  for (const key of Object.keys(PROFILE_TEXT_FIELDS)) profile[key] = typeof raw[key] === 'string' ? raw[key] : '';
  profile.alcohol_notice = raw.alcohol_notice !== false;
  profile.features = storeFeatures(store);
  profile.hidden_categories = hiddenCategories(store);
  return profile;
}

function readProfile(body) {
  const profile = {};
  for (const [key, max] of Object.entries(PROFILE_TEXT_FIELDS)) profile[key] = cleanText(body?.[key], max);
  profile.instagram = profile.instagram.replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '');
  profile.alcohol_notice = body?.alcohol_notice !== false;
  if (body?.features && typeof body.features === 'object') {
    profile.features = Object.fromEntries(Object.keys(STORE_FEATURE_DEFAULTS).map(key => [key, Boolean(body.features[key])]));
  }
  if (Array.isArray(body?.hidden_categories)) {
    profile.hidden_categories = body.hidden_categories.map(value => cleanText(value, 60).trim()).filter(Boolean).slice(0, 30);
  }
  return profile;
}

function publicStore(store, zones = []) {
  const open = effectiveOpen(store);

  return {
    name: store.name,
    profile: storeProfile(store),
    features: storeFeatures(store),
    // Só o que o cardápio usa para achar o bairro pelo endereço (os caminhos ficam no painel).
    delivery_rules: { broad: store.delivery_rules?.broad || [], aliases: store.delivery_rules?.aliases || {} },
    whatsapp: store.whatsapp,
    delivery_fee_cents: store.delivery_fee_cents,
    min_order_cents: store.min_order_cents,
    category_min_orders: storeFeatures(store).category_min_orders ? (store.category_min_orders || []) : [],
    accept_scheduled: Boolean(store.accept_scheduled),
    is_open: open,
    closes_at: open ? closingTimeToday(store) : null,
    opens_text: open ? null : nextOpeningText(store),
    delivery_zones: zones.map(({ id, name, fee_cents, streets }) => ({ id, name, fee_cents, streets: streets || [] })),
    delivery_minutes: store.delivery_minutes,
    pickup_minutes: store.pickup_minutes,
    // Horário de funcionamento (rodapé do cardápio).
    hours: store.auto_hours && Array.isArray(store.hours)
      ? store.hours.map(({ day, open: o, close, enabled }) => ({ day, open: o, close, enabled: Boolean(enabled) }))
      : null,
  };
}

const ORDER_STATUSES = ['received', 'accepted', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];

// Prazo prometido do pedido (entrega ou retirada), contado a partir da hora do pedido.
function orderDeadline(order, store) {
  const minutes = order.delivery_type === 'pickup' ? store.pickup_minutes : store.delivery_minutes;
  return new Date(order.created_at).getTime() + (minutes || 45) * 60000;
}
// 'cartao' = pedidos antigos (antes de separar débito/crédito); o site e o painel não oferecem mais.
// 'fiado' = crediário: só a equipe lança (painel), nunca o site nem o entregador.
const PAYMENT_METHODS = ['dinheiro', 'debito', 'credito', 'pix', 'cartao', 'fiado'];
const PAYMENT_LABELS = { dinheiro: 'Dinheiro', debito: 'Débito', credito: 'Crédito', pix: 'Pix', cartao: 'Cartão', fiado: 'Fiado' };
// Formas para receber o pagamento de uma dívida do fiado.
const CREDIT_PAY_METHODS = ['dinheiro', 'pix', 'debito', 'credito'];
const DELIVERY_TYPES = ['delivery', 'pickup'];
const PAYMENT_STATUSES = ['pending', 'paid'];

// Preço de uma quantidade com "engradado": cada bulkQty unidades saem por bulkPrice
// (só quando o engradado é mais barato que as unidades soltas). O resto sai pelo preço unitário.
function linePrice(qty, unit, bulkQty, bulkPrice) {
  if (bulkQty > 1 && bulkPrice != null && bulkPrice < bulkQty * unit && qty >= bulkQty) {
    const packs = Math.floor(qty / bulkQty);
    return { total: packs * bulkPrice + (qty % bulkQty) * unit, packs };
  }

  return { total: qty * unit, packs: 0 };
}

// Quantos engradados levam a taxa de "gelado": com preço de engradado, cada engradado completo;
// produto que já é um engradado (sem bulk_qty), cada unidade.
function chillPackCount(product, priceSource, qty) {
  const bulkQty = priceSource.bulk_qty || product.bulk_qty;
  return bulkQty > 1 ? Math.floor(qty / bulkQty) : qty;
}

// Pagamento dividido em duas formas (ex.: parte no Pix, parte no dinheiro).
// Entrada: { first_method, first_cents, second_method }; a segunda parte é o restante do total.
// Saída gravada em orders.payment_split: [{ method, cents }, { method, cents }].
function parsePaymentSplit(raw, total) {
  if (!raw || typeof raw !== 'object') return { split: null };

  const first = raw.first_method;
  const second = raw.second_method;
  const firstCents = toCents(raw.first_cents);

  if (!PAYMENT_METHODS.includes(first) || !PAYMENT_METHODS.includes(second) || first === second) {
    return { error: 'No pagamento dividido, escolha duas formas diferentes.' };
  }

  if (firstCents === null || firstCents <= 0 || firstCents >= total) {
    return { error: `No pagamento dividido, a primeira parte precisa ser maior que zero e menor que o total (${money(total)}).` };
  }

  return { split: [{ method: first, cents: firstCents }, { method: second, cents: total - firstCents }] };
}

// Quanto do pedido é pago em dinheiro (o troco é calculado sobre isso).
function cashPartCents(order) {
  if (Array.isArray(order.payment_split)) {
    return order.payment_split.filter(p => p.method === 'dinheiro').reduce((s, p) => s + p.cents, 0);
  }

  return order.payment_method === 'dinheiro' ? order.total_cents : 0;
}

function paymentText(order) {
  if (Array.isArray(order.payment_split)) {
    return order.payment_split.map(p => `${PAYMENT_LABELS[p.method] || p.method} ${money(p.cents)}`).join(' + ');
  }

  return PAYMENT_LABELS[order.payment_method] || order.payment_method;
}

// Partes do pagamento de um pedido: a divisão, ou o total inteiro na forma escolhida.
function paymentParts(order) {
  return Array.isArray(order.payment_split) ? order.payment_split : [{ method: order.payment_method, cents: order.total_cents }];
}

/* ---------------- Público ---------------- */

// Promoção com horário (só em produto sem variações). Ativa = preço menor que o normal, dentro do horário
// e, se houver dias da semana marcados, só nesses dias (fuso de São Paulo).
// Devolve também a promoção que ainda vai começar hoje, para o cardápio trocar sozinho na hora certa.
function promoFor(p, now = Date.now()) {
  if (p.promo_price_cents == null || p.variants?.length || p.promo_price_cents >= p.price_cents) return null;

  if (p.promo_weekdays?.length && !p.promo_weekdays.includes(nowInSaoPaulo(new Date(now)).day)) return null;

  const starts = p.promo_starts_at ? new Date(p.promo_starts_at).getTime() : null;
  const ends = p.promo_ends_at ? new Date(p.promo_ends_at).getTime() : null;

  if (ends && ends <= now) return null;

  return {
    price_cents: p.promo_price_cents,
    starts_at: p.promo_starts_at,
    ends_at: p.promo_ends_at,
    weekdays: p.promo_weekdays?.length ? p.promo_weekdays : null,
    active: !starts || starts <= now,
  };
}

function unitPriceNow(product, variant, now = Date.now()) {
  if (variant) return variant.price_cents;

  const promo = promoFor({ ...product, variants: product.product_variants || [] }, now);

  return promo?.active ? promo.price_cents : product.price_cents;
}

/* ----- Recomendações aprendidas com os pedidos reais ----- */

// Feriados nacionais fixos (o "modo ressaca" vale em domingo ou feriado de manhã).
const FIXED_HOLIDAYS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];

function isRestDay(date) {
  const day = new Date(`${date}T12:00:00-03:00`).getUTCDay();
  return day === 0 || FIXED_HOLIDAYS.includes(date.slice(5));
}

const recommendationsCache = new Map();

// "Comprados juntos" (Brahma + gelo...) e o que mais sai em manhã de domingo/feriado.
// Calcula com os pedidos dos últimos 120 dias e guarda 10 min na memória do Worker.
async function recommendations(env, store) {
  const cached = recommendationsCache.get(store.id);
  if (cached && cached.expires > Date.now()) return cached.data;
  if (cached) recommendationsCache.delete(store.id);

  const since = new Date(Date.now() - 120 * DAY_MS).toISOString();
  const orders = await fetchAllRows(
    env,
    `orders?select=created_at,order_items(product_id,quantity)&store_id=eq.${store.id}&status=neq.cancelled&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc`,
    'Não foi possível calcular as recomendações.'
  );

  const together = new Map();
  const restMorning = new Map();

  for (const o of orders) {
    const ids = [...new Set(o.order_items.map(i => i.product_id).filter(Boolean))];

    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        if (!together.has(a)) together.set(a, new Map());
        together.get(a).set(b, (together.get(a).get(b) || 0) + 1);
      }
    }

    const local = new Date(new Date(o.created_at).getTime() - 3 * 3600000);
    const hour = local.getUTCHours();

    if (hour >= 6 && hour < 14 && isRestDay(local.toISOString().slice(0, 10))) {
      for (const i of o.order_items) {
        if (i.product_id) restMorning.set(i.product_id, (restMorning.get(i.product_id) || 0) + i.quantity);
      }
    }
  }

  // Só pares que aconteceram pelo menos 2 vezes (evita "coincidência" virar recomendação).
  const pairs = {};

  for (const [a, partners] of together) {
    const top = [...partners.entries()].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([id]) => id);
    if (top.length) pairs[a] = top;
  }

  const data = {
    pairs,
    rest_morning: [...restMorning.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id),
    orders_analyzed: orders.length,
  };

  recommendationsCache.set(store.id, { data, expires: Date.now() + 10 * 60 * 1000 });

  return data;
}

async function handleRecommendations(request, env) {
  const store = await getStore(env);
  return json(await recommendations(env, store), 200, { 'cache-control': 'private, no-store' });
}

async function openCouponFor(env, customerId) {
  const response = await supabaseFetch(env, `coupons?select=id,amount_cents&customer_id=eq.${customerId}&used_order_id=is.null&order=created_at.asc&limit=1`);
  const [coupon] = await readJsonResponse(response, 'cupom');
  return coupon || null;
}

// Busca do cardápio que não achou nada (só o termo; nada do cliente).
async function handleSearchLog(request, env) {
  const body = await request.json().catch(() => ({}));
  const term = normalizeSearchTerm(body.term);

  if (term.length < 2) return json({ ok: false });

  const store = await getStore(env);
  await supabaseFetch(env, 'search_logs', { method: 'POST', body: JSON.stringify({ store_id: store.id, term }) });

  return json({ ok: true });
}

function normalizeSearchTerm(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// "Colocou no carrinho" de um aparelho anônimo (id aleatório guardado no navegador).
async function handleCartEvent(request, env) {
  const body = await request.json().catch(() => ({}));
  const device = String(body.device || '').replace(/[^a-z0-9]/gi, '').slice(0, 40);

  if (!validUuid(body.product_id) || device.length < 8) return json({ ok: false });

  const store = await getStore(env);
  await supabaseFetch(env, 'cart_events', { method: 'POST', body: JSON.stringify({ store_id: store.id, product_id: body.product_id, device }) });

  return json({ ok: true });
}

// Cancelamentos que foram culpa da loja (o cliente merece uma compensação).
const STORE_FAULT_REASONS = ['Produto em falta', 'Demora na entrega', 'Loja sem entregador disponível'];
// Atraso "grande" = passou do prazo em mais de 20 min.
const BIG_DELAY_MINUTES = 20;

// Aba "Sugestões": só recomenda. Nada aqui muda preço, cria cupom ou manda mensagem sozinho.
async function handleAdminSuggestions(request, env) {
  const store = await getStore(env);
  const now = Date.now();
  const iso = days => encodeURIComponent(new Date(now - days * DAY_MS).toISOString());

  const [products, orders, searches, events, carts, reviews, problems, recs] = await Promise.all([
    fetchAllRows(env, `products?select=id,name,category,available,price_cents,promo_price_cents,promo_ends_at,created_at&store_id=eq.${store.id}`, 'Não foi possível carregar.'),
    fetchAllRows(env, `orders?select=id,source,created_at,order_items(product_id,quantity)&store_id=eq.${store.id}&status=neq.cancelled&created_at=gte.${iso(60)}`, 'Não foi possível carregar.'),
    fetchAllRows(env, `search_logs?select=term,created_at&store_id=eq.${store.id}&created_at=gte.${iso(30)}`, 'Não foi possível carregar.'),
    fetchAllRows(env, `cart_events?select=product_id,device,created_at&store_id=eq.${store.id}&created_at=gte.${iso(30)}`, 'Não foi possível carregar.'),
    fetchAllRows(env, `abandoned_carts?select=recovered_order_id,updated_at&store_id=eq.${store.id}&updated_at=gte.${iso(30)}`, 'Não foi possível carregar.'),
    readJsonResponse(await supabaseFetch(env, `order_reviews?select=order_id,rating,comment,created_at,orders(public_code,daily_number,order_number,customer_name)&store_id=eq.${store.id}&order=created_at.desc&limit=60`), 'Não foi possível carregar.'),
    fetchAllRows(env, `orders?select=id,order_number,public_code,status,delivery_type,created_at,closed_at,cancel_reason,customer_id,customer_name,total_cents&store_id=eq.${store.id}&customer_id=not.is.null&coupon_decision=is.null&status=in.(delivered,cancelled)&created_at=gte.${iso(14)}&order=created_at.desc`, 'Não foi possível carregar.'),
    recommendations(env, store),
  ]);

  const byId = new Map(products.map(p => [p.id, p]));
  const nameOf = id => byId.get(id)?.name || null;
  const sold30 = new Map();
  const sold60 = new Map();
  const ordersWith30 = new Map();
  const cut30 = now - 30 * DAY_MS;

  for (const o of orders) {
    const recent = new Date(o.created_at).getTime() >= cut30;
    const ids = new Set();

    for (const i of o.order_items) {
      if (!i.product_id) continue;
      sold60.set(i.product_id, (sold60.get(i.product_id) || 0) + i.quantity);
      if (recent) sold30.set(i.product_id, (sold30.get(i.product_id) || 0) + i.quantity);
      ids.add(i.product_id);
    }

    if (recent) for (const id of ids) ordersWith30.set(id, (ordersWith30.get(id) || 0) + 1);
  }

  const orders30 = orders.filter(o => new Date(o.created_at).getTime() >= cut30).length;
  // Com poucos pedidos, "vende pouco" seria chute: só sugere com base suficiente.
  const enoughData = orders30 >= 30;
  const oldEnough = p => now - new Date(p.created_at).getTime() >= 30 * DAY_MS;
  const inPromo = p => p.promo_price_cents && (!p.promo_ends_at || new Date(p.promo_ends_at).getTime() > now);

  const lowSales = enoughData
    ? products.filter(p => p.available && oldEnough(p) && !inPromo(p) && (sold30.get(p.id) || 0) > 0 && (sold30.get(p.id) || 0) <= 2)
      .map(p => ({ id: p.id, name: p.name, category: p.category, sold_30d: sold30.get(p.id) || 0 })).slice(0, 20)
    : [];

  const stagnant = enoughData
    ? products.filter(p => p.available && now - new Date(p.created_at).getTime() >= 60 * DAY_MS && !sold60.get(p.id))
      .map(p => ({ id: p.id, name: p.name, category: p.category })).slice(0, 30)
    : [];

  const termCount = new Map();
  for (const sl of searches) termCount.set(sl.term, (termCount.get(sl.term) || 0) + 1);
  const missingSearches = [...termCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([term, count]) => ({ term, count }));

  const addCount = new Map();
  for (const e of events) if (e.product_id) addCount.set(e.product_id, (addCount.get(e.product_id) || 0) + 1);
  const addsNoBuy = [...addCount.entries()]
    .map(([id, adds]) => ({ id, name: nameOf(id), adds, orders: ordersWith30.get(id) || 0 }))
    .filter(x => x.name && x.adds >= 5 && x.orders / x.adds < 0.3)
    .sort((a, b) => b.adds - a.adds).slice(0, 15);

  const iceIds = new Set(products.filter(p => /\bgelo\b/i.test(p.name)).map(p => p.id));
  const withIce = Object.entries(recs.pairs || {})
    .filter(([id, partners]) => !iceIds.has(id) && partners.some(pid => iceIds.has(pid)))
    .map(([id]) => ({ id, name: nameOf(id) })).filter(x => x.name).slice(0, 15);

  const devices7 = new Set(events.filter(e => new Date(e.created_at).getTime() >= now - 7 * DAY_MS).map(e => e.device));
  const devices30 = new Set(events.map(e => e.device));
  const siteOrders = days => orders.filter(o => o.source === 'site' && new Date(o.created_at).getTime() >= now - days * DAY_MS).length;
  const cartStats = {
    started_7d: devices7.size,
    ordered_7d: siteOrders(7),
    started_30d: devices30.size,
    ordered_30d: siteOrders(30),
    with_phone_30d: carts.length,
    recovered_30d: carts.filter(c => c.recovered_order_id).length,
    tracking_since: events.length ? events.reduce((m, e) => (e.created_at < m ? e.created_at : m), events[0].created_at) : null,
  };

  const deadlineOf = o => (o.delivery_type === 'pickup' ? store.pickup_minutes : store.delivery_minutes) || 45;
  const couponCandidates = problems.filter(o => {
    if (o.status === 'cancelled') return STORE_FAULT_REASONS.includes(o.cancel_reason);
    if (!o.closed_at) return false;
    return (new Date(o.closed_at) - new Date(o.created_at)) / 60000 > deadlineOf(o) + BIG_DELAY_MINUTES;
  }).map(o => ({
    id: o.id,
    number: o.order_number,
    code: o.public_code,
    customer_name: o.customer_name,
    total_cents: o.total_cents,
    created_at: o.created_at,
    why: o.status === 'cancelled'
      ? `Cancelado: ${o.cancel_reason}`
      : `Entregue em ${Math.round((new Date(o.closed_at) - new Date(o.created_at)) / 60000)} min (prazo de ${deadlineOf(o)} min)`,
  }));

  const ratings = reviews.map(r => r.rating);

  return json({
    orders_30d: orders30,
    enough_data: enoughData,
    low_sales: lowSales,
    stagnant,
    missing_searches: missingSearches,
    adds_no_buy: addsNoBuy,
    with_ice: withIce,
    cart_stats: cartStats,
    coupon_candidates: couponCandidates,
    reviews: {
      average: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
      count: ratings.length,
      list: reviews,
    },
  });
}

// O dono decidiu sobre a sugestão de cupom: cria (com o valor que escolheu) ou dispensa.
async function handleCouponDecision(request, env, session) {
  const body = await request.json().catch(() => ({}));

  if (!validUuid(body.order_id)) return json({ error: 'Pedido inválido.' }, 400);

  const [order] = await readJsonResponse(await supabaseFetch(env, `orders?select=id,store_id,customer_id,customer_name,order_number,coupon_decision&id=eq.${body.order_id}`), 'Não foi possível carregar o pedido.');

  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);
  if (order.coupon_decision) return json({ error: 'Esse pedido já foi resolvido.' }, 409);

  if (body.action === 'dismiss') {
    await readJsonResponse(await supabaseFetch(env, `orders?id=eq.${order.id}`, { method: 'PATCH', body: JSON.stringify({ coupon_decision: 'dismissed' }) }), 'Não foi possível salvar.');
    return json({ ok: true });
  }

  const amount = toCents(body.amount_cents);

  if (!order.customer_id) return json({ error: 'Pedido sem cliente cadastrado.' }, 400);
  if (!amount || amount < 100 || amount > 20000) return json({ error: 'Escolha um valor entre R$ 1,00 e R$ 200,00.' }, 400);

  await readJsonResponse(await supabaseFetch(env, 'coupons', {
    method: 'POST',
    body: JSON.stringify({
      store_id: order.store_id,
      customer_id: order.customer_id,
      amount_cents: amount,
      reason: cleanText(body.reason, 200) || null,
      source_order_id: order.id,
      created_by: session?.name || null,
    }),
  }), 'Não foi possível criar o cupom.');

  await supabaseFetch(env, `orders?id=eq.${order.id}`, { method: 'PATCH', body: JSON.stringify({ coupon_decision: 'created' }) });
  await audit(env, session, 'coupon.create', `Cupom de ${money(amount)} para ${order.customer_name} (pedido #${order.order_number})`, { entity: 'order', entityId: order.id });

  return json({ ok: true });
}

// Prova social só com dados reais de hoje: o que mais saiu (a quantidade de pedidos NÃO vai para o cliente).
async function todayStats(env, store) {
  const today = todaySaoPaulo();
  const response = await supabaseFetch(
    env,
    `orders?select=id,order_items(product_id,quantity)&store_id=eq.${store.id}&status=neq.cancelled&created_at=gte.${encodeURIComponent(dayStart(today))}&created_at=lte.${encodeURIComponent(dayEnd(today))}&limit=2000`
  );
  const orders = await readJsonResponse(response, 'Não foi possível calcular hoje.');
  const qty = new Map();

  for (const o of orders) {
    for (const i of o.order_items) {
      if (i.product_id) qty.set(i.product_id, (qty.get(i.product_id) || 0) + i.quantity);
    }
  }

  // "Muito pedido hoje": os 5 que mais saíram, com pelo menos 3 unidades.
  const top = [...qty.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);

  return { top_products: top };
}

async function handleMenu(request, env) {
  const store = await getStore(env);

  // Produto inativo (estoque ou conferência de preço) nunca vai para o cliente.
  const [response, today] = await Promise.all([
    supabaseFetch(
      env,
      `products?select=id,name,description,category,price_cents,bulk_qty,bulk_price_cents,chill_fee_cents,promo_price_cents,promo_starts_at,promo_ends_at,promo_weekdays,created_at,image_url,featured,featured_order,suggest,available,sold_by_weight,kg_price_cents,is_addon,product_variants(id,name,price_cents,bulk_qty,bulk_price_cents,available,sort_order,image_url)&store_id=eq.${store.id}&order=sort_order.asc,name.asc`
    ),
    todayStats(env, store).catch(() => null),
  ]);

  const rows = await readJsonResponse(response, 'Não foi possível carregar o cardápio.');
  const hidden = new Set(hiddenCategories(store).map(normalizeName));
  const zones = await getDeliveryZones(env, store.id, true);
  const now = Date.now();
  const products = [];

  for (const { product_variants: allVariants, promo_price_cents, promo_starts_at, promo_ends_at, promo_weekdays, ...product } of rows) {
    if (hidden.has(normalizeName(product.category))) continue;
    const variants = sortVariants(allVariants)
      .map(({ id, name, price_cents, bulk_qty, bulk_price_cents, available, image_url }) => ({ id, name, price_cents, bulk_qty, bulk_price_cents, available, image_url }));

    // Produto com variações só está disponível se alguma opção estiver.
    const available = product.available && (!variants.length || variants.some(v => v.available));

    if (!available) continue;

    const promo = promoFor({ promo_price_cents, promo_starts_at, promo_ends_at, promo_weekdays, price_cents: product.price_cents, variants }, now);

    products.push({ ...product, available, variants, promo });
  }

  return json({
    store: publicStore(store, zones),
    products,
    today,
    server_time: new Date(now).toISOString(),
    app_version: appVersion(env),
    // Chave pública dos avisos (para o cliente ativar o aviso do andamento do pedido).
    push_public_key: pushReady(env) ? env.VAPID_PUBLIC_KEY : null,
  });
}

function sortVariants(variants) {
  return [...(variants || [])].sort((a, b) => a.sort_order - b.sort_order);
}

// WhatsApp só com dígitos e sem o 55 do Brasil, pra "(24) 99999-9999" e
// "+55 24 99999-9999" caírem no mesmo cliente.
function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');

  if (digits.length > 11 && digits.startsWith('55')) digits = digits.slice(2);

  return digits;
}

function normalizeName(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function findCustomerByPhone(env, storeId, digits) {
  if (!digits || digits.length < 10) return null;

  const response = await supabaseFetch(env, `customers?select=id,name,phone,address,delivery_zone,is_vip,birthday,birthday_set_at,marketing_opt_in&store_id=eq.${storeId}&phone=eq.${digits}&limit=1`);
  const [customer] = await readJsonResponse(response, 'Não foi possível buscar o cliente.');

  return customer || null;
}

// Esconde os números do endereço (casa, bloco, apto) e corta o ponto de referência: o cliente
// reconhece a rua dele, mas quem digitar o número de outra pessoa não descobre a casa dela.
// Ex.: "Rua das Palmeiras, 120 - bloco 3 - Ref.: portão azul" -> "Rua das Palmeiras, 1•• - bloco •".
function maskAddress(address) {
  return String(address || '')
    .split(/\s*-?\s*\bref(\.|erência|erencia)?\s*:?/i)[0]
    .replace(/\d+/g, n => (n.length > 1 ? n[0] + '•'.repeat(n.length - 1) : '•'))
    .trim()
    .slice(0, 70);
}

function zoneIdByName(zones, name) {
  const target = normalizeName(name);
  return target ? zones.find(z => normalizeName(z.name) === target)?.id || null : null;
}

// Cardápio: o cliente digita o WhatsApp e o sistema reconhece o cadastro.
// Devolve só o primeiro nome e o endereço mascarado (nada de nome completo ou endereço inteiro).
// Confirmação VIP: código nunca é devolvido ao navegador nem registrado em logs.
// O login_attempt já existente faz os contadores e o consumo único com lock no banco.
const VIP_COOKIE = '__Host-garatucaia-vip';
const VIP_CODE_SECONDS = 300;
const VIP_SESSION_SECONDS = 86400;

async function vipToken(env, value) {
  const encoded = textToBase64Url(JSON.stringify({ ...value, audience: env.SUPABASE_URL }));
  return `${encoded}.${await sign(encoded, env.SESSION_SECRET)}`;
}

async function readVipToken(env, token, purpose) {
  if (typeof token !== 'string' || token.length > 2500) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!(await safeEqual(parts[1], await sign(parts[0], env.SESSION_SECRET), env.SESSION_SECRET))) return null;
  try {
    const value = JSON.parse(base64UrlToText(parts[0]));
    return value.purpose === purpose && value.audience === env.SUPABASE_URL && value.exp > Math.floor(Date.now() / 1000) ? value : null;
  } catch { return null; }
}

// O benefício VIP e o endereço salvo exigem confirmação do WhatsApp por código.
const VIP_REQUIRE_CODE = true;

async function vipPhoneVerified(request, env, phone) {
  if (!VIP_REQUIRE_CODE) return true;
  if (!request) return false;
  const store = await getStore(env);
  const session = await readVipToken(env, getCookie(request, VIP_COOKIE), 'vip-session');
  return Boolean(session && session.store_id === store.id && session.phone === normalizePhone(phone));
}

async function vipAttempt(env, key, max, minutes) {
  const response = await supabaseFetch(env, 'rpc/login_attempt', {
    method: 'POST',
    body: JSON.stringify({ p_key: `vip:${key}`, p_max: max, p_lock_minutes: minutes, p_window_minutes: minutes }),
  });
  // Falha fechada: indisponibilidade do contador nunca autoriza um código.
  if (!response.ok) throw new Error('Não foi possível conferir o código agora. Tente novamente mais tarde.');
  return (await response.json()) === true;
}

async function handleVipCodeSend(request, env) {
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);
  if (!/^\d{10,11}$/.test(phone)) return json({ error: 'Informe o WhatsApp com DDD.' }, 400);
  const isTest = env.SUPABASE_URL === 'https://baarxygrjpirsizvpzlu.supabase.co';
  const serviceUrl = env.VIP_WHATSAPP_URL || (!isTest && env.WA_SERVICE_URL);
  const serviceToken = env.VIP_WHATSAPP_TOKEN || (!isTest && env.WA_SERVICE_TOKEN);
  if (!serviceUrl || !serviceToken) return json({ error: 'A confirmação por WhatsApp ainda não está disponível. Você pode comprar sem os benefícios VIP.' }, 503);
  if (isTest && phone !== normalizePhone(env.VIP_TEST_PHONE || '')) return json({ error: 'Nesta versão teste, o envio está liberado apenas para o número de teste autorizado.' }, 403);
  const ip = await sign(request.headers.get('CF-Connecting-IP') || 'local', env.SESSION_SECRET);
  if (!(await vipAttempt(env, `send-ip:${ip}`, 10, 60)) ||
      !(await vipAttempt(env, `send-phone:${phone}`, 3, 60)) ||
      !(await vipAttempt(env, `send-cooldown:${phone}`, 1, 1))) {
    return json({ error: 'Aguarde antes de pedir outro código. Limite de três envios por hora.' }, 429);
  }
  const store = await getStore(env);
  const customer = await findCustomerByPhone(env, store.id, phone);
  if (!customer?.is_vip) return json({ error: 'Este número não tem um cadastro VIP. Continue seu pedido normalmente.' }, 400);
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0] >= 4294960000);
  const code = String(random[0] % 10000).padStart(4, '0');
  const id = crypto.randomUUID();
  const digest = await sign(`vip-code:${id}:${phone}:${code}`, env.SESSION_SECRET);
  const challenge = await vipToken(env, { purpose: 'vip-code', id, phone, store_id: store.id, digest, exp: Math.floor(Date.now() / 1000) + VIP_CODE_SECONDS });
  try {
    const response = await fetch(`${String(serviceUrl).replace(/\/$/, '')}/test`, {
      method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, text: `${isTest ? '[TESTE] ' : ''}${store.name}: seu código para confirmar o WhatsApp VIP é ${code}. Válido por 5 minutos. Não compartilhe este código. Se não foi você, ignore esta mensagem.` }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error('send failed');
  } catch {
    return json({ error: 'Não conseguimos enviar o código. Tente mais tarde ou continue sem benefícios VIP.' }, 503);
  }
  return json({ ok: true, challenge, expires_in: VIP_CODE_SECONDS });
}

async function handleVipCodeVerify(request, env) {
  const body = await request.json().catch(() => ({}));
  const store = await getStore(env);
  const challenge = await readVipToken(env, body.challenge, 'vip-code');
  if (!challenge || challenge.store_id !== store.id || challenge.phone !== normalizePhone(body.phone)) return json({ error: 'Código expirado ou inválido. Solicite outro.' }, 400);
  if (!(await vipAttempt(env, `verify:${challenge.id}`, 5, 10))) return json({ error: 'Limite de tentativas atingido. Solicite outro código.' }, 429);
  const code = String(body.code || '');
  const digest = await sign(`vip-code:${challenge.id}:${challenge.phone}:${code}`, env.SESSION_SECRET);
  if (!/^\d{4}$/.test(code) || !(await safeEqual(digest, challenge.digest, env.SESSION_SECRET))) return json({ error: 'Código incorreto.' }, 400);
  if (!(await vipAttempt(env, `used:${challenge.id}`, 1, 10))) return json({ error: 'Este código já foi utilizado. Solicite outro.' }, 409);
  const token = await vipToken(env, { purpose: 'vip-session', phone: challenge.phone, store_id: store.id, exp: Math.floor(Date.now() / 1000) + VIP_SESSION_SECONDS });
  return json({ ok: true }, 200, { 'Set-Cookie': `${VIP_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${VIP_SESSION_SECONDS}` });
}

// Login opcional do cliente (nome + WhatsApp) — mesmo mecanismo do VIP acima (challenge/sessão
// assinados por HMAC, sem gravar código em texto puro, mesmo limite de tentativas via login_attempt
// e mesmo waService), mas sem exigir cadastro VIP e com cookie de sessão independente. Nunca é
// obrigatório para pedir; fica pronto e inerte até o WhatsApp automático desta loja ser configurado
// (mesma limitação de handleVipCodeSend).
const CUSTOMER_COOKIE = '__Host-pontox-customer';
const CUSTOMER_SESSION_SECONDS = 90 * 86400;

async function customerLoginAttempt(env, key, max, minutes) {
  const response = await supabaseFetch(env, 'rpc/login_attempt', {
    method: 'POST',
    body: JSON.stringify({ p_key: `customer-login:${key}`, p_max: max, p_lock_minutes: minutes, p_window_minutes: minutes }),
  });
  // Falha fechada: indisponibilidade do contador nunca autoriza um código.
  if (!response.ok) throw new Error('Não foi possível conferir o código agora. Tente novamente mais tarde.');
  return (await response.json()) === true;
}

async function handleCustomerLoginSend(request, env) {
  const body = await request.json().catch(() => ({}));
  const name = cleanText(body.name, 80);
  const phone = normalizePhone(body.phone);
  if (!name) return json({ error: 'Informe seu nome.' }, 400);
  if (!/^\d{10,11}$/.test(phone)) return json({ error: 'Informe o WhatsApp com DDD.' }, 400);
  const isTest = env.SUPABASE_URL === 'https://baarxygrjpirsizvpzlu.supabase.co';
  const serviceUrl = env.VIP_WHATSAPP_URL || (!isTest && env.WA_SERVICE_URL);
  const serviceToken = env.VIP_WHATSAPP_TOKEN || (!isTest && env.WA_SERVICE_TOKEN);
  if (!serviceUrl || !serviceToken) return json({ error: 'O login por WhatsApp ainda não está disponível. Você pode fazer seu pedido sem entrar na conta.' }, 503);
  if (isTest && phone !== normalizePhone(env.VIP_TEST_PHONE || '')) return json({ error: 'Nesta versão teste, o envio está liberado apenas para o número de teste autorizado.' }, 403);
  const ip = await sign(request.headers.get('CF-Connecting-IP') || 'local', env.SESSION_SECRET);
  if (!(await customerLoginAttempt(env, `send-ip:${ip}`, 10, 60)) ||
      !(await customerLoginAttempt(env, `send-phone:${phone}`, 3, 60)) ||
      !(await customerLoginAttempt(env, `send-cooldown:${phone}`, 1, 1))) {
    return json({ error: 'Aguarde antes de pedir outro código. Limite de três envios por hora.' }, 429);
  }
  const store = await getStore(env);
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0] >= 4294960000);
  const code = String(random[0] % 10000).padStart(4, '0');
  const id = crypto.randomUUID();
  const digest = await sign(`customer-code:${id}:${phone}:${code}`, env.SESSION_SECRET);
  const challenge = await vipToken(env, { purpose: 'customer-code', id, phone, name, store_id: store.id, digest, exp: Math.floor(Date.now() / 1000) + VIP_CODE_SECONDS });
  try {
    const response = await fetch(`${String(serviceUrl).replace(/\/$/, '')}/test`, {
      method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, text: `${isTest ? '[TESTE] ' : ''}${store.name}: seu código para entrar na conta é ${code}. Válido por 5 minutos. Não compartilhe este código. Se não foi você, ignore esta mensagem.` }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok !== true) throw new Error('send failed');
  } catch {
    return json({ error: 'Não conseguimos enviar o código. Tente mais tarde ou continue sem entrar na conta.' }, 503);
  }
  return json({ ok: true, challenge, expires_in: VIP_CODE_SECONDS });
}

async function handleCustomerLoginVerify(request, env) {
  const body = await request.json().catch(() => ({}));
  const store = await getStore(env);
  const challenge = await readVipToken(env, body.challenge, 'customer-code');
  if (!challenge || challenge.store_id !== store.id || challenge.phone !== normalizePhone(body.phone)) return json({ error: 'Código expirado ou inválido. Solicite outro.' }, 400);
  if (!(await customerLoginAttempt(env, `verify:${challenge.id}`, 5, 10))) return json({ error: 'Limite de tentativas atingido. Solicite outro código.' }, 429);
  const code = String(body.code || '');
  const digest = await sign(`customer-code:${challenge.id}:${challenge.phone}:${code}`, env.SESSION_SECRET);
  if (!/^\d{4}$/.test(code) || !(await safeEqual(digest, challenge.digest, env.SESSION_SECRET))) return json({ error: 'Código incorreto.' }, 400);
  if (!(await customerLoginAttempt(env, `used:${challenge.id}`, 1, 10))) return json({ error: 'Este código já foi utilizado. Solicite outro.' }, 409);
  await upsertCustomer(env, store.id, { phone: challenge.phone, name: challenge.name });
  const token = await vipToken(env, { purpose: 'customer-session', phone: challenge.phone, name: challenge.name, store_id: store.id, exp: Math.floor(Date.now() / 1000) + CUSTOMER_SESSION_SECONDS });
  return json({ ok: true, name: challenge.name }, 200, { 'Set-Cookie': `${CUSTOMER_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${CUSTOMER_SESSION_SECONDS}` });
}

async function handleCustomerSession(request, env) {
  const store = await getStore(env);
  const session = await readVipToken(env, getCookie(request, CUSTOMER_COOKIE), 'customer-session');
  if (!session || session.store_id !== store.id) return json({ logged_in: false });
  return json({ logged_in: true, name: session.name, phone: session.phone });
}

async function handleCustomerLookup(request, env) {
  const body = await request.json().catch(() => ({}));
  const digits = normalizePhone(body.phone);

  if (digits.length < 10 || digits.length > 11) return json({ found: false });

  const store = await getStore(env);
  const customer = await findCustomerByPhone(env, store.id, digits);

  if (!customer) return json({ found: false });

  if (customer.is_vip && !(await vipPhoneVerified(request, env, digits))) {
    return json({ found: true, vip: false, verification_required: true, first_name: null, address: null });
  }

  const name = String(customer.name || '').trim();
  const first = name.split(/\s+/)[0];
  const zones = await getDeliveryZones(env, store.id, true);
  const hasRealName = first.replace(/[^\p{L}]/gu, '').length >= 2 && !/^cliente$/i.test(first);

  return json({
    found: true,
    vip: Boolean(customer.is_vip),
    verification_required: false,
    first_name: hasRealName ? first : null,
    address: customer.address
      ? { masked: maskAddress(customer.address), zone_id: zoneIdByName(zones, customer.delivery_zone), zone_name: customer.delivery_zone || null }
      : null,
  });
}

// Cardápio: o que mostrar para o cliente deste aparelho (VIP, presente de aniversário,
// "hora de repor"). A prova de que é ele são os ids dos pedidos que o próprio aparelho
// guardou (uuid impossível de adivinhar) — só o WhatsApp não basta para ver hábitos de compra.
async function handleCustomerInsights(request, env) {
  const body = await request.json().catch(() => ({}));
  const ids = (Array.isArray(body.order_ids) ? body.order_ids : []).filter(validUuid).slice(0, 10);

  if (!ids.length) return json({ found: false });

  const store = await getStore(env);
  const ordersResponse = await supabaseFetch(env, `orders?select=customer_id,created_at&store_id=eq.${store.id}&id=in.(${ids.join(',')})&customer_id=not.is.null&order=created_at.desc&limit=1`);
  const [ref] = await readJsonResponse(ordersResponse, 'Não foi possível carregar.');

  if (!ref) return json({ found: false });

  const response = await supabaseFetch(env, `customers?select=id,phone,is_vip,highlight,birthday,birthday_set_at,marketing_opt_in,orders(status,created_at,order_items(product_id,variant_id,product_name))&id=eq.${ref.customer_id}`);
  const [customer] = await readJsonResponse(response, 'Não foi possível carregar.');

  if (!customer) return json({ found: false });

  if (customer.is_vip && !(await vipPhoneVerified(request, env, customer.phone))) return json({ found: false, verification_required: true });

  const birthdayNow = await birthdayEligible(env, store, customer).catch(() => false);
  const coupon = await openCouponFor(env, customer.id).catch(() => null);

  return json({
    found: true,
    coupon_cents: coupon?.amount_cents || 0,
    vip: customer.is_vip,
    highlight: customer.highlight,
    has_birthday: Boolean(customer.birthday),
    opted_in: customer.marketing_opt_in,
    birthday_offer: birthdayNow ? birthdayOfferText(birthdaySettings(store)) : null,
    repeat: repeatSuggestions(customer.orders).map(({ product_id, variant_id, name, every_days }) => ({ product_id, variant_id, name, every_days })),
  });
}

// Carrinho abandonado: o checkout avisa quando o cliente já digitou o WhatsApp.
// Se ele fechar o pedido, o carrinho é marcado como recuperado.
async function handleCartDraft(request, env) {
  const body = await request.json().catch(() => ({}));
  const phone = normalizePhone(body.phone);

  if (phone.length < 10 || phone.length > 11) return json({ ok: false });

  const items = (Array.isArray(body.items) ? body.items : [])
    .slice(0, 100)
    .filter(i => validUuid(i?.product_id) && (!i.variant_id || validUuid(i.variant_id)))
    .map(i => ({ product_id: i.product_id, variant_id: i.variant_id || null, quantity: Math.min(99, Math.max(1, Math.floor(Number(i.quantity)) || 1)), name: cleanText(i.name, 120) }));

  if (!items.length) return json({ ok: false });

  const store = await getStore(env);
  const customer = await findCustomerByPhone(env, store.id, phone);
  if (customer?.is_vip && !(await vipPhoneVerified(request, env, phone))) return json({ ok: false });
  const response = await supabaseFetch(env, 'abandoned_carts?on_conflict=store_id,phone', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      store_id: store.id,
      phone,
      customer_name: cleanText(body.name, 80) || null,
      items,
      subtotal_cents: toCents(body.subtotal_cents) || 0,
      marketing_opt_in: body.marketing_opt_in === true,
      updated_at: new Date().toISOString(),
      reminded_at: null,
      recovered_order_id: null,
    }),
  });

  if (!response.ok) console.error('cart draft', response.status, await response.text());

  return json({ ok: response.ok });
}

// Carrinhos parados há mais de 30 min (até 3 dias) que não viraram pedido.
async function handleAbandonedCarts(request, env) {
  const store = await getStore(env);
  const to = new Date(Date.now() - 30 * 60000).toISOString();
  const from = new Date(Date.now() - 3 * DAY_MS).toISOString();

  const [cartsResponse, customersResponse] = await Promise.all([
    supabaseFetch(env, `abandoned_carts?select=*&store_id=eq.${store.id}&recovered_order_id=is.null&updated_at=gte.${encodeURIComponent(from)}&updated_at=lte.${encodeURIComponent(to)}&order=updated_at.desc`),
    supabaseFetch(env, `customers?select=id,phone,name,marketing_opt_in&store_id=eq.${store.id}&marketing_opt_in=is.true`),
  ]);
  const carts = await readJsonResponse(cartsResponse, 'Não foi possível carregar os carrinhos.');
  const optedIn = new Map((await readJsonResponse(customersResponse, 'Não foi possível carregar os carrinhos.')).map(c => [c.phone, c]));

  return json({
    carts: carts.map(c => ({ ...c, customer_id: optedIn.get(c.phone)?.id || null, can_message: c.marketing_opt_in || optedIn.has(c.phone) })),
  });
}

async function handleCartReminded(request, env, cartId) {
  if (!validUuid(cartId)) return json({ error: 'Carrinho inválido.' }, 400);

  await readJsonResponse(await supabaseFetch(env, `abandoned_carts?id=eq.${cartId}`, {
    method: 'PATCH',
    body: JSON.stringify({ reminded_at: new Date().toISOString() }),
  }), 'Não foi possível salvar.');

  return json({ ok: true });
}

/* ----- Resumo do dia para o dono ----- */

// 01:30 UTC = 22:30 em São Paulo (precisa bater com wrangler.jsonc).
const DAILY_SUMMARY_CRON = '30 1 * * *';

async function dailySummary(env, store, date) {
  const [ordersResponse, productsResponse, auditResponse] = await Promise.all([
    supabaseFetch(env, `orders?select=id,order_number,status,delivery_type,total_cents,subtotal_cents,delivery_fee_cents,discount_cents,payment_method,payment_split,payment_status,created_at,closed_at,cancel_reason,courier_issue,order_items(product_name,product_id,variant_id,quantity,subtotal_cents,cost_cents)&store_id=eq.${store.id}&created_at=gte.${encodeURIComponent(dayStart(date))}&created_at=lte.${encodeURIComponent(dayEnd(date))}&limit=2000`),
    supabaseFetch(env, `products?select=name,available,featured,suggest&store_id=eq.${store.id}&available=is.false&or=(featured.is.true,suggest.is.true)`),
    supabaseFetch(env, `audit_log?select=action,summary&store_id=eq.${store.id}&action=in.(order.refund,order.discount,order.courier_issue)&created_at=gte.${encodeURIComponent(dayStart(date))}&created_at=lte.${encodeURIComponent(dayEnd(date))}`),
  ]);
  const orders = await readJsonResponse(ordersResponse, 'Não foi possível montar o resumo.');
  const outOfStock = await readJsonResponse(productsResponse, 'Não foi possível montar o resumo.');
  const events = await readJsonResponse(auditResponse, 'Não foi possível montar o resumo.');

  const valid = orders.filter(o => o.status !== 'cancelled');
  const cancelled = orders.filter(o => o.status === 'cancelled');
  const revenue = valid.reduce((s, o) => s + o.total_cents, 0);
  const margin = (store.default_margin_percent ?? 30) / 100;
  let profit = 0;
  let costKnown = 0;
  const products = new Map();

  for (const o of valid) {
    for (const i of o.order_items) {
      // Lucro do item: preço − custo cadastrado; sem custo, usa a margem padrão da loja.
      profit += i.cost_cents != null ? i.subtotal_cents - i.cost_cents * i.quantity : Math.round(i.subtotal_cents * margin);
      if (i.cost_cents != null) costKnown++;

      const name = i.product_name.replace(/ \(\d+ engradados? de \d+\)$/, '');
      const p = products.get(name) || { name, quantity: 0, total_cents: 0 };
      p.quantity += i.quantity;
      p.total_cents += i.subtotal_cents;
      products.set(name, p);
    }

    profit -= o.discount_cents || 0;
  }

  const payments = {};
  for (const o of valid.filter(x => x.payment_status === 'paid')) {
    for (const p of paymentParts(o)) payments[p.method] = (payments[p.method] || 0) + p.cents;
  }

  const late = valid.filter(o => o.status === 'delivered' && o.closed_at && new Date(o.closed_at).getTime() > orderDeadline(o, store));
  const reasons = {};
  for (const o of cancelled) reasons[o.cancel_reason || 'sem motivo'] = (reasons[o.cancel_reason || 'sem motivo'] || 0) + 1;

  return {
    date,
    orders_count: valid.length,
    cancelled_count: cancelled.length,
    revenue_cents: revenue,
    delivery_fees_cents: valid.reduce((s, o) => s + o.delivery_fee_cents, 0),
    discounts_cents: valid.reduce((s, o) => s + (o.discount_cents || 0), 0),
    average_ticket_cents: valid.length ? Math.round(revenue / valid.length) : 0,
    profit_cents: profit,
    profit_based_on_cost: costKnown > 0,
    margin_percent: store.default_margin_percent ?? 30,
    pending_cents: valid.filter(o => o.payment_status !== 'paid').reduce((s, o) => s + o.total_cents, 0),
    payments,
    top_products: [...products.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 8),
    out_of_stock: outOfStock.map(p => p.name),
    occurrences: {
      cancel_reasons: reasons,
      late_count: late.length,
      late_orders: late.map(o => o.order_number),
      courier_issues: valid.filter(o => o.courier_issue).map(o => ({ order_number: o.order_number, issue: o.courier_issue })),
      refunds: events.filter(e => e.action === 'order.refund').map(e => e.summary),
      discounts_given: events.filter(e => e.action === 'order.discount').length,
    },
  };
}

async function handleDailySummary(request, env) {
  const url = new URL(request.url);
  const date = validDate(url.searchParams.get('date')) || todaySaoPaulo();
  const store = await getStore(env);

  return json({ summary: await dailySummary(env, store, date) });
}

// Cron 22:30 (São Paulo): manda o resumo do dia no celular do dono.
async function runDailySummaryPush(env) {
  if (!pushReady(env)) return;

  const store = await getStore(env);
  const s = await dailySummary(env, store, todaySaoPaulo());
  const extras = [
    s.cancelled_count ? `${s.cancelled_count} cancelado(s)` : '',
    s.occurrences.late_count ? `${s.occurrences.late_count} fora do prazo` : '',
    s.occurrences.courier_issues.length ? `${s.occurrences.courier_issues.length} diferença(s) do entregador` : '',
    s.out_of_stock.length ? `${s.out_of_stock.length} destaque(s) esgotado(s)` : '',
  ].filter(Boolean).join(' · ');

  await notifyOwner(env, store.id, {
    title: `📊 Resumo de hoje: ${money(s.revenue_cents)}`,
    body: `${s.orders_count} pedido(s) · ticket ${money(s.average_ticket_cents)} · lucro est. ${money(s.profit_cents)}${extras ? ` · ${extras}` : ''}`,
    url: '/admin.html',
    tag: 'resumo-diario',
  }, true);
}

// Transcreve o áudio do pedido por voz (iPhone). Até ~45 s de WAV 16 kHz (1,5 MB).
async function handleVoiceTranscribe(request, env) {
  if (!env.AI) return json({ error: 'Pedido por voz indisponível no momento.' }, 503);

  const audio = new Uint8Array(await request.arrayBuffer());

  if (audio.length < 2000) return json({ text: '' });
  if (audio.length > 1_500_000) return json({ error: 'Áudio muito longo. Fale um pouco menos de cada vez.' }, 413);

  let binary = '';
  for (let i = 0; i < audio.length; i += 0x8000) binary += String.fromCharCode(...audio.subarray(i, i + 0x8000));

  try {
    const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: btoa(binary),
      task: 'transcribe',
      language: 'pt',
      vad_filter: true,
      initial_prompt: 'Pedido na hamburgueria Ponto X: X-Tudo, X-Bacon, hambúrguer, combo, batata frita, Coca-Cola, Guaravita. Dois lanches e um refrigerante.',
    });
    const text = String(out?.text ?? out?.transcription_info?.text ?? '').trim();

    return json({ text });
  } catch (err) {
    console.error('voice-transcribe', err);
    return json({ error: 'Não consegui entender o áudio. Tente de novo.' }, 502);
  }
}

// Cliente cadastra/muda o aniversário pelo perfil.
// Quem é o cliente: 1º pelos ids dos pedidos guardados no aparelho (prova forte: pode mudar a data);
// 2º pelo WhatsApp + nome salvos na conta do aparelho (pedidos antigos apagados, pedido sem cadastro
// vinculado...). Pelo WhatsApp só dá para cadastrar a data quando ainda não há uma — mudar exige a
// prova dos pedidos ou o dono no painel. Mudou agora = recomeça a carência (não dá para "virar
// aniversariante" hoje para ganhar o presente).
async function handleCustomerBirthday(request, env) {
  const body = await request.json().catch(() => ({}));
  const ids = (Array.isArray(body.order_ids) ? body.order_ids : []).filter(validUuid).slice(0, 10);
  const digits = normalizePhone(body.phone);
  const name = String(body.name || '').trim().slice(0, 80);

  if (birthdayDistance(body.birthday) === null) return json({ error: 'Data de aniversário inválida.' }, 400);
  if (!ids.length && digits.length < 10) return json({ error: 'Faça um pedido primeiro.' }, 400);

  const store = await getStore(env);
  let customerId = null;
  let strongProof = false;

  if (ids.length) {
    const [ref] = await readJsonResponse(await supabaseFetch(env, `orders?select=customer_id&store_id=eq.${store.id}&id=in.(${ids.join(',')})&customer_id=not.is.null&order=created_at.desc&limit=1`), 'Não foi possível salvar.');

    if (ref) {
      customerId = ref.customer_id;
      strongProof = true;
    }
  }

  if (!customerId && digits.length >= 10 && digits.length <= 11) {
    const customer = await findCustomerByPhone(env, store.id, digits);

    if (customer) {
      if (customer.birthday && customer.birthday !== body.birthday) {
        return json({ error: 'Seu aniversário já está cadastrado com outra data. Para mudar, fale com a loja pelo WhatsApp.' }, 409);
      }
      customerId = customer.id;
    } else if (name.replace(/[^\p{L}]/gu, '').length >= 2) {
      // Tem nome e WhatsApp na conta do aparelho, mas nenhum cadastro na loja ainda: cria já com a data.
      const created = await upsertCustomer(env, store.id, { phone: digits, name, birthday: body.birthday });

      if (created) return json({ ok: true, birthday: body.birthday });
    }
  }

  if (!customerId) return json({ error: 'Não achamos seu cadastro. Confira o WhatsApp em "Minha conta" ou faça um pedido.' }, 404);

  const [current] = await readJsonResponse(await supabaseFetch(env, `customers?select=birthday,is_vip,phone&id=eq.${customerId}`), 'Não foi possível salvar.');
  if (current?.is_vip && !(await vipPhoneVerified(request, env, current.phone))) {
    return json({ error: 'Confirme seu WhatsApp por código no checkout antes de alterar seu cadastro VIP.' }, 403);
  }

  if (current?.birthday !== body.birthday) {
    if (current?.birthday && !strongProof) {
      return json({ error: 'Seu aniversário já está cadastrado com outra data. Para mudar, fale com a loja pelo WhatsApp.' }, 409);
    }

    await readJsonResponse(await supabaseFetch(env, `customers?id=eq.${customerId}`, {
      method: 'PATCH',
      body: JSON.stringify({ birthday: body.birthday, birthday_set_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
    }), 'Não foi possível salvar.');
  }

  return json({ ok: true, birthday: body.birthday });
}

// Cria o cliente na primeira compra ou atualiza nome/endereço nas seguintes.
// Falha aqui não impede o pedido: ele só fica sem perfil vinculado.
async function upsertCustomer(env, storeId, { phone, name, address, zone, birthday, optIn }) {
  const digits = normalizePhone(phone);

  if (digits.length < 10) return null;

  const existing = await findCustomerByPhone(env, storeId, digits).catch(() => null);
  // Mantém o nome do cadastro quando o novo é só um pedaço dele, ou quando é o
  // "Cliente balcão" automático (venda de balcão lançada sem digitar o nome).
  const placeholder = normalizeName(name) === normalizeName('Cliente balcão');
  const keepName = existing && (placeholder || (normalizeName(existing.name).startsWith(normalizeName(name)) && existing.name.length > name.length));
  const now = new Date().toISOString();
  const fields = { store_id: storeId, phone: digits, name: keepName ? existing.name : name, updated_at: now };

  if (address) fields.address = address;
  if (zone) fields.delivery_zone = zone;

  // Aniversário: o cliente só informa uma vez (depois, só o dono muda no painel).
  if (birthday && birthdayDistance(birthday) !== null && !existing?.birthday) {
    fields.birthday = birthday;
    fields.birthday_set_at = now;
  }

  if (optIn && !existing?.marketing_opt_in) {
    fields.marketing_opt_in = true;
    fields.opt_in_at = now;
  }

  try {
    const response = await supabaseFetch(env, 'customers?on_conflict=store_id,phone', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(fields),
    });
    const [customer] = await readJsonResponse(response, 'Não foi possível salvar o cliente.');

    return customer?.id || null;
  } catch (err) {
    console.error('upsertCustomer', err);
    return null;
  }
}

const ADMIN_ORDER_SOURCES = ['balcao', 'whatsapp', 'telefone'];

async function handleCreateOrder(request, env, ctx) {
  return createOrder(env, await request.json().catch(() => null), { fromAdmin: false, ctx, request });
}

// Pedido lançado pelo dono no painel (balcão, WhatsApp, telefone).
async function handleAdminCreateOrder(request, env, ctx, session) {
  return createOrder(env, await request.json().catch(() => null), { fromAdmin: true, ctx, session });
}

// Preço dos itens do carrinho, sempre a partir do banco (nunca do navegador): promoção com
// horário, engradado, engradado gelado e disponibilidade. Usado no pedido novo e em
// "adicionar itens ao pedido". Erro = { response }.
const WEIGHED_MAX_CENTS = 100000; // R$ 1.000,00 por item pesado

async function priceCartItems(env, store, rawList, fromAdmin) {
  const rawItems = Array.isArray(rawList) ? rawList.slice(0, 100) : [];
  const quantities = new Map();

  for (const item of rawItems) {
    const qty = Math.floor(Number(item?.quantity));
    const variantId = item?.variant_id || null;

    if (!validUuid(item?.product_id) || (variantId && !validUuid(variantId)) || !Number.isFinite(qty) || qty < 1 || qty > 99) {
      return { response: json({ error: 'Item inválido no carrinho.' }, 400) };
    }

    const chilled = item?.chilled === true;
    // Produto por kg: o painel pode mandar o valor pesado na balança (o total da linha).
    const weighed = fromAdmin && item?.weighed_cents != null ? toCents(item.weighed_cents) : null;
    if (fromAdmin && item?.weighed_cents != null && (!weighed || weighed > WEIGHED_MAX_CENTS)) {
      return { response: json({ error: 'Valor pesado inválido.' }, 400) };
    }
    const key = `${item.product_id}:${variantId || ''}`;
    const current = quantities.get(key);
    quantities.set(key, {
      productId: item.product_id,
      variantId,
      quantity: (current?.quantity || 0) + qty,
      chilled: Boolean(current?.chilled) || chilled,
      weighed: weighed ?? current?.weighed ?? null,
    });
  }

  if (!quantities.size) {
    return { response: json({ error: 'Seu carrinho está vazio.' }, 400) };
  }

  // Preço sempre vem do banco, nunca do navegador do cliente.
  const ids = [...new Set([...quantities.values()].map(q => q.productId))].join(',');
  const productsResponse = await supabaseFetch(
    env,
    `products?select=id,name,category,price_cents,bulk_qty,bulk_price_cents,cost_cents,chill_fee_cents,promo_price_cents,promo_starts_at,promo_ends_at,promo_weekdays,available,inactive_reason,sold_by_weight,product_variants(id,name,price_cents,bulk_qty,bulk_price_cents,cost_cents,available)&store_id=eq.${store.id}&id=in.(${ids})`
  );
  const products = await readJsonResponse(productsResponse, 'Não foi possível validar os produtos.');

  const byId = new Map(products.map(p => [p.id, p]));
  const items = [];
  let subtotal = 0;
  const unavailable = json({ error: 'Algum produto do carrinho não está mais disponível. Atualize a página.' }, 409);

  for (const { productId, variantId, quantity, chilled, weighed } of quantities.values()) {
    const product = byId.get(productId);

    if (!product || (!fromAdmin && !product.available)) return { response: unavailable };

    if (!product.available && product.inactive_reason === 'preco') {
      return { response: json({ error: `"${product.name}" está inativo para conferência de preço. Corrija o preço e reative antes de vender.` }, 409) };
    }

    // Preço de agora (promoção com horário vale só dentro do horário).
    let unitPrice = unitPriceNow(product, null);
    let variant = null;

    if (product.product_variants.length) {
      variant = product.product_variants.find(v => v.id === variantId);

      if (!variant || (!fromAdmin && !variant.available)) return { response: unavailable };

      unitPrice = variant.price_cents;
    } else if (variantId) {
      return { response: unavailable };
    }

    // Recursos comerciais são habilitados por loja; o servidor não confia no frontend.
    const features = storeFeatures(store);
    const priceSource = variant || product;
    const { total: lineTotal, packs } = features.bulk
      ? linePrice(quantity, unitPrice, priceSource.bulk_qty, priceSource.bulk_price_cents)
      : { total: quantity * unitPrice, packs: 0 };

    // Engradado gelado: + chill_fee por engradado (produto que já é engradado: por unidade).
    const chillPacks = features.chill && chilled && product.chill_fee_cents ? chillPackCount(product, priceSource, quantity) : 0;
    const estimated = lineTotal + chillPacks * product.chill_fee_cents;
    // Por kg: o painel já pode lançar o valor da balança; senão vale o estimado.
    const byWeight = Boolean(features.weight && product.sold_by_weight);
    const itemSubtotal = byWeight && weighed ? weighed : estimated;
    subtotal += itemSubtotal;

    const baseName = variant ? `${product.name} - ${variant.name}` : product.name;
    const notes = [
      packs ? `${packs} engradado${packs > 1 ? 's' : ''} de ${priceSource.bulk_qty}` : '',
      chillPacks ? `${chillPacks > 1 ? `${chillPacks} ` : ''}GELADO${chillPacks > 1 ? 'S' : ''}` : '',
    ].filter(Boolean).join(' · ');

    items.push({
      product_id: product.id,
      // O caixa vê quantos engradados separar (e se vão gelados).
      product_name: notes ? `${baseName} (${notes})` : baseName,
      variant_id: variant?.id || null,
      variant_name: variant?.name || null,
      unit_price_cents: byWeight && weighed ? Math.round(weighed / quantity) : unitPrice,
      quantity,
      subtotal_cents: itemSubtotal,
      cost_cents: variant?.cost_cents ?? product.cost_cents ?? null,
      by_weight: byWeight,
      estimated_cents: byWeight ? estimated : null,
    });
  }

  return { items, subtotal, byId };
}

// Cliente adiciona itens a um pedido que ainda não saiu (prova: o id do pedido, guardado no aparelho).
const ADDABLE_STATUSES = ['received', 'accepted', 'preparing'];

async function handleAddOrderItems(request, env, orderId, ctx) {
  if (!validUuid(orderId)) return json({ error: 'Pedido não encontrado.' }, 404);

  const body = await request.json().catch(() => ({}));
  const store = await getStore(env);
  const [order] = await readJsonResponse(await supabaseFetch(env, `orders?select=id,order_number,public_code,status,payment_status,subtotal_cents,total_cents,pdv_closing_id&id=eq.${orderId}&store_id=eq.${store.id}`), 'Pedido não encontrado.');

  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);

  if (!ADDABLE_STATUSES.includes(order.status) || order.pdv_closing_id) {
    return json({ error: 'Esse pedido já saiu ou foi finalizado. Faça um pedido novo.' }, 409);
  }

  const priced = await priceCartItems(env, store, body.items, false);

  if (priced.response) return priced.response;

  const inserted = await supabaseFetch(env, 'order_items', {
    method: 'POST',
    body: JSON.stringify(priced.items.map(item => ({ ...item, order_id: order.id }))),
  });

  if (!inserted.ok) {
    console.error('add items', inserted.status, await inserted.text());
    return json({ error: 'Não foi possível adicionar os itens. Tente de novo.' }, 500);
  }

  // Total novo; a divisão de pagamento (se havia) era do total antigo.
  const now = new Date().toISOString();
  const [updated] = await readJsonResponse(await supabaseFetch(env, `orders?id=eq.${order.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      subtotal_cents: order.subtotal_cents + priced.subtotal,
      total_cents: order.total_cents + priced.subtotal,
      payment_split: null,
      payment_status: 'pending',
      paid_at: null,
      updated_at: now,
    }),
  }), 'Não foi possível atualizar o pedido.');

  await audit(env, { name: 'Cliente (pelo cardápio)' }, 'order.add_items',
    `Cliente adicionou ${priced.items.length} item(ns) ao pedido #${order.order_number} (+ ${money(priced.subtotal)})`,
    { entity: 'order', entityId: order.id });

  const push = notifyOwner(env, store.id, {
    title: `➕ Itens adicionados ao pedido #${order.order_number}`,
    body: `${priced.items.map(i => `${i.quantity}x ${i.product_name}`).join(', ')} · + ${money(priced.subtotal)}`,
    url: '/admin.html',
    tag: `pedido-${order.id}`,
  }).catch(() => {});

  if (ctx) ctx.waitUntil(push);

  return json({ ok: true, total_cents: updated?.total_cents ?? order.total_cents + priced.subtotal, code: order.public_code });
}

// Avaliação simples depois de entregue (1 a 5 estrelas + comentário opcional). Uma por pedido.
async function handleReviewOrder(request, env, orderId) {
  if (!validUuid(orderId)) return json({ error: 'Pedido não encontrado.' }, 404);

  const body = await request.json().catch(() => ({}));
  const rating = Math.round(Number(body.rating));

  if (!Number.isFinite(rating) || rating < 1 || rating > 5) return json({ error: 'Escolha de 1 a 5 estrelas.' }, 400);

  const [order] = await readJsonResponse(await supabaseFetch(env, `orders?select=id,store_id,customer_id,status&id=eq.${orderId}`), 'Pedido não encontrado.');

  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);
  if (order.status !== 'delivered') return json({ error: 'Dá para avaliar depois que o pedido for entregue.' }, 400);

  const response = await supabaseFetch(env, 'order_reviews', {
    method: 'POST',
    body: JSON.stringify({ order_id: order.id, store_id: order.store_id, customer_id: order.customer_id, rating, comment: cleanText(body.comment, 500) || null }),
  });

  if (response.status === 409) return json({ error: 'Esse pedido já foi avaliado. Obrigado! 💛' }, 409);

  await readJsonResponse(response, 'Não foi possível salvar a avaliação.');

  return json({ ok: true });
}

// Regras em comum para o pedido do site e o do painel. No painel:
// origem obrigatória, telefone opcional no balcão, loja fechada e pedido mínimo
// não bloqueiam, dá pra vender item marcado como esgotado no cardápio, e o
// pedido pode nascer pago e/ou entregue.
async function createOrder(env, body, { fromAdmin, ctx, request, session = null }) {
  if (!body) {
    return json({ error: 'Pedido inválido.' }, 400);
  }

  const store = await getStore(env);

  // Loja fechada: só aceita se o dono ligou "pedido para quando abrir" e o cliente confirmou que entendeu.
  const closedNow = !fromAdmin && !effectiveOpen(store);

  if (closedNow && !(store.accept_scheduled && body.scheduled_ok === true)) {
    const opens = nextOpeningText(store);
    return json({ error: `A loja está fechada no momento.${opens ? ` Abrimos ${opens}.` : ''}` }, 400);
  }

  const source = fromAdmin ? body.source : 'site';

  if (fromAdmin && !ADMIN_ORDER_SOURCES.includes(source)) {
    return json({ error: 'Escolha a origem do pedido.' }, 400);
  }

  const customerName = cleanText(body.customer_name, 80) || (fromAdmin && source === 'balcao' ? 'Cliente balcão' : '');
  const customerPhone = cleanText(body.customer_phone, 20).replace(/[^\d()+\s-]/g, '');
  const deliveryType = DELIVERY_TYPES.includes(body.delivery_type) ? body.delivery_type : null;
  const paymentMethod = PAYMENT_METHODS.includes(body.payment_method) ? body.payment_method : null;
  let address = cleanText(body.address, 300);
  const notes = cleanText(body.notes, 500);

  if (customerName.length < 2) {
    return json({ error: fromAdmin ? 'Informe o nome do cliente.' : 'Informe seu nome.' }, 400);
  }

  const phoneDigits = customerPhone.replace(/\D/g, '');

  // No balcão o telefone é opcional; se vier, precisa ser válido.
  if ((!fromAdmin || source !== 'balcao' || phoneDigits) && phoneDigits.length < 10) {
    return json({ error: 'Informe um WhatsApp válido com DDD.' }, 400);
  }

  if (!deliveryType || !paymentMethod) {
    return json({ error: 'Escolha a forma de entrega e de pagamento.' }, 400);
  }

  const matchedCustomer = await findCustomerByPhone(env, store.id, normalizePhone(customerPhone));
  const vipAllowed = !matchedCustomer?.is_vip || fromAdmin || await vipPhoneVerified(request, env, customerPhone);
  const knownCustomer = vipAllowed ? matchedCustomer : null;
  if (!fromAdmin && body.require_vip && (!vipAllowed || !matchedCustomer?.is_vip)) return json({ error: 'Confirme novamente seu WhatsApp VIP ou revise o pedido sem os benefícios.' }, 409);
  // Um pedido sem confirmação é de convidado: não altera nem vincula o cadastro VIP.
  if (!vipAllowed && body.use_saved_address) return json({ error: 'Confirme seu WhatsApp ou informe um endereço para comprar sem benefícios VIP.' }, 403);

  if (!fromAdmin && deliveryType === 'delivery' && body.use_saved_address) {
    const saved = await findCustomerByPhone(env, store.id, normalizePhone(customerPhone));

    if (!saved?.address) return json({ error: 'Não achamos o endereço do seu cadastro. Informe o endereço de entrega.' }, 400);

    address = saved.address;
  }

  // Sem tamanho mínimo: em algumas regiões o endereço é só quadra + lote ("B-25").
  if (deliveryType === 'delivery' && !address) {
    return json({ error: 'Informe o endereço de entrega.' }, 400);
  }

  const priced = await priceCartItems(env, store, body.items, fromAdmin);

  if (priced.response) return priced.response;

  const features = storeFeatures(store);
  const { items, byId } = priced;
  let subtotal = priced.subtotal;

  if (!fromAdmin && subtotal < store.min_order_cents) {
    return json({ error: 'O pedido não atingiu o valor mínimo.' }, 400);
  }

  // Pedido mínimo por categoria na entrega (ex.: cigarros só com pedido de R$ 20,00 ou mais).
  if (!fromAdmin && features.category_min_orders && deliveryType === 'delivery') {
    for (const rule of store.category_min_orders || []) {
      const hasCategory = [...byId.values()].some(p => items.some(i => i.product_id === p.id) && normalizeName(p.category).includes(normalizeName(rule.match)));

      if (hasCategory && subtotal < rule.min_cents) {
        return json({ error: `Para entrega com ${rule.label}, o pedido mínimo é ${money(rule.min_cents)}.` }, 400);
      }
    }
  }

  // Taxa de entrega: por bairro quando há bairros cadastrados; senão, a taxa única da loja.
  let deliveryFee = 0;
  let deliveryZone = null;
  let deliveryStreet = null;

  if (deliveryType === 'delivery') {
    const zones = await getDeliveryZones(env, store.id, true);

    if (zones.length) {
      const zone = zones.find(z => z.id === body.delivery_zone_id);

      if (!zone) return json({ error: 'Escolha o bairro da entrega.' }, 400);

      deliveryFee = zone.fee_cents;
      deliveryZone = zone.name;
      // Rua escolhida na lista do bairro (a fila de entregas agrupa por ela). Fora da lista = sem rua.
      const street = cleanText(body.delivery_street, 60);
      deliveryStreet = (zone.streets || []).find(s => s.toLowerCase() === street.toLowerCase()) || null;
    } else {
      deliveryFee = store.delivery_fee_cents;
    }
  }

  // Cliente conhecido pelo WhatsApp: VIP não paga entrega; aniversariante ganha o presente.
  let feeWaived = null;

  if (knownCustomer?.is_vip && deliveryType === 'delivery' && deliveryFee > 0) {
    deliveryFee = 0;
    feeWaived = 'vip';
  }

  // Desconto: manual só pelo painel; o de aniversário é automático (se o painel não deu outro).
  let discount = 0;
  let discountReason = null;

  if (fromAdmin && body.discount_cents != null && body.discount_cents !== '') {
    discount = toCents(body.discount_cents);

    if (discount === null || discount >= subtotal + deliveryFee) {
      return json({ error: 'O desconto precisa ser menor que o total do pedido.' }, 400);
    }

    if (discount) discountReason = 'painel';
  }

  if (!discount && knownCustomer && await birthdayEligible(env, store, knownCustomer).catch(() => false)) {
    discount = Math.min(birthdayDiscountCents(store, subtotal), subtotal);
    if (discount) discountReason = 'aniversario';
  }

  // Cupom de compensação que o dono criou (atraso/cancelamento): vale no próximo pedido.
  let coupon = null;

  if (!discount && knownCustomer) {
    coupon = await openCouponFor(env, knownCustomer.id).catch(() => null);

    if (coupon) {
      discount = Math.min(coupon.amount_cents, subtotal);
      discountReason = 'cupom';
    }
  }

  const total = subtotal + deliveryFee - discount;

  const { split: paymentSplit, error: splitError } = parsePaymentSplit(body.payment_split, total);

  if (splitError) return json({ error: splitError }, 400);

  // Com pagamento dividido, a forma "principal" é a da primeira parte.
  const mainMethod = paymentSplit ? paymentSplit[0].method : paymentMethod;

  // Fiado: só a equipe lança, só para cliente cadastrado com fiado liberado e dentro do limite.
  // (O banco confere de novo na hora de lançar no livro do fiado; aqui é para avisar antes.)
  const fiadoCents = paymentSplit
    ? paymentSplit.filter(p => p.method === 'fiado').reduce((sum, p) => sum + p.cents, 0)
    : mainMethod === 'fiado' ? total : 0;

  if (fiadoCents > 0) {
    if (!fromAdmin) return json({ error: 'Forma de pagamento inválida.' }, 400);
    if (phoneDigits.length < 10) return json({ error: 'Fiado precisa do WhatsApp do cliente (é por ele que a dívida fica no cadastro).' }, 400);

    const [credit] = await readJsonResponse(await supabaseFetch(env,
      `customers?select=name,credit_enabled,credit_limit_cents,credit_balance_cents&store_id=eq.${store.id}&phone=eq.${normalizePhone(customerPhone)}&limit=1`),
    'Não foi possível conferir o fiado do cliente.');
    const after = (credit?.credit_balance_cents || 0) + fiadoCents;

    if (after > 0 && !credit?.credit_enabled) {
      return json({ error: credit ? `${credit.name} não tem fiado liberado. O administrador libera no cadastro do cliente (📒 Fiado).` : 'Cliente sem cadastro: o fiado precisa ser liberado no cadastro antes (o cadastro nasce no primeiro pedido pago de outra forma).' }, 400);
    }

    if (after > 0 && after > credit.credit_limit_cents) {
      return json({ error: `Limite do fiado estourado: ${credit.name} deve ${money(credit.credit_balance_cents)}, o limite é ${money(credit.credit_limit_cents)} e esta compra no fiado é ${money(fiadoCents)}.` }, 400);
    }
  }
  const cashDue = cashPartCents({ payment_split: paymentSplit, payment_method: mainMethod, total_cents: total });

  let changeFor = null;

  if (cashDue > 0 && body.change_for_cents != null && body.change_for_cents !== '') {
    changeFor = toCents(body.change_for_cents);

    if (changeFor === null || changeFor < cashDue) {
      return json({ error: `O troco precisa ser para um valor maior que o pago em dinheiro (${money(cashDue)}).` }, 400);
    }
  }

  const customerId = vipAllowed ? await upsertCustomer(env, store.id, {
    phone: customerPhone,
    name: customerName,
    address: deliveryType === 'delivery' ? address : null,
    zone: deliveryZone,
    birthday: /^\d{2}-\d{2}$/.test(body.birthday || '') ? body.birthday : null,
    optIn: body.marketing_opt_in === true,
  }) : null;

  const now = new Date().toISOString();
  const paidNow = fromAdmin && Boolean(body.paid || body.delivered);
  const deliveredNow = fromAdmin && Boolean(body.delivered);
  // Aceite automático (stores.auto_accept, ligado por padrão): o pedido já nasce "aceito".
  const acceptedNow = !deliveredNow && store.auto_accept !== false;

  const orderResponse = await supabaseFetch(env, 'orders', {
    method: 'POST',
    headers: { Prefer: 'return=representation', ...actorHeaders(session || { name: fromAdmin ? 'Painel' : 'Site' }) },
    body: JSON.stringify({
      store_id: store.id,
      source,
      status: deliveredNow ? 'delivered' : acceptedNow ? 'accepted' : 'received',
      accepted_at: acceptedNow ? now : null,
      scheduled: closedNow, // feito com a loja fechada: aguardando a abertura
      closed_at: deliveredNow ? now : null,
      payment_status: paidNow ? 'paid' : 'pending',
      paid_at: paidNow ? now : null,
      customer_id: customerId,
      customer_name: customerName,
      customer_phone: customerPhone,
      delivery_type: deliveryType,
      address: deliveryType === 'delivery' ? address : null,
      delivery_zone: deliveryZone,
      delivery_street: deliveryStreet,
      payment_method: mainMethod,
      ...(paymentSplit ? { payment_split: paymentSplit } : {}),
      change_for_cents: changeFor,
      notes: notes || null,
      subtotal_cents: subtotal,
      delivery_fee_cents: deliveryFee,
      fee_waived: feeWaived,
      discount_cents: discount,
      discount_reason: discountReason,
      total_cents: total,
    }),
  });

  const [order] = await readFiadoResponse(orderResponse, 'Não foi possível registrar o pedido.');

  const itemsResponse = await supabaseFetch(env, 'order_items', {
    method: 'POST',
    body: JSON.stringify(items.map(item => ({ ...item, order_id: order.id }))),
  });

  if (!itemsResponse.ok) {
    console.error('Supabase error (order_items)', itemsResponse.status, await itemsResponse.text());
    await supabaseFetch(env, `orders?id=eq.${order.id}`, { method: 'DELETE' });
    return json({ error: 'Não foi possível registrar o pedido. Tente de novo.' }, 500);
  }

  if (coupon) {
    await supabaseFetch(env, `coupons?id=eq.${coupon.id}&used_order_id=is.null`, {
      method: 'PATCH',
      body: JSON.stringify({ used_order_id: order.id, used_at: new Date().toISOString() }),
    }).catch(err => console.error('coupon use', err));
  }

  // Virou pedido: o carrinho abandonado desse WhatsApp não precisa mais de lembrete.
  if (phoneDigits.length >= 10) {
    const recover = supabaseFetch(env, `abandoned_carts?store_id=eq.${store.id}&phone=eq.${normalizePhone(customerPhone)}&recovered_order_id=is.null`, {
      method: 'PATCH',
      body: JSON.stringify({ recovered_order_id: order.id }),
    }).catch(err => console.error('recover cart', err));

    if (ctx) ctx.waitUntil(recover);
  }

  // Aviso no celular do dono (pedido do site; o que o dono lança no painel não precisa).
  if (!fromAdmin && ctx) {
    ctx.waitUntil(notifyNewOrder(env, store, order, total, customerName, deliveryType, deliveryZone).catch(err => console.error('notifyNewOrder', err)));
  }

  // WhatsApp automático: "pedido aceito" (aceite automático) ou "pedido recebido"
  // (não manda para venda de balcão já entregue na hora).
  if (!deliveredNow && ctx) {
    ctx.waitUntil(autoNotify(env, store, order.id, acceptedNow ? 'accepted' : 'received', storeOrigin(store, env)));
  }

  // Cliente só vê o código aleatório; o número em ordem (order_number) volta só para o painel.
  return json({ id: order.id, code: order.public_code, total_cents: total, ...(fromAdmin ? { order_number: order.order_number } : {}) });
}

async function handleOrderStatus(request, env, orderId) {
  if (!validUuid(orderId)) {
    return json({ error: 'Pedido não encontrado.' }, 404);
  }

  const response = await supabaseFetch(
    env,
    `orders?select=id,public_code,status,delivery_type,payment_method,payment_split,subtotal_cents,delivery_fee_cents,discount_cents,discount_reason,fee_waived,total_cents,created_at,scheduled,order_reviews(rating),order_items(product_id,variant_id,product_name,quantity,subtotal_cents,by_weight,estimated_cents,weighed_at)&id=eq.${orderId}`
  );

  const rows = await readJsonResponse(response, 'Não foi possível carregar o pedido.');

  if (!rows[0]) {
    return json({ error: 'Pedido não encontrado.' }, 404);
  }

  return json({ order: rows[0] });
}

/* ---------------- Admin ---------------- */

const STAFF_ROLES = ['admin', 'caixa', 'entregador'];

// Rotas só de administrador (o funcionário "caixa" recebe 403).
const ADMIN_ONLY_ROUTES = [
  ['GET', /^\/api\/admin\/whatsapp$/],
  ['GET', /^\/api\/admin\/abandoned-carts/],
  ['POST', /^\/api\/admin\/abandoned-carts/],
  ['PATCH', /^\/api\/admin\/store$/],
  ['POST', /^\/api\/admin\/zones$/],
  ['PATCH', /^\/api\/admin\/zones\/[^/]+$/],
  ['DELETE', /^\/api\/admin\/zones\/[^/]+$/],
  ['POST', /^\/api\/admin\/whatsapp\//],
  ['GET', /^\/api\/admin\/wa-qr$/],
  ['POST', /^\/api\/admin\/wa-qr\//],
  ['POST', /^\/api\/admin\/products$/],
  ['DELETE', /^\/api\/admin\/products\/[^/]+$/],
  ['POST', /^\/api\/admin\/products\/[^/]+\/photo$/],
  ['DELETE', /^\/api\/admin\/products\/[^/]+\/photo$/],
  ['GET', /^\/api\/admin\/pdv\//],
  ['POST', /^\/api\/admin\/pdv\//],
  ['GET', /^\/api\/admin\/daily-summary$/],
  ['GET', /^\/api\/admin\/suggestions$/],
  ['POST', /^\/api\/admin\/coupons$/],
  // Fiado: ajuste, estorno, lista geral e cópia do livro são só do administrador.
  ['POST', /^\/api\/admin\/customers\/[^/]+\/credit\/(adjust|reverse)$/],
  ['GET', /^\/api\/admin\/credit(\/.*)?$/],
];
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 5;
const loginDelay = () => new Promise(resolve => setTimeout(resolve, 800));
const PASSWORD_MAX_PER_IP = 5;
const PASSWORD_MAX_GLOBAL = 20;

// Registra uma tentativa (RPC login_attempt, atômica). Se o banco falhar, bloqueia
// a tentativa: indisponibilidade do contador nunca deve desativar o limite de login.
async function loginAttempt(env, key, max, lockMinutes, windowMinutes) {
  try {
    const response = await supabaseFetch(env, 'rpc/login_attempt', {
      method: 'POST',
      body: JSON.stringify({ p_key: key, p_max: max, p_lock_minutes: lockMinutes, p_window_minutes: windowMinutes }),
    });

    if (!response.ok) throw new Error(await response.text());

    return (await response.json()) !== false;
  } catch (err) {
    console.error('loginAttempt', err);
    return false;
  }
}

// Nomes para a tela de login (só quem está ativo; sem PIN, claro).
async function handleLoginUsers(request, env) {
  const store = await getStore(env);
  const response = await supabaseFetch(env, `staff?select=id,name&store_id=eq.${store.id}&active=is.true&order=name.asc`);

  return json({ users: await readJsonResponse(response, 'Não foi possível carregar os usuários.') });
}

// Login por usuário + PIN, ou pela senha do painel (entra como "Dono").
async function handleAdminLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  let user;

  if (body.staff_id) {
    const pin = String(body.pin || '');
    const store = await getStore(env);
    const staff = validUuid(body.staff_id)
      ? (await readJsonResponse(await supabaseFetch(env, `staff?select=*&id=eq.${body.staff_id}&store_id=eq.${store.id}&active=is.true`), 'Não foi possível entrar.'))[0]
      : null;

    if (!staff) {
      await loginDelay();
      return json({ error: 'Usuário não encontrado.' }, 401);
    }

    if (staff.locked_until && new Date(staff.locked_until) > new Date()) {
      return json({ error: `Muitas tentativas erradas. Espere ${PIN_LOCK_MINUTES} minutos e tente de novo.` }, 429);
    }

    if (!validPin(pin) || !(await checkPin(pin, staff.pin_hash, env.SESSION_SECRET))) {
      const attempts = staff.failed_attempts + 1;
      const lock = attempts >= PIN_MAX_ATTEMPTS;

      await supabaseFetch(env, `staff?id=eq.${staff.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          failed_attempts: lock ? 0 : attempts,
          locked_until: lock ? new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString() : null,
        }),
      });
      await loginDelay();
      return json({ error: lock ? `PIN errado ${PIN_MAX_ATTEMPTS} vezes. Bloqueado por ${PIN_LOCK_MINUTES} minutos.` : 'PIN incorreto.' }, 401);
    }

    if (staff.failed_attempts || staff.locked_until) {
      await supabaseFetch(env, `staff?id=eq.${staff.id}`, { method: 'PATCH', body: JSON.stringify({ failed_attempts: 0, locked_until: null }) });
    }

    user = { uid: staff.id, name: staff.name, urole: staff.role, staff_key: await sign(`staff:${staff.id}:${staff.pin_hash}`, env.SESSION_SECRET) };
  } else {
    const password = String(body.password || '');

    // A senha única do painel (ADMIN_PASSWORD) é só da loja principal. ULTRION_PASSWORD (secret opcional)
    // é a senha de suporte da Ultrion: entra como administrador em qualquer loja (auditoria: "Ultrion (suporte)").
    // Nas outras lojas, a equipe entra com nome e PIN.
    const isMain = await isDefaultStore(env);

    if (!isMain && !env.ULTRION_PASSWORD) {
      await loginDelay();
      return json({ error: 'Entre com seu nome e PIN.' }, 401);
    }

    const ipKey = `senha:ip:${request.headers.get('CF-Connecting-IP') || 'desconhecido'}`;
    const globalKey = isMain ? 'senha:geral' : `senha:geral:${await currentStoreId(env)}`;

    // Cada tentativa conta ANTES de conferir a senha: 5 por aparelho (bloqueia 15 min)
    // e 20 no geral em 1 hora (bloqueia a senha por 30 min; o login por PIN continua).
    const [ipOk, globalOk] = await Promise.all([
      loginAttempt(env, ipKey, PASSWORD_MAX_PER_IP, 15, 60),
      loginAttempt(env, globalKey, PASSWORD_MAX_GLOBAL, 30, 60),
    ]);

    if (!ipOk || !globalOk) {
      await loginDelay();
      return json({
        error: !ipOk
          ? 'Muitas tentativas erradas neste aparelho. Espere 15 minutos e tente de novo.'
          : 'A senha do painel está bloqueada por 30 minutos por excesso de tentativas. Entre com seu nome e PIN.',
      }, 429);
    }

    const ownerOk = Boolean(isMain && env.ADMIN_PASSWORD && password && await safeEqual(password, env.ADMIN_PASSWORD, env.SESSION_SECRET));
    const supportOk = !ownerOk && Boolean(env.ULTRION_PASSWORD && password && await safeEqual(password, env.ULTRION_PASSWORD, env.SESSION_SECRET));

    if (!ownerOk && !supportOk) {
      await loginDelay();
      return json({ error: 'Senha incorreta.' }, 401);
    }

    // Acertou: zera os contadores.
    await supabaseFetch(env, `login_throttle?key=in.(${encodeURIComponent(`"${ipKey}","${globalKey}"`)})`, { method: 'DELETE' }).catch(() => {});

    user = { uid: null, name: supportOk ? 'Ultrion (suporte)' : 'Administrador', urole: 'admin' };
  }

  const token = await createAdminSession(env.SESSION_SECRET, { ...user, sid: (await getStore(env)).id });

  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * SESSION_HOURS}`,
  });
}

function handleAdminLogout() {
  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  });
}

async function handleAdminBootstrap(request, env, session) {
  const store = await getStore(env);

  const response = await supabaseFetch(
    env,
    `products?select=*,product_variants(*)&store_id=eq.${store.id}&order=sort_order.asc,name.asc`
  );

  const rows = await readJsonResponse(response, 'Não foi possível carregar os produtos.');
  // Composição dos combos (null = a tabela ainda não foi criada no banco: o painel esconde a seção).
  const components = await loadComponents(env, `store_id=eq.${store.id}`).catch(() => null);
  const products = rows.map(({ product_variants: variants, ...product }) => ({
    ...product,
    variants: sortVariants(variants),
    components: components?.get(product.id) || [],
  }));
  const zones = await getDeliveryZones(env, store.id, false);

  return json({ store: storeForRole(store, session), products: products.map(p => productForRole(p, session)), components_ready: Boolean(components), delivery_zones: zones, me: { name: session.name, role: session.urole } });
}

function pickFields(value, fields) {
  return Object.fromEntries(fields.split(',').filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));
}

function productForRole(product, session) {
  if (session?.urole === 'admin') return product;
  const fields = 'id,name,description,category,price_cents,bulk_qty,bulk_price_cents,chill_fee_cents,promo_price_cents,promo_starts_at,promo_ends_at,promo_weekdays,created_at,image_url,available,inactive_reason,inactive_since,featured,featured_order,suggest,sort_order,sold_by_weight,kg_price_cents,is_addon';
  return { ...pickFields(product, fields), variants: (product.variants || []).map(v => pickFields(v, fields)) };
}

function storeForRole(store, session) {
  if (session?.urole === 'admin') return adminStore(store);
  return pickFields(adminStore(store), 'id,name,phone,whatsapp,address,delivery_rules,profile,is_open,effective_open,closes_at,opens_text,delivery_fee_cents,min_order_cents,delivery_minutes,pickup_minutes,print_settings,whatsapp_templates');
}

// Valores de pedido são operacionais enquanto ele está em andamento ou no caixa aberto pelo funcionário.
async function cashierOrderFilter(env, storeId, session, onlyCash = false) {
  if (session?.urole === 'admin') return '';
  const open = await getOpenCashSession(env, storeId);
  const clauses = onlyCash ? [] : ['status.not.in.(delivered,cancelled)'];
  if (open && session?.uid && open.opened_by_id === session.uid) {
    clauses.push(`and(paid_at.gte.${encodeURIComponent(open.opened_at)},paid_at.lte.${encodeURIComponent(new Date().toISOString())})`);
  }
  return clauses.length ? `&or=(${clauses.join(',')})` : '&id=is.null';
}

async function cashierCanOperateOrder(env, session, orderId) {
  if (session?.urole === 'admin') return true;
  const store = await getStore(env);
  const filter = await cashierOrderFilter(env, store.id, session);
  const rows = await readJsonResponse(await supabaseFetch(env, `orders?select=id&store_id=eq.${store.id}&id=eq.${orderId}${filter}`), 'Não foi possível conferir a permissão.');
  return rows.length === 1;
}

/* ---------------- Auditoria ---------------- */

// Registra quem fez o quê. Nunca derruba a ação principal se falhar.
async function audit(env, session, action, summary, { entity = null, entityId = null, details = null } = {}) {
  try {
    const store = await getStore(env);
    const response = await supabaseFetch(env, 'audit_log', {
      method: 'POST',
      body: JSON.stringify({
        store_id: store.id,
        user_id: session?.uid || null,
        user_name: session?.name || 'Sistema',
        action,
        entity,
        entity_id: entityId,
        summary: String(summary).slice(0, 500),
        details,
      }),
    });

    if (!response.ok) console.error('audit', response.status, await response.text());
  } catch (err) {
    console.error('audit', err);
  }
}

async function handleAudit(request, env) {
  const url = new URL(request.url);
  const to = validDate(url.searchParams.get('to')) || todaySaoPaulo();
  const from = validDate(url.searchParams.get('from')) || to;
  const action = url.searchParams.get('action');
  const store = await getStore(env);

  let query = `audit_log?select=*&store_id=eq.${store.id}`
    + `&created_at=gte.${encodeURIComponent(dayStart(from))}&created_at=lte.${encodeURIComponent(dayEnd(to))}`
    + '&order=created_at.desc&limit=1000';

  if (/^[a-z_.]+$/.test(action || '')) query += `&action=like.${encodeURIComponent(action)}*`;

  const response = await supabaseFetch(env, query);

  return json({ from, to, entries: await readJsonResponse(response, 'Não foi possível carregar a auditoria.') });
}

/* ---------------- Despacho e entregador ---------------- */

const ORDER_REF = 'id,order_number,public_code,status,delivery_type,customer_name,total_cents,pdv_closing_id';

async function handleCouriers(request, env) {
  const store = await getStore(env);
  const response = await supabaseFetch(env, `staff?select=id,name&store_id=eq.${store.id}&role=eq.entregador&active=is.true&order=name.asc`);

  return json({ couriers: await readJsonResponse(response, 'Não foi possível carregar os entregadores.') });
}

// Caixa conferiu os itens e entrega o pedido para um entregador: status "saiu para entrega".
async function handleDispatch(request, env, orderId, ctx, session) {
  if (!validUuid(orderId)) return json({ error: 'Pedido inválido.' }, 400);

  const body = await request.json().catch(() => ({}));

  if (body.checked !== true) return json({ error: 'Confira todos os itens antes de despachar.' }, 400);
  if (!validUuid(body.courier_id)) return json({ error: 'Escolha o entregador.' }, 400);

  const store = await getStore(env);
  const [[order], [courier]] = await Promise.all([
    readJsonResponse(await supabaseFetch(env, `orders?select=${ORDER_REF}&id=eq.${orderId}&store_id=eq.${store.id}`), 'Não foi possível despachar.'),
    readJsonResponse(await supabaseFetch(env, `staff?select=id,name&id=eq.${body.courier_id}&store_id=eq.${store.id}&role=eq.entregador&active=is.true`), 'Não foi possível despachar.'),
  ]);

  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);
  if (!courier) return json({ error: 'Entregador não encontrado.' }, 404);
  if (order.delivery_type !== 'delivery') return json({ error: 'Pedido de retirada não é despachado.' }, 400);
  if (!['received', 'accepted', 'preparing'].includes(order.status)) return json({ error: 'Este pedido já saiu ou foi finalizado.' }, 409);

  const now = new Date().toISOString();
  const street = cleanText(body.delivery_street, 60);
  const response = await supabaseFetch(env, `orders?id=eq.${orderId}&status=in.(received,accepted,preparing)`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'out_for_delivery',
      courier_id: courier.id,
      courier_name: courier.name,
      dispatched_at: now,
      dispatched_by: session.name,
      courier_confirmed_at: null,
      courier_issue: null,
      ...(street ? { delivery_street: street } : {}),
      updated_at: now,
    }),
  });
  const [updated] = await readJsonResponse(response, 'Não foi possível despachar.');

  if (!updated) return json({ error: 'Este pedido acabou de mudar. Atualize a tela.' }, 409);

  await audit(env, session, 'order.dispatch', `Conferiu e despachou o pedido #${order.order_number} com ${courier.name}`, { entity: 'order', entityId: orderId });

  // Celular do entregador: a entrega é dele agora.
  const push = notifyCouriers(env, store.id, {
    title: `🛵 Entrega pra você: pedido ${order.public_code}`,
    body: `${[updated.delivery_zone, updated.delivery_street].filter(Boolean).join(' · ') || 'Entrega'} — confira os itens antes de sair.`,
    url: '/admin.html',
    tag: `pedido-${orderId}`,
  }, courier.id).catch(err => console.error('push courier', err));

  if (ctx) ctx.waitUntil(push);

  if (ctx) {
    ctx.waitUntil(autoNotify(env, store, orderId, 'out_for_delivery', storeOrigin(store, env)));
  }

  return json({ order: updated });
}

// Tela do entregador: os pedidos que estão com ele agora + os que ele entregou hoje.
async function handleCourierOrders(request, env, session) {
  const store = await getStore(env);
  const today = todaySaoPaulo();
  const fields = 'id,public_code,status,customer_name,customer_phone,address,delivery_zone,delivery_street,notes,total_cents,payment_method,payment_split,payment_status,change_for_cents,dispatched_at,dispatched_by,courier_confirmed_at,courier_issue,closed_at,created_at,order_items(product_name,quantity)';

  const [activeResponse, doneResponse, upcomingResponse] = await Promise.all([
    supabaseFetch(env, `orders?select=${fields}&store_id=eq.${store.id}&courier_id=eq.${session.uid}&status=eq.out_for_delivery&order=dispatched_at.asc`),
    supabaseFetch(env, `orders?select=id,public_code,customer_name,total_cents,closed_at&store_id=eq.${store.id}&courier_id=eq.${session.uid}&status=eq.delivered&closed_at=gte.${encodeURIComponent(dayStart(today))}&order=closed_at.desc`),
    // Pedidos de entrega que chegaram e ainda estão na loja (sem nome nem valor: só para ele se preparar).
    supabaseFetch(env, `orders?select=id,public_code,status,delivery_zone,delivery_street,created_at&store_id=eq.${store.id}&delivery_type=eq.delivery&status=in.(received,accepted,preparing)&created_at=gte.${encodeURIComponent(dayStart(today))}&order=created_at.asc`),
  ]);

  return json({
    active: await readJsonResponse(activeResponse, 'Não foi possível carregar as entregas.'),
    delivered_today: await readJsonResponse(doneResponse, 'Não foi possível carregar as entregas.'),
    upcoming: await readJsonResponse(upcomingResponse, 'Não foi possível carregar as entregas.'),
    app_version: appVersion(env),
  });
}

async function courierOrder(env, session, orderId) {
  if (!validUuid(orderId)) return null;

  const response = await supabaseFetch(env, `orders?select=${ORDER_REF},courier_id,courier_confirmed_at,payment_status&id=eq.${orderId}&courier_id=eq.${session.uid}`);
  const [order] = await readJsonResponse(response, 'Não foi possível carregar o pedido.');

  return order || null;
}

// Entregador confirma que pegou exatamente os itens (ou aponta a diferença).
async function handleCourierConfirm(request, env, orderId, session) {
  const order = await courierOrder(env, session, orderId);

  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);
  if (order.status !== 'out_for_delivery') return json({ error: 'Este pedido não está mais em entrega.' }, 409);

  const body = await request.json().catch(() => ({}));
  const issue = body.ok === false ? cleanText(body.issue, 300) : '';

  if (body.ok === false && issue.length < 3) return json({ error: 'Descreva a diferença.' }, 400);

  const now = new Date().toISOString();
  await readJsonResponse(await supabaseFetch(env, `orders?id=eq.${orderId}`, {
    method: 'PATCH',
    body: JSON.stringify({ courier_confirmed_at: now, courier_issue: issue || null, updated_at: now }),
  }), 'Não foi possível confirmar.');

  await audit(env, session, issue ? 'order.courier_issue' : 'order.courier_confirm',
    issue ? `Apontou diferença nos itens do pedido #${order.order_number}: ${issue}` : `Confirmou os itens do pedido #${order.order_number}`,
    { entity: 'order', entityId: orderId });

  if (issue) {
    const store = await getStore(env);
    await notifyOwner(env, store.id, {
      title: `⚠️ Diferença no pedido #${order.order_number}`,
      body: `${session.name}: ${issue}`,
      url: '/admin.html',
      tag: `diferenca-${orderId}`,
    }).catch(() => {});
  }

  return json({ ok: true });
}

// Entregador entregou e diz como o cliente pagou.
async function handleCourierDelivered(request, env, orderId, ctx, session) {
  const order = await courierOrder(env, session, orderId);

  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);
  if (order.status !== 'out_for_delivery') return json({ error: 'Este pedido não está mais em entrega.' }, 409);
  if (!order.courier_confirmed_at) return json({ error: 'Confira os itens antes de entregar.' }, 400);

  const body = await request.json().catch(() => ({}));
  const now = new Date().toISOString();
  const fields = { status: 'delivered', closed_at: now, updated_at: now };

  // Fiado é decidido na loja (painel), nunca pelo entregador na rua.
  if (body.payment_method === 'fiado' || body.payment_split?.first_method === 'fiado' || body.payment_split?.second_method === 'fiado') {
    return json({ error: 'Fiado só pode ser lançado pela loja. Avise o caixa.' }, 403);
  }

  if (body.payment_split) {
    const { split, error } = parsePaymentSplit(body.payment_split, order.total_cents);
    if (error) return json({ error }, 400);
    Object.assign(fields, { payment_split: split, payment_method: split[0].method, payment_status: 'paid', paid_at: now });
  } else if (PAYMENT_METHODS.includes(body.payment_method)) {
    Object.assign(fields, { payment_method: body.payment_method, payment_split: null, payment_status: 'paid', paid_at: now });
  } else if (order.payment_status !== 'paid' && (order.payment_method === 'fiado' || order.payment_split?.some?.(p => p.method === 'fiado'))) {
    // Pedido que a loja já lançou no fiado: entregou = vai para a conta do cliente (o banco confere o limite).
    Object.assign(fields, { payment_status: 'paid', paid_at: now });
  } else if (order.payment_status !== 'paid') {
    return json({ error: 'Diga como o cliente pagou.' }, 400);
  }

  await readFiadoResponse(await supabaseFetch(env, `orders?id=eq.${orderId}&status=eq.out_for_delivery`, {
    method: 'PATCH',
    headers: actorHeaders(session),
    body: JSON.stringify(fields),
  }), 'Não foi possível marcar como entregue.');

  await audit(env, session, 'order.delivered',
    `Entregou o pedido #${order.order_number}${fields.payment_method ? ` (${paymentText({ ...order, ...fields })})` : ''}`,
    { entity: 'order', entityId: orderId });

  if (ctx) {
    ctx.waitUntil(getStore(env).then(store => autoNotify(env, store, orderId, 'delivered', storeOrigin(store, env))));
  }

  return json({ ok: true });
}

/* ---------------- Usuários do painel ---------------- */

function readStaffFields(body, partial) {
  const fields = {};

  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, 60);
    if (name.length < 2) return { error: 'Informe o nome (pelo menos 2 letras).' };
    fields.name = name;
  }

  if (!partial || body.role !== undefined) {
    if (!STAFF_ROLES.includes(body.role)) return { error: 'Função inválida.' };
    fields.role = body.role;
  }

  if (partial && body.active !== undefined) fields.active = Boolean(body.active);

  return { fields };
}

async function handleListStaff(request, env) {
  const store = await getStore(env);
  const response = await supabaseFetch(env, `staff?select=id,name,role,active,created_at&store_id=eq.${store.id}&order=active.desc,name.asc`);

  return json({ staff: await readJsonResponse(response, 'Não foi possível carregar os usuários.') });
}

async function handleCreateStaff(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const { fields, error } = readStaffFields(body, false);

  if (error) return json({ error }, 400);
  if (!validPin(body.pin)) return json({ error: 'O PIN precisa ter de 4 a 6 números.' }, 400);

  const store = await getStore(env);
  const response = await supabaseFetch(env, 'staff', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...fields, store_id: store.id, pin_hash: await hashPin(String(body.pin)) }),
  });
  const [staff] = await readJsonResponse(response, 'Não foi possível criar o usuário.');

  await audit(env, session, 'staff.create', `Criou o usuário ${staff.name} (${staff.role})`, { entity: 'staff', entityId: staff.id });

  return json({ staff: { id: staff.id, name: staff.name, role: staff.role, active: staff.active } });
}

async function handleUpdateStaff(request, env, staffId, session) {
  if (!validUuid(staffId)) return json({ error: 'Usuário inválido.' }, 400);

  const body = await request.json().catch(() => ({}));
  const { fields, error } = readStaffFields(body, true);

  if (error) return json({ error }, 400);

  if (body.pin !== undefined) {
    if (!validPin(body.pin)) return json({ error: 'O PIN precisa ter de 4 a 6 números.' }, 400);
    fields.pin_hash = await hashPin(String(body.pin));
    fields.failed_attempts = 0;
    fields.locked_until = null;
  }

  if (staffId === session.uid && (fields.active === false || (fields.role && fields.role !== 'admin'))) {
    return json({ error: 'Você não pode desativar nem tirar o administrador de si mesmo.' }, 400);
  }

  if (!Object.keys(fields).length) return json({ error: 'Nada para atualizar.' }, 400);

  const store = await getStore(env);
  const response = await supabaseFetch(env, `staff?id=eq.${staffId}&store_id=eq.${store.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  const [staff] = await readJsonResponse(response, 'Não foi possível salvar o usuário.');

  if (!staff) return json({ error: 'Usuário não encontrado.' }, 404);

  const changes = [
    fields.name && `nome ${staff.name}`,
    fields.role && `função ${staff.role}`,
    fields.active !== undefined && (staff.active ? 'reativou' : 'desativou'),
    fields.pin_hash && 'trocou o PIN',
  ].filter(Boolean).join(', ');
  await audit(env, session, 'staff.update', `Alterou o usuário ${staff.name}: ${changes}`, { entity: 'staff', entityId: staff.id });

  return json({ staff: { id: staff.id, name: staff.name, role: staff.role, active: staff.active } });
}

// Loja + situação calculada agora (aberta pelo horário automático ou pelo botão).
function adminStore(store) {
  return {
    ...store,
    effective_open: effectiveOpen(store),
    closes_at: closingTimeToday(store),
    opens_text: nextOpeningText(store),
  };
}

// Variações (ex.: Carvão 2,5 kg / 5 kg). Lista vazia = produto sem variações.
function readVariants(body) {
  if (body.variants === undefined) return { variants: undefined };

  if (!Array.isArray(body.variants) || body.variants.length > 50) {
    return { error: 'Variações inválidas.' };
  }

  const variants = [];

  for (const raw of body.variants) {
    const name = cleanText(raw?.name, 60);
    const price = toCents(raw?.price_cents);

    if (!name) return { error: 'Toda variação precisa de um nome.' };

    if (price === null) return { error: `Preço inválido na variação "${name}".` };

    if (raw?.id && !validUuid(raw.id)) return { error: 'Variação inválida.' };

    const extra = readBulkAndCost(raw || {});

    if (extra.error) return { error: `${extra.error} (variação "${name}")` };

    variants.push({
      id: raw?.id || null,
      name,
      price_cents: price,
      available: raw?.available === undefined ? true : Boolean(raw.available),
      bulk_qty: extra.fields.bulk_qty ?? null,
      bulk_price_cents: extra.fields.bulk_price_cents ?? null,
      cost_cents: extra.fields.cost_cents ?? null,
    });
  }

  return { variants };
}

// Engradado (quantidade + preço do engradado) e custo. Vazio = sem engradado / sem custo.
function readBulkAndCost(raw) {
  const fields = {};

  if (raw.bulk_qty !== undefined || raw.bulk_price_cents !== undefined) {
    const qty = raw.bulk_qty === null || raw.bulk_qty === '' ? null : Math.floor(Number(raw.bulk_qty));
    const price = raw.bulk_price_cents === null || raw.bulk_price_cents === '' ? null : toCents(raw.bulk_price_cents);

    if ((qty === null) !== (price === null)) return { error: 'Informe a quantidade e o preço do engradado (ou deixe os dois vazios).' };
    if (qty !== null && (!Number.isFinite(qty) || qty < 2 || qty > 100)) return { error: 'O engradado precisa ter de 2 a 100 unidades.' };

    fields.bulk_qty = qty;
    fields.bulk_price_cents = price;
  }

  if (raw.cost_cents !== undefined) {
    const cost = raw.cost_cents === null || raw.cost_cents === '' ? null : toCents(raw.cost_cents);
    if (raw.cost_cents !== null && raw.cost_cents !== '' && cost === null) return { error: 'Custo inválido.' };
    fields.cost_cents = cost;
  }

  return { fields };
}

// Deixa as variações do produto iguais à lista recebida (atualiza, cria e apaga).
async function syncVariants(env, productId, variants) {
  const existingResponse = await supabaseFetch(env, `product_variants?select=id&product_id=eq.${productId}`);
  const existing = await readJsonResponse(existingResponse, 'Não foi possível salvar as variações.');
  const existingIds = new Set(existing.map(v => v.id));
  const keepIds = new Set(variants.filter(v => v.id && existingIds.has(v.id)).map(v => v.id));

  const toDelete = [...existingIds].filter(id => !keepIds.has(id));

  if (toDelete.length) {
    const photos = await readJsonResponse(await supabaseFetch(env, `product_variants?select=image_url&id=in.(${toDelete.join(',')})&image_url=not.is.null`), 'Não foi possível salvar as variações.');
    const del = await supabaseFetch(env, `product_variants?id=in.(${toDelete.join(',')})`, { method: 'DELETE' });
    for (const { image_url: url } of photos) await deleteStorageObject(env, storageObjectPathFromPublicUrl(env, url)).catch(() => {});
    await readJsonResponse(del, 'Não foi possível salvar as variações.');
  }

  const toInsert = [];

  for (const [index, variant] of variants.entries()) {
    const fields = {
      name: variant.name,
      price_cents: variant.price_cents,
      available: variant.available,
      bulk_qty: variant.bulk_qty,
      bulk_price_cents: variant.bulk_price_cents,
      cost_cents: variant.cost_cents,
      sort_order: index,
    };

    if (variant.id && keepIds.has(variant.id)) {
      const upd = await supabaseFetch(env, `product_variants?id=eq.${variant.id}`, {
        method: 'PATCH',
        body: JSON.stringify(fields),
      });
      await readJsonResponse(upd, 'Não foi possível salvar as variações.');
    } else {
      toInsert.push({ ...fields, product_id: productId });
    }
  }

  if (toInsert.length) {
    const ins = await supabaseFetch(env, 'product_variants', {
      method: 'POST',
      body: JSON.stringify(toInsert),
    });
    await readJsonResponse(ins, 'Não foi possível salvar as variações.');
  }
}

async function productWithVariants(env, productId) {
  const response = await supabaseFetch(env, `products?select=*,product_variants(*)&id=eq.${productId}`);
  const [row] = await readJsonResponse(response, 'Não foi possível carregar o produto.');

  if (!row) return null;

  const { product_variants: variants, ...product } = row;
  const components = await loadComponents(env, `product_id=eq.${productId}`).catch(() => null);

  return { ...product, variants: sortVariants(variants), components: components?.get(productId) || [] };
}

/* ----- Composição do combo (para o futuro controle de estoque) ----- */

// O que sai do estoque quando o combo é vendido. combo_variant_index = posição da opção do
// combo na lista de variações (null = vale para todas as opções).
function readComponents(body) {
  if (body.components === undefined) return { components: undefined };

  if (!Array.isArray(body.components) || body.components.length > 30) return { error: 'Composição do combo inválida.' };

  const components = [];

  for (const raw of body.components) {
    const qty = Math.floor(Number(raw?.qty));
    const index = raw?.combo_variant_index === null || raw?.combo_variant_index === undefined ? null : Math.floor(Number(raw.combo_variant_index));

    if (!validUuid(raw?.product_id)) return { error: 'Escolha o produto de cada item do combo.' };
    if (raw.variant_id && !validUuid(raw.variant_id)) return { error: 'Opção inválida num item do combo.' };
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) return { error: 'A quantidade de cada item do combo vai de 1 a 99.' };
    if (index !== null && (!Number.isFinite(index) || index < 0 || index > 49)) return { error: 'Opção do combo inválida.' };

    components.push({ product_id: raw.product_id, variant_id: raw.variant_id || null, qty, combo_variant_index: index });
  }

  return { components };
}

async function componentsTableReady(env) {
  const response = await supabaseFetch(env, 'product_components?select=id&limit=1');
  return response.ok;
}

// Deixa a composição do combo igual à lista recebida (apaga e grava de novo).
async function syncComponents(env, store, productId, components) {
  const variants = await readJsonResponse(
    await supabaseFetch(env, `product_variants?select=id&product_id=eq.${productId}&order=sort_order.asc`),
    'Não foi possível salvar os itens do combo.'
  );

  const ids = [...new Set(components.map(c => c.product_id))];
  const refs = ids.length
    ? await readJsonResponse(
      await supabaseFetch(env, `products?select=id,name,product_variants(id)&store_id=eq.${store.id}&id=in.(${ids.join(',')})`),
      'Não foi possível salvar os itens do combo.'
    )
    : [];
  const byId = new Map(refs.map(p => [p.id, p]));

  const rows = [];

  for (const [index, c] of components.entries()) {
    const ref = byId.get(c.product_id);

    if (!ref) return 'Um dos produtos do combo não existe mais.';
    if (c.product_id === productId) return 'O combo não pode ter ele mesmo como item.';
    if (c.variant_id && !ref.product_variants.some(v => v.id === c.variant_id)) return `Opção inválida em "${ref.name}".`;
    if (!c.variant_id && ref.product_variants.length) return `Escolha a opção de "${ref.name}" no combo.`;

    const comboVariant = c.combo_variant_index === null ? null : variants[c.combo_variant_index];

    if (c.combo_variant_index !== null && !comboVariant) return 'Um item do combo aponta para uma opção que não existe.';

    rows.push({
      store_id: store.id,
      product_id: productId,
      variant_id: comboVariant ? comboVariant.id : null,
      component_product_id: c.product_id,
      component_variant_id: c.variant_id,
      qty: c.qty,
      sort_order: index,
    });
  }

  await readJsonResponse(
    await supabaseFetch(env, `product_components?product_id=eq.${productId}`, { method: 'DELETE' }),
    'Não foi possível salvar os itens do combo.'
  );

  if (rows.length) {
    await readJsonResponse(
      await supabaseFetch(env, 'product_components', { method: 'POST', body: JSON.stringify(rows) }),
      'Não foi possível salvar os itens do combo.'
    );
  }

  return null;
}

// Grava a composição e registra na auditoria (só quando mudou). Devolve o problema (texto) ou null.
async function saveComponents(env, session, store, productId, components, before) {
  if (!(await componentsTableReady(env))) return 'falta criar a tabela product_components no banco (supabase/schema.sql).';

  const problem = await syncComponents(env, store, productId, components);
  if (problem) return problem;

  const saved = await productWithVariants(env, productId);
  const describe = async list => {
    if (!list?.length) return 'sem itens';
    const ids = [...new Set(list.map(c => c.product_id))];
    const refs = (await readJsonResponse(await supabaseFetch(env, `products?select=id,name,product_variants(id,name)&id=in.(${ids.join(',')})`), 'Não foi possível salvar os itens do combo.'))
      .map(({ product_variants: v, ...p }) => ({ ...p, variants: v }));
    const byOption = new Map();
    for (const c of list) {
      const option = saved.variants.find(v => v.id === c.combo_variant_id)?.name || 'todas';
      if (!byOption.has(option)) byOption.set(option, []);
      byOption.get(option).push(c);
    }
    return [...byOption].map(([option, items]) => `(${option}) ${componentsSummary(items, refs)}`).join('; ');
  };

  const after = await describe(saved.components);
  const previous = before ? await describe(before.components) : 'sem itens';

  if (after !== previous) {
    await audit(env, session, 'product.components', `Itens do combo "${saved.name}": ${after}`.slice(0, 500), { entity: 'product', entityId: productId });
  }

  return null;
}

// Composição de todos os produtos (ou de um só), já no formato do painel. Sem a tabela, lista vazia.
async function loadComponents(env, filter) {
  const response = await supabaseFetch(env, `product_components?select=product_id,variant_id,component_product_id,component_variant_id,qty,sort_order&${filter}&order=sort_order.asc`);
  if (!response.ok) return null;
  const rows = await response.json();
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push({
      combo_variant_id: r.variant_id,
      product_id: r.component_product_id,
      variant_id: r.component_variant_id,
      qty: r.qty,
    });
  }
  return byProduct;
}

function componentsSummary(components, products) {
  return components.map(c => {
    const p = products.find(x => x.id === c.product_id);
    const v = p?.variants?.find(x => x.id === c.variant_id);
    return `${c.qty}× ${p ? p.name : '?'}${v ? ` / ${v.name}` : ''}`;
  }).join(', ');
}

// Auditoria do produto: só o que importa para desvio/erro (preço, disponibilidade, nome).
async function auditProductChanges(env, session, before, after) {
  const changes = [];

  if (before.name !== after.name) changes.push(`nome "${before.name}" → "${after.name}"`);

  if (!after.variants.length && before.price_cents !== after.price_cents) {
    changes.push(`preço ${money(before.price_cents)} → ${money(after.price_cents)}`);
  }

  if (before.bulk_qty !== after.bulk_qty || before.bulk_price_cents !== after.bulk_price_cents) {
    changes.push(after.bulk_qty
      ? `engradado ${before.bulk_qty ? `${before.bulk_qty} por ${money(before.bulk_price_cents)}` : 'nenhum'} → ${after.bulk_qty} por ${money(after.bulk_price_cents)}`
      : 'tirou o preço de engradado');
  }

  if (before.available !== after.available || before.inactive_reason !== after.inactive_reason) {
    changes.push(after.available ? 'reativado' : `inativado por ${INACTIVE_REASONS[after.inactive_reason] || 'estoque'}`);
  }

  const oldVariants = new Map(before.variants.map(v => [v.id, v]));

  for (const v of after.variants) {
    const old = oldVariants.get(v.id);

    if (!old) changes.push(`nova opção "${v.name}" ${money(v.price_cents)}`);
    else if (old.price_cents !== v.price_cents) changes.push(`"${v.name}" ${money(old.price_cents)} → ${money(v.price_cents)}`);
    else if (old.available !== v.available) changes.push(`"${v.name}" ${v.available ? 'disponível' : 'esgotado'}`);

    oldVariants.delete(v.id);
  }

  for (const v of oldVariants.values()) changes.push(`removeu a opção "${v.name}"`);

  if (!changes.length) return;

  const priceChanged = changes.some(c => c.includes('→') && c.includes('R$'));

  await audit(env, session, priceChanged ? 'product.price' : 'product.update', `Produto "${after.name}": ${changes.join('; ')}`, { entity: 'product', entityId: after.id });
}

// Motivos de produto inativo (o cliente não vê produto inativo).
const INACTIVE_REASONS = { estoque: 'estoque', preco: 'erro/conferência de preço' };

function readProductFields(body, partial) {
  const fields = {};

  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, 120);

    if (name.length < 2) return { error: 'Informe o nome do produto.' };

    fields.name = name;
  }

  const { variants, error: variantsError } = readVariants(body);

  if (variantsError) return { error: variantsError };

  // Com variações, o preço do produto passa a ser o menor preço entre elas
  // (usado pra mostrar "a partir de").
  if (variants && variants.length) {
    const available = variants.filter(v => v.available);
    fields.price_cents = Math.min(...(available.length ? available : variants).map(v => v.price_cents));
  } else if (!partial || body.price_cents !== undefined) {
    const price = toCents(body.price_cents);

    if (price === null) return { error: 'Preço inválido.' };

    fields.price_cents = price;
  }

  if (body.description !== undefined) {
    fields.description = cleanText(body.description, 500) || null;
  }

  if (body.category !== undefined) {
    fields.category = cleanText(body.category, 60) || 'Geral';
  }

  // Inativo sempre tem motivo (estoque ou erro/conferência de preço); ativo não tem motivo.
  if (body.available !== undefined) {
    fields.available = Boolean(body.available);
    fields.inactive_reason = fields.available ? null : (INACTIVE_REASONS[body.inactive_reason] ? body.inactive_reason : 'estoque');
    fields.inactive_since = fields.available ? null : new Date().toISOString();
  }

  if (body.sort_order !== undefined) {
    fields.sort_order = Math.floor(Number(body.sort_order)) || 0;
  }

  // "Leve junto": sugerido no carrinho do cliente.
  if (body.sold_by_weight !== undefined) fields.sold_by_weight = Boolean(body.sold_by_weight);

  if (body.kg_price_cents !== undefined) {
    const kg = body.kg_price_cents === null || body.kg_price_cents === '' ? null : toCents(body.kg_price_cents);
    if (kg === 0 || (body.kg_price_cents !== null && body.kg_price_cents !== '' && kg === null)) return { error: 'Preço do quilo inválido.' };
    fields.kg_price_cents = kg;
  }

  if (body.suggest !== undefined) {
    fields.suggest = Boolean(body.suggest);
  }

  // Complemento: aparece em "Turbine seu lanche" dentro dos hambúrgueres.
  if (body.is_addon !== undefined) {
    fields.is_addon = Boolean(body.is_addon);
  }

  // Destaque: aparece também na seção "Mais Vendidos", no topo do cardápio.
  if (body.featured !== undefined) {
    fields.featured = Boolean(body.featured);
  }

  if (body.featured_order !== undefined) {
    fields.featured_order = Math.floor(Number(body.featured_order)) || 0;
  }

  const extra = readBulkAndCost(body);

  if (extra.error) return { error: extra.error };

  Object.assign(fields, extra.fields);

  // Promoção com horário: preço promocional + início/fim (vazio = sem promoção).
  if (body.promo_price_cents !== undefined) {
    const price = body.promo_price_cents === null || body.promo_price_cents === '' ? null : toCents(body.promo_price_cents);
    const starts = body.promo_starts_at ? new Date(body.promo_starts_at) : null;
    const ends = body.promo_ends_at ? new Date(body.promo_ends_at) : null;

    if (body.promo_price_cents !== null && body.promo_price_cents !== '' && price === null) return { error: 'Preço da promoção inválido.' };
    if ((starts && Number.isNaN(starts.getTime())) || (ends && Number.isNaN(ends.getTime()))) return { error: 'Horário da promoção inválido.' };
    if (starts && ends && ends <= starts) return { error: 'A promoção precisa terminar depois de começar.' };

    fields.promo_price_cents = price;
    fields.promo_starts_at = price === null ? null : starts?.toISOString() || null;
    fields.promo_ends_at = price === null ? null : ends?.toISOString() || null;
  }

  // Promoção fixa por dia da semana (0=domingo..6=sábado); vazio/null = todo dia.
  if (body.promo_weekdays !== undefined) {
    if (body.promo_weekdays === null || body.promo_weekdays === '') {
      fields.promo_weekdays = null;
    } else if (Array.isArray(body.promo_weekdays) && body.promo_weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
      fields.promo_weekdays = body.promo_weekdays.length ? [...new Set(body.promo_weekdays)].sort() : null;
    } else {
      return { error: 'Dias da promoção inválidos.' };
    }
  }

  // Engradado gelado: valor a mais por engradado (vazio = sem a opção).
  if (body.chill_fee_cents !== undefined) {
    const fee = body.chill_fee_cents === null || body.chill_fee_cents === '' ? null : toCents(body.chill_fee_cents);

    if (body.chill_fee_cents !== null && body.chill_fee_cents !== '' && fee === null) return { error: 'Valor do gelado inválido.' };

    fields.chill_fee_cents = fee;
  }

  return { fields, variants };
}

// O cardápio segue sort_order, que também define a ordem das categorias
// (cada categoria ocupa uma faixa de 1000). Produto entra no fim da própria
// categoria; categoria nova vai para o fim do cardápio.
async function nextSortOrder(env, storeId, category, excludeProductId = null) {
  const exclude = excludeProductId ? `&id=neq.${excludeProductId}` : '';

  const lastResponse = await supabaseFetch(
    env,
    `products?select=sort_order&store_id=eq.${storeId}&category=eq.${encodeURIComponent(category)}${exclude}&order=sort_order.desc&limit=1`
  );
  const [last] = await readJsonResponse(lastResponse, 'Não foi possível salvar o produto.');

  if (last) return last.sort_order + 1;

  const maxResponse = await supabaseFetch(
    env,
    `products?select=sort_order&store_id=eq.${storeId}${exclude}&order=sort_order.desc&limit=1`
  );
  const [max] = await readJsonResponse(maxResponse, 'Não foi possível salvar o produto.');

  return max ? (Math.floor(max.sort_order / 1000) + 1) * 1000 : 0;
}

async function handleCreateProduct(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const { fields, variants, error } = readProductFields(body, false);

  if (error) return json({ error }, 400);

  const { components, error: componentsError } = readComponents(body);

  if (componentsError) return json({ error: componentsError }, 400);

  const store = await getStore(env);

  if (fields.sort_order === undefined) {
    fields.sort_order = await nextSortOrder(env, store.id, fields.category || 'Geral');
  }

  const response = await supabaseFetch(env, 'products', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...fields, store_id: store.id }),
  });

  const [product] = await readJsonResponse(response, 'Não foi possível cadastrar o produto.');

  if (variants && variants.length) {
    try {
      await syncVariants(env, product.id, variants);
    } catch (err) {
      await supabaseFetch(env, `products?id=eq.${product.id}`, { method: 'DELETE' });
      throw err;
    }
  }

  await audit(env, session, 'product.create', `Cadastrou o produto "${product.name}" (${money(product.price_cents)})`, { entity: 'product', entityId: product.id });

  if (components && components.length) {
    const problem = await saveComponents(env, session, store, product.id, components, null);
    if (problem) return json({ error: `Produto cadastrado, mas os itens do combo não foram salvos: ${problem}`, product: await productWithVariants(env, product.id) }, 400);
  }

  return json({ product: await productWithVariants(env, product.id) });
}

async function handleUpdateProduct(request, env, productId, session) {
  if (!validUuid(productId)) return json({ error: 'Produto inválido.' }, 400);

  const body = await request.json().catch(() => ({}));

  // Funcionário só inativa/reativa por estoque (preço, nome etc. é com o administrador).
  if (session?.urole !== 'admin' && Object.keys(body).some(k => k !== 'available' && k !== 'inactive_reason')) {
    return json({ error: 'Funcionário só pode inativar ou reativar o produto por estoque.' }, 403);
  }

  const { fields, variants, error } = readProductFields(body, true);

  if (error) return json({ error }, 400);

  const { components, error: componentsError } = readComponents(body);

  if (componentsError) return json({ error: componentsError }, 400);

  if (!Object.keys(fields).length && variants === undefined && components === undefined) return json({ error: 'Nada para atualizar.' }, 400);

  // Removeu todas as variações sem informar preço: o produto precisa de um preço próprio.
  if (variants && !variants.length && fields.price_cents === undefined) {
    return json({ error: 'Informe o preço do produto.' }, 400);
  }

  // Como estava antes (para a auditoria de preço/disponibilidade).
  const before = await productWithVariants(env, productId).catch(() => null);

  if (!(await ownsProduct(env, productId))) return json({ error: 'Produto não encontrado.' }, 404);

  if (session?.urole !== 'admin' && (body.inactive_reason === 'preco' || (before?.inactive_reason === 'preco' && fields.available))) {
    return json({ error: 'Conferência de preço é com o administrador.' }, 403);
  }

  // Continua inativo pelo mesmo motivo: mantém a data em que ficou inativo.
  if (before && fields.available === false && !before.available && before.inactive_reason === fields.inactive_reason) {
    delete fields.inactive_since;
  }

  // Mudou de categoria: vai para o fim da categoria nova.
  if (fields.category !== undefined && fields.sort_order === undefined) {
    const currentResponse = await supabaseFetch(env, `products?select=store_id,category&id=eq.${productId}`);
    const [current] = await readJsonResponse(currentResponse, 'Não foi possível atualizar o produto.');

    if (current && current.category !== fields.category) {
      fields.sort_order = await nextSortOrder(env, current.store_id, fields.category, productId);
    }
  }

  if (Object.keys(fields).length) {
    const response = await supabaseFetch(env, `products?id=eq.${productId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(fields),
    });

    const rows = await readJsonResponse(response, 'Não foi possível atualizar o produto.');

    if (!rows[0]) return json({ error: 'Produto não encontrado.' }, 404);
  }

  if (variants !== undefined) {
    await syncVariants(env, productId, variants);
  }

  let componentsProblem = null;

  // Produto sem itens de combo que continua sem: nada a fazer.
  if (components !== undefined && (components.length || before?.components?.length)) {
    componentsProblem = await saveComponents(env, session, await getStore(env), productId, components, before);
  }

  const product = await productWithVariants(env, productId);

  if (!product) return json({ error: 'Produto não encontrado.' }, 404);

  if (before) await auditProductChanges(env, session, before, product);

  if (componentsProblem) return json({ error: `Produto salvo, mas os itens do combo não: ${componentsProblem}`, product: productForRole(product, session) }, 400);

  return json({ product: productForRole(product, session) });
}

function storageObjectPathFromPublicUrl(env, url) {
  const prefix = `${env.SUPABASE_URL}/storage/v1/object/public/${PRODUCT_BUCKET}/`;

  return url && url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

async function deleteStorageObject(env, path) {
  if (!path) return;

  await fetch(`${env.SUPABASE_URL}/storage/v1/object/${PRODUCT_BUCKET}/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  }).catch(err => console.error('Falha ao apagar foto antiga', err));
}

async function handleDeleteProduct(request, env, productId, session) {
  if (!validUuid(productId)) return json({ error: 'Produto inválido.' }, 400);

  const response = await supabaseFetch(env, `products?id=eq.${productId}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  });

  const rows = await readJsonResponse(response, 'Não foi possível excluir o produto.');

  if (rows[0]) {
    await deleteStorageObject(env, storageObjectPathFromPublicUrl(env, rows[0].image_url));
    await audit(env, session, 'product.delete', `Excluiu o produto "${rows[0].name}" (${money(rows[0].price_cents)})`, { entity: 'product', entityId: productId });
  }

  return json({ ok: true });
}

const PRODUCT_BUCKET = 'product-photos';
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

// Multi-loja: product_variants não tem store_id; antes de mexer numa variação, confere se o produto é desta loja.
async function ownsProduct(env, productId) {
  if (!validUuid(productId)) return false;
  const rows = await readJsonResponse(await supabaseFetch(env, `products?select=id&id=eq.${productId}`), 'Não foi possível carregar o produto.');
  return rows.length > 0;
}

// Tira a foto de uma variação (ela volta a usar a foto do produto).
async function handleRemoveVariantPhoto(request, env, productId) {
  const variantId = new URL(request.url).searchParams.get('variant');

  if (!validUuid(productId) || !validUuid(variantId)) return json({ error: 'Variação inválida.' }, 400);
  if (!(await ownsProduct(env, productId))) return json({ error: 'Produto não encontrado.' }, 404);

  const [variant] = await readJsonResponse(await supabaseFetch(env, `product_variants?select=image_url&id=eq.${variantId}&product_id=eq.${productId}`), 'Não foi possível carregar a variação.');

  if (!variant) return json({ error: 'Variação não encontrada.' }, 404);

  await readJsonResponse(await supabaseFetch(env, `product_variants?id=eq.${variantId}`, { method: 'PATCH', body: JSON.stringify({ image_url: null }) }), 'Não foi possível tirar a foto.');
  await deleteStorageObject(env, storageObjectPathFromPublicUrl(env, variant.image_url));

  return json({ ok: true });
}

async function handleProductPhoto(request, env, productId) {
  if (!validUuid(productId)) return json({ error: 'Produto inválido.' }, 400);
  if (!(await ownsProduct(env, productId))) return json({ error: 'Produto não encontrado.' }, 404);

  // Com ?variant=id, a foto é da variação (ex.: Red Bull Tradicional).
  const variantId = new URL(request.url).searchParams.get('variant');

  if (variantId && !validUuid(variantId)) return json({ error: 'Variação inválida.' }, 400);

  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  const extension = PHOTO_TYPES[contentType];

  if (!extension) {
    return json({ error: 'Envie uma foto JPG, PNG ou WEBP.' }, 400);
  }

  const bytes = await request.arrayBuffer();

  if (!bytes.byteLength) return json({ error: 'Foto vazia.' }, 400);

  if (bytes.byteLength > PHOTO_MAX_BYTES) return json({ error: 'Foto muito grande (máx. 5 MB).' }, 400);

  const currentResponse = variantId
    ? await supabaseFetch(env, `product_variants?select=image_url&id=eq.${variantId}&product_id=eq.${productId}`)
    : await supabaseFetch(env, `products?select=image_url&id=eq.${productId}`);
  const current = await readJsonResponse(currentResponse, 'Não foi possível carregar o produto.');

  if (!current[0]) return json({ error: variantId ? 'Variação não encontrada.' : 'Produto não encontrado.' }, 404);

  const path = variantId ? `${productId}/v-${variantId}-${Date.now()}.${extension}` : `${productId}/${Date.now()}.${extension}`;

  const upload = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${PRODUCT_BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': contentType,
      'Cache-Control': 'max-age=31536000',
    },
    body: bytes,
  });

  if (!upload.ok) {
    console.error('Storage upload error', upload.status, await upload.text());
    return json({ error: 'Não foi possível enviar a foto.' }, 500);
  }

  const imageUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${PRODUCT_BUCKET}/${path}`;

  const response = await supabaseFetch(env, variantId ? `product_variants?id=eq.${variantId}` : `products?id=eq.${productId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ image_url: imageUrl }),
  });

  const rows = await readJsonResponse(response, 'Não foi possível salvar a foto.');

  await deleteStorageObject(env, storageObjectPathFromPublicUrl(env, current[0].image_url));

  return json(variantId ? { variant: rows[0] } : { product: rows[0] });
}

async function handleUpdateStore(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const fields = {};

  if (body.name !== undefined) {
    const name = cleanText(body.name, 80);

    if (name.length < 2) return json({ error: 'Nome da loja inválido.' }, 400);

    fields.name = name;
  }

  if (body.whatsapp !== undefined) {
    fields.whatsapp = cleanText(body.whatsapp, 20).replace(/\D/g, '') || null;
  }

  for (const key of ['delivery_fee_cents', 'min_order_cents']) {
    if (body[key] !== undefined) {
      const value = toCents(body[key]);

      if (value === null) return json({ error: 'Valor inválido.' }, 400);

      fields[key] = value;
    }
  }

  if (body.profile !== undefined) fields.profile = readProfile(body.profile);
  if (body.accept_scheduled !== undefined) fields.accept_scheduled = Boolean(body.accept_scheduled);
  if (body.auto_accept !== undefined) fields.auto_accept = Boolean(body.auto_accept);

  if (body.default_margin_percent !== undefined) {
    const margin = Math.round(Number(body.default_margin_percent));
    if (!Number.isFinite(margin) || margin < 0 || margin > 100) return json({ error: 'Margem inválida (0 a 100%).' }, 400);
    fields.default_margin_percent = margin;
  }

  for (const key of ['delivery_minutes', 'pickup_minutes']) {
    if (body[key] !== undefined) {
      const value = Math.round(Number(body[key]));

      if (!Number.isFinite(value) || value < 5 || value > 240) return json({ error: 'O prazo precisa ser entre 5 e 240 minutos.' }, 400);

      fields[key] = value;
    }
  }

  // Presente de aniversário.
  if (body.birthday_settings !== undefined) {
    const b = body.birthday_settings || {};
    const int = (v, min, max) => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));

    fields.birthday_settings = {
      enabled: Boolean(b.enabled),
      type: b.type === 'amount' ? 'amount' : 'percent',
      value: int(b.value, 1, 100),
      amount_cents: int(b.amount_cents, 0, 100000),
      max_cents: int(b.max_cents, 0, 100000),
      days_before: int(b.days_before, 0, 15),
      days_after: int(b.days_after, 0, 15),
      min_days_registered: int(b.min_days_registered ?? 30, 0, 365),
    };
  }

  if (body.is_open !== undefined) {
    fields.is_open = Boolean(body.is_open);
  }

  if (body.auto_hours !== undefined) {
    fields.auto_hours = Boolean(body.auto_hours);
  }

  if (body.hours !== undefined) {
    if (!validHours(body.hours)) return json({ error: 'Horário inválido.' }, 400);

    fields.hours = body.hours.map(({ day, enabled, open, close }) => ({ day, enabled, open, close }));
  }

  // Configurações livres (impressora e WhatsApp): só objetos pequenos.
  for (const key of ['print_settings', 'whatsapp_templates', 'whatsapp_settings']) {
    if (body[key] !== undefined) {
      if (!body[key] || typeof body[key] !== 'object' || Array.isArray(body[key]) || JSON.stringify(body[key]).length > 20000) {
        return json({ error: 'Configuração inválida.' }, 400);
      }

      fields[key] = body[key];
    }
  }

  if (!Object.keys(fields).length) return json({ error: 'Nada para atualizar.' }, 400);

  const store = await getStore(env);

  const response = await supabaseFetch(env, `stores?id=eq.${store.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });

  const rows = await readJsonResponse(response, 'Não foi possível salvar as configurações.');

  // Auditoria só do que mexe com dinheiro ou com a operação.
  const labels = { delivery_fee_cents: 'taxa de entrega', min_order_cents: 'pedido mínimo', delivery_minutes: 'prazo de entrega', pickup_minutes: 'prazo de retirada', is_open: 'loja aberta' };
  const changes = Object.keys(labels)
    .filter(k => fields[k] !== undefined && fields[k] !== store[k])
    .map(k => `${labels[k]}: ${k.endsWith('_cents') ? `${money(store[k])} → ${money(fields[k])}` : `${store[k]} → ${fields[k]}`}`);

  if (changes.length) await audit(env, session, 'store.update', `Configuração da loja: ${changes.join('; ')}`, { entity: 'store', entityId: store.id });

  return json({ store: adminStore(rows[0]) });
}

async function handleAdminOrders(request, env, session) {
  const url = new URL(request.url);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '')
    ? url.searchParams.get('date')
    : todaySaoPaulo();

  // Brasil não tem horário de verão desde 2019: o dia em São Paulo é sempre UTC-3.
  const start = encodeURIComponent(`${date}T00:00:00-03:00`);
  const end = encodeURIComponent(`${date}T23:59:59.999-03:00`);
  const store = await getStore(env);

  const scope = session?.urole === 'admin' ? `&created_at=gte.${start}&created_at=lte.${end}` : await cashierOrderFilter(env, store.id, session);
  const orders = await fetchAllRows(env,
    `orders?select=*,customers(highlight),order_items(id,product_name,quantity,unit_price_cents,subtotal_cents,by_weight,estimated_cents,weighed_by,weighed_at)&store_id=eq.${store.id}${scope}&order=created_at.desc,id.asc`,
    'Não foi possível carregar os pedidos.');

  return json({ date, orders, app_version: appVersion(env) });
}

async function handleReopenOrder(request, env, orderId, session) {
  if (!validUuid(orderId)) return json({ error: 'Pedido inválido.' }, 400);
  if (session?.urole !== 'admin') return json({ error: 'Só administrador pode reabrir pedido finalizado.' }, 403);

  const body = await request.json().catch(() => ({}));
  const reason = cleanText(body.reason, 200);
  if (reason.length < 3) return json({ error: 'Informe o motivo da reabertura.' }, 400);

  const store = await getStore(env);
  const [current] = await readJsonResponse(await supabaseFetch(env,
    `orders?select=id,order_number,status,payment_status,pdv_closing_id&id=eq.${orderId}&store_id=eq.${store.id}`),
  'Não foi possível carregar o pedido.');

  if (!current) return json({ error: 'Pedido não encontrado.' }, 404);
  if (current.status !== 'delivered') return json({ error: 'Só é possível reabrir um pedido finalizado como entregue.' }, 409);
  if (current.pdv_closing_id) return json({ error: 'Este pedido já entrou num Fechamento PDV e não pode mais ser reaberto.' }, 409);

  const now = new Date().toISOString();
  const response = await supabaseFetch(env,
    `orders?id=eq.${orderId}&store_id=eq.${store.id}&status=eq.delivered&pdv_closing_id=is.null`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation', ...actorHeaders(session) },
      body: JSON.stringify({
        status: 'preparing',
        closed_at: null,
        dispatched_at: null,
        dispatched_by: null,
        courier_id: null,
        courier_name: null,
        courier_confirmed_at: null,
        courier_issue: null,
        updated_at: now,
      }),
    });
  const rows = await readFiadoResponse(response, 'Não foi possível reabrir o pedido.');

  if (!rows?.length) return json({ error: 'O pedido mudou enquanto era reaberto. Atualize a tela e tente de novo.' }, 409);

  await audit(env, session, 'order.reopen',
    `Reabriu o pedido #${current.order_number} e voltou para preparação (${current.payment_status === 'paid' ? 'pagamento preservado' : 'pagamento pendente'}) — motivo: ${reason}`,
    { entity: 'order', entityId: orderId });

  return json({ order: rows[0] });
}

async function handleUpdateOrderStatus(request, env, orderId, ctx, session) {
  if (!validUuid(orderId)) return json({ error: 'Pedido inválido.' }, 400);
  if (!(await cashierCanOperateOrder(env, session, orderId))) return json({ error: 'Este pedido não pertence à operação ou ao seu caixa aberto.' }, 403);

  const body = await request.json().catch(() => ({}));
  const now = new Date().toISOString();
  const fields = { updated_at: now };

  if (body.status !== undefined && !ORDER_STATUSES.includes(body.status)) {
    return json({ error: 'Status inválido.' }, 400);
  }

  if (body.payment_status !== undefined && !PAYMENT_STATUSES.includes(body.payment_status)) {
    return json({ error: 'Situação de pagamento inválida.' }, 400);
  }

  if (body.payment_method !== undefined && !PAYMENT_METHODS.includes(body.payment_method)) {
    return json({ error: 'Forma de pagamento inválida.' }, 400);
  }

  if (body.status === undefined && body.payment_status === undefined && body.payment_method === undefined && !body.payment_split && body.discount_cents === undefined) {
    return json({ error: 'Nada para atualizar.' }, 400);
  }

  const currentResponse = await supabaseFetch(env, `orders?select=order_number,status,payment_status,subtotal_cents,delivery_fee_cents,discount_cents,total_cents,pdv_closing_id,accepted_at&id=eq.${orderId}`);
  const [current] = await readJsonResponse(currentResponse, 'Não foi possível atualizar o pedido.');

  if (!current) return json({ error: 'Pedido não encontrado.' }, 404);

  // Pedido que já entrou num Fechamento PDV não muda mais (senão o fechamento deixa de bater).
  if (current.pdv_closing_id) {
    return json({ error: 'Este pedido já entrou num Fechamento PDV e não pode mais ser alterado.' }, 409);
  }

  let total = current.total_cents;

  // Desconto (só em pedido ainda não pago e não cancelado): recalcula o total.
  if (body.discount_cents !== undefined) {
    const discount = toCents(body.discount_cents);

    if (current.status === 'cancelled' || current.payment_status === 'paid') {
      return json({ error: 'Só dá para dar desconto em pedido ainda não pago.' }, 400);
    }

    if (discount === null || discount >= current.subtotal_cents + current.delivery_fee_cents) {
      return json({ error: 'O desconto precisa ser menor que o total do pedido.' }, 400);
    }

    total = current.subtotal_cents + current.delivery_fee_cents - discount;
    fields.discount_cents = discount;
    fields.total_cents = total;
    // A divisão do pagamento era sobre o total antigo.
    fields.payment_split = null;
  }

  // O cliente pode pagar de um jeito diferente do que escolheu no pedido
  // (uma forma só, ou dividido em duas).
  if (body.payment_split) {
    const { split, error } = parsePaymentSplit(body.payment_split, total);

    if (error) return json({ error }, 400);

    fields.payment_split = split;
    fields.payment_method = split[0].method;
  } else if (body.payment_method !== undefined) {
    fields.payment_method = body.payment_method;
    fields.payment_split = null;
  }

  if (body.status !== undefined) {
    // Cancelar exige motivo (para depois entender por que pedidos se perdem).
    if (body.status === 'cancelled' && current.status !== 'cancelled') {
      const reason = cleanText(body.cancel_reason, 200);

      if (reason.length < 3) return json({ error: 'Informe o motivo do cancelamento.' }, 400);

      fields.cancel_reason = reason;
      fields.cancelled_by = session?.name || null;
    }

    if (body.status === 'accepted' && !current.accepted_at) fields.accepted_at = now;

    fields.status = body.status;
    // Fechamento = entregue ou cancelado.
    fields.closed_at = ['delivered', 'cancelled'].includes(body.status) ? now : null;

    // Pagamento é na entrega: entregue sem pagamento marcado vira pago.
    if (body.status === 'delivered' && current.payment_status !== 'paid' && body.payment_status === undefined) {
      fields.payment_status = 'paid';
      fields.paid_at = now;
    }
  }

  if (body.payment_status !== undefined) {
    if ((body.status || current.status) === 'cancelled' && body.payment_status === 'paid') {
      return json({ error: 'Pedido cancelado não pode ser marcado como pago.' }, 400);
    }

    fields.payment_status = body.payment_status;
    fields.paid_at = body.payment_status === 'paid' ? now : null;
  }

  // Cancelado não entra no caixa.
  if (fields.status === 'cancelled' && current.payment_status === 'paid') {
    fields.payment_status = 'pending';
    fields.paid_at = null;
  }

  // O banco lança/estorna o fiado junto com a mudança; se estourar o limite, nada muda.
  const response = await supabaseFetch(env, `orders?id=eq.${orderId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation', ...actorHeaders(session) },
    body: JSON.stringify(fields),
  });

  const rows = await readFiadoResponse(response, 'Não foi possível atualizar o pedido.');
  const updated = rows[0] || {};
  const ref = `pedido #${current.order_number}`;

  // Auditoria: o que mexe em dinheiro ou some com pedido.
  if (fields.status === 'cancelled' && current.status !== 'cancelled') {
    await audit(env, session, 'order.cancel', `Cancelou o ${ref} (${money(current.total_cents)}) — motivo: ${fields.cancel_reason}`, { entity: 'order', entityId: orderId });
  }

  if (fields.discount_cents !== undefined && fields.discount_cents !== current.discount_cents) {
    await audit(env, session, 'order.discount',
      fields.discount_cents
        ? `Deu desconto de ${money(fields.discount_cents)} no ${ref} (total ${money(current.subtotal_cents + current.delivery_fee_cents)} → ${money(fields.total_cents)})`
        : `Tirou o desconto do ${ref}`,
      { entity: 'order', entityId: orderId });
  }

  if (fields.payment_status === 'pending' && current.payment_status === 'paid') {
    await audit(env, session, 'order.refund', `Desmarcou o pagamento (estorno) do ${ref} (${money(updated.total_cents ?? current.total_cents)})`, { entity: 'order', entityId: orderId });
  } else if (fields.payment_status === 'paid' && current.payment_status !== 'paid') {
    await audit(env, session, 'order.paid', `Marcou o ${ref} como pago: ${paymentText(updated)}`, { entity: 'order', entityId: orderId });
  } else if (current.payment_status === 'paid' && (fields.payment_method || fields.payment_split)) {
    await audit(env, session, 'order.payment_method', `Mudou a forma de pagamento do ${ref} já pago para ${paymentText(updated)}`, { entity: 'order', entityId: orderId });
  }

  // WhatsApp automático: avisa o cliente da nova etapa.
  if (body.status !== undefined && body.status !== current.status && ctx) {
    ctx.waitUntil(getStore(env).then(store => autoNotify(env, store, orderId, body.status, storeOrigin(store, env))));
  }

  return json({ order: rows[0] });
}

/* ---------------- Produto por kg: valor da balança ---------------- */

// A equipe pesa e lança o valor real do item (pode subir ou descer). Só antes de pagar.
async function handleAddAdminOrderItems(request, env, orderId, session) {
  if (!validUuid(orderId)) return json({ error: 'Pedido inválido.' }, 400);
  if (!(await cashierCanOperateOrder(env, session, orderId))) return json({ error: 'Este pedido não pertence à operação ou ao seu caixa aberto.' }, 403);

  const body = await request.json().catch(() => ({}));
  const store = await getStore(env);
  const [order] = await readJsonResponse(await supabaseFetch(env,
    `orders?select=id,order_number,status,payment_status,subtotal_cents,delivery_fee_cents,discount_cents,total_cents,pdv_closing_id&id=eq.${orderId}&store_id=eq.${store.id}`),
  'Não foi possível carregar o pedido.');

  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);
  if (order.pdv_closing_id) return json({ error: 'Este pedido já entrou num Fechamento PDV e não pode mais ser alterado.' }, 409);
  if (['delivered', 'cancelled'].includes(order.status)) return json({ error: 'Pedido já finalizado: não dá mais para adicionar itens.' }, 409);
  if (order.payment_status === 'paid') return json({ error: 'Desmarque o pagamento antes de adicionar itens.' }, 409);

  const priced = await priceCartItems(env, store, body.items, true);
  if (priced.response) return priced.response;

  const subtotal = order.subtotal_cents + priced.subtotal;
  const total = subtotal + order.delivery_fee_cents - (order.discount_cents || 0);
  if (total <= 0) return json({ error: 'O desconto atual deixa o pedido inválido. Remova o desconto antes.' }, 400);

  const inserted = await supabaseFetch(env, 'order_items', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(priced.items.map(item => ({ ...item, order_id: order.id }))),
  });
  if (!inserted.ok) {
    console.error('admin add items', inserted.status, await inserted.text());
    return json({ error: 'Não foi possível adicionar os itens.' }, 500);
  }

  const now = new Date().toISOString();
  const rows = await readFiadoResponse(await supabaseFetch(env, `orders?id=eq.${order.id}&payment_status=eq.pending&pdv_closing_id=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation', ...actorHeaders(session) },
    body: JSON.stringify({ subtotal_cents: subtotal, total_cents: total, payment_split: null, updated_at: now }),
  }), 'Não foi possível atualizar o total do pedido.');

  if (!rows?.length) return json({ error: 'O pedido mudou enquanto era atualizado. Confira e tente de novo.' }, 409);

  await audit(env, session, 'order.add_items',
    `Adicionou ${priced.items.map(i => `${i.quantity}x ${i.product_name}`).join(', ')} ao pedido #${order.order_number} (+ ${money(priced.subtotal)}; total ${money(order.total_cents)} → ${money(total)})`,
    { entity: 'order', entityId: order.id });

  return json({ order: rows[0] });
}

// Carrega o pedido (com os itens) já checando os mesmos bloqueios de "adicionar item":
// caixa dono do pedido, sem Fechamento PDV, não finalizado/cancelado e ainda não pago.
async function loadOrderForItemEdit(env, session, orderId) {
  if (!validUuid(orderId)) return { error: json({ error: 'Pedido inválido.' }, 400) };
  if (!(await cashierCanOperateOrder(env, session, orderId))) return { error: json({ error: 'Este pedido não pertence à operação ou ao seu caixa aberto.' }, 403) };

  const store = await getStore(env);
  const [order] = await readJsonResponse(await supabaseFetch(env,
    `orders?select=id,order_number,status,payment_status,subtotal_cents,delivery_fee_cents,discount_cents,total_cents,pdv_closing_id,order_items(id,product_id,variant_id,product_name,variant_name,quantity,unit_price_cents,subtotal_cents,by_weight)&id=eq.${orderId}&store_id=eq.${store.id}`),
  'Não foi possível carregar o pedido.');

  if (!order) return { error: json({ error: 'Pedido não encontrado.' }, 404) };
  if (order.pdv_closing_id) return { error: json({ error: 'Este pedido já entrou num Fechamento PDV e não pode mais ser alterado.' }, 409) };
  if (['delivered', 'cancelled'].includes(order.status)) return { error: json({ error: 'Pedido já finalizado: não dá mais para mudar os itens.' }, 409) };
  if (order.payment_status === 'paid') return { error: json({ error: 'Desmarque o pagamento antes de mudar os itens.' }, 409) };

  return { store, order };
}

// PATCH condicional igual ao de "adicionar item": só aplica se o pedido continuar do jeito que foi lido.
async function saveOrderItemsTotal(env, session, order, subtotal, total) {
  const now = new Date().toISOString();
  const response = await supabaseFetch(env, `orders?id=eq.${order.id}&payment_status=eq.pending&pdv_closing_id=is.null`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation', ...actorHeaders(session) },
    body: JSON.stringify({ subtotal_cents: subtotal, total_cents: total, payment_split: null, updated_at: now }),
  });
  return readFiadoResponse(response, 'Não foi possível atualizar o total do pedido.');
}

async function handleRemoveOrderItem(request, env, orderId, itemId, session) {
  if (!validUuid(itemId)) return json({ error: 'Item inválido.' }, 400);

  const { error, order } = await loadOrderForItemEdit(env, session, orderId);
  if (error) return error;

  const item = order.order_items.find(i => i.id === itemId);
  if (!item) return json({ error: 'Item não encontrado.' }, 404);
  if (order.order_items.length <= 1) return json({ error: 'Não dá pra tirar o último item; cancele o pedido se for o caso.' }, 400);

  const subtotal = order.subtotal_cents - item.subtotal_cents;
  const total = subtotal + order.delivery_fee_cents - (order.discount_cents || 0);
  if (total <= 0) return json({ error: 'Removendo esse item o desconto fica maior que o pedido. Ajuste o desconto antes.' }, 400);

  const deleted = await supabaseFetch(env, `order_items?id=eq.${itemId}&order_id=eq.${orderId}`, { method: 'DELETE' });
  if (!deleted.ok) {
    console.error('remove order item', deleted.status, await deleted.text());
    return json({ error: 'Não foi possível tirar o item.' }, 500);
  }

  const rows = await saveOrderItemsTotal(env, session, order, subtotal, total);
  if (!rows?.length) return json({ error: 'O pedido mudou enquanto era atualizado. Confira e tente de novo.' }, 409);

  await audit(env, session, 'order.edit_items',
    `Tirou ${item.quantity}x ${item.product_name} do pedido #${order.order_number} (− ${money(item.subtotal_cents)}; total ${money(order.total_cents)} → ${money(total)})`,
    { entity: 'order', entityId: order.id });

  return json({ order: rows[0] });
}

async function handleEditOrderItemQty(request, env, orderId, itemId, session) {
  if (!validUuid(itemId)) return json({ error: 'Item inválido.' }, 400);

  const body = await request.json().catch(() => ({}));
  const quantity = Math.floor(Number(body.quantity));
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) return json({ error: 'Quantidade inválida.' }, 400);

  const { error, store, order } = await loadOrderForItemEdit(env, session, orderId);
  if (error) return error;

  const item = order.order_items.find(i => i.id === itemId);
  if (!item) return json({ error: 'Item não encontrado.' }, 404);
  if (item.by_weight) return json({ error: 'Item pesado: mude o valor pela balança, não pela quantidade.' }, 400);

  const priced = await priceCartItems(env, store, [{ product_id: item.product_id, variant_id: item.variant_id, quantity }], true);
  if (priced.response) return priced.response;

  const repriced = priced.items[0];
  const subtotal = order.subtotal_cents - item.subtotal_cents + repriced.subtotal_cents;
  const total = subtotal + order.delivery_fee_cents - (order.discount_cents || 0);
  if (total <= 0) return json({ error: 'Com essa quantidade o desconto fica maior que o pedido. Ajuste o desconto antes.' }, 400);

  await readJsonResponse(await supabaseFetch(env, `order_items?id=eq.${itemId}&order_id=eq.${orderId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      quantity: repriced.quantity,
      unit_price_cents: repriced.unit_price_cents,
      subtotal_cents: repriced.subtotal_cents,
      product_name: repriced.product_name,
      variant_name: repriced.variant_name,
    }),
  }), 'Não foi possível mudar a quantidade.');

  const rows = await saveOrderItemsTotal(env, session, order, subtotal, total);
  if (!rows?.length) {
    // Foi pago no meio do caminho: volta o item como estava.
    await supabaseFetch(env, `order_items?id=eq.${itemId}&order_id=eq.${orderId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        quantity: item.quantity,
        unit_price_cents: item.unit_price_cents,
        subtotal_cents: item.subtotal_cents,
        product_name: item.product_name,
        variant_name: item.variant_name,
      }),
    });
    return json({ error: 'O pedido acabou de ser pago. Desmarque o pagamento para mudar a quantidade.' }, 409);
  }

  await audit(env, session, 'order.edit_items',
    `Mudou ${item.product_name} de ${item.quantity}x para ${repriced.quantity}x no pedido #${order.order_number} (total ${money(order.total_cents)} → ${money(total)})`,
    { entity: 'order', entityId: order.id });

  return json({ order: rows[0] });
}

async function handleWeighItem(request, env, orderId, itemId, session) {
  if (!validUuid(orderId) || !validUuid(itemId)) return json({ error: 'Item inválido.' }, 400);
  if (!(await cashierCanOperateOrder(env, session, orderId))) return json({ error: 'Este pedido não pertence à operação ou ao seu caixa aberto.' }, 403);

  const body = await request.json().catch(() => ({}));
  const cents = toCents(body.subtotal_cents);
  if (!cents || cents > WEIGHED_MAX_CENTS) return json({ error: 'Informe o valor da balança.' }, 400);

  const [order] = await readJsonResponse(await supabaseFetch(env,
    `orders?select=id,order_number,status,payment_status,pdv_closing_id,delivery_fee_cents,discount_cents,subtotal_cents,total_cents,order_items(id,product_name,quantity,subtotal_cents,by_weight,estimated_cents)&id=eq.${orderId}`),
  'Não foi possível carregar o pedido.');

  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);
  if (order.pdv_closing_id) return json({ error: 'Este pedido já entrou num Fechamento PDV.' }, 409);
  if (['delivered', 'cancelled'].includes(order.status)) return json({ error: 'Pedido já finalizado: não dá mais para mudar o valor.' }, 409);
  if (order.payment_status === 'paid') return json({ error: 'Pedido já pago: desmarque o pagamento antes de mudar o valor pesado.' }, 409);

  const item = order.order_items.find(i => i.id === itemId);
  if (!item) return json({ error: 'Item não encontrado.' }, 404);
  if (!item.by_weight) return json({ error: 'Só produto vendido por kg tem o valor ajustado na balança.' }, 400);

  const subtotal = order.order_items.reduce((sum, i) => sum + (i.id === itemId ? cents : i.subtotal_cents), 0);
  const total = subtotal + order.delivery_fee_cents - (order.discount_cents || 0);
  if (total <= 0) return json({ error: 'Com esse valor o desconto fica maior que o pedido. Tire o desconto antes.' }, 400);

  const now = new Date().toISOString();
  await readJsonResponse(await supabaseFetch(env, `order_items?id=eq.${itemId}&order_id=eq.${orderId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      subtotal_cents: cents,
      unit_price_cents: Math.round(cents / item.quantity),
      estimated_cents: item.estimated_cents ?? item.subtotal_cents,
      weighed_by: session?.name || null,
      weighed_at: now,
    }),
  }), 'Não foi possível salvar o valor pesado.');

  // Total novo; a divisão do pagamento era sobre o total antigo.
  const rows = await readFiadoResponse(await supabaseFetch(env, `orders?id=eq.${orderId}&payment_status=eq.pending`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation', ...actorHeaders(session) },
    body: JSON.stringify({ subtotal_cents: subtotal, total_cents: total, payment_split: null, updated_at: now }),
  }), 'Não foi possível atualizar o total do pedido.');

  if (!rows?.length) {
    // Foi pago no meio do caminho: volta o item como estava.
    await supabaseFetch(env, `order_items?id=eq.${itemId}`, { method: 'PATCH', body: JSON.stringify({ subtotal_cents: item.subtotal_cents, unit_price_cents: Math.round(item.subtotal_cents / item.quantity) }) });
    return json({ error: 'O pedido acabou de ser pago. Desmarque o pagamento para mudar o valor.' }, 409);
  }

  await audit(env, session, 'order.weigh',
    `Pesou "${item.product_name}" no pedido #${order.order_number}: ${money(item.subtotal_cents)} → ${money(cents)} (total ${money(order.total_cents)} → ${money(total)})`,
    { entity: 'order', entityId: orderId });

  return json({ order: rows[0] });
}

/* ---------------- Histórico de pedidos ---------------- */

// Início e fim de um dia de São Paulo (UTC-3, sem horário de verão desde 2019).
function dayStart(date) {
  return `${date}T00:00:00-03:00`;
}

function dayEnd(date) {
  return `${date}T23:59:59.999-03:00`;
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : null;
}

async function handleOrderHistory(request, env, session) {
  const url = new URL(request.url);
  const to = validDate(url.searchParams.get('to')) || todaySaoPaulo();
  const from = validDate(url.searchParams.get('from')) || to;
  const status = url.searchParams.get('status');
  const payment = url.searchParams.get('payment');
  const store = await getStore(env);

  let query = `orders?select=id,order_number,public_code,status,source,delivery_type,payment_method,payment_split,payment_status,paid_at,created_at,closed_at,customer_id,customer_name,customer_phone,total_cents,cancel_reason,cancelled_by`
    + `&store_id=eq.${store.id}`
    + `&created_at=gte.${encodeURIComponent(dayStart(from))}&created_at=lte.${encodeURIComponent(dayEnd(to))}`
    + `&order=created_at.desc&limit=1000`;

  if (ORDER_STATUSES.includes(status)) query += `&status=eq.${status}`;
  if (status === 'open') query += `&status=not.in.(delivered,cancelled)`;
  // Cancelado não tem pagamento a receber: fica fora do filtro de pagamento.
  if (PAYMENT_STATUSES.includes(payment)) query += `&payment_status=eq.${payment}&status=neq.cancelled`;
  if (session?.urole !== 'admin') query += await cashierOrderFilter(env, store.id, session, true);

  const response = await supabaseFetch(env, query);
  const orders = await readJsonResponse(response, 'Não foi possível carregar o histórico.');

  const valid = orders.filter(o => o.status !== 'cancelled');
  const summary = {
    count: orders.length,
    cancelled: orders.length - valid.length,
    total_cents: valid.reduce((s, o) => s + o.total_cents, 0),
    paid_cents: valid.filter(o => o.payment_status === 'paid').reduce((s, o) => s + o.total_cents, 0),
    pending_cents: valid.filter(o => o.payment_status !== 'paid').reduce((s, o) => s + o.total_cents, 0),
  };

  // Funcionário vê a lista de pedidos, mas não os totais de faturamento da loja.
  const shown = session?.urole === 'admin' ? summary : { count: summary.count, cancelled: summary.cancelled, hidden: true };

  return json({ from, to, orders, summary: shown, truncated: orders.length >= 1000 });
}

/* ---------------- Caixa ---------------- */

async function getOpenCashSession(env, storeId) {
  const response = await supabaseFetch(env, `cash_sessions?select=*&store_id=eq.${storeId}&closed_at=is.null&limit=1`);
  const [session] = await readJsonResponse(response, 'Não foi possível carregar o caixa.');

  return session || null;
}

// Resumo do caixa: pedidos pagos no período do caixa, por forma de pagamento,
// mais sangrias e suprimentos.
async function cashSummary(env, session) {
  const end = session.closed_at || new Date().toISOString();

  const [paidOrders, movements, pendingOrders, creditPayments] = await Promise.all([
    fetchAllRows(env, `orders?select=id,order_number,customer_name,payment_method,payment_split,total_cents,paid_at&store_id=eq.${session.store_id}&payment_status=eq.paid&status=neq.cancelled&paid_at=gte.${encodeURIComponent(session.opened_at)}&paid_at=lte.${encodeURIComponent(end)}&order=paid_at.asc,id.asc`, 'Não foi possível calcular o caixa.'),
    fetchAllRows(env, `cash_movements?select=*&session_id=eq.${session.id}&order=created_at.asc,id.asc`, 'Não foi possível calcular o caixa.'),
    fetchAllRows(env, `orders?select=id,order_number,customer_name,total_cents,status&store_id=eq.${session.store_id}&payment_status=eq.pending&status=neq.cancelled&created_at=gte.${encodeURIComponent(session.opened_at)}&created_at=lte.${encodeURIComponent(end)}&order=created_at.asc,id.asc`, 'Não foi possível calcular o caixa.'),
    // Dívidas do fiado pagas neste caixa (e estornos desses pagamentos). Sem a tabela, nada.
    fetchAllRows(env, `customer_credit_entries?select=id,kind,amount_cents,method,created_at,customers(name)&store_id=eq.${session.store_id}&method=not.is.null&created_at=gte.${encodeURIComponent(session.opened_at)}&created_at=lte.${encodeURIComponent(end)}&order=created_at.asc,id.asc`, 'Não foi possível calcular o caixa.').catch(() => []),
  ]);

  // Pedido com pagamento dividido entra em cada forma com a sua parte.
  const byMethod = method => paidOrders.reduce((s, o) => s + paymentParts(o).filter(p => p.method === method).reduce((t, p) => t + p.cents, 0), 0);
  const cash = byMethod('dinheiro');
  // Na gaveta, débito e crédito caem juntos na maquininha.
  const card = byMethod('cartao') + byMethod('debito') + byMethod('credito');
  const pix = byMethod('pix');
  // Venda no fiado não entra dinheiro agora: fica na conta do cliente.
  const fiado = byMethod('fiado');
  // Recebido de dívidas do fiado (pagamento = valor negativo no livro; estorno volta).
  const received = methods => -creditPayments.filter(e => methods.includes(e.method)).reduce((sum, e) => sum + e.amount_cents, 0);
  const creditCash = received(['dinheiro']);
  const creditCard = received(['debito', 'credito']);
  const creditPix = received(['pix']);
  const sangrias = movements.filter(m => m.type === 'sangria').reduce((s, m) => s + m.amount_cents, 0);
  const suprimentos = movements.filter(m => m.type === 'suprimento').reduce((s, m) => s + m.amount_cents, 0);

  return {
    sales_cash_cents: cash,
    sales_card_cents: card,
    sales_pix_cents: pix,
    sales_total_cents: cash + card + pix,
    sales_fiado_cents: fiado,
    credit_received_cash_cents: creditCash,
    credit_received_card_cents: creditCard,
    credit_received_pix_cents: creditPix,
    credit_payments: creditPayments.map(e => ({ kind: e.kind, amount_cents: e.amount_cents, method: e.method, created_at: e.created_at, customer_name: e.customers?.name || '' })),
    paid_orders_count: paidOrders.length,
    sangrias_cents: sangrias,
    suprimentos_cents: suprimentos,
    expected_cash_cents: session.opening_cents + cash + creditCash + suprimentos - sangrias,
    expected_card_cents: card + creditCard,
    expected_pix_cents: pix + creditPix,
    movements,
    paid_orders: paidOrders,
    pending_orders: pendingOrders,
  };
}

async function handleCash(request, env, session) {
  const store = await getStore(env);
  const open = await getOpenCashSession(env, store.id);
  const isAdmin = session?.urole === 'admin';
  // Funcionário vê só os caixas que ele mesmo abriu.
  const mine = isAdmin ? '' : `&opened_by_id=eq.${session?.uid}`;

  const historyResponse = await supabaseFetch(
    env,
    `cash_sessions?select=*&store_id=eq.${store.id}&closed_at=not.is.null${mine}&order=closed_at.desc&limit=30`
  );
  const history = await readJsonResponse(historyResponse, 'Não foi possível carregar o caixa.');

  // Caixa aberto por outra pessoa: o funcionário só fica sabendo que está aberto (sem valores).
  const canSee = open && (isAdmin || open.opened_by_id === session?.uid);

  return json({
    open: open ? (canSee ? { ...open, summary: await cashSummary(env, open) } : { id: open.id, opened_at: open.opened_at, opened_by_name: open.opened_by_name, other: true }) : null,
    history,
  });
}

async function handleOpenCash(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const opening = toCents(body.opening_cents ?? 0);

  if (opening === null) return json({ error: 'Valor de abertura inválido.' }, 400);

  const store = await getStore(env);

  if (await getOpenCashSession(env, store.id)) {
    return json({ error: 'Já existe um caixa aberto.' }, 409);
  }

  const response = await supabaseFetch(env, 'cash_sessions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ store_id: store.id, opening_cents: opening, opened_by_id: user?.uid || null, opened_by_name: user?.name || null }),
  });
  const [session] = await readJsonResponse(response, 'Não foi possível abrir o caixa.');

  await audit(env, user, 'cash.open', `Abriu o caixa com ${money(opening)} de troco`, { entity: 'cash', entityId: session.id });

  return json({ session });
}

async function handleCashMovement(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const amount = toCents(body.amount_cents);

  if (!['sangria', 'suprimento'].includes(body.type)) return json({ error: 'Tipo inválido.' }, 400);
  if (!amount) return json({ error: 'Informe o valor.' }, 400);

  const store = await getStore(env);
  const session = await getOpenCashSession(env, store.id);

  if (!session) return json({ error: 'Nenhum caixa aberto.' }, 409);

  // Funcionário só mexe no caixa que ele mesmo abriu.
  if (user?.urole !== 'admin' && session.opened_by_id !== user?.uid) return json({ error: 'Este caixa foi aberto por outra pessoa.' }, 403);

  const response = await supabaseFetch(env, 'cash_movements', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      session_id: session.id,
      type: body.type,
      amount_cents: amount,
      description: cleanText(body.description, 200) || null,
    }),
  });
  const [movement] = await readJsonResponse(response, 'Não foi possível registrar.');

  await audit(env, user, `cash.${body.type}`,
    `Registrou ${body.type === 'sangria' ? 'sangria' : 'suprimento'} de ${money(amount)}${movement.description ? ` (${movement.description})` : ''}`,
    { entity: 'cash', entityId: session.id });

  return json({ movement });
}

async function handleCloseCash(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const counted = {};

  for (const key of ['counted_cash_cents', 'counted_card_cents', 'counted_pix_cents']) {
    const value = toCents(body[key] ?? 0);

    if (value === null) return json({ error: 'Valor contado inválido.' }, 400);

    counted[key] = value;
  }

  const store = await getStore(env);
  const session = await getOpenCashSession(env, store.id);

  if (!session) return json({ error: 'Nenhum caixa aberto.' }, 409);

  // Funcionário só mexe no caixa que ele mesmo abriu.
  if (user?.urole !== 'admin' && session.opened_by_id !== user?.uid) return json({ error: 'Este caixa foi aberto por outra pessoa.' }, 403);

  const closedAt = new Date().toISOString();
  const summary = await cashSummary(env, { ...session, closed_at: closedAt });

  const response = await supabaseFetch(env, `cash_sessions?id=eq.${session.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      closed_at: closedAt,
      expected_cash_cents: summary.expected_cash_cents,
      expected_card_cents: summary.expected_card_cents,
      expected_pix_cents: summary.expected_pix_cents,
      sales_total_cents: summary.sales_total_cents,
      sangrias_cents: summary.sangrias_cents,
      suprimentos_cents: summary.suprimentos_cents,
      ...counted,
      notes: cleanText(body.notes, 500) || null,
    }),
  });
  const [closed] = await readJsonResponse(response, 'Não foi possível fechar o caixa.');

  const diff = counted.counted_cash_cents - summary.expected_cash_cents;
  await audit(env, user, 'cash.close',
    `Fechou o caixa: vendas ${money(summary.sales_total_cents)}, dinheiro contado ${money(counted.counted_cash_cents)} (esperado ${money(summary.expected_cash_cents)}${diff ? `, ${diff > 0 ? 'sobra' : 'falta'} ${money(Math.abs(diff))}` : ''})`,
    { entity: 'cash', entityId: session.id, details: { ...counted, expected_cash_cents: summary.expected_cash_cents } });

  return json({ session: closed, summary });
}

/* ---------------- Computador da impressora ---------------- */

// Grava em stores.print_settings qual aparelho imprime sozinho os pedidos novos.
// { device_id, label } define; { off: true } desliga. Só mexe nos campos station_*.
async function handlePrintStation(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const store = await getStore(env);
  const current = store.print_settings && typeof store.print_settings === 'object' ? store.print_settings : {};
  const deviceId = String(body.device_id || '').slice(0, 64);

  if (!body.off && !/^[\w-]{8,64}$/.test(deviceId)) return json({ error: 'Aparelho inválido.' }, 400);

  // "Assumir se ninguém assumiu": não troca o computador de outro.
  if (body.only_if_empty && current.station_id && current.station_id !== deviceId) {
    return json({ store: storeForRole({ ...store, print_settings: current }, session), changed: false });
  }

  const printSettings = body.off
    ? { ...current, station_id: null, station_label: null, station_set_at: null }
    : { ...current, station_id: deviceId, station_label: String(body.label || '').slice(0, 80), station_set_at: new Date().toISOString() };

  const response = await supabaseFetch(env, `stores?id=eq.${store.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ print_settings: printSettings }),
  });
  const [updated] = await readJsonResponse(response, 'Não foi possível salvar.');

  await audit(env, session, 'store.print_station', body.off ? 'Desligou a impressão automática' : `Computador da impressora: ${printSettings.station_label || deviceId}`);

  return json({ store: storeForRole(updated, session), changed: true });
}

/* ---------------- Fechamento PDV ---------------- */

// Resumo financeiro dos pedidos do delivery para lançar à mão no PDV principal da loja.
// Entram só pedidos ENTREGUES, feitos no período (data e hora do pedido, fuso de São Paulo) e que ainda não
// entraram em nenhum fechamento. Ao finalizar, cada pedido fica preso ao fechamento
// (orders.pdv_closing_id) e nunca mais entra em outro.
const CLOSING_METHODS = ['pix', 'dinheiro', 'debito', 'credito', 'cartao', 'fiado'];

async function pdvCandidates(env, storeId, period) {
  const orders = await fetchAllRows(
    env,
    `orders?select=id,order_number,status,payment_status,payment_method,payment_split,subtotal_cents,delivery_fee_cents,discount_cents,total_cents`
      + `&store_id=eq.${storeId}&pdv_closing_id=is.null`
      + `&created_at=gte.${encodeURIComponent(period.start)}&created_at=lte.${encodeURIComponent(period.end)}&order=created_at.asc`,
    'Não foi possível carregar os pedidos do período.'
  );

  return {
    done: orders.filter(o => o.status === 'delivered'),
    // Ainda em andamento: ficam de fora (avisamos na tela).
    open: orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).map(o => o.order_number),
  };
}

function summarizePdv(orders) {
  const payments = Object.fromEntries(CLOSING_METHODS.map(m => [m, 0]));
  let unpaid = 0;
  const unpaidOrders = [];

  for (const o of orders) {
    if (o.payment_status === 'paid') {
      for (const p of paymentParts(o)) payments[p.method] = (payments[p.method] || 0) + p.cents;
    } else {
      unpaid += o.total_cents;
      unpaidOrders.push(o.order_number);
    }
  }

  const sum = key => orders.reduce((s, o) => s + (o[key] || 0), 0);
  const total = sum('total_cents');
  const received = Object.values(payments).reduce((s, v) => s + v, 0);

  return {
    orders_count: orders.length,
    products_cents: sum('subtotal_cents'),
    delivery_fees_cents: sum('delivery_fee_cents'),
    discounts_cents: sum('discount_cents'),
    total_cents: total,
    payments,
    received_cents: received,
    divergence_cents: total - received,
    unpaid_cents: unpaid,
    unpaid_orders: unpaidOrders,
  };
}

// Período do fechamento: datas + horários (HH:MM, São Paulo). Sem horário = o dia inteiro.
function readPeriod(from, to, fromTime, toTime) {
  const f = validDate(from);
  const t = validDate(to);
  const time = (v, fallback) => {
    const m = String(v || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return v ? (m ? m[0] : null) : fallback;
  };
  const ft = time(fromTime, '00:00');
  const tt = time(toTime, '23:59');

  if (!f || !t) return { error: 'Escolha a data inicial e a final.' };
  if (!ft || !tt) return { error: 'Horário inválido.' };

  const start = `${f}T${ft}:00-03:00`;
  const end = `${t}T${tt}:59.999-03:00`;

  if (new Date(start) > new Date(end)) return { error: 'O início não pode ser depois do fim.' };

  return { from: f, to: t, from_time: ft, to_time: tt, start, end };
}

async function handlePdvPreview(request, env) {
  const url = new URL(request.url);
  const period = readPeriod(url.searchParams.get('from'), url.searchParams.get('to'), url.searchParams.get('from_time'), url.searchParams.get('to_time'));

  if (period.error) return json({ error: period.error }, 400);

  const { from, to } = period;
  const store = await getStore(env);
  const { done, open } = await pdvCandidates(env, store.id, period);

  return json({
    from,
    to,
    from_time: period.from_time,
    to_time: period.to_time,
    summary: summarizePdv(done),
    order_ids: done.map(o => o.id),
    order_numbers: done.map(o => o.order_number),
    open_orders: open,
  });
}

async function handlePdvFinalize(request, env, session) {
  if (session.urole !== 'admin') return json({ error: 'Fechamento PDV é exclusivo do administrador.' }, 403);

  const body = await request.json().catch(() => ({}));
  const period = readPeriod(body.from, body.to, body.from_time, body.to_time);

  if (period.error) return json({ error: period.error }, 400);

  const { from, to } = period;
  const store = await getStore(env);
  const { done } = await pdvCandidates(env, store.id, period);
  const summary = summarizePdv(done);
  const sent = Array.isArray(body.order_ids) ? [...body.order_ids].sort() : [];
  const now = done.map(o => o.id).sort();

  // O que vai ser gravado precisa ser exatamente o que a pessoa conferiu na tela.
  if (!now.length) return json({ error: 'Não há pedidos para fechar neste período.' }, 400);

  if (sent.join() !== now.join() || Number(body.expected_total_cents) !== summary.total_cents) {
    return json({ error: 'Os pedidos do período mudaram desde que o fechamento foi gerado. Gere de novo e confira.' }, 409);
  }

  const response = await supabaseFetch(env, 'rpc/finalize_pdv_closing', {
    method: 'POST',
    body: JSON.stringify({
      p_order_ids: now,
      p_closing: {
        store_id: store.id,
        period_from: from,
        period_to: to,
        period_from_time: period.from_time,
        period_to_time: period.to_time,
        orders_count: summary.orders_count,
        products_cents: summary.products_cents,
        delivery_fees_cents: summary.delivery_fees_cents,
        discounts_cents: summary.discounts_cents,
        total_cents: summary.total_cents,
        payments: summary.payments,
        received_cents: summary.received_cents,
        divergence_cents: summary.divergence_cents,
        finalized_by_id: session.uid || '',
        finalized_by_name: session.name,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('finalize_pdv_closing', response.status, text);

    if (text.includes('PDV_STALE')) {
      return json({ error: 'Algum pedido deste fechamento acabou de ser fechado ou alterado. Gere de novo.' }, 409);
    }

    return json({ error: 'Não foi possível finalizar o fechamento.' }, 500);
  }

  const closing = await response.json();

  await audit(env, session, 'pdv.finalize',
    `Finalizou o Fechamento PDV nº ${closing.number} (${summary.orders_count} pedidos, ${money(summary.total_cents)}${summary.divergence_cents ? `, divergência ${money(Math.abs(summary.divergence_cents))}` : ''})`,
    { entity: 'pdv_closing', entityId: closing.id });

  return json({ closing });
}

async function handlePdvClosings(request, env) {
  const store = await getStore(env);
  const response = await supabaseFetch(env, `pdv_closings?select=*&store_id=eq.${store.id}&order=finalized_at.desc&limit=200`);

  return json({ closings: await readJsonResponse(response, 'Não foi possível carregar os fechamentos.') });
}

async function handlePdvClosing(request, env, closingId) {
  if (!validUuid(closingId)) return json({ error: 'Fechamento inválido.' }, 400);

  const store = await getStore(env);
  const [closingResponse, ordersResponse] = await Promise.all([
    supabaseFetch(env, `pdv_closings?select=*&id=eq.${closingId}&store_id=eq.${store.id}`),
    supabaseFetch(env, `orders?select=order_number&pdv_closing_id=eq.${closingId}&order=order_number.asc`),
  ]);
  const [closing] = await readJsonResponse(closingResponse, 'Não foi possível carregar o fechamento.');

  if (!closing) return json({ error: 'Fechamento não encontrado.' }, 404);

  const orders = await readJsonResponse(ordersResponse, 'Não foi possível carregar o fechamento.');

  return json({ closing: { ...closing, order_numbers: orders.map(o => o.order_number) } });
}

/* ---------------- WhatsApp automático (API oficial da Meta) ---------------- */

// Mensagem iniciada pela loja só pode sair de modelo aprovado pela Meta. Os textos
// abaixo são enviados para aprovação pelo painel; os {{n}} são preenchidos com os
// dados do pedido na ordem de "params". Regras da Meta: parâmetro não pode ter
// quebra de linha e o texto não pode começar nem terminar com variável.
const GRAPH = 'https://graph.facebook.com/v21.0';

const WA_API_TEMPLATES = {
  // v2: o "recebido" não diz mais que foi aceito (agora o aceite é uma etapa própria).
  received: {
    name: 'pontox_pedido_recebido_v2',
    body: 'Olá, {{1}}! 👋 Recebemos seu pedido *#{{2}}* na {{3}} e já vamos conferir.\n\nItens: {{4}}\nTotal: *{{5}}* ({{6}})\n\nAcompanhe seu pedido em tempo real: {{7}}\n\nQualquer dúvida, é só responder esta mensagem.',
    params: v => [v.nome, v.pedido, v.loja, v.itens, v.total, v.pagamento, v.link],
  },
  accepted: {
    name: 'pontox_pedido_aceito',
    body: 'Oba, {{1}}! Seu pedido *#{{2}}* foi aceito ✅\n\nPrevisão: {{3}}.\nAcompanhe: {{4}}\n\nObrigado pela preferência!',
    params: v => [v.nome, v.pedido, v.previsao, v.link],
  },
  preparing: {
    name: 'pontox_pedido_preparo',
    body: 'Oba, {{1}}! Seu pedido *#{{2}}* já está sendo separado com todo cuidado 🧊🍺\nLogo, logo ele sai daqui!',
    params: v => [v.nome, v.pedido],
  },
  out_for_delivery: {
    name: 'pontox_pedido_saiu',
    body: 'Boa notícia, {{1}}! 🛵 Seu pedido *#{{2}}* saiu para entrega e já está a caminho de {{3}}.\n\nTotal: *{{4}}* — pagamento na entrega ({{5}}).\nAcompanhe: {{6}}\n\nObrigado pela preferência!',
    params: v => [v.nome, v.pedido, v.endereco, v.total, v.pagamento, v.link],
  },
  ready_pickup: {
    name: 'pontox_pedido_pronto',
    body: 'Olá, {{1}}! Seu pedido *#{{2}}* está pronto para retirada na {{3}} 🏪\n\nTotal: *{{4}}* ({{5}}). É só chegar e retirar!',
    params: v => [v.nome, v.pedido, v.loja, v.total, v.pagamento],
  },
  delivered: {
    name: 'pontox_pedido_entregue',
    body: 'Pedido *#{{1}}* entregue ✅ Obrigado pela preferência, {{2}}! 💛\n\nFoi tudo certo? Sua opinião ajuda muito a gente. Até a próxima! 🍻',
    params: v => [v.pedido, v.nome],
  },
  cancelled: {
    name: 'pontox_pedido_cancelado',
    body: 'Olá, {{1}}. Infelizmente seu pedido *#{{2}}* foi cancelado 😕\n\nSe quiser, responda esta mensagem que a gente te ajuda a refazer o pedido ou tirar qualquer dúvida.',
    params: v => [v.nome, v.pedido],
  },
};

const WA_SAMPLE_VALUES = {
  nome: 'Maria', pedido: '123', loja: 'Ponto X', itens: '2x X-Tudo, 1x Coca-Cola lata',
  total: 'R$ 41,99', pagamento: 'Dinheiro', endereco: 'Rua Exemplo, 100 - Ponto X',
  link: 'https://pontox.sistemaultrion.com.br/?pedido=exemplo',
  previsao: 'chega até as 19:45',
};

function money(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Parâmetro de modelo: sem quebra de linha e sem espaços em excesso (regra da Meta).
function waParam(value, max = 250) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim() || '-';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function waValues(order, store, origin) {
  const items = (order.order_items || []).map(i => `${i.quantity}x ${i.product_name}`).join(', ');

  return {
    nome: (String(order.customer_name || '').trim().split(/\s+/)[0]) || 'cliente',
    pedido: String(order.public_code || order.order_number), // cliente vê o código aleatório
    loja: store.name,
    itens: items,
    total: money(order.total_cents),
    pagamento: paymentText(order),
    endereco: [order.address, order.delivery_zone].filter(Boolean).join(' - ') || 'seu endereço',
    link: `${origin}/?pedido=${order.id}`,
    previsao: order.created_at ? `${order.delivery_type === 'pickup' ? 'pronto para retirar' : 'chega'} até as ${hourMinute(orderDeadline(order, store))}` : 'em breve',
  };
}

function hourMinute(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

function waTemplateKey(order, status) {
  return status === 'out_for_delivery' && order.delivery_type === 'pickup' ? 'ready_pickup' : status;
}

function waSettings(store) {
  return store.whatsapp_settings || {};
}

function waApiReady(env, store) {
  const s = waSettings(store);
  return s.mode === 'api' && s.phone_number_id && env.WHATSAPP_TOKEN;
}

async function graphFetch(env, path, options = {}) {
  const response = await fetch(`${GRAPH}/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(data?.error?.error_user_msg || data?.error?.message || `Erro ${response.status} na Meta`);
    err.meta = data?.error;
    throw err;
  }

  return data;
}

async function logWhatsapp(env, entry) {
  await supabaseFetch(env, 'whatsapp_messages', { method: 'POST', body: JSON.stringify(entry) })
    .catch(err => console.error('logWhatsapp', err));
}

// Envia o modelo de uma etapa para o cliente do pedido e registra o resultado.
async function sendWhatsappTemplate(env, store, order, key, { origin, phoneOverride } = {}) {
  const template = WA_API_TEMPLATES[key];
  let digits = normalizePhone(phoneOverride || order.customer_phone);

  if (!template || digits.length < 10) return { skipped: true };

  const values = order.id === 'teste' ? WA_SAMPLE_VALUES : waValues(order, store, origin);
  const to = `55${digits}`;

  try {
    const data = await graphFetch(env, `${waSettings(store).phone_number_id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: template.name,
          language: { code: 'pt_BR' },
          components: [{ type: 'body', parameters: template.params(values).map(text => ({ type: 'text', text: waParam(text) })) }],
        },
      }),
    });

    await logWhatsapp(env, { store_id: store.id, order_id: order.id === 'teste' ? null : order.id, phone: to, template: template.name, status: 'sent', wa_message_id: data?.messages?.[0]?.id || null });
    return { sent: true };
  } catch (err) {
    await logWhatsapp(env, { store_id: store.id, order_id: order.id === 'teste' ? null : order.id, phone: to, template: template.name, status: 'error', error: String(err.message).slice(0, 500) });
    return { error: err.message };
  }
}

// Disparo automático (em segundo plano, não atrasa o pedido).
// Aviso de etapa: push no celular do cliente (se ele ativou) e WhatsApp automático (se ligado).
async function autoNotify(env, store, orderId, status, origin) {
  await notifyCustomerPush(env, orderId, status).catch(err => console.error('notifyCustomerPush', err));

  const viaQr = waQrReady(env, store);

  if (!viaQr && !waApiReady(env, store)) return;

  let order;

  try {
    const response = await supabaseFetch(env, `orders?select=*,order_items(product_name,quantity)&id=eq.${orderId}`);
    [order] = await readJsonResponse(response, 'Pedido não encontrado.');
  } catch (err) {
    console.error('autoNotify', err);
    return;
  }

  if (!order) return;

  const key = waTemplateKey(order, status);

  if (waSettings(store).auto_send?.[key] === false) return;

  if (viaQr) {
    await queueWhatsappText(env, store, order, key, origin).catch(err => console.error('queueWhatsappText', err));
    return;
  }

  await sendWhatsappTemplate(env, store, order, key, { origin });
}

/* ----- WhatsApp da loja (QR Code): serviço no servidor da Oracle ----- */
// Worker → fila wa_outbox (uma mensagem por pedido + etapa) → serviço (Baileys) → WhatsApp Web.
// Mudar o status do pedido nunca espera o WhatsApp: a mensagem entra na fila em segundo plano.

// Textos padrão (os mesmos do painel; a loja edita em Loja → WhatsApp).
const WA_TEXT_DEFAULTS = {
  received: 'Olá, {nome}! 👋 Aqui é da *{loja}*.\n\nRecebemos seu pedido *#{pedido}* e já vamos conferir. 😉\n\n{itens}\n\n*Total: {total}* · {pagamento}{troco}\n\nAcompanhe em tempo real: {link}\nQualquer dúvida é só responder aqui.',
  accepted: 'Oba, {nome}! Seu pedido *#{pedido}* foi aceito ✅\n\n⏰ Previsão: {previsao}.\n\nAcompanhe: {link}',
  preparing: '{nome}, seu pedido *#{pedido}* já está sendo separado com todo cuidado! 🧊🍺\nLogo, logo ele sai daqui.',
  out_for_delivery: '🛵 Boa notícia, {nome}! Seu pedido *#{pedido}* acabou de sair para entrega e já está a caminho.\n\n📍 {endereco}\n💰 *{total}* · pagamento na entrega ({pagamento}){troco}\n\nAcompanhe: {link}',
  ready_pickup: '{nome}, seu pedido *#{pedido}* está pronto e te esperando aqui na *{loja}*! 🏪\nÉ só chegar e retirar. Total: *{total}* ({pagamento}).',
  delivered: 'Pedido *#{pedido}* entregue! ✅\nObrigado pela preferência, {nome}! 💛\n\nFoi tudo certo? Sua opinião ajuda muito a gente. Até a próxima! 🍻',
  cancelled: '{nome}, infelizmente seu pedido *#{pedido}* foi cancelado. 😕\nSe quiser, responda esta mensagem que a gente te ajuda a refazer o pedido ou tirar qualquer dúvida.',
};

function waQrReady(env, store) {
  return waSettings(store).mode === 'qr' && Boolean(env.WA_SERVICE_URL && env.WA_SERVICE_TOKEN && env.WA_SERVICE_TENANT_SECRET);
}

async function waService(env, storeId, path, { method = 'GET', body, timeout = 12000 } = {}) {
  if (!validUuid(storeId)) throw new Error('Loja inválida para o serviço do WhatsApp.');
  if (!env.WA_SERVICE_TENANT_SECRET) throw new Error('Escopo do serviço do WhatsApp não configurado.');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await sign(`${storeId}.${timestamp}`, env.WA_SERVICE_TENANT_SECRET);
  const response = await fetch(`${env.WA_SERVICE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.WA_SERVICE_TOKEN}`,
      'X-WA-Store-Id': storeId,
      'X-WA-Timestamp': timestamp,
      'X-WA-Store-Signature': signature,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) throw new Error(data.error || `O serviço do WhatsApp respondeu ${response.status}.`);

  return data;
}

function waTextValues(order, store, origin) {
  return {
    ...waValues(order, store, origin),
    itens: (order.order_items || []).map(i => `• ${i.quantity}x ${i.product_name}`).join('\n'),
    troco: order.change_for_cents ? `\n💵 Troco para ${money(order.change_for_cents)}` : '',
  };
}

function renderWaText(store, key, values) {
  const template = store.whatsapp_templates?.[key] || WA_TEXT_DEFAULTS[key] || '';
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));
}

// Coloca o aviso na fila (se já existe para esse pedido + etapa, não duplica) e cutuca o serviço.
async function queueWhatsappText(env, store, order, key, origin) {
  const phone = normalizePhone(order.customer_phone);

  if (phone.length < 10 || !WA_TEXT_DEFAULTS[key]) return;

  const response = await supabaseFetch(env, 'wa_outbox?on_conflict=order_id,event', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ store_id: store.id, order_id: order.id, event: key, phone, body: renderWaText(store, key, waTextValues(order, store, origin)) }),
  });

  if (!response.ok) {
    console.error('wa_outbox', response.status, await response.text());
    return;
  }

  // Se o aviso não chegar, o serviço confere a fila sozinho a cada 20 segundos.
  await waService(env, store.id, '/kick', { method: 'POST', timeout: 5000 }).catch(() => {});
}

// Painel: situação da conexão, fila e últimos envios.
async function handleWaQrStatus(request, env) {
  const store = await getStore(env);
  const result = {
    configured: Boolean(env.WA_SERVICE_URL && env.WA_SERVICE_TOKEN && env.WA_SERVICE_TENANT_SECRET),
    mode: waSettings(store).mode || 'manual',
    service: null,
    error: null,
  };

  if (result.configured) {
    try {
      result.service = await waService(env, store.id, '/status');
    } catch (err) {
      result.error = `Não consegui falar com o servidor do WhatsApp (${err.message}).`;
    }
  }

  const since = new Date(Date.now() - DAY_MS).toISOString();
  const [queue, log] = await Promise.all([
    readJsonResponse(await supabaseFetch(env, `wa_outbox?select=status&store_id=eq.${store.id}&created_at=gte.${encodeURIComponent(since)}`), 'Não foi possível carregar a fila.'),
    readJsonResponse(await supabaseFetch(env, `wa_outbox?select=id,event,phone,status,attempts,last_error,created_at,sent_at,orders(public_code,order_number)&store_id=eq.${store.id}&order=created_at.desc&limit=30`), 'Não foi possível carregar o histórico.'),
  ]);

  result.queue = queue.reduce((acc, row) => ({ ...acc, [row.status]: (acc[row.status] || 0) + 1 }), {});
  result.log = log;

  return json(result);
}

// Painel: conectar (QR), desconectar, reconectar, teste e reenviar uma mensagem que falhou.
async function handleWaQrAction(request, env, action, session) {
  if (!env.WA_SERVICE_URL || !env.WA_SERVICE_TOKEN) return json({ error: 'O servidor do WhatsApp ainda não foi configurado.' }, 400);

  const store = await getStore(env);

  if (action === 'test') {
    const body = await request.json().catch(() => ({}));
    const phone = normalizePhone(body.phone);

    if (phone.length < 10) return json({ error: 'Informe um WhatsApp com DDD.' }, 400);

    const sample = { ...WA_SAMPLE_VALUES, itens: '• 2x X-Tudo\n• 1x Coca-Cola lata', troco: '', loja: store.name };
    const text = `🧪 *Mensagem de teste*\n\n${renderWaText(store, 'received', sample)}`;

    return json(await waService(env, store.id, '/test', { method: 'POST', body: JSON.stringify({ phone, text }), timeout: 30000 }));
  }

  if (action === 'retry') {
    const body = await request.json().catch(() => ({}));

    if (!validUuid(body.id)) return json({ error: 'Mensagem inválida.' }, 400);

    await readJsonResponse(await supabaseFetch(env, `wa_outbox?id=eq.${body.id}&store_id=eq.${store.id}&status=in.(failed,skipped)`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'pending', attempts: 0, last_error: null, next_attempt_at: new Date().toISOString(), created_at: new Date().toISOString() }),
    }), 'Não foi possível reenviar.');

    await waService(env, store.id, '/kick', { method: 'POST', timeout: 5000 }).catch(() => {});

    return json({ ok: true });
  }

  const data = await waService(env, store.id, `/${action}`, { method: 'POST', timeout: 25000 });
  const labels = { connect: 'Pediu o QR Code para conectar o WhatsApp da loja', logout: 'Desconectou o WhatsApp da loja', restart: 'Reconectou o WhatsApp da loja' };

  await audit(env, session, `whatsapp.${action}`, labels[action], { entity: 'store', entityId: store.id });

  return json(data);
}

/* ----- Avisos no celular do cliente (andamento do pedido) ----- */

const CUSTOMER_PUSH_TEXTS = {
  accepted: ['✅ Pedido aceito!', 'Já vamos começar a separar seu pedido.'],
  preparing: ['🧊 Separando seu pedido', 'Seu pedido está sendo preparado com carinho.'],
  out_for_delivery: ['🛵 Saiu para entrega!', 'Seu pedido está a caminho.'],
  ready_pickup: ['🏪 Pronto para retirada!', 'Seu pedido está te esperando na loja.'],
  delivered: ['💛 Pedido entregue', 'Obrigado pela preferência! Até a próxima.'],
  cancelled: ['😕 Pedido cancelado', 'Se precisar, fale com a loja pelo WhatsApp.'],
};

async function notifyCustomerPush(env, orderId, status) {
  if (!pushReady(env)) return;

  const [order] = await readJsonResponse(await supabaseFetch(env, `orders?select=id,public_code,customer_id,delivery_type&id=eq.${orderId}`), 'Pedido não encontrado.');

  if (!order) return;

  const key = status === 'out_for_delivery' && order.delivery_type === 'pickup' ? 'ready_pickup' : status;
  const text = CUSTOMER_PUSH_TEXTS[key];

  if (!text) return;

  // Aparelhos do cliente (pelo cadastro) ou, sem cadastro, os que ativaram neste pedido.
  const filter = `order_id=eq.${order.id}`;

  await sendPushTo(env, `audience=eq.customer&${filter}`, {
    title: `${text[0]} · pedido ${order.public_code}`,
    body: text[1],
    url: `/?pedido=${order.id}`,
    tag: `cliente-${order.id}`,
  });
}

// Cliente ativa os avisos na tela do pedido. A prova de que é ele é o id do pedido (uuid).
async function handleCustomerPushSubscribe(request, env) {
  const body = await request.json().catch(() => ({}));
  const sub = body.subscription || {};

  if (!validUuid(body.order_id)) return json({ error: 'Pedido inválido.' }, 400);

  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth || !/^https:\/\//.test(sub.endpoint)) {
    return json({ error: 'Inscrição inválida.' }, 400);
  }

  const [order] = await readJsonResponse(await supabaseFetch(env, `orders?select=id,store_id,customer_id&id=eq.${body.order_id}`), 'Pedido não encontrado.');

  if (!order) return json({ error: 'Pedido não encontrado.' }, 404);

  // Aparelho da equipe (dono/caixa/entregador) continua sendo da equipe: não vira "cliente".
  const [existing] = await readJsonResponse(await supabaseFetch(env, `push_subscriptions?select=audience&endpoint=eq.${encodeURIComponent(sub.endpoint)}`), 'Não foi possível ativar os avisos.');

  if (existing && existing.audience !== 'customer') return json({ ok: true, staff_device: true });

  const response = await supabaseFetch(env, 'push_subscriptions?on_conflict=endpoint', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      store_id: order.store_id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      device: 'Cliente',
      audience: 'customer',
      customer_id: order.customer_id,
      order_id: order.id,
      staff_id: null,
    }),
  });
  await readJsonResponse(response, 'Não foi possível ativar os avisos.');

  return json({ ok: true });
}

// Cliente aceitou receber promoções (pop-up do cardápio). Aparelho da equipe não muda de público.
async function handlePromoPushSubscribe(request, env) {
  const body = await request.json().catch(() => ({}));
  const sub = body.subscription || {};

  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth || !/^https:\/\//.test(sub.endpoint)) {
    return json({ error: 'Inscrição inválida.' }, 400);
  }

  const store = await getStore(env);
  const [existing] = await readJsonResponse(await supabaseFetch(env, `push_subscriptions?select=audience&endpoint=eq.${encodeURIComponent(sub.endpoint)}`), 'Não foi possível ativar os avisos.');

  if (existing && existing.audience !== 'customer') return json({ ok: true, staff_device: true });

  const response = await supabaseFetch(env, 'push_subscriptions?on_conflict=endpoint', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      store_id: store.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      device: 'Cliente',
      audience: 'customer',
      promos: true,
    }),
  });
  await readJsonResponse(response, 'Não foi possível ativar os avisos.');

  return json({ ok: true });
}

// Painel: manda uma promoção para todos os aparelhos que aceitaram.
async function handleSendPromo(request, env, session) {
  if (!pushReady(env)) return json({ error: 'A chave das notificações ainda não foi cadastrada no Cloudflare.' }, 400);

  const body = await request.json().catch(() => ({}));
  const title = cleanText(body.title, 60);
  const text = cleanText(body.body, 180);

  if (title.length < 3 || text.length < 3) return json({ error: 'Escreva o título e a mensagem da promoção.' }, 400);

  const store = await getStore(env);
  const result = await sendPushTo(env, `store_id=eq.${store.id}&audience=eq.customer&promos=is.true`, { title, body: text, url: '/', tag: 'promocao' });

  await audit(env, session, 'promo.send', `Mandou a promoção "${title}" para ${result.sent} aparelho(s)`, { entity: 'store', entityId: store.id });

  return json(result);
}

// Endereço oficial da loja: domínio próprio cadastrado (stores.domains) sempre
// que existir — cada loja usa o dela nos links do WhatsApp. Sem domínio
// cadastrado, cai em vars.SITE_URL (loja principal); nunca usa o endereço
// acessado (workers.dev/teste).
function storeOrigin(store, env) {
  const domains = Array.isArray(store?.domains) ? store.domains : [];
  const domain = domains.find(d => d && !/^www\./i.test(d)) || domains[0];
  if (domain) return `https://${domain}`;
  return env?.SITE_URL ? String(env.SITE_URL).replace(/[/]+$/, '') : '';
}

async function handleWhatsappStatus(request, env) {
  const store = await getStore(env);
  const s = waSettings(store);
  const result = {
    token_configured: Boolean(env.WHATSAPP_TOKEN),
    mode: s.mode || 'manual',
    phone_number_id: s.phone_number_id || '',
    waba_id: s.waba_id || '',
    templates: Object.entries(WA_API_TEMPLATES).map(([key, t]) => ({ key, name: t.name, body: t.body, status: null })),
    phone: null,
    error: null,
  };

  if (env.WHATSAPP_TOKEN && s.phone_number_id) {
    try {
      result.phone = await graphFetch(env, `${s.phone_number_id}?fields=display_phone_number,verified_name,quality_rating`);
    } catch (err) {
      result.error = `Número: ${err.message}`;
    }
  }

  if (env.WHATSAPP_TOKEN && s.waba_id) {
    try {
      const data = await graphFetch(env, `${s.waba_id}/message_templates?fields=name,status,category&limit=100`);
      const byName = new Map((data.data || []).map(t => [t.name, t]));

      for (const t of result.templates) {
        const remote = byName.get(t.name);
        t.status = remote?.status || 'NAO_CRIADO';
        t.category = remote?.category || null;
      }
    } catch (err) {
      result.error = [result.error, `Modelos: ${err.message}`].filter(Boolean).join(' · ');
    }
  }

  const logResponse = await supabaseFetch(env, `whatsapp_messages?select=*&store_id=eq.${store.id}&order=created_at.desc&limit=30`);
  result.log = await readJsonResponse(logResponse, 'Não foi possível carregar o histórico.');

  return json(result);
}

// Manda os 6 modelos para aprovação da Meta (os que já existem são ignorados).
async function handleCreateWhatsappTemplates(request, env) {
  const store = await getStore(env);
  const s = waSettings(store);

  if (!env.WHATSAPP_TOKEN) return json({ error: 'O token do WhatsApp ainda não foi cadastrado no Cloudflare.' }, 400);
  if (!s.waba_id) return json({ error: 'Informe o ID da conta do WhatsApp Business e salve.' }, 400);

  const results = [];

  for (const template of Object.values(WA_API_TEMPLATES)) {
    const example = [template.params(WA_SAMPLE_VALUES).map(v => waParam(v))];

    try {
      const data = await graphFetch(env, `${s.waba_id}/message_templates`, {
        method: 'POST',
        body: JSON.stringify({
          name: template.name,
          language: 'pt_BR',
          category: 'UTILITY',
          components: [{ type: 'BODY', text: template.body, example: { body_text: example } }],
        }),
      });
      results.push({ name: template.name, ok: true, status: data.status });
    } catch (err) {
      const exists = /already exists|já existe/i.test(err.message) || err.meta?.error_subcode === 2388024;
      results.push({ name: template.name, ok: exists, status: exists ? 'JA_EXISTE' : null, error: exists ? null : err.message });
    }
  }

  return json({ results });
}

async function handleWhatsappTest(request, env) {
  const body = await request.json().catch(() => ({}));
  const store = await getStore(env);

  if (!waApiReady(env, store)) {
    return json({ error: 'Ligue o modo automático, informe o ID do número e cadastre o token antes do teste.' }, 400);
  }

  const result = await sendWhatsappTemplate(env, store, { id: 'teste', customer_phone: body.phone }, 'received', { phoneOverride: body.phone });

  if (result.skipped) return json({ error: 'Informe um WhatsApp válido com DDD.' }, 400);
  if (result.error) return json({ error: result.error }, 502);

  return json({ ok: true });
}

/* ---------------- Taxa de entrega por bairro ---------------- */

function readZoneFields(body, partial) {
  const fields = {};

  if (!partial || body.name !== undefined) {
    const name = cleanText(body.name, 80);

    if (name.length < 2) return { error: 'Informe o nome do bairro.' };

    fields.name = name;
  }

  if (!partial || body.fee_cents !== undefined) {
    const fee = toCents(body.fee_cents ?? 0);

    if (fee === null) return { error: 'Taxa inválida.' };

    fields.fee_cents = fee;
  }

  if (body.active !== undefined) fields.active = Boolean(body.active);
  if (body.sort_order !== undefined) fields.sort_order = Math.floor(Number(body.sort_order)) || 0;

  // Ruas do bairro (a fila de entregas agrupa por elas). Sem repetidas, na ordem digitada.
  if (body.streets !== undefined) {
    if (!Array.isArray(body.streets)) return { error: 'Lista de ruas inválida.' };

    const seen = new Set();
    fields.streets = body.streets.map(s => cleanText(s, 60)).filter(s => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())).slice(0, 80);
  }

  return { fields };
}

async function handleCreateZone(request, env, session) {
  const { fields, error } = readZoneFields(await request.json().catch(() => ({})), false);

  if (error) return json({ error }, 400);

  const store = await getStore(env);
  const zones = await getDeliveryZones(env, store.id, false);

  const response = await supabaseFetch(env, 'delivery_zones', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ sort_order: zones.length, ...fields, store_id: store.id }),
  });
  const [zone] = await readJsonResponse(response, 'Não foi possível salvar o bairro.');

  await audit(env, session, 'zone.create', `Cadastrou o bairro ${zone.name} (taxa ${money(zone.fee_cents)})`, { entity: 'zone', entityId: zone.id });

  return json({ zone });
}

async function handleUpdateZone(request, env, zoneId, session) {
  if (!validUuid(zoneId)) return json({ error: 'Bairro inválido.' }, 400);

  const { fields, error } = readZoneFields(await request.json().catch(() => ({})), true);

  if (error) return json({ error }, 400);
  if (!Object.keys(fields).length) return json({ error: 'Nada para atualizar.' }, 400);

  const [before] = await readJsonResponse(await supabaseFetch(env, `delivery_zones?select=name,fee_cents&id=eq.${zoneId}`), 'Não foi possível salvar o bairro.');

  const response = await supabaseFetch(env, `delivery_zones?id=eq.${zoneId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  const rows = await readJsonResponse(response, 'Não foi possível salvar o bairro.');

  if (!rows[0]) return json({ error: 'Bairro não encontrado.' }, 404);

  if (before && before.fee_cents !== rows[0].fee_cents) {
    await audit(env, session, 'zone.fee', `Taxa do bairro ${rows[0].name}: ${money(before.fee_cents)} → ${money(rows[0].fee_cents)}`, { entity: 'zone', entityId: zoneId });
  }

  return json({ zone: rows[0] });
}

async function handleDeleteZone(request, env, zoneId, session) {
  if (!validUuid(zoneId)) return json({ error: 'Bairro inválido.' }, 400);

  const response = await supabaseFetch(env, `delivery_zones?id=eq.${zoneId}`, { method: 'DELETE', headers: { Prefer: 'return=representation' } });
  const [zone] = await readJsonResponse(response, 'Não foi possível excluir o bairro.');

  if (zone) await audit(env, session, 'zone.delete', `Excluiu o bairro ${zone.name}`, { entity: 'zone', entityId: zoneId });

  return json({ ok: true });
}

/* ---------------- Aviso de pedido novo no celular do dono (Web Push) ---------------- */

// Mesmo mecanismo do app da mercearia: chaves VAPID + payload criptografado (aes128gcm).
function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

function concatBytes(...arrays) {
  const result = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let offset = 0;

  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }

  return result;
}

function uint32BE(n) {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, n, false);
  return buf;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

async function hkdfExpand(prk, info, length) {
  return (await hmacSha256(prk, concatBytes(info, new Uint8Array([1])))).slice(0, length);
}

async function vapidAuthHeader(env, audience) {
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_KEY_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = textToBase64Url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = textToBase64Url(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: env.VAPID_SUBJECT }));
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(unsigned));

  return `vapid t=${unsigned}.${toBase64Url(new Uint8Array(signature))}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function encryptPushPayload(payloadObj, p256dhB64, authB64) {
  const payload = new TextEncoder().encode(JSON.stringify(payloadObj));
  const subscriberPublicKeyRaw = base64UrlToBytes(p256dhB64);
  const authSecret = base64UrlToBytes(authB64);
  const subscriberPublicKey = await crypto.subtle.importKey('raw', subscriberPublicKeyRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: subscriberPublicKey }, ephemeral.privateKey, 256));
  const serverPublicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  const prkKey = await hmacSha256(authSecret, sharedSecret);
  const keyInfo = concatBytes(new TextEncoder().encode('WebPush: info\0'), subscriberPublicKeyRaw, serverPublicKeyRaw);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmacSha256(salt, ikm);
  const cek = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, concatBytes(payload, new Uint8Array([2]))));

  return concatBytes(salt, uint32BE(4096), new Uint8Array([serverPublicKeyRaw.length]), serverPublicKeyRaw, ciphertext);
}

async function sendWebPush(env, subscription, payloadObj) {
  const endpoint = new URL(subscription.endpoint);
  const [authHeader, body] = await Promise.all([
    vapidAuthHeader(env, `${endpoint.protocol}//${endpoint.host}`),
    encryptPushPayload(payloadObj, subscription.p256dh, subscription.auth),
  ]);

  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: '3600', Urgency: 'high' },
    body,
  });
}

function pushReady(env) {
  return Boolean(env.VAPID_PRIVATE_KEY_JWK && env.VAPID_PUBLIC_KEY);
}

// Manda para todos os aparelhos inscritos; apaga inscrições que o navegador já cancelou.
// Dono/caixa: todos os avisos (inclusive faturamento e alertas).
async function notifyOwner(env, storeId, payloadObj, adminOnly = false) {
  let filter = `store_id=eq.${storeId}&audience=eq.owner`;
  if (adminOnly) {
    const staff = await readJsonResponse(await supabaseFetch(env, `staff?select=id&store_id=eq.${storeId}&active=is.true&role=eq.admin`), 'Não foi possível conferir administradores.');
    filter += staff.length ? `&or=(staff_id.is.null,staff_id.in.(${staff.map(s => s.id).join(',')}))` : '&staff_id=is.null';
  }
  return sendPushTo(env, filter, payloadObj);
}

// Entregadores: só pedido novo (para já ir se preparando) e a entrega que caiu para ele.
async function notifyCouriers(env, storeId, payloadObj, staffId = null) {
  return sendPushTo(env, `store_id=eq.${storeId}&audience=eq.courier${staffId ? `&staff_id=eq.${staffId}` : ''}`, payloadObj);
}

async function sendPushTo(env, filter, payloadObj) {
  if (!pushReady(env)) return { sent: 0, reason: 'sem chave' };

  const response = await supabaseFetch(env, `push_subscriptions?select=id,endpoint,p256dh,auth&${filter}`);
  const subs = await readJsonResponse(response, 'Erro ao carregar aparelhos.');
  let sent = 0;

  await Promise.allSettled(subs.map(async sub => {
    try {
      const res = await sendWebPush(env, sub, payloadObj);

      if (res.status === 404 || res.status === 410) {
        await supabaseFetch(env, `push_subscriptions?id=eq.${sub.id}`, { method: 'DELETE' });
      } else if (res.ok) {
        sent++;
      } else {
        console.error('push', res.status, await res.text());
      }
    } catch (err) {
      console.error('push', err);
    }
  }));

  return { sent, devices: subs.length };
}

async function notifyNewOrder(env, store, order, total, customerName, deliveryType, zone) {
  const where = deliveryType === 'pickup' ? 'retirada' : (zone || 'entrega');

  await Promise.allSettled([
    notifyOwner(env, store.id, {
      title: `🔔 Pedido novo #${order.order_number}${order.scheduled ? ' (para quando abrir)' : ''}`,
      body: `${customerName} · ${money(total)} · ${where}`,
      url: '/admin.html',
      tag: `pedido-${order.id}`,
    }),
    // Entregador: só pedido de entrega, sem valor nem nome do cliente.
    deliveryType === 'delivery' ? notifyCouriers(env, store.id, {
      title: `🛵 Pedido novo para entrega: ${order.public_code}`,
      body: `${[zone, order.delivery_street].filter(Boolean).join(' · ') || 'Entrega'} — já vai se preparando!`,
      url: '/admin.html',
      tag: `pedido-${order.id}`,
    }) : null,
  ]);
}

/* ----- Alertas agrupados para o dono (Cron Trigger a cada 5 min) ----- */

// Em vez de um aviso por pedido: um só resumo ("3 pedidos passaram do prazo"),
// enviado apenas quando surge pedido NOVO nessa situação (alert_state guarda quem já foi avisado).
const WAIT_ACCEPT_MINUTES = 5;

async function runOwnerAlerts(env) {
  if (!pushReady(env)) return;

  const store = await getStore(env);
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const response = await supabaseFetch(
    env,
    `orders?select=id,order_number,status,delivery_type,created_at&store_id=eq.${store.id}&status=not.in.(delivered,cancelled)&created_at=gte.${encodeURIComponent(since)}&order=created_at.asc`
  );
  const orders = await readJsonResponse(response, 'Não foi possível verificar os pedidos.');
  const now = Date.now();

  const late = orders.filter(o => orderDeadline(o, store) < now);
  const waiting = orders.filter(o => o.status === 'received' && now - new Date(o.created_at).getTime() > WAIT_ACCEPT_MINUTES * 60000);
  const prev = { late: store.alert_state?.late || [], waiting: store.alert_state?.waiting || [], wa_down: store.alert_state?.wa_down || 0, wa_alerted: Boolean(store.alert_state?.wa_alerted) };
  const numbers = list => list.map(o => `#${o.order_number}`).join(', ');
  const lines = [];

  if (late.some(o => !prev.late.includes(o.id))) {
    lines.push(late.length === 1 ? `O pedido ${numbers(late)} passou do prazo.` : `${late.length} pedidos passaram do prazo: ${numbers(late)}.`);
  }

  if (waiting.some(o => !prev.waiting.includes(o.id))) {
    lines.push(waiting.length === 1
      ? `O pedido ${numbers(waiting)} está esperando aceite há mais de ${WAIT_ACCEPT_MINUTES} min.`
      : `${waiting.length} pedidos esperando aceite há mais de ${WAIT_ACCEPT_MINUTES} min: ${numbers(waiting)}.`);
  }

  if (lines.length) {
    await notifyOwner(env, store.id, { title: '⚠️ Atenção nos pedidos', body: lines.join(' '), url: '/admin.html', tag: 'alerta-pedidos' });
  }

  // WhatsApp da loja (QR Code) caiu: avisa o dono uma vez (depois de 2 conferências seguidas,
  // ~10 min, para não alarmar quando ele só está reconectando) e avisa de novo quando voltar.
  const wa = { down: store.alert_state?.wa_down || 0, alerted: Boolean(store.alert_state?.wa_alerted) };

  if (waQrReady(env, store)) {
    const status = await waService(env, store.id, '/status', { timeout: 8000 }).catch(() => null);
    const online = status?.state === 'open';

    if (online) {
      if (wa.alerted) {
        await notifyOwner(env, store.id, { title: '✅ WhatsApp da loja conectado', body: 'As mensagens automáticas e os códigos do VIP voltaram a sair.', url: '/admin.html', tag: 'whatsapp-caiu' });
      }
      Object.assign(wa, { down: 0, alerted: false });
    } else {
      wa.down += 1;

      if (wa.down >= 2 && !wa.alerted) {
        await notifyOwner(env, store.id, {
          title: '📵 WhatsApp da loja desconectado',
          body: status ? 'As mensagens automáticas e os códigos do VIP não estão saindo. Reconecte em Loja > WhatsApp (QR Code).' : 'O servidor do WhatsApp não respondeu. Mensagens automáticas e códigos do VIP não estão saindo.',
          url: '/admin.html',
          tag: 'whatsapp-caiu',
        });
        wa.alerted = true;
      }
    }
  } else {
    Object.assign(wa, { down: 0, alerted: false });
  }

  const next = { late: late.map(o => o.id), waiting: waiting.map(o => o.id), wa_down: wa.down, wa_alerted: wa.alerted };

  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    await supabaseFetch(env, `stores?id=eq.${store.id}`, { method: 'PATCH', body: JSON.stringify({ alert_state: next }) });
  }
}

async function handlePushSubscribe(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const sub = body.subscription || {};
  const courier = session?.urole === 'entregador';

  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth || !/^https:\/\//.test(sub.endpoint)) {
    return json({ error: 'Inscrição inválida.' }, 400);
  }

  const store = await getStore(env);
  const response = await supabaseFetch(env, 'push_subscriptions?on_conflict=endpoint', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      store_id: store.id,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      device: `${courier ? `${session.name} · ` : ''}${cleanText(body.device, 100)}` || null,
      audience: courier ? 'courier' : 'owner',
      staff_id: session?.uid || null,
    }),
  });
  await readJsonResponse(response, 'Não foi possível ativar os avisos.');

  return json({ ok: true });
}

async function handlePushUnsubscribe(request, env) {
  const body = await request.json().catch(() => ({}));

  if (body.endpoint) {
    await supabaseFetch(env, `push_subscriptions?endpoint=eq.${encodeURIComponent(body.endpoint)}`, { method: 'DELETE' });
  }

  return json({ ok: true });
}

async function handlePushStatus(request, env, session) {
  const store = await getStore(env);
  // Entregador só vê os próprios aparelhos.
  const mine = session?.urole === 'entregador' ? `&staff_id=eq.${session.uid}` : '';
  // Lista só aparelhos da equipe; dos clientes, só a quantidade que aceitou promoções.
  const [devicesResponse, promosResponse] = await Promise.all([
    supabaseFetch(env, `push_subscriptions?select=id,device,audience,created_at&store_id=eq.${store.id}&audience=in.(owner,courier)${mine}&order=created_at.desc`),
    supabaseFetch(env, `push_subscriptions?select=id&store_id=eq.${store.id}&audience=eq.customer&promos=is.true`),
  ]);
  const devices = await readJsonResponse(devicesResponse, 'Erro ao carregar aparelhos.');
  const promoDevices = session?.urole === 'entregador' ? 0 : (await readJsonResponse(promosResponse, 'Erro ao carregar aparelhos.')).length;

  return json({ ready: pushReady(env), public_key: env.VAPID_PUBLIC_KEY || null, devices, promo_devices: promoDevices });
}

async function handlePushTest(request, env) {
  if (!pushReady(env)) return json({ error: 'A chave das notificações ainda não foi cadastrada no Cloudflare.' }, 400);

  const store = await getStore(env);
  const result = await notifyOwner(env, store.id, {
    title: '🔔 Teste de aviso',
    body: 'Se você está vendo isto, os avisos de pedido novo estão funcionando! 🍻',
    url: '/admin.html',
    tag: 'teste',
  });

  if (!result.devices) return json({ error: 'Nenhum aparelho ativado ainda.' }, 400);

  return json(result);
}

/* ---------------- Clientes ---------------- */

// Níveis de fidelidade (pedidos cancelados não contam). Vale o primeiro que bater.
// ("VIP" agora é a marcação manual de entrega grátis; o nível automático virou "Fiel".)
const CUSTOMER_TIERS = [
  { key: 'elite', label: '👑 Elite', minSpentCents: 300000, minOrders: 50 },
  { key: 'fiel', label: '💎 Fiel', minSpentCents: 100000, minOrders: 20 },
  { key: 'frequente', label: '🔁 Frequente', minSpentCents: Infinity, minOrders: 6 },
  { key: 'novo', label: '🆕 Novo', minSpentCents: 0, minOrders: 0 },
];
const INACTIVE_DAYS = 30;
const DAY_MS = 86400000;

// Intervalo médio (em dias) entre compras, contando no máximo uma por dia. Null se não dá para saber.
function averageIntervalDays(isoDates) {
  const days = [...new Set(isoDates.map(d => Math.floor(new Date(d).getTime() / DAY_MS)))].sort((a, b) => a - b);

  if (days.length < 2) return null;

  return (days[days.length - 1] - days[0]) / (days.length - 1);
}

// "Parou de comprar": cliente que comprava com frequência (3+ pedidos) e passou bem do ritmo dele.
function stoppedBuying(validCount, avgInterval, daysSinceLast) {
  return validCount >= 3 && avgInterval != null && daysSinceLast != null
    && daysSinceLast > Math.max(avgInterval * 2, avgInterval + 7, 10);
}

// Dias até o aniversário ("MM-DD"): positivo = faltam, negativo = já passou (perto da virada do ano também).
function birthdayDistance(mmdd) {
  if (!/^\d{2}-\d{2}$/.test(mmdd || '')) return null;

  const [bm, bd] = mmdd.split('-').map(Number);
  // Dia precisa existir no mês (2000 é bissexto, então 29/02 vale).
  if (new Date(Date.UTC(2000, bm - 1, bd)).getUTCMonth() !== bm - 1 || bd < 1) return null;

  const [y, m, d] = todaySaoPaulo().split('-').map(Number);
  const today = Date.UTC(y, m - 1, d);
  let best = null;

  for (const year of [y - 1, y, y + 1]) {
    const diff = Math.round((Date.UTC(year, bm - 1, bd) - today) / DAY_MS);
    if (best === null || Math.abs(diff) < Math.abs(best)) best = diff;
  }

  return best;
}

// Produtos que o cliente costuma repetir e que "está na hora" de comprar de novo.
function repeatSuggestions(orders) {
  const byItem = new Map();

  for (const o of (orders || []).filter(x => x.status !== 'cancelled')) {
    for (const i of o.order_items || []) {
      if (!i.product_id) continue;

      const key = `${i.product_id}:${i.variant_id || ''}`;
      if (!byItem.has(key)) byItem.set(key, { product_id: i.product_id, variant_id: i.variant_id || null, name: i.product_name, dates: [] });
      byItem.get(key).dates.push(o.created_at);
    }
  }

  const now = Date.now();
  const due = [];

  for (const item of byItem.values()) {
    const every = averageIntervalDays(item.dates);

    if (!every || every < 2) continue;

    const last = Math.max(...item.dates.map(d => new Date(d).getTime()));
    const since = Math.floor((now - last) / DAY_MS);

    // Chegou perto do ritmo de sempre (e não faz tanto tempo que ele já desistiu do produto).
    if (since >= every * 0.85 && since <= every * 3) {
      due.push({ product_id: item.product_id, variant_id: item.variant_id, name: item.name, every_days: Math.round(every), days_since: since, times: item.dates.length });
    }
  }

  return due.sort((a, b) => b.days_since / b.every_days - a.days_since / a.every_days).slice(0, 6);
}

const BIRTHDAY_DEFAULTS = { enabled: true, type: 'percent', value: 10, amount_cents: 1000, max_cents: 2000, days_before: 3, days_after: 3, min_days_registered: 30 };

function birthdaySettings(store) {
  return { ...BIRTHDAY_DEFAULTS, ...(store.birthday_settings || {}) };
}

function birthdayOfferText(s) {
  return s.type === 'amount'
    ? `${money(s.amount_cents)} de desconto`
    : `${s.value}% de desconto${s.max_cents ? ` (até ${money(s.max_cents)})` : ''}`;
}

// Está na janela do aniversário e ainda não usou o presente este ano?
async function birthdayEligible(env, store, customer) {
  const s = birthdaySettings(store);

  if (!s.enabled || !customer?.id || !customer.birthday) return false;

  const distance = birthdayDistance(customer.birthday);

  if (distance === null || distance > s.days_before || distance < -s.days_after) return false;

  // Aniversário cadastrado agora há pouco não vale (evita "virar aniversariante" para ganhar desconto).
  if (customer.birthday_set_at && Date.now() - new Date(customer.birthday_set_at).getTime() < s.min_days_registered * DAY_MS) return false;

  const since = new Date(Date.now() - 300 * DAY_MS).toISOString();
  const response = await supabaseFetch(env, `orders?select=id&customer_id=eq.${customer.id}&discount_reason=eq.aniversario&status=neq.cancelled&created_at=gte.${encodeURIComponent(since)}&limit=1`);
  const used = await readJsonResponse(response, 'Não foi possível conferir o presente de aniversário.');

  return !used.length;
}

function birthdayDiscountCents(store, subtotal) {
  const s = birthdaySettings(store);

  if (s.type === 'amount') return Math.min(s.amount_cents, subtotal);

  const cents = Math.round((subtotal * s.value) / 100);
  return s.max_cents ? Math.min(cents, s.max_cents) : cents;
}

// legacyOrders: pedidos que o cliente fez no Olá Click (só a quantidade; o valor não veio).
function customerStats(orders, legacyOrders = 0) {
  const valid = (orders || []).filter(o => o.status !== 'cancelled');
  const spent = valid.reduce((sum, o) => sum + o.total_cents, 0);
  const dates = valid.map(o => o.created_at).sort();
  const last = dates[dates.length - 1] || null;
  const totalOrders = valid.length + (legacyOrders || 0);
  const tier = CUSTOMER_TIERS.find(t => spent >= t.minSpentCents || totalOrders >= t.minOrders);
  const daysSinceLast = last ? Math.floor((Date.now() - new Date(last).getTime()) / 86400000) : null;
  const avgInterval = averageIntervalDays(dates);

  return {
    avg_interval_days: avgInterval != null ? Math.round(avgInterval) : null,
    stopped: stoppedBuying(valid.length, avgInterval, daysSinceLast),
    orders_count: valid.length,
    legacy_orders_count: legacyOrders || 0,
    total_orders_count: totalOrders,
    cancelled_count: (orders || []).length - valid.length,
    total_spent_cents: spent,
    average_ticket_cents: valid.length ? Math.round(spent / valid.length) : 0,
    first_order_at: dates[0] || null,
    last_order_at: last,
    days_since_last_order: daysSinceLast,
    inactive: daysSinceLast !== null && daysSinceLast > INACTIVE_DAYS,
    tier: tier.key,
    tier_label: tier.label,
  };
}

async function handleAdminCustomers(request, env, session) {
  const store = await getStore(env);

  const rows = await fetchAllRows(
    env,
    `customers?select=id,name,phone,address,delivery_zone,email,notes,source,legacy_orders_count,created_at,is_vip,highlight,birthday,marketing_opt_in,orders(total_cents,status,created_at)&store_id=eq.${store.id}&order=id.asc`,
    'Não foi possível carregar os clientes.'
  );

  const customers = rows
    .map(({ orders, ...customer }) => ({ ...customer, ...customerStats(orders, customer.legacy_orders_count), birthday_in_days: birthdayDistance(customer.birthday) }))
    .sort((a, b) => b.total_spent_cents - a.total_spent_cents || b.total_orders_count - a.total_orders_count || (b.last_order_at || '').localeCompare(a.last_order_at || ''))
    // Funcionário não vê quanto cada cliente gastou (somando daria o faturamento da loja).
    .map(c => (session?.urole === 'admin' ? c : { ...c, total_spent_cents: null, average_ticket_cents: null }));
  if (session?.urole !== 'admin') customers.sort((a, b) => a.name.localeCompare(b.name));

  return json({
    customers,
    tiers: CUSTOMER_TIERS.map(({ key, label, minSpentCents, minOrders }) => ({
      key,
      label,
      min_spent_cents: Number.isFinite(minSpentCents) ? minSpentCents : null,
      min_orders: minOrders,
    })),
    inactive_days: INACTIVE_DAYS,
    birthday: { ...birthdaySettings(store), offer_text: birthdayOfferText(birthdaySettings(store)) },
  });
}

// Novo pedido pelo painel: acha o cadastro pelo telefone (dados completos, só para a equipe).
async function handleAdminCustomerByPhone(request, env) {
  const digits = normalizePhone(new URL(request.url).searchParams.get('phone'));

  if (digits.length < 10 || digits.length > 11) return json({ found: false });

  const store = await getStore(env);
  const response = await supabaseFetch(
    env,
    `customers?select=id,name,phone,address,delivery_zone,is_vip,highlight,notes,legacy_orders_count,credit_enabled,credit_limit_cents,credit_balance_cents,orders(total_cents,status,created_at)&store_id=eq.${store.id}&phone=eq.${digits}&limit=1`
  );
  const [row] = await readJsonResponse(response, 'Não foi possível buscar o cliente.');

  if (!row) return json({ found: false });

  const { orders, ...customer } = row;
  const stats = customerStats(orders, customer.legacy_orders_count);

  return json({
    found: true,
    customer: {
      ...customer,
      total_orders_count: stats.total_orders_count,
      last_order_at: stats.last_order_at,
      tier_label: stats.tier_label,
    },
  });
}

async function handleAdminCustomer(request, env, customerId, session) {
  if (!validUuid(customerId)) return json({ error: 'Cliente inválido.' }, 400);

  const response = await supabaseFetch(
    env,
    `customers?select=*,orders(id,order_number,status,delivery_type,payment_method,payment_split,total_cents,delivery_fee_cents,discount_cents,discount_reason,fee_waived,address,notes,created_at,order_items(product_id,variant_id,product_name,quantity,subtotal_cents))&id=eq.${customerId}&orders.order=created_at.desc`
  );
  const [row] = await readJsonResponse(response, 'Não foi possível carregar o cliente.');

  if (!row) return json({ error: 'Cliente não encontrado.' }, 404);

  const { orders, ...customer } = row;

  // Produtos que o cliente mais compra (pedidos cancelados não contam).
  const totals = new Map();

  for (const order of orders.filter(o => o.status !== 'cancelled')) {
    for (const item of order.order_items) {
      const current = totals.get(item.product_name) || { name: item.product_name, quantity: 0, spent_cents: 0 };
      current.quantity += item.quantity;
      current.spent_cents += item.subtotal_cents;
      totals.set(item.product_name, current);
    }
  }

  const topProducts = [...totals.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5);
  const store = await getStore(env);
  const birthdayNow = await birthdayEligible(env, store, customer).catch(() => false);

  const stats = customerStats(orders, customer.legacy_orders_count);

  if (session?.urole !== 'admin') Object.assign(stats, { total_spent_cents: null, average_ticket_cents: null });

  if (session?.urole !== 'admin') {
    return json({
      customer: { ...pickFields(customer, 'id,name,phone,address,delivery_zone,email,notes,source,legacy_orders_count,created_at,is_vip,highlight,birthday,marketing_opt_in,credit_enabled,credit_limit_cents,credit_balance_cents'), ...stats },
      orders: [], top_products: [], repeat: [], birthday_offer: null, financial_history_hidden: true,
    });
  }

  return json({
    customer: { ...customer, ...stats, birthday_in_days: birthdayDistance(customer.birthday) },
    orders,
    top_products: topProducts,
    repeat: repeatSuggestions(orders),
    birthday_offer: birthdayNow ? birthdayOfferText(birthdaySettings(store)) : null,
  });
}

async function handleUpdateCustomer(request, env, customerId, session) {
  if (!validUuid(customerId)) return json({ error: 'Cliente inválido.' }, 400);

  const body = await request.json().catch(() => ({}));
  const fields = {};

  // Funcionário só escreve observação (VIP, aniversário e autorização é com o administrador).
  if (session?.urole !== 'admin' && Object.keys(body).some(k => k !== 'notes')) {
    return json({ error: 'Só administrador pode mudar isso no cliente.' }, 403);
  }

  if (body.name !== undefined) {
    const name = cleanText(body.name, 80);

    if (name.length < 2) return json({ error: 'Nome inválido.' }, 400);

    fields.name = name;
  }

  if (body.notes !== undefined) fields.notes = cleanText(body.notes, 1000) || null;

  if (body.is_vip !== undefined) fields.is_vip = Boolean(body.is_vip);

  // Aniversário cadastrado pelo dono vale na hora (não espera os dias de carência).
  if (body.birthday !== undefined) {
    if (body.birthday && birthdayDistance(body.birthday) === null) return json({ error: 'Aniversário inválido.' }, 400);
    fields.birthday = body.birthday || null;
    fields.birthday_set_at = body.birthday ? '2000-01-01T00:00:00Z' : null;
  }

  if (body.marketing_opt_in !== undefined) {
    fields.marketing_opt_in = Boolean(body.marketing_opt_in);
    fields.opt_in_at = body.marketing_opt_in ? new Date().toISOString() : null;
  }

  // Fiado: liberar/bloquear e limite (o saldo nunca muda por aqui, só pelo livro do fiado).
  if (body.credit_enabled !== undefined) fields.credit_enabled = Boolean(body.credit_enabled);

  if (body.credit_limit_cents !== undefined) {
    const limit = toCents(body.credit_limit_cents);
    if (limit === null || limit < 0 || limit > CREDIT_MAX_CENTS) return json({ error: 'Limite do fiado inválido.' }, 400);
    fields.credit_limit_cents = limit;
  }

  const creditBefore = fields.credit_enabled !== undefined || fields.credit_limit_cents !== undefined
    ? (await readJsonResponse(await supabaseFetch(env, `customers?select=credit_enabled,credit_limit_cents&id=eq.${customerId}`), 'Não foi possível salvar o cliente.'))[0]
    : null;

  if (!Object.keys(fields).length) return json({ error: 'Nada para atualizar.' }, 400);

  fields.updated_at = new Date().toISOString();

  const response = await supabaseFetch(env, `customers?id=eq.${customerId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  const rows = await readJsonResponse(response, 'Não foi possível salvar o cliente.');

  if (!rows[0]) return json({ error: 'Cliente não encontrado.' }, 404);

  if (creditBefore && (creditBefore.credit_enabled !== rows[0].credit_enabled || creditBefore.credit_limit_cents !== rows[0].credit_limit_cents)) {
    await audit(env, session, 'credit.settings',
      `Fiado de ${rows[0].name}: ${rows[0].credit_enabled ? `liberado, limite ${money(rows[0].credit_limit_cents)}` : 'bloqueado'}`
        + ` (antes: ${creditBefore.credit_enabled ? `liberado, limite ${money(creditBefore.credit_limit_cents)}` : 'bloqueado'})`,
      { entity: 'customer', entityId: customerId });
  }

  if (fields.is_vip !== undefined) {
    await audit(env, session, 'customer.vip', `${fields.is_vip ? 'Marcou' : 'Tirou'} ${rows[0].name} como cliente VIP (entrega grátis)`, { entity: 'customer', entityId: customerId });
  }

  return json({ customer: rows[0] });
}

/* ---------------- Fiado (crediário) ---------------- */

// Livro do fiado (customer_credit_entries): só recebe lançamentos novos. O banco não deixa
// alterar nem apagar nada (nem o saldo do cliente à mão); erro se corrige com estorno.
// amount_cents > 0 aumenta a dívida; < 0 diminui. Saldo negativo = crédito a favor do cliente.
const CREDIT_KIND_LABELS = {
  compra: 'Compra no fiado',
  estorno_compra: 'Compra desfeita',
  pagamento: 'Pagamento',
  ajuste: 'Ajuste',
  estorno: 'Estorno',
};
const CREDIT_MAX_CENTS = 10000000; // R$ 100.000,00 por lançamento

async function creditCustomer(env, storeId, customerId) {
  if (!validUuid(customerId)) return null;
  const [row] = await readJsonResponse(await supabaseFetch(env,
    `customers?select=id,name,phone,credit_enabled,credit_limit_cents,credit_balance_cents&store_id=eq.${storeId}&id=eq.${customerId}`),
  'Não foi possível carregar o fiado do cliente.');
  return row || null;
}

function creditView(customer) {
  const balance = customer.credit_balance_cents || 0;
  return {
    enabled: Boolean(customer.credit_enabled),
    limit_cents: customer.credit_limit_cents || 0,
    balance_cents: balance,
    // Quanto ainda pode comprar no fiado agora.
    available_cents: Math.max(0, (customer.credit_enabled ? customer.credit_limit_cents : 0) - balance),
  };
}

async function handleCustomerCredit(request, env, customerId) {
  const store = await getStore(env);
  const customer = await creditCustomer(env, store.id, customerId);
  if (!customer) return json({ error: 'Cliente não encontrado.' }, 404);

  const entries = await fetchAllRows(env,
    `customer_credit_entries?select=id,kind,amount_cents,method,order_id,order_number,reverses_entry_id,note,created_by_name,created_at,balance_after_cents&customer_id=eq.${customer.id}&order=created_at.desc,id.desc`,
    'Não foi possível carregar o extrato do fiado.');
  const reversed = new Set(entries.map(e => e.reverses_entry_id).filter(Boolean));

  return json({
    customer: { id: customer.id, name: customer.name, phone: customer.phone },
    credit: creditView(customer),
    entries: entries.map(e => ({ ...e, label: CREDIT_KIND_LABELS[e.kind] || e.kind, reversed: reversed.has(e.id) })),
  });
}

// Grava um lançamento. request_id (gerado no navegador) evita lançar duas vezes no clique duplo.
async function insertCreditEntry(env, session, row) {
  const response = await supabaseFetch(env, 'customer_credit_entries', {
    method: 'POST',
    headers: { Prefer: 'return=representation', ...actorHeaders(session) },
    body: JSON.stringify({ ...row, created_by_id: session?.uid && validUuid(session.uid) ? session.uid : null, created_by_name: session?.name || 'Sistema' }),
  });

  if (response.status === 409) {
    const text = await response.text().catch(() => '');
    if (row.request_id && text.includes('cce_request_once')) return { duplicate: true };
    if (text.includes('cce_reverses_once')) throw new UserError('Este lançamento já foi estornado.', 409);
    console.error('Supabase error', response.status, text);
    throw new UserError(fiadoFriendly(text) || 'Não foi possível lançar no fiado.', 409);
  }

  const [entry] = await readFiadoResponse(response, 'Não foi possível lançar no fiado.');
  return { entry };
}

function readRequestId(body) {
  return validUuid(body.request_id) ? body.request_id : null;
}

// Cliente pagou (parte ou toda) a dívida. Caixa e administrador.
async function handleCreditPayment(request, env, customerId, session) {
  const body = await request.json().catch(() => ({}));
  const amount = toCents(body.amount_cents);
  const method = CREDIT_PAY_METHODS.includes(body.method) ? body.method : null;

  if (!amount || amount <= 0 || amount > CREDIT_MAX_CENTS) return json({ error: 'Informe o valor recebido.' }, 400);
  if (!method) return json({ error: 'Escolha como o cliente pagou.' }, 400);

  const store = await getStore(env);
  const customer = await creditCustomer(env, store.id, customerId);
  if (!customer) return json({ error: 'Cliente não encontrado.' }, 404);

  const result = await insertCreditEntry(env, session, {
    store_id: store.id, customer_id: customer.id, kind: 'pagamento', amount_cents: -amount, method,
    note: cleanText(body.note, 300) || null, request_id: readRequestId(body),
  });

  if (!result.duplicate) {
    await audit(env, session, 'credit.payment',
      `Recebeu ${money(amount)} (${PAYMENT_LABELS[method]}) do fiado de ${customer.name} — saldo ${money(result.entry.balance_after_cents)}`,
      { entity: 'customer', entityId: customer.id });
  }

  return handleCustomerCredit(request, env, customer.id);
}

// Ajuste (ex.: saldo do caderno antigo). Só administrador, sempre com motivo.
async function handleCreditAdjust(request, env, customerId, session) {
  const body = await request.json().catch(() => ({}));
  const cents = Math.round(Number(body.amount_cents));
  const note = cleanText(body.note, 300);

  if (!Number.isFinite(cents) || cents === 0 || Math.abs(cents) > CREDIT_MAX_CENTS) return json({ error: 'Valor do ajuste inválido.' }, 400);
  if (note.length < 3) return json({ error: 'Escreva o motivo do ajuste.' }, 400);

  const store = await getStore(env);
  const customer = await creditCustomer(env, store.id, customerId);
  if (!customer) return json({ error: 'Cliente não encontrado.' }, 404);

  const result = await insertCreditEntry(env, session, {
    store_id: store.id, customer_id: customer.id, kind: 'ajuste', amount_cents: cents, note, request_id: readRequestId(body),
  });

  if (!result.duplicate) {
    await audit(env, session, 'credit.adjust',
      `Ajuste no fiado de ${customer.name}: ${cents > 0 ? '+' : '−'}${money(Math.abs(cents))} (${note}) — saldo ${money(result.entry.balance_after_cents)}`,
      { entity: 'customer', entityId: customer.id });
  }

  return handleCustomerCredit(request, env, customer.id);
}

// Estorna um pagamento ou ajuste lançado errado (uma vez só). Compra se desfaz pelo pedido.
async function handleCreditReverse(request, env, customerId, session) {
  const body = await request.json().catch(() => ({}));
  const note = cleanText(body.note, 300);

  if (!validUuid(body.entry_id)) return json({ error: 'Lançamento inválido.' }, 400);
  if (note.length < 3) return json({ error: 'Escreva o motivo do estorno.' }, 400);

  const store = await getStore(env);
  const customer = await creditCustomer(env, store.id, customerId);
  if (!customer) return json({ error: 'Cliente não encontrado.' }, 404);

  const [original] = await readJsonResponse(await supabaseFetch(env,
    `customer_credit_entries?select=id,kind,amount_cents,method&id=eq.${body.entry_id}&customer_id=eq.${customer.id}`), 'Não foi possível estornar.');
  if (!original) return json({ error: 'Lançamento não encontrado.' }, 404);
  if (!['pagamento', 'ajuste'].includes(original.kind)) {
    return json({ error: 'Compra no fiado se desfaz pelo próprio pedido (desmarcar pagamento ou cancelar).' }, 400);
  }

  const result = await insertCreditEntry(env, session, {
    store_id: store.id, customer_id: customer.id, kind: 'estorno', amount_cents: -original.amount_cents,
    reverses_entry_id: original.id, note,
  });

  await audit(env, session, 'credit.reverse',
    `Estornou ${CREDIT_KIND_LABELS[original.kind].toLowerCase()} de ${money(Math.abs(original.amount_cents))} no fiado de ${customer.name} (${note}) — saldo ${money(result.entry.balance_after_cents)}`,
    { entity: 'customer', entityId: customer.id });

  return handleCustomerCredit(request, env, customer.id);
}

// Quem tem fiado liberado ou saldo (devendo ou com crédito a favor). Só administrador.
async function handleCreditList(request, env) {
  const store = await getStore(env);
  const rows = await fetchAllRows(env,
    `customers?select=id,name,phone,credit_enabled,credit_limit_cents,credit_balance_cents&store_id=eq.${store.id}&or=(credit_enabled.is.true,credit_balance_cents.neq.0)&order=credit_balance_cents.desc,name.asc,id.asc`,
    'Não foi possível carregar o fiado.');

  const last = rows.length
    ? await fetchAllRows(env,
      `customer_credit_entries?select=customer_id,created_at,kind&store_id=eq.${store.id}&customer_id=in.(${rows.map(r => r.id).join(',')})&order=created_at.desc,id.desc`,
      'Não foi possível carregar o fiado.')
    : [];
  const lastBy = {};
  const lastPayBy = {};
  for (const e of last) {
    if (!lastBy[e.customer_id]) lastBy[e.customer_id] = e.created_at;
    if (e.kind === 'pagamento' && !lastPayBy[e.customer_id]) lastPayBy[e.customer_id] = e.created_at;
  }

  const customers = rows.map(r => ({
    id: r.id, name: r.name, phone: r.phone, ...creditView(r),
    last_entry_at: lastBy[r.id] || null, last_payment_at: lastPayBy[r.id] || null,
  }));

  return json({
    customers,
    receivable_cents: customers.reduce((sum, c) => sum + Math.max(0, c.balance_cents), 0),
    credit_in_favor_cents: customers.reduce((sum, c) => sum + Math.max(0, -c.balance_cents), 0),
  });
}

// Cópia de segurança: todo o livro do fiado em planilha (CSV, abre no Excel). Só administrador.
async function handleCreditExport(request, env, session) {
  const store = await getStore(env);
  const entries = await fetchAllRows(env,
    `customer_credit_entries?select=id,created_at,kind,amount_cents,method,order_number,note,created_by_name,balance_after_cents,reverses_entry_id,customers(name,phone)&store_id=eq.${store.id}&order=created_at.asc,id.asc`,
    'Não foi possível exportar o fiado.');

  const cell = v => {
    const text = String(v ?? '');
    // Evita fórmula maliciosa ao abrir no Excel (=, +, -, @ no começo).
    const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const brl = cents => (cents / 100).toFixed(2).replace('.', ',');
  const header = ['Data (São Paulo)', 'Cliente', 'WhatsApp', 'Tipo', 'Valor (R$)', 'Forma', 'Pedido', 'Motivo/obs.', 'Quem lançou', 'Saldo depois (R$)', 'ID', 'Estorno de'];
  const lines = entries.map(e => [
    new Date(e.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    e.customers?.name, e.customers?.phone, CREDIT_KIND_LABELS[e.kind] || e.kind, brl(e.amount_cents),
    PAYMENT_LABELS[e.method] || '', e.order_number ?? '', e.note, e.created_by_name, brl(e.balance_after_cents), e.id, e.reverses_entry_id || '',
  ].map(cell).join(';'));

  await audit(env, session, 'credit.export', `Baixou a cópia do livro do fiado (${entries.length} lançamentos)`);

  const date = todaySaoPaulo();
  return new Response('﻿' + [header.map(cell).join(';'), ...lines].join('\r\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="fiado-${store.slug || 'loja'}-${date}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

/* ---------------- Roteamento ---------------- */

// Arquivos públicos de marca. Adicione os caminhos da arte aprovada por slug.
const STORE_BRANDS = {
  pontox: { shortName: 'Ponto X', logo: '/assets/logo.png', image: '/assets/logo.png', imageType: 'image/png', imageWidth: 1254, imageHeight: 1254 },
};

function brandEscape(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function serveStoreBrand(request, env) {
  const url = new URL(request.url);
  const store = await getStore(env);
  const brand = STORE_BRANDS[store.slug] || {};
  const name = store.name || 'Loja';
  const shortName = brand.shortName || name;
  // URLs explícitas mantêm a marca mesmo quando o cookie de teste muda de loja.
  const query = env.STORE_DOMAIN_MATCH || store.slug === 'pontox' ? '' : '?loja=' + encodeURIComponent(store.slug || '');
  const logo = brand.logo || '/api/brand/logo' + query;
  const icon = size => brand.icons ? brand.icons + size + '.png' : logo;
  const admin = url.pathname.startsWith('/admin');
  const title = admin ? 'Painel · ' + name : name + ' · Delivery';
  const description = store.slug === 'pontox' ? 'Bateu a fome? Peça seus hambúrgueres, combos e bebidas na Ponto X. Confira o cardápio e escolha seu favorito.' : 'Faça seu pedido na ' + name + '.';
  const canonical = new URL('/' + query, url.origin).href;
  const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' };
  if (url.searchParams.has('loja')) {
    const slug = env.STORE_SLUG;
    headers['Set-Cookie'] = `loja=${slug}; Path=/; Max-Age=${slug ? 2592000 : 0}; SameSite=Lax; Secure`;
  }
  if (url.pathname === '/api/brand/logo') {
    if (brand.logo) return new Response(null, { status: 302, headers: { ...headers, Location: brand.logo } });
    // Identificação provisória para lojas que ainda não receberam sua arte final.
    const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => Array.from(word)[0]).join('');
    return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="64" fill="#171717"/><text x="256" y="285" text-anchor="middle" font-family="Arial,sans-serif" font-size="160" fill="white">${brandEscape(initials)}</text></svg>`, { headers: { ...headers, 'Content-Type': 'image/svg+xml' } });
  }
  if (url.pathname.endsWith('.webmanifest')) {
    return new Response(JSON.stringify({
      id: (admin ? '/admin' : '/') + query, name: title,
      short_name: admin ? 'Painel ' + shortName : shortName,
      start_url: (admin ? '/admin.html' : '/') + query, scope: '/',
      display: 'standalone', background_color: '#000000', theme_color: '#000000',
      icons: brand.icons ? [192, 512].map(size => ({ src: icon(size), sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' }))
        : [{ src: logo, sizes: brand.logo ? `${brand.imageWidth}x${brand.imageHeight}` : 'any', type: brand.logo ? 'image/png' : 'image/svg+xml', purpose: 'any' }],
    }), { headers: { ...headers, 'Content-Type': 'application/manifest+json; charset=utf-8' } });
  }
  const assetURL = new URL(admin ? '/admin' : '/', url.origin);
  const response = await env.ASSETS.fetch(new Request(assetURL, { method: 'GET' }));
  if (!response.ok) return response;
  const image = new URL(brand.image || logo, url.origin).href;
  const metadata = {
    description, 'apple-mobile-web-app-title': admin ? 'Painel ' + shortName : shortName,
    'og:site_name': name, 'og:url': canonical, 'og:title': name, 'og:description': description,
    'og:image': image, 'og:image:secure_url': image, 'og:image:alt': name + ' • Delivery online',
    'og:image:type': brand.imageType || 'image/jpeg', 'og:image:width': brand.imageWidth || 1200, 'og:image:height': brand.imageHeight || 630,
    'twitter:title': name, 'twitter:description': description, 'twitter:image': image, 'twitter:image:alt': name + ' • Delivery online',
  };
  const html = (await response.text())
    .replace('<html lang="pt-BR">', `<html lang="pt-BR" data-store="${brandEscape(store.slug || '')}">`)
    .replace(/<title>[^<]*<\/title>/, '<title>' + brandEscape(title) + '</title>')
    .replace(/<meta\b[^>]*>/g, tag => {
      const key = tag.match(/(?:name|property)="([^"]+)"/)?.[1];
      if (!brand.image && ['og:image:type', 'og:image:width', 'og:image:height'].includes(key)) return '';
      return Object.hasOwn(metadata, key) ? tag.replace(/content="[^"]*"/, 'content="' + brandEscape(metadata[key]) + '"') : tag;
    })
    .replace(/<link\b[^>]*>/g, tag => {
      const rel = tag.match(/rel="([^"]+)"/)?.[1];
      const href = rel === 'canonical' ? canonical : rel === 'manifest' ? (admin ? '/admin.webmanifest' : '/manifest.webmanifest') + query : ['icon', 'apple-touch-icon'].includes(rel) ? icon(192) : null;
      return href ? tag.replace(/href="[^"]*"/, 'href="' + brandEscape(href) + '"') : tag;
    })
    .replace('</head>', `<meta name="store-logo" content="${brandEscape(logo)}" />\n</head>`);
  return new Response(request.method === 'HEAD' ? null : html, { headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(request, rootEnv, ctx) {
    const url = new URL(request.url);
    const env = envForHost(rootEnv, url.hostname, request);
    const path = url.pathname;
    const method = request.method;

    try {
      if (['GET', 'HEAD'].includes(method) && ['/', '/index.html', '/admin', '/admin.html', '/manifest.webmanifest', '/admin.webmanifest', '/api/brand/logo'].includes(path)) {
        return await serveStoreBrand(request, env);
      }
      if (path === '/api/menu' && method === 'GET') {
        return await handleMenu(request, env);
      }

      if (path === '/api/customer-lookup' && method === 'POST') {
        return await handleCustomerLookup(request, env);
      }

      if (path === '/api/vip/send-code' && method === 'POST') return await handleVipCodeSend(request, env);
      if (path === '/api/vip/verify-code' && method === 'POST') return await handleVipCodeVerify(request, env);
      if (path === '/api/customer/send-code' && method === 'POST') return await handleCustomerLoginSend(request, env);
      if (path === '/api/customer/verify-code' && method === 'POST') return await handleCustomerLoginVerify(request, env);
      if (path === '/api/customer/session' && method === 'GET') return await handleCustomerSession(request, env);

      if (path === '/api/customer-insights' && method === 'POST') {
        return await handleCustomerInsights(request, env);
      }

      if (path === '/api/customer-push' && method === 'POST') {
        return await handleCustomerPushSubscribe(request, env);
      }

      if (path === '/api/recommendations' && method === 'GET') {
        return await handleRecommendations(request, env);
      }

      // Pedido por voz no iPhone: o site grava o áudio (WAV) e aqui vira texto (Workers AI / Whisper).
      if (path === '/api/voice-transcribe' && method === 'POST') {
        return await handleVoiceTranscribe(request, env);
      }

      // Diagnóstico do pedido por voz (celulares): só registra no log do Worker.
      if (path === '/api/voice-log' && method === 'POST') {
        const text = (await request.text()).slice(0, 3000);
        console.log(`voice-log ${text}`);
        return new Response(null, { status: 204 });
      }

      if (path === '/api/customer-birthday' && method === 'POST') {
        return await handleCustomerBirthday(request, env);
      }

      if (path === '/api/promo-push' && method === 'POST') {
        return await handlePromoPushSubscribe(request, env);
      }

      if (path === '/api/search-log' && method === 'POST') {
        return await handleSearchLog(request, env);
      }

      if (path === '/api/cart-event' && method === 'POST') {
        return await handleCartEvent(request, env);
      }

      if (path === '/api/cart-draft' && method === 'POST') {
        return await handleCartDraft(request, env);
      }

      if (path === '/api/orders' && method === 'POST') {
        return await handleCreateOrder(request, env, ctx);
      }

      const orderMatch = path.match(/^\/api\/orders\/([^/]+)$/);

      if (orderMatch && method === 'GET') {
        return await handleOrderStatus(request, env, orderMatch[1]);
      }

      const orderActionMatch = path.match(/^\/api\/orders\/([^/]+)\/(items|review)$/);

      if (orderActionMatch && method === 'POST') {
        return orderActionMatch[2] === 'items'
          ? await handleAddOrderItems(request, env, orderActionMatch[1], ctx)
          : await handleReviewOrder(request, env, orderActionMatch[1]);
      }

      if (path === '/api/admin/login' && method === 'POST') {
        return await handleAdminLogin(request, env);
      }

      if (path === '/api/admin/logout' && method === 'POST') {
        return handleAdminLogout();
      }

      if (path === '/api/admin/login-users' && method === 'GET') {
        return await handleLoginUsers(request, env);
      }

      if (path.startsWith('/api/admin/')) {
        let session = await getAdminSession(request, env.SESSION_SECRET);

        // Sessão vale só na loja em que foi feito o login (sessões antigas, sem loja, só na principal).
        if (session && (session.sid ? session.sid !== await currentStoreId(env) : !(await isDefaultStore(env)))) {
          session = null;
        }

        if (session?.uid) {
          const store = await getStore(env);
          const [staff] = await readJsonResponse(await supabaseFetch(env, `staff?select=id,name,role,active,pin_hash&id=eq.${session.uid}&store_id=eq.${store.id}`), 'Não foi possível conferir seu acesso.');
          if (!staff?.active || !session.staff_key || !(await safeEqual(session.staff_key, await sign(`staff:${staff.id}:${staff.pin_hash}`, env.SESSION_SECRET), env.SESSION_SECRET))) session = null;
          else session = { ...session, name: staff.name, urole: staff.role };
        }

        if (!session) {
          return json({ error: 'Não autenticado.' }, 401);
        }

        // Entregador só enxerga a própria tela de entregas (nada de produtos, caixa, clientes...).
        if (session.urole === 'entregador') {
          if (path === '/api/admin/bootstrap' && method === 'GET') {
            const store = await getStore(env);
            return json({ store: { name: store.name, delivery_rules: store.delivery_rules || {}, profile: storeProfile(store) }, products: [], delivery_zones: [], me: { name: session.name, role: session.urole } });
          }

          if (path === '/api/admin/courier/orders' && method === 'GET') {
            return await handleCourierOrders(request, env, session);
          }

          // Avisos no celular do entregador (pedido novo e entrega dele).
          if (path === '/api/admin/push' && method === 'GET') {
            return await handlePushStatus(request, env, session);
          }

          if (path === '/api/admin/push/subscribe' && method === 'POST') {
            return await handlePushSubscribe(request, env, session);
          }

          if (path === '/api/admin/push/unsubscribe' && method === 'POST') {
            return await handlePushUnsubscribe(request, env);
          }

          const courierMatch = path.match(/^\/api\/admin\/courier\/orders\/([^/]+)\/(confirm|delivered)$/);

          if (courierMatch && method === 'POST') {
            return courierMatch[2] === 'confirm'
              ? await handleCourierConfirm(request, env, courierMatch[1], session)
              : await handleCourierDelivered(request, env, courierMatch[1], ctx, session);
          }

          return json({ error: 'Sem permissão.' }, 403);
        }

        // Funcionário (caixa): opera o dia a dia, mas não vê faturamento da loja nem mexe em
        // preço/configuração. Só administrador passa por estas rotas.
        if (session.urole !== 'admin' && ADMIN_ONLY_ROUTES.some(([m, re]) => m === method && re.test(path))) {
          return json({ error: 'Só administrador pode fazer isso.' }, 403);
        }

        if (path === '/api/admin/bootstrap' && method === 'GET') {
          return await handleAdminBootstrap(request, env, session);
        }

        if (path === '/api/admin/couriers' && method === 'GET') {
          return await handleCouriers(request, env);
        }

        const dispatchMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/dispatch$/);

        if (dispatchMatch && method === 'POST') {
          return await handleDispatch(request, env, dispatchMatch[1], ctx, session);
        }

        if (path === '/api/admin/customer-by-phone' && method === 'GET') {
          return await handleAdminCustomerByPhone(request, env);
        }

        if (path === '/api/admin/abandoned-carts' && method === 'GET') {
          return await handleAbandonedCarts(request, env);
        }

        const cartMatch = path.match(/^\/api\/admin\/abandoned-carts\/([^/]+)\/reminded$/);

        if (cartMatch && method === 'POST') {
          return await handleCartReminded(request, env, cartMatch[1]);
        }

        if (path === '/api/admin/daily-summary' && method === 'GET') {
          return await handleDailySummary(request, env);
        }

        if (path === '/api/admin/audit' && method === 'GET') {
          if (session.urole !== 'admin') return json({ error: 'Só administrador vê a auditoria.' }, 403);
          return await handleAudit(request, env);
        }

        // Usuários: só administrador.
        if (path.startsWith('/api/admin/staff')) {
          if (session.urole !== 'admin') return json({ error: 'Só administrador pode mexer nos usuários.' }, 403);

          if (path === '/api/admin/staff' && method === 'GET') {
            return await handleListStaff(request, env);
          }

          if (path === '/api/admin/staff' && method === 'POST') {
            return await handleCreateStaff(request, env, session);
          }

          const staffMatch = path.match(/^\/api\/admin\/staff\/([^/]+)$/);

          if (staffMatch && method === 'PATCH') {
            return await handleUpdateStaff(request, env, staffMatch[1], session);
          }
        }

        if (path === '/api/admin/pdv/preview' && method === 'GET') {
          return await handlePdvPreview(request, env);
        }

        if (path === '/api/admin/pdv/finalize' && method === 'POST') {
          return await handlePdvFinalize(request, env, session);
        }

        if (path === '/api/admin/pdv/closings' && method === 'GET') {
          return await handlePdvClosings(request, env);
        }

        const closingMatch = path.match(/^\/api\/admin\/pdv\/closings\/([^/]+)$/);

        if (closingMatch && method === 'GET') {
          return await handlePdvClosing(request, env, closingMatch[1]);
        }

        if (path === '/api/admin/store' && method === 'PATCH') {
          return await handleUpdateStore(request, env, session);
        }

        // Computador da impressora (dono ou caixa podem definir; só mexe nesses campos).
        if (path === '/api/admin/print-station' && method === 'POST') {
          return await handlePrintStation(request, env, session);
        }

        if (path === '/api/admin/products' && method === 'POST') {
          return await handleCreateProduct(request, env, session);
        }

        const photoMatch = path.match(/^\/api\/admin\/products\/([^/]+)\/photo$/);

        if (photoMatch && method === 'POST') {
          return await handleProductPhoto(request, env, photoMatch[1]);
        }

        if (photoMatch && method === 'DELETE') {
          return await handleRemoveVariantPhoto(request, env, photoMatch[1]);
        }

        const productMatch = path.match(/^\/api\/admin\/products\/([^/]+)$/);

        if (productMatch && method === 'PATCH') {
          return await handleUpdateProduct(request, env, productMatch[1], session);
        }

        if (productMatch && method === 'DELETE') {
          return await handleDeleteProduct(request, env, productMatch[1], session);
        }

        if (path === '/api/admin/orders' && method === 'GET') {
          return await handleAdminOrders(request, env, session);
        }

        if (path === '/api/admin/push' && method === 'GET') {
          return await handlePushStatus(request, env, session);
        }

        if (path === '/api/admin/push/subscribe' && method === 'POST') {
          return await handlePushSubscribe(request, env, session);
        }

        if (path === '/api/admin/push/unsubscribe' && method === 'POST') {
          return await handlePushUnsubscribe(request, env);
        }

        if (path === '/api/admin/push/test' && method === 'POST') {
          return await handlePushTest(request, env);
        }

        if (path === '/api/admin/suggestions' && method === 'GET') {
          return await handleAdminSuggestions(request, env);
        }

        if (path === '/api/admin/coupons' && method === 'POST') {
          return await handleCouponDecision(request, env, session);
        }

        if (path === '/api/admin/promo' && method === 'POST') {
          if (session.urole !== 'admin') return json({ error: 'Só administrador manda promoção.' }, 403);
          return await handleSendPromo(request, env, session);
        }

        if (path === '/api/admin/wa-qr' && method === 'GET') {
          return await handleWaQrStatus(request, env);
        }

        const waQrMatch = path.match(/^\/api\/admin\/wa-qr\/(connect|logout|restart|test|retry)$/);

        if (waQrMatch && method === 'POST') {
          return await handleWaQrAction(request, env, waQrMatch[1], session);
        }

        if (path === '/api/admin/whatsapp' && method === 'GET') {
          return await handleWhatsappStatus(request, env);
        }

        if (path === '/api/admin/whatsapp/templates' && method === 'POST') {
          return await handleCreateWhatsappTemplates(request, env);
        }

        if (path === '/api/admin/whatsapp/test' && method === 'POST') {
          return await handleWhatsappTest(request, env);
        }

        if (path === '/api/admin/zones' && method === 'POST') {
          return await handleCreateZone(request, env, session);
        }

        const zoneMatch = path.match(/^\/api\/admin\/zones\/([^/]+)$/);

        if (zoneMatch && method === 'PATCH') {
          return await handleUpdateZone(request, env, zoneMatch[1], session);
        }

        if (zoneMatch && method === 'DELETE') {
          return await handleDeleteZone(request, env, zoneMatch[1], session);
        }

        if (path === '/api/admin/orders' && method === 'POST') {
          return await handleAdminCreateOrder(request, env, ctx, session);
        }

        if (path === '/api/admin/order-history' && method === 'GET') {
          return await handleOrderHistory(request, env, session);
        }

        if (path === '/api/admin/cash' && method === 'GET') {
          return await handleCash(request, env, session);
        }

        if (path === '/api/admin/cash/open' && method === 'POST') {
          return await handleOpenCash(request, env, session);
        }

        if (path === '/api/admin/cash/movement' && method === 'POST') {
          return await handleCashMovement(request, env, session);
        }

        if (path === '/api/admin/cash/close' && method === 'POST') {
          return await handleCloseCash(request, env, session);
        }

        if (path === '/api/admin/customers' && method === 'GET') {
          return await handleAdminCustomers(request, env, session);
        }

        const creditMatch = path.match(/^\/api\/admin\/customers\/([^/]+)\/credit(?:\/(payment|adjust|reverse))?$/);

        if (creditMatch && method === 'GET' && !creditMatch[2]) {
          return await handleCustomerCredit(request, env, creditMatch[1]);
        }

        if (creditMatch && method === 'POST' && creditMatch[2] === 'payment') {
          return await handleCreditPayment(request, env, creditMatch[1], session);
        }

        if (creditMatch && method === 'POST' && creditMatch[2] === 'adjust') {
          return await handleCreditAdjust(request, env, creditMatch[1], session);
        }

        if (creditMatch && method === 'POST' && creditMatch[2] === 'reverse') {
          return await handleCreditReverse(request, env, creditMatch[1], session);
        }

        if (path === '/api/admin/credit' && method === 'GET') {
          return await handleCreditList(request, env);
        }

        if (path === '/api/admin/credit/export' && method === 'GET') {
          return await handleCreditExport(request, env, session);
        }

        const customerMatch = path.match(/^\/api\/admin\/customers\/([^/]+)$/);

        if (customerMatch && method === 'GET') {
          return await handleAdminCustomer(request, env, customerMatch[1], session);
        }

        if (customerMatch && method === 'PATCH') {
          return await handleUpdateCustomer(request, env, customerMatch[1], session);
        }

        const addItemsMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/items$/);

        if (addItemsMatch && method === 'POST') {
          return await handleAddAdminOrderItems(request, env, addItemsMatch[1], session);
        }

        const weighMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/items\/([^/]+)\/weigh$/);

        if (weighMatch && method === 'POST') {
          return await handleWeighItem(request, env, weighMatch[1], weighMatch[2], session);
        }

        const orderItemMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/items\/([^/]+)$/);

        if (orderItemMatch && method === 'DELETE') {
          return await handleRemoveOrderItem(request, env, orderItemMatch[1], orderItemMatch[2], session);
        }

        if (orderItemMatch && method === 'PATCH') {
          return await handleEditOrderItemQty(request, env, orderItemMatch[1], orderItemMatch[2], session);
        }

        const reopenOrderMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/reopen$/);

        if (reopenOrderMatch && method === 'POST') {
          return await handleReopenOrder(request, env, reopenOrderMatch[1], session);
        }

        const adminOrderMatch = path.match(/^\/api\/admin\/orders\/([^/]+)$/);

        if (adminOrderMatch && method === 'PATCH') {
          return await handleUpdateOrderStatus(request, env, adminOrderMatch[1], ctx, session);
        }
      }

      if (path.startsWith('/api/')) {
        return json({ error: 'Rota não encontrada.' }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return json({ error: err.message || 'Erro interno.' }, err instanceof UserError ? err.status : 500);
    }
  },

  // Cron (wrangler.jsonc "triggers"): alertas agrupados de pedido atrasado / esperando aceite.
  // Multi-loja: roda uma vez para cada loja (cada uma com o seu env).
  async scheduled(event, rootEnv, ctx) {
    const job = event.cron === DAILY_SUMMARY_CRON ? runDailySummaryPush : runOwnerAlerts;

    ctx.waitUntil((async () => {
      for (const storeId of await allStoreIds(rootEnv)) {
        await job(envForStore(rootEnv, storeId)).catch(err => console.error(job.name, storeId, err));
      }
    })().catch(err => console.error('scheduled', err)));
  },
};
