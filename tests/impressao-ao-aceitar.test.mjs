import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Ao ACEITAR o pedido saem 2 vias no computador da impressora: COZINHA e ENTREGADOR (retirada/mesa: BALCÃO). Uma vez só.
const admin = await readFile(new URL('../admin.js', import.meta.url), 'utf8');
const block = admin.slice(admin.indexOf('// Via da COZINHA'), admin.indexOf('// Imprime por um iframe escondido'));

function setup() {
  const store = {};
  const printed = [];
  const ctx = {
    state: { ordersDate: '2026-10-09', orderStatusSeen: null },
    todaySaoPaulo: () => '2026-10-09',
    printSettings: () => ({}),
    printDocument: html => printed.push(html),
    receiptHtml: order => `<div class="receipt">NOTA ${order.id}</div>`,
    escapeHtml: v => String(v ?? ''),
    dateOf: () => '09/10', timeOf: () => '20:00',
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
    Date, JSON, Object, Map,
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx);
  return { ctx, printed };
}
const order = (id, status, extra = {}) => ({ id, status, order_number: 10, created_at: new Date().toISOString(), delivery_type: 'delivery', customer_name: 'Ana', order_items: [{ quantity: 2, product_name: 'X-Burguer' }], notes: 'sem cebola', ...extra });

test('primeira carga não imprime; aceitar depois imprime cozinha + entregador uma vez só', () => {
  const { ctx, printed } = setup();
  ctx.printNewlyAccepted([order('a', 'received')]); // primeira carga: só anota
  ctx.state.orderStatusSeen = new Map([['a', 'received']]);
  ctx.printNewlyAccepted([order('a', 'received')]);
  assert.equal(printed.length, 0, 'recebido ainda não imprime');

  ctx.printNewlyAccepted([order('a', 'accepted')]);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /\*\*\* COZINHA \*\*\*/);
  assert.match(printed[0], /2x X-Burguer/);
  assert.match(printed[0], /sem cebola/);
  assert.match(printed[0], /\*\*\* ENTREGADOR \*\*\*/);

  ctx.state.orderStatusSeen = new Map([['a', 'accepted']]);
  ctx.printNewlyAccepted([order('a', 'preparing')]);
  ctx.state.orderStatusSeen = new Map([['a', 'received']]); // mesmo se a tela recarregar e ver de novo
  ctx.printNewlyAccepted([order('a', 'accepted')]);
  assert.equal(printed.length, 1, 'não imprime de novo');
});

test('pedido que já chega aceito (aceite automático) imprime; retirada sai como BALCÃO', () => {
  const { ctx, printed } = setup();
  ctx.state.orderStatusSeen = new Map();
  ctx.printNewlyAccepted([order('b', 'accepted', { delivery_type: 'pickup' })]);
  assert.equal(printed.length, 1);
  assert.match(printed[0], /\*\*\* BALCÃO \*\*\*/);
  assert.doesNotMatch(printed[0], /ENTREGADOR/);
});

test('outro dia na tela ou pedido velho não imprime', () => {
  const { ctx, printed } = setup();
  ctx.state.orderStatusSeen = new Map();
  ctx.printNewlyAccepted([order('c', 'accepted', { created_at: new Date(Date.now() - 7 * 3600000).toISOString() })]);
  ctx.state.ordersDate = '2026-10-08';
  ctx.printNewlyAccepted([order('d', 'accepted')]);
  assert.equal(printed.length, 0);
});

test('o painel chama a impressão ao aceitar só no computador da impressora', () => {
  assert.match(admin, /if \(autoPrintHere\(\)\) printNewlyAccepted\(data\.orders\);/);
  assert.doesNotMatch(admin, /if \(autoPrintHere\(\)\) printOrders\(fresh\);/);
});
