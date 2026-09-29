import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Carrega o Worker real, sem modificar seu módulo nem exportar utilitários no site.
const source = await readFile(new URL('../worker.js', import.meta.url), 'utf8');
const exports = ['vipToken', 'readVipToken', 'vipPhoneVerified', 'handleVipCodeSend', 'handleVipCodeVerify', 'handleCustomerLookup', 'handleCustomerBirthday', 'handleCustomerInsights', 'createOrder', 'recommendations', 'storeForRole', 'productForRole', 'handleAdminBootstrap', 'handleAdminCustomer', 'handleAdminOrders', 'handleOrderHistory', 'cashierOrderFilter', 'handleCash', 'handleCloseCash', 'cashSummary', 'createAdminSession', 'sign', 'notifyCustomerPush'];
const w = await import(`data:text/javascript;base64,${Buffer.from(source + '\nexport { ' + exports.join(',') + ' };\n//# sourceURL=worker-under-test.js').toString('base64')}`);
const originalFetch = globalThis.fetch;
const id = '11111111-1111-4111-8111-111111111111';
const staffId = '22222222-2222-4222-8222-222222222222';
const phone = '21968671667';
const env = { __storeScoped: true, SUPABASE_URL: 'https://baarxygrjpirsizvpzlu.supabase.co', SUPABASE_SECRET_KEY: 'fake-test-key', SESSION_SECRET: 'local-test-secret-not-a-real-credential', VIP_WHATSAPP_URL: 'https://whatsapp.invalid', VIP_WHATSAPP_TOKEN: 'fake', VIP_TEST_PHONE: phone };
const store = { id, name: 'Loja teste', is_open: true, auto_hours: false, delivery_fee_cents: 500, min_order_cents: 0, default_margin_percent: 35, alert_state: { private: true } };
const customer = { id, phone, name: 'Maria teste', is_vip: true, address: 'Rua 10', birthday: null };
const cashier = { uid: staffId, urole: 'caixa', name: 'Caixa teste' };
let calls, counts, open, failCounter, failDelivery, sentCode;
function reply(data, status = 200) { return Response.json(data, { status }); }
function request(body, cookie = '', path = '/api/vip/verify-code') { return new Request('https://teste.invalid' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }); }
beforeEach(() => {
  calls = []; counts = new Map(); open = null; failCounter = false; failDelivery = false; sentCode = null;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input); const path = url.pathname.replace('/rest/v1/', '');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, path, method: options.method || 'GET', body });
    if (url.hostname === 'whatsapp.invalid') {
      sentCode = body.text.match(/é (\d{4})\./)?.[1];
      return reply({ ok: !failDelivery }, failDelivery ? 503 : 200);
    }
    if (path === 'rpc/login_attempt') {
      if (failCounter) return reply({ error: 'simulated' }, 503);
      const count = (counts.get(body.p_key) || 0) + 1; counts.set(body.p_key, count);
      return reply(count <= body.p_max);
    }
    if (path === 'stores') return reply([store]);
    if (path === 'customers') return reply([{ ...customer, orders: [], cost_cents: 9999 }]);
    if (path === 'delivery_zones') return reply([]);
    if (path === 'coupons') return reply([]);
    if (path === 'cash_sessions') return reply(open ? [open] : []);
    if (path === 'cash_movements') return reply([]);
    if (path === 'products') return reply([{ id, name: 'Produto teste', available: true, price_cents: 1000, cost_cents: 400, chill_fee_cents: 0, product_variants: [] }]);
    if (path === 'orders') return reply(options.method === 'POST' ? [{ ...body, id, public_code: '12345' }] : []);
    if (path === 'order_items' || path === 'abandoned_carts') return reply([]);
    throw new Error(`Unexpected mock request: ${path}`);
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });
async function send() {
  const response = await w.handleVipCodeSend(request({ phone }), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.match(sentCode, /^\d{4}$/);
  assert.equal(data.code, undefined);
  return data;
}
async function verifiedCookie() {
  return '__Host-garatucaia-vip=' + await w.vipToken(env, { purpose: 'vip-session', phone, store_id: store.id, exp: Math.floor(Date.now() / 1000) + 600 });
}

test('WhatsApp envia quatro dígitos; código correto emite cookie seguro e de uso único', async () => {
  const { challenge } = await send();
  const response = await w.handleVipCodeVerify(request({ phone, challenge, code: sentCode }), env);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('Set-Cookie');
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=86400']) assert.ok(cookie.includes(part));
  assert.equal(await w.vipPhoneVerified(request({}, cookie), env, phone), true);
  assert.equal(await w.vipPhoneVerified(request({}, cookie), env, '21999999999'), false);
  assert.equal((await w.handleVipCodeVerify(request({ phone, challenge, code: sentCode }), env)).status, 409);
});
test('cinco erros bloqueiam inclusive o código correto', async () => {
  const { challenge } = await send();
  const wrong = sentCode === '0000' ? '0001' : '0000';
  for (let i = 0; i < 5; i++) assert.equal((await w.handleVipCodeVerify(request({ phone, challenge, code: wrong }), env)).status, 400);
  assert.equal((await w.handleVipCodeVerify(request({ phone, challenge, code: sentCode }), env)).status, 429);
});
test('duas confirmações simultâneas não reutilizam o código', async () => {
  const { challenge } = await send();
  const responses = await Promise.all(Array.from({ length: 2 }, () => w.handleVipCodeVerify(request({ phone, challenge, code: sentCode }), env)));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
});
test('assinatura, finalidade, validade e banco impedem adulteração e uso cruzado', async () => {
  const valid = await w.vipToken(env, { purpose: 'vip-session', phone, exp: Math.floor(Date.now() / 1000) + 300 });
  assert.equal(await w.readVipToken(env, valid + 'a', 'vip-session'), null);
  assert.equal(await w.readVipToken(env, valid, 'vip-code'), null);
  assert.equal(await w.readVipToken({ ...env, SUPABASE_URL: 'https://production.invalid' }, valid, 'vip-session'), null);
  const expired = await w.vipToken(env, { purpose: 'vip-session', phone, exp: 1 });
  assert.equal(await w.readVipToken(env, expired, 'vip-session'), null);
});
test('falha no contador não autoriza confirmação nem envio', async () => {
  const { challenge } = await send(); failCounter = true;
  await assert.rejects(w.handleVipCodeVerify(request({ phone, challenge, code: sentCode }), env));
  await assert.rejects(w.handleVipCodeSend(request({ phone }), env));
});
test('prévia só envia ao número autorizado e respeita intervalo entre envios', async () => {
  assert.equal((await w.handleVipCodeSend(request({ phone: '21999999999' }), env)).status, 403);
  assert.equal(calls.length, 0);
  await send();
  assert.equal((await w.handleVipCodeSend(request({ phone }), env)).status, 429);
});
test('WhatsApp desconectado não retorna desafio ou falso sucesso', async () => {
  failDelivery = true;
  const response = await w.handleVipCodeSend(request({ phone }), env);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).challenge, undefined);
});
test('VIP não confirmado não recebe nome, endereço ou benefício no lookup', async () => {
  const response = await w.handleCustomerLookup(request({ phone }), env);
  const data = await response.json();
  assert.equal(data.vip, false); assert.equal(data.verification_required, true);
  assert.equal(data.first_name, null); assert.equal(data.address, null);
  const confirmed = await (await w.handleCustomerLookup(request({ phone }, await verifiedCookie()), env)).json();
  assert.equal(confirmed.vip, true); assert.equal(confirmed.first_name, 'Maria');
});
test('VIP não confirmado não altera aniversário nem dispara PATCH no cadastro', async () => {
  const result = await w.handleCustomerBirthday(request({ phone, birthday: '02-10' }), env);
  assert.equal(result.status, 403);
  assert.ok(!calls.some(c => c.path === 'customers' && c.method !== 'GET'));
});
test('pedido convidado com telefone VIP cobra entrega e não toca no cadastro nem benefícios', async () => {
  const body = { customer_name: 'Convidado', customer_phone: phone, delivery_type: 'delivery', payment_method: 'pix', address: 'Outra rua 12', items: [{ product_id: id, quantity: 1 }], marketing_opt_in: true, birthday: '02-10' };
  const result = await w.createOrder(env, body, { fromAdmin: false, request: request(body) });
  assert.equal(result.status, 200);
  const order = calls.find(c => c.path === 'orders' && c.method === 'POST').body;
  assert.equal(order.customer_id, null); assert.equal(order.delivery_fee_cents, 500); assert.equal(order.total_cents, 1500); assert.equal(order.discount_cents, 0);
  assert.ok(!calls.some(c => c.path === 'customers' && c.method !== 'GET'));
  assert.ok(!calls.some(c => c.path === 'coupons'));
});
test('pedido VIP confirmado recebe entrega grátis e vínculo correto', async () => {
  const body = { customer_name: 'Cliente teste', customer_phone: phone, delivery_type: 'delivery', payment_method: 'pix', address: 'Rua 10', items: [{ product_id: id, quantity: 1 }], require_vip: true };
  const result = await w.createOrder(env, body, { fromAdmin: false, request: request(body, await verifiedCookie()) });
  assert.equal(result.status, 200);
  const order = calls.find(c => c.path === 'orders' && c.method === 'POST').body;
  assert.equal(order.customer_id, id); assert.equal(order.fee_waived, 'vip'); assert.equal(order.total_cents, 1000);
});
test('sessão VIP expirada não aumenta silenciosamente o preço no fechamento', async () => {
  const body = { customer_name: 'Cliente teste', customer_phone: phone, delivery_type: 'delivery', payment_method: 'pix', address: 'Rua 10', items: [{ product_id: id, quantity: 1 }], require_vip: true };
  assert.equal((await w.createOrder(env, body, { fromAdmin: false, request: request(body) })).status, 409);
  assert.ok(!calls.some(c => c.method !== 'GET'));
});

test('sessão VIP de outra loja não autoriza consulta no projeto', async () => {
  const otherStore = { ...store, id: '33333333-3333-4333-8333-333333333333' };
  const cookie = '__Host-garatucaia-vip=' + await w.vipToken(env, { purpose: 'vip-session', phone, store_id: otherStore.id, exp: Math.floor(Date.now() / 1000) + 600 });
  const response = await w.handleCustomerLookup(request({ phone }, cookie), env);
  const data = await response.json();
  assert.equal(data.verification_required, true);
  assert.equal(data.first_name, null);
  assert.equal(data.address, null);
});

test('recomendações são armazenadas separadamente por loja', async () => {
  const firstStore = { ...store, id: '44444444-4444-4444-8444-444444444444' };
  const secondStore = { ...store, id: '55555555-5555-4555-8555-555555555555' };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    const storeId = url.searchParams.get('store_id')?.replace(/^eq\./, '');
    const productId = storeId === firstStore.id ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const rows = storeId === firstStore.id ? [{ created_at: '2026-09-28T12:00:00Z', order_items: [{ product_id: productId, quantity: 2 }] }] : [
      { created_at: '2026-09-28T12:00:00Z', order_items: [{ product_id: productId, quantity: 2 }] },
      { created_at: '2026-09-27T12:00:00Z', order_items: [{ product_id: productId, quantity: 1 }] },
    ];
    return reply(rows);
  };
  try {
    const first = await w.recommendations({ ...env, __storeId: firstStore.id }, firstStore);
    const second = await w.recommendations({ ...env, __storeId: secondStore.id }, secondStore);
    assert.equal(first.orders_analyzed, 1);
    assert.equal(second.orders_analyzed, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
test('bootstrap do caixa remove custo e configurações internas; administrador preservado', async () => {
  const data = await (await w.handleAdminBootstrap(request({}), env, cashier)).json();
  assert.equal(data.products[0].cost_cents, undefined); assert.equal(data.products[0].price_cents, 1000);
  assert.equal(data.store.default_margin_percent, undefined); assert.equal(data.store.alert_state, undefined);
  const product = { id, price_cents: 1000, cost_cents: 500, future_secret: 1, variants: [{ id, price_cents: 900, cost_cents: 400 }] };
  assert.equal(w.productForRole(product, cashier).variants[0].cost_cents, undefined);
  assert.equal(w.productForRole(product, cashier).future_secret, undefined);
  assert.equal(w.productForRole(product, { urole: 'admin' }), product);
});
test('detalhe do cliente não entrega histórico financeiro ao caixa', async () => {
  const data = await (await w.handleAdminCustomer(request({}), env, id, cashier)).json();
  assert.deepEqual(data.orders, []); assert.deepEqual(data.top_products, []);
  assert.equal(data.customer.total_spent_cents, null); assert.equal(data.customer.cost_cents, undefined);
});
test('filtro do caixa só libera operação e pagamentos do próprio turno aberto', async () => {
  assert.equal(await w.cashierOrderFilter(env, id, cashier, true), '&id=is.null');
  open = { id, opened_by_id: 'outro', opened_at: '2026-09-25T12:00:00Z' };
  assert.equal(await w.cashierOrderFilter(env, id, cashier, true), '&id=is.null');
  open.opened_by_id = staffId;
  assert.match(await w.cashierOrderFilter(env, id, cashier), /paid_at.gte/);
  assert.match(await w.cashierOrderFilter(env, id, cashier), /status.not.in.\(delivered,cancelled\)/);
  assert.equal(await w.cashierOrderFilter(env, id, { urole: 'admin' }), '');
});
test('caixa alheio oculta valores e não pode ser fechado', async () => {
  open = { id, opened_by_id: 'outro', opening_cents: 10000, opened_at: '2026-09-25T12:00:00Z' };
  const data = await (await w.handleCash(request({}), env, cashier)).json();
  assert.equal(data.open.other, true); assert.equal(data.open.opening_cents, undefined);
  assert.equal((await w.handleCloseCash(request({}), env, cashier)).status, 403);
});
test('resumo do caixa pagina mais de mil pedidos sem perder valores', async () => {
  globalThis.fetch = async input => {
    const u = new URL(input);
    if (u.pathname.endsWith('/cash_movements') || u.searchParams.get('payment_status') === 'eq.pending') return reply([]);
    const offset = Number(u.searchParams.get('offset'));
    return reply(Array.from({ length: offset === 0 ? 1000 : offset === 1000 ? 5 : 0 }, () => ({ payment_method: 'pix', total_cents: 100 })));
  };
  const data = await w.cashSummary(env, { id, store_id: id, opening_cents: 0, opened_at: '2026-09-25T12:00:00Z' });
  assert.equal(data.paid_orders_count, 1005); assert.equal(data.sales_pix_cents, 100500);
});
test('função atual é revalidada mesmo com cookie antigo de administrador', async () => {
  const key = await w.sign(`staff:${staffId}:hash-fixture`, env.SESSION_SECRET);
  const cookie = 'admin_session=' + await w.createAdminSession(env.SESSION_SECRET, { uid: staffId, urole: 'admin', staff_key: key });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => new URL(url).pathname.endsWith('/staff') ? reply([{ id: staffId, name: 'Caixa teste', active: true, role: 'caixa', pin_hash: 'hash-fixture' }]) : previousFetch(url, options);
  const response = await w.default.fetch(new Request('https://teste.invalid/api/admin/pdv/preview', { headers: { Cookie: cookie } }), env, {});
  assert.equal(response.status, 403);
});
test('troca de PIN invalida sessão de funcionário', async () => {
  const cookie = 'admin_session=' + await w.createAdminSession(env.SESSION_SECRET, { uid: staffId, urole: 'caixa', staff_key: 'old' });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => new URL(url).pathname.endsWith('/staff') ? reply([{ id: staffId, active: true, role: 'caixa', pin_hash: 'new' }]) : previousFetch(url, options);
  assert.equal((await w.default.fetch(new Request('https://teste.invalid/api/admin/bootstrap', { headers: { Cookie: cookie } }), env, {})).status, 401);
});
