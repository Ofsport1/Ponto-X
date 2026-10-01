// Multi-loja (endereço de teste): ?loja=apelido escolhe a loja (ex.: ...workers.dev/?loja=pontox).
// Fica guardado num cookie; "?loja=" vazio volta para a loja principal. No domínio próprio da loja o servidor ignora.
(() => {
  const loja = new URLSearchParams(location.search).get('loja');
  if (loja === null) return;
  const slug = loja.toLowerCase().replace(/[^a-z0-9-]/g, '');
  document.cookie = slug ? `loja=${slug}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax; Secure` : 'loja=; Path=/; Max-Age=0';
})();

const isBurgerStore = () => document.documentElement.dataset.store === 'pontox';
const storeFeatures = () => state.store?.profile?.features || {};
const storeCopy = (burger, market) => isBurgerStore() ? burger : market;
const STATUS_LABELS = {
  received: 'Recebido',
  accepted: 'Aceito',
  preparing: 'Em preparação',
  out_for_delivery: 'Saiu p/ entrega',
  delivered: 'Entregue',
  cancelled: 'Cancelado',
};

const NEXT_STATUS = {
  received: 'accepted',
  accepted: 'preparing',
  preparing: 'out_for_delivery',
  out_for_delivery: 'delivered',
};

// Motivos de cancelamento (obrigatório escolher um; "Outro" pede o texto).
const CANCEL_REASONS = [
  'Cliente desistiu',
  'Cliente não atendeu / não estava no endereço',
  'Produto em falta',
  'Endereço fora da área de entrega',
  'Demora na entrega',
  'Pedido duplicado ou de teste',
  'Loja sem entregador disponível',
];

const PAYMENT_LABELS = { dinheiro: 'Dinheiro', pix: 'Pix', debito: 'Débito', credito: 'Crédito', cartao: 'Cartão', fiado: 'Fiado' };
// Formas oferecidas hoje ('cartao' só aparece em pedido antigo).
const PAYMENT_CHOICES = ['dinheiro', 'pix', 'debito', 'credito'];
// A loja (painel) também lança no fiado; o entregador e o site não.
const STAFF_PAYMENT_CHOICES = [...PAYMENT_CHOICES, 'fiado'];
// Pagamento de dívida do fiado.
const CREDIT_PAY_CHOICES = ['dinheiro', 'pix', 'debito', 'credito'];

const state = {
  tab: 'orders',
  store: null,
  products: [],
  orders: [],
  ordersDate: todaySaoPaulo(),
  knownOrderIds: null,
  editingProductId: null,
  productSearch: '',
  customers: null,
  customerTiers: [],
  inactiveDays: 30,
  customerSearch: '',
  customerFilter: '',
  customerDetail: null,
  customerCredit: null,
  creditList: null,
  history: { from: todaySaoPaulo(), to: todaySaoPaulo(), status: '', payment: '', search: '', data: null },
  cash: null,
  newOrder: null,
  productView: 'grid',
  storeTab: 'geral',
  waStatus: null,
  push: null,
  zones: [],
  me: null,
  staff: null,
  courier: null,
  ordersView: 'active',
  daily: { date: todaySaoPaulo(), data: null, loading: false },
  customerView: 'list',
  carts: null,
  audit: { from: todaySaoPaulo(), to: todaySaoPaulo(), action: '', entries: null },
  financeTab: 'caixa',
  pdv: { from: todaySaoPaulo(), to: todaySaoPaulo(), fromTime: '00:00', toTime: '23:59', preview: null, closings: null, detail: null },
};

const app = document.getElementById('app');
let refreshTimer;
let loadedVersion = null;
let timerTicker;
let storeTicker;

function todaySaoPaulo() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function money(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function centsToInput(cents) {
  return (Number(cents || 0) / 100).toFixed(2).replace('.', ',');
}

function inputToCents(value) {
  const raw = String(value || '').trim().replace(/\s/g, '');
  if (!raw) return 0;
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  const n = Number(normalized);

  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

let toastTimer;

function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

async function api(path, options = {}) {
  const isJsonBody = options.body && !(options.body instanceof Blob);

  const response = await fetch(path, {
    ...options,
    headers: {
      ...(isJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));

  if (response.status === 401 && !path.startsWith('/api/admin/login')) {
    renderLogin();
    throw new Error('Sessão expirada. Entre de novo.');
  }

  if (!response.ok) {
    throw new Error(data.error || 'Algo deu errado.');
  }

  return data;
}

// Bipe curto quando chega pedido novo (sem precisar de arquivo de áudio).
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();

    [0, 0.25, 0.5].forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.15);
    });
  } catch {}
}

/* ---------------- Login ---------------- */

// Login: toca no nome e digita o PIN. A senha do painel continua valendo (entra como "Administrador").
async function renderLogin(mode) {
  clearInterval(refreshTimer);

  let users = [];

  if (mode !== 'password') {
    try {
      users = (await api('/api/admin/login-users')).users;
    } catch {}
  }

  const usePassword = mode === 'password' || !users.length;

  app.innerHTML = `
    <form class="login-box card" id="login-form">
      <img src="${escapeHtml(document.querySelector('meta[name="store-logo"]')?.content || 'assets/logo.png')}" alt="" />
      <h2>Painel do delivery</h2>
      ${usePassword ? `
        <div class="field"><input type="password" name="password" placeholder="Senha do painel" autocomplete="current-password" required /></div>
        <button class="btn primary block" type="submit">Entrar</button>
        ${users.length || mode === 'password' ? '<button type="button" class="btn block" id="login-users" style="margin-top:8px">← Entrar com meu nome e PIN</button>' : ''}`
      : `
        <div class="field"><label>Quem é você?</label>
          <select name="staff_id" required>
            <option value="">Escolha seu nome…</option>
            ${users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><input type="password" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="PIN" autocomplete="off" required /></div>
        <button class="btn primary block" type="submit">Entrar</button>
        <button type="button" class="btn block" id="login-password" style="margin-top:8px">Entrar com a senha do painel</button>`}
    </form>`;

  const form = document.getElementById('login-form');
  (form.password || form.staff_id).focus();
  form.staff_id?.addEventListener('change', () => form.pin.focus());
  document.getElementById('login-password')?.addEventListener('click', () => renderLogin('password'));
  document.getElementById('login-users')?.addEventListener('click', () => renderLogin());

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const button = form.querySelector('[type=submit]');
    button.disabled = true;

    const body = usePassword ? { password: form.password.value } : { staff_id: form.staff_id.value, pin: form.pin.value };

    try {
      await api('/api/admin/login', { method: 'POST', body: JSON.stringify(body) });
      await start();
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
      if (form.pin) form.pin.value = '';
    }
  });
}

/* ---------------- Estrutura ---------------- */

function render() {
  if (isCourier()) return renderCourier();

  const tabs = [
    ['orders', '📦 Pedidos'],
    ['history', '🧾 Histórico'],
    ['cash', '💰 Caixa'],
    ['products', '🛒 Produtos'],
    ['customers', '👥 Clientes'],
    ...(isAdminUser() ? [['suggestions', '💡 Sugestões']] : []),
    ['store', '⚙️ Loja'],
  ];

  app.innerHTML = `
    <header class="header">
      <img src="${escapeHtml(document.querySelector('meta[name="store-logo"]')?.content || 'assets/logo.png')}" alt="" />
      <div>
        <h1>Painel do delivery</h1>
        <p><span class="status-pill ${state.store.effective_open ? 'open' : 'closed'}" id="store-pill">${escapeHtml(openStatusText(state.store))}</span></p>
      </div>
      <div class="spacer"></div>
      ${state.me ? `<span class="muted" style="font-size:13px;margin-right:8px">👤 ${escapeHtml(state.me.name)}</span>` : ''}
      <button class="btn small" id="logout">Sair</button>
    </header>
    <nav class="tabs">
      ${tabs.map(([key, label]) => `<button data-tab="${key}" class="${state.tab === key ? 'active' : ''}">${label}</button>`).join('')}
      <a class="btn small" href="/" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;margin-left:auto">Ver cardápio ↗</a>
    </nav>
    <div id="tab-content"></div>`;

  renderTab();
}

function renderTab() {
  const content = document.getElementById('tab-content');

  if (!content) return;

  closeModal();
  // A tela de caixa (novo pedido) usa a largura toda.
  app.classList.toggle('wide', state.tab === 'orders' && Boolean(state.newOrder));

  if (state.tab === 'orders') {
    content.innerHTML = ordersHtml();
    if (state.newOrder) syncNewOrderForm(state.newOrder.started ? undefined : 'source');
    if (state.newOrder) state.newOrder.started = true;
  }
  if (state.tab === 'products') content.innerHTML = productsHtml();
  if (state.tab === 'store') content.innerHTML = storeHtml();
  if (state.tab === 'customers') content.innerHTML = customersTabHtml();
  if (state.tab === 'history') content.innerHTML = historyTabHtml();
  if (state.tab === 'cash') content.innerHTML = cashAreaHtml();
  if (state.tab === 'suggestions') content.innerHTML = suggestionsHtml();
}

app.addEventListener('click', async event => {
  // Lembrete de carrinho abandonado: o link abre o WhatsApp e aqui só registra que foi enviado.
  const remind = event.target.closest('[data-cart-remind]');

  if (remind) {
    api(`/api/admin/abandoned-carts/${remind.dataset.cartRemind}/reminded`, { method: 'POST' })
      .then(() => {
        const cart = state.carts?.find(c => c.id === remind.dataset.cartRemind);
        if (cart) cart.reminded_at = new Date().toISOString();
        renderTab();
      })
      .catch(() => {});
    return;
  }

  const btn = event.target.closest('button');

  if (!btn) return;

  if (btn.id === 'logout') {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    courierKnown = null;
    renderLogin();
  } else if (btn.dataset.courierOk) {
    btn.disabled = true;
    courierConfirm(btn.dataset.courierOk, true);
  } else if (btn.dataset.courierIssue) {
    courierConfirm(btn.dataset.courierIssue, false);
  } else if (btn.dataset.courierDone) {
    openCourierDelivered(btn.dataset.courierDone);
  } else if (btn.dataset.customerVip) {
    const vip = !state.customerDetail.customer.is_vip;
    updateCustomerCrm(btn.dataset.customerVip, { is_vip: vip }, vip ? '⭐ Agora é VIP: entrega grátis!' : 'VIP removido.');
  } else if (btn.dataset.customerOptin) {
    const optIn = !state.customerDetail.customer.marketing_opt_in;
    updateCustomerCrm(btn.dataset.customerOptin, { marketing_opt_in: optIn }, optIn ? 'Autorização registrada.' : 'Autorização removida.');
  } else if (btn.dataset.dispatch) {
    openDispatchModal(btn.dataset.dispatch);
  } else if (btn.id === 'audit-apply') {
    Object.assign(state.audit, {
      from: document.getElementById('audit-from').value || state.audit.from,
      to: document.getElementById('audit-to').value || state.audit.to,
      action: document.getElementById('audit-action').value,
      entries: null,
    });
    renderTab();
  } else if (btn.dataset.tab) {
    state.tab = btn.dataset.tab;
    state.editingProductId = null;
    state.customerDetail = null;
    render();
    if (state.tab === 'customers') loadCustomers();
    if (state.tab === 'history') loadHistory();
    if (state.tab === 'cash') loadCash();
    if (state.tab === 'cash' && state.financeTab === 'historico' && isAdminUser()) loadPdvClosings();
    if (state.tab === 'suggestions') loadSuggestions();
  } else if (btn.dataset.couponCreate) {
    createCoupon(btn.dataset.couponCreate, btn);
  } else if (btn.dataset.couponDismiss) {
    dismissCoupon(btn.dataset.couponDismiss, btn);
  } else if (btn.id === 'suggestions-reload') {
    loadSuggestions();
  } else if (btn.dataset.financeTab) {
    state.financeTab = btn.dataset.financeTab;
    state.pdv.detail = null;
    if (state.financeTab === 'resumo') state.daily.data = null;
    renderTab();
    if (state.financeTab === 'historico' && isAdminUser()) loadPdvClosings();
    if (state.financeTab === 'caixa' || state.financeTab === 'fechamento') loadCash();
  } else if (btn.dataset.ordersView) {
    state.ordersView = btn.dataset.ordersView;
    refreshOrdersView();
  } else if (btn.dataset.customerView) {
    state.customerView = btn.dataset.customerView;
    if (state.customerView === 'carts') state.carts = null;
    if (state.customerView === 'credit') state.creditList = null;
    renderTab();
  } else if ('pdvToday' in btn.dataset) {
    state.financeTab = 'fechamento';
    state.pdv.detail = null;
    setPdvRange('today');
  } else if (btn.dataset.pdvRange) {
    setPdvRange(btn.dataset.pdvRange);
  } else if (btn.id === 'pdv-generate') {
    generatePdv(btn);
  } else if (btn.id === 'pdv-finalize') {
    finalizePdv(btn);
  } else if (btn.id === 'pdv-print') {
    printPdv(state.pdv.preview.summary, { from: state.pdv.preview.from, to: state.pdv.preview.to, fromTime: state.pdv.preview.from_time, toTime: state.pdv.preview.to_time });
  } else if (btn.dataset.pdvOpen) {
    openPdvClosing(btn.dataset.pdvOpen);
  } else if (btn.id === 'pdv-back') {
    state.pdv.detail = null;
    renderTab();
  } else if (btn.id === 'pdv-print-detail') {
    const c = state.pdv.detail;
    printPdv(c, { from: c.period_from, to: c.period_to, fromTime: c.period_from_time, toTime: c.period_to_time, closing: c });
  } else if (btn.dataset.reopenOrder) {
    reopenOrder(btn.dataset.reopenOrder);
  } else if (btn.dataset.editOrder) {
    openEditOrderModal(btn.dataset.editOrder);
  } else if (btn.dataset.discount) {
    openDiscountModal(btn.dataset.discount);
  } else if (btn.dataset.staffPin) {
    openStaffPinModal(btn.dataset.staffPin);
  } else if (btn.dataset.staffToggle) {
    const s = state.staff?.find(u => u.id === btn.dataset.staffToggle);
    if (s && (!s.active || confirm(`Desativar ${s.name}? Essa pessoa não vai mais conseguir entrar no painel.`))) updateStaff(s.id, { active: !s.active });
  } else if (btn.id === 'new-order') {
    state.newOrder = { items: [], search: '' };
    renderTab();
    window.scrollTo(0, 0);
  } else if (btn.id === 'cancel-new-order') {
    if (state.newOrder.items.length && !confirm('Descartar este pedido?')) return;
    closeNewOrder();
  } else if (btn.dataset.tile) {
    if (btn.dataset.mode === 'pos') posTileClick(btn.dataset.tile);
    else openProductForm(btn.dataset.tile);
  } else if (btn.dataset.gridCat) {
    document.getElementById(btn.dataset.gridCat)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (btn.dataset.productView) {
    state.productView = btn.dataset.productView;
    renderTab();
  } else if ('closeModal' in btn.dataset) {
    closeModal();
  } else if (btn.id === 'pos-go-cart') {
    document.getElementById('new-order-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (btn.dataset.noAdd) {
    addNewOrderItem(btn.dataset.noAdd, btn.dataset.variant || null);
  } else if (btn.dataset.noChill) {
    const item = state.newOrder?.items.find(i => i.key === btn.dataset.noChill);
    if (item) { item.chilled = !item.chilled; refreshNewOrder(); }
  } else if (btn.dataset.noInc) {
    changeNewOrderQty(btn.dataset.noInc, 1);
  } else if (btn.dataset.noDec) {
    changeNewOrderQty(btn.dataset.noDec, -1);
  } else if ('payMethod' in btn.dataset) {
    choosePayment(btn.dataset.order, btn.dataset.payMethod, Boolean(btn.dataset.deliver));
  } else if (btn.dataset.pay) {
    // Marcar como pago pergunta a forma de pagamento; desmarcar é direto.
    if (btn.dataset.paid === 'paid') openPaymentPicker(btn.dataset.pay);
    else updateOrderPayment(btn.dataset.pay, 'pending');
  } else if (btn.id === 'history-apply') {
    readHistoryFilters();
    loadHistory();
  } else if (btn.dataset.range) {
    setHistoryRange(btn.dataset.range);
  } else if (btn.dataset.weighItem) {
    weighOrderItem(btn.dataset.order, btn.dataset.weighItem);
  } else if (btn.dataset.noWeigh) {
    const item = state.newOrder?.items.find(i => i.key === btn.dataset.noWeigh);
    if (item) {
      const estimated = linePrice(item.qty, item.price, item.bulk_qty, item.bulk_price_cents).total;
      const text = prompt(`${item.qty}× ${item.name}\nEstimado: ${money(estimated)}\n\nValor da balança (R$) — vazio volta ao estimado:`, item.weighed ? centsToInput(item.weighed) : '');
      if (text !== null) {
        const cents = text.trim() ? inputToCents(text) : null;
        if (text.trim() && (!cents || cents <= 0)) toast('Valor inválido.', true);
        else { item.weighed = cents; refreshNewOrder(); }
      }
    }
  } else if (btn.dataset.creditReverse) {
    reverseCreditEntry(btn.dataset.creditReverse);
  } else if (btn.id === 'credit-print') {
    printCreditStatement();
  } else if (btn.dataset.customer) {
    openCustomer(btn.dataset.customer);
  } else if (btn.id === 'back-customers') {
    state.customerDetail = null;
    renderTab();
  } else if (btn.dataset.tierFilter !== undefined) {
    state.customerFilter = btn.dataset.tierFilter;
    document.getElementById('customer-list').innerHTML = customerListHtml();
    document.querySelectorAll('[data-tier-filter]').forEach(b => b.classList.toggle('active', b === btn));
  } else if (btn.dataset.advance) {
    const order = findOrder(btn.dataset.advance);

    // "Finalizar pedido" pula as etapas que faltam: confirma antes (evita clique sem querer).
    if (btn.dataset.finish && !confirm(`Finalizar o pedido #${order?.order_number ?? ''}${order?.customer_name ? ` (${order.customer_name})` : ''}? Ele vai para ✅ Finalizados como entregue.`)) return;

    // Entregar um pedido ainda não pago: já pergunta como o cliente pagou.
    if (btn.dataset.status === 'delivered' && order && order.payment_status !== 'paid') {
      openPaymentPicker(order.id, { deliver: true });
      return;
    }

    notifyOnStatusChange(btn.dataset.advance, btn.dataset.status);
    updateOrderStatus(btn.dataset.advance, btn.dataset.status);
  } else if (btn.dataset.cancel) {
    openCancelModal(btn.dataset.cancel);
  } else if (btn.dataset.print) {
    const order = state.orders.find(o => o.id === btn.dataset.print);
    if (order) printOrders([order]);
  } else if (btn.dataset.notify) {
    const order = state.orders.find(o => o.id === btn.dataset.notify);
    if (order) openWhatsapp(order, templateKeyFor(order));
  } else if (btn.dataset.storeTab) {
    state.storeTab = btn.dataset.storeTab;
    if (state.storeTab === 'whatsapp') { state.waStatus = null; state.waQr = null; }
    if (state.storeTab === 'avisos') state.push = null;
    if (state.storeTab === 'usuarios') state.staff = null;
    if (state.storeTab === 'auditoria') state.audit.entries = null;
    state.tab = 'store';
    render();
  } else if (btn.id === 'hours-copy') {
    copyFirstDayHours();
  } else if (btn.dataset.zoneDelete) {
    const zone = state.zones.find(z => z.id === btn.dataset.zoneDelete);
    if (zone && confirm(`Excluir o bairro "${zone.name}"?`)) deleteZone(zone.id);
  } else if (btn.id === 'push-on') {
    enablePush(btn);
  } else if (btn.id === 'push-off') {
    disablePush();
  } else if (btn.id === 'push-test') {
    testPush(btn);
  } else if (btn.id === 'wa-refresh') {
    state.waStatus = undefined;
    renderTab();
    loadWaStatus();
  } else if (btn.dataset.waQr) {
    waQrAction(btn.dataset.waQr, btn);
  } else if (btn.dataset.waRetry) {
    retryWaMessage(btn.dataset.waRetry, btn);
  } else if (btn.id === 'wa-qr-refresh') {
    loadWaQr();
  } else if (btn.id === 'wa-create-templates') {
    createWaTemplates(btn);
  } else if (btn.id === 'print-test') {
    const form = document.getElementById('printer-form');
    printTest(form);
  } else if (btn.id === 'print-station-off') {
    setPrintStation({ off: true }, 'Impressão automática desligada.');
  } else if (btn.id === 'print-station-here') {
    claimPrintStation();
  } else if (btn.dataset.waPreview) {
    previewTemplate(btn.dataset.waPreview);
  } else if (btn.dataset.waReset) {
    const form = document.getElementById('whatsapp-form');
    form[btn.dataset.waReset].value = WHATSAPP_TEMPLATES.find(([k]) => k === btn.dataset.waReset)[2];
  } else if (btn.dataset.edit) {
    openProductForm(btn.dataset.edit);
  } else if (btn.id === 'new-product') {
    state.newAsAddon = false;
    openProductForm('new');
  } else if (btn.id === 'new-addon') {
    state.newAsAddon = true;
    openProductForm('new');
  } else if (btn.id === 'toggle-advanced') {
    const advanced = document.getElementById('advanced-fields');
    advanced.hidden = false;
    btn.hidden = true;
  } else if (btn.id === 'add-variant') {
    document.getElementById('variants').insertAdjacentHTML('beforeend', variantRowHtml());
    document.getElementById('price-field').hidden = true;
    document.getElementById('simple-fields').hidden = true;
    document.getElementById('promo-fields').hidden = true;
    document.querySelector('#variants .variant-row:last-child [data-vname]').focus();
    refreshComponentOptions();
  } else if (btn.id === 'add-component') {
    document.getElementById('components').insertAdjacentHTML('beforeend', componentRowHtml());
    refreshComponentOptions();
    document.querySelector('#components .component-row:last-child [data-cproduct]').focus();
  } else if ('removeComponent' in btn.dataset) {
    btn.closest('.component-row').remove();
  } else if (btn.dataset.vphotoRemove) {
    // Tira a foto da opção: ela volta a usar a foto do produto.
    const row = btn.closest('.variant-row');
    btn.disabled = true;
    api(`/api/admin/products/${state.editingProductId}/photo?variant=${btn.dataset.vphotoRemove}`, { method: 'DELETE' })
      .then(() => {
        row.querySelector('.variant-thumb').firstElementChild.outerHTML = '<span>📷</span>';
        btn.remove();
        const v = state.products.find(p => p.id === state.editingProductId)?.variants.find(x => x.id === btn.dataset.vphotoRemove);
        if (v) v.image_url = null;
        toast('Foto da opção removida.');
      })
      .catch(err => { toast(err.message, true); btn.disabled = false; });
  } else if ('removeVariant' in btn.dataset) {
    btn.closest('.variant-row').remove();
    refreshComponentOptions();
    document.getElementById('price-field').hidden = Boolean(document.querySelector('#variants .variant-row'));
    document.getElementById('simple-fields').hidden = Boolean(document.querySelector('#variants .variant-row'));
    document.getElementById('promo-fields').hidden = Boolean(document.querySelector('#variants .variant-row'));
  } else if (btn.id === 'cancel-edit') {
    closeProductForm();
  } else if (btn.dataset.inactivate) {
    const product = state.products.find(p => p.id === btn.dataset.inactivate);
    if (btn.dataset.confirm && !confirm(`Inativar "${product.name}" por falta de estoque? Ele some do cardápio até você reativar (aba Inativos).`)) return;
    btn.disabled = true;
    saveProduct(product.id, { available: false, inactive_reason: btn.dataset.reason })
      .then(ok => ok && toast(`"${product.name}" inativado (${INACTIVE_LABELS[btn.dataset.reason]}). O cliente não vê mais.`));
  } else if (btn.dataset.reactivate) {
    const product = state.products.find(p => p.id === btn.dataset.reactivate);
    btn.disabled = true;
    saveProduct(product.id, { available: true }).then(ok => ok && toast(`"${product.name}" reativado ✓`));
  } else if (btn.dataset.delete) {
    const product = state.products.find(p => p.id === btn.dataset.delete);

    if (confirm(`Excluir "${product.name}"? Isso não pode ser desfeito.`)) deleteProduct(product.id);
  } else if (btn.id === 'toggle-open') {
    saveStore({ is_open: !state.store.is_open });
  }
});

// Só a lista é redesenhada, para a busca não perder o foco enquanto digita.
app.addEventListener('input', event => {
  if (event.target.matches?.('[data-vname]')) {
    refreshComponentOptions();
  } else if (event.target.id === 'pos-search') {
    state.newOrder.search = event.target.value;
    document.getElementById('pos-grid').innerHTML = posGridHtml();
  } else if (event.target.id === 'history-search') {
    state.history.search = event.target.value;
    document.getElementById('history-list').innerHTML = historyListHtml();
  } else if (event.target.id === 'customer-search') {
    state.customerSearch = event.target.value;
    document.getElementById('customer-list').innerHTML = customerListHtml();
  } else if (event.target.id === 'product-search') {
    state.productSearch = event.target.value;
    document.getElementById('product-list').innerHTML = productListHtml();
  } else if (event.target.name === 'discount' && event.target.closest('#new-order-form')) {
    refreshNewOrder();
  } else if (event.target.name === 'customer_phone' && event.target.closest('#new-order-form')) {
    lookupNewOrderCustomer(event.target.form);
  } else if (event.target.name === 'address' && event.target.closest('#new-order-form')) {
    // Bairro automático pelo endereço (se o bairro ainda não foi escolhido na mão).
    const form = event.target.form;
    const select = form.delivery_zone_id;
    const zone = select && select.dataset.manual !== '1' ? detectZoneFromAddress(event.target.value, activeZones()) : null;
    if (zone && select.value !== zone.id) {
      select.value = zone.id;
      refreshNewOrder();
    }
  }
});

// Novo pedido: ao digitar o telefone, acha o cadastro e preenche nome, endereço e bairro.
let customerLookupTimer;

function lookupNewOrderCustomer(form) {
  clearTimeout(customerLookupTimer);

  customerLookupTimer = setTimeout(async () => {
    const digits = form.customer_phone.value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
    const box = document.getElementById('no-customer-info');

    if (!box || !state.newOrder) return;

    if (digits.length < 10) {
      box.innerHTML = '';
      if (state.newOrder.vip) { state.newOrder.vip = false; refreshNewOrder(); }
      return;
    }

    if (digits === state.newOrder.lookedUp) return;

    state.newOrder.lookedUp = digits;

    try {
      const { found, customer: c } = await api(`/api/admin/customer-by-phone?phone=${digits}`);

      // Digitou outro número enquanto buscava.
      if (form.customer_phone.value.replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '') !== digits) return;

      state.newOrder.vip = Boolean(found && c.is_vip);

      if (!found) {
        box.innerHTML = '<p class="muted" style="margin:-4px 0 10px;font-size:13px">🆕 Cliente novo — o cadastro é criado com este pedido.</p>';
        refreshNewOrder();
        return;
      }

      // Preenche só o que ainda está vazio (não apaga o que a pessoa já digitou).
      if (!form.customer_name.value.trim()) form.customer_name.value = c.name;
      if (c.address && !form.address.value.trim()) form.address.value = c.address;

      const zone = c.delivery_zone && activeZones().find(z => normalizeText(z.name) === normalizeText(c.delivery_zone));
      if (zone && form.delivery_zone_id && !form.delivery_zone_id.value) form.delivery_zone_id.value = zone.id;

      box.innerHTML = `
        <div class="card" style="margin:-4px 0 12px;padding:10px 12px">
          👤 <strong>${customerNameHtml(c.name, c.highlight)}</strong> ${c.is_vip ? '<span class="badge vip">⭐ VIP · entrega grátis</span>' : ''}
          <span class="muted">· ${c.total_orders_count} pedido(s)${c.last_order_at ? ` · último em ${dateOf(c.last_order_at)}` : ''} · ${escapeHtml(c.tier_label)}</span>
          ${c.address ? `<br><span class="muted">📍 ${escapeHtml(c.address)}${c.delivery_zone ? ` (${escapeHtml(c.delivery_zone)})` : ''}</span>` : ''}
          ${c.notes ? `<br><span class="muted">📝 ${escapeHtml(c.notes)}</span>` : ''}
          ${creditLineHtml(c)}
        </div>`;

      refreshNewOrder();
    } catch (err) {
      state.newOrder.lookedUp = null;
      toast(err.message, true);
    }
  }, 400);
}

// Enter no filtro do novo pedido adiciona o primeiro produto da grade.
app.addEventListener('keydown', event => {
  if (event.target.id === 'pos-search' && event.key === 'Enter') {
    event.preventDefault();
    document.querySelector('#pos-grid [data-tile]')?.click();
  }

  if (event.key === 'Escape' && document.getElementById('modal')) {
    closeModal();
    state.editingProductId = null;
  }
});

app.addEventListener('change', event => {
  // Bairro escolhido na mão no Novo pedido: o endereço não troca mais sozinho.
  if (event.target.name === 'delivery_zone_id' && event.target.closest('#new-order-form')) event.target.dataset.manual = '1';
  // Foto escolhida para uma opção: mostra a prévia (é enviada ao salvar o produto).
  // Item do combo: trocou o produto, mostra as opções dele (sabor, tamanho).
  if (event.target.matches?.('[data-cproduct]')) {
    const select = event.target.closest('.component-row').querySelector('[data-cvariant]');
    select.innerHTML = componentVariantTags(event.target.value, null);
    select.hidden = !select.innerHTML;
    return;
  }
  if (event.target.matches?.('[data-vphoto]') && event.target.files[0]) {
    const thumb = event.target.closest('.variant-thumb');
    thumb.firstElementChild.outerHTML = `<img src="${URL.createObjectURL(event.target.files[0])}" alt="" />`;
    return;
  }
  // Foto do produto escolhida clicando na própria imagem: abre o recorte manual (arrastar
  // + zoom) antes de aceitar. A prévia só troca quando o usuário confirma no modal.
  if (event.target.matches?.('[data-pphoto]') && event.target.files[0]) {
    openCropModal(event.target.files[0], event.target);
    return;
  }

  if (event.target.id === 'daily-date') {
    state.daily.date = event.target.value || todaySaoPaulo();
    state.daily.data = null;
    renderTab();
  } else if (event.target.dataset.staffRoleSelect) {
    updateStaff(event.target.dataset.staffRoleSelect, { role: event.target.value });
  } else if (['pdv-from', 'pdv-to', 'pdv-from-time', 'pdv-to-time'].includes(event.target.id)) {
    const key = { 'pdv-from': 'from', 'pdv-to': 'to', 'pdv-from-time': 'fromTime', 'pdv-to-time': 'toTime' }[event.target.id];
    state.pdv[key] = event.target.value || (key === 'fromTime' ? '00:00' : key === 'toTime' ? '23:59' : state.pdv[key]);
    // Mudou o período: o fechamento gerado antes não vale mais.
    state.pdv.preview = null;
    renderTab();
  } else if (event.target.id === 'orders-date') {
    state.ordersDate = event.target.value || todaySaoPaulo();
    state.knownOrderIds = null;
    loadOrders();
  } else if (event.target.closest('#new-order-form') && ['source', 'delivery_type', 'payment_method'].includes(event.target.name)) {
    syncNewOrderForm(event.target.name);
  }
});

app.addEventListener('submit', event => {
  if (event.target.id === 'credit-settings-form') {
    event.preventDefault();
    saveCreditSettings(event.target);
    return;
  }
  if (event.target.id === 'credit-payment-form') {
    event.preventDefault();
    submitCreditPayment(event.target);
    return;
  }
  if (event.target.id === 'credit-adjust-form') {
    event.preventDefault();
    submitCreditAdjust(event.target);
    return;
  }
  if (event.target.id === 'new-order-form') {
    event.preventDefault();
    submitNewOrder(event.target);
  } else if (event.target.id === 'cash-open-form') {
    event.preventDefault();
    openCash(event.target);
  } else if (event.target.id === 'cash-movement-form') {
    event.preventDefault();
    addCashMovement(event.target);
  } else if (event.target.id === 'cash-close-form') {
    event.preventDefault();
    closeCash(event.target);
  } else if (event.target.id === 'customer-notes-form') {
    event.preventDefault();
    saveCustomerNotes(event.target);
  } else if (event.target.id === 'product-form') {
    event.preventDefault();
    submitProductForm(event.target);
  } else if (event.target.id === 'store-form') {
    event.preventDefault();
    submitStoreForm(event.target);
  } else if (event.target.id === 'hours-form') {
    event.preventDefault();
    saveStore({ auto_hours: event.target.auto_hours.checked, hours: readHoursForm(event.target) }, 'Horários salvos!');
  } else if (event.target.classList.contains('zone-form') || event.target.id === 'zone-new-form') {
    event.preventDefault();
    saveZone(event.target);
  } else if (event.target.id === 'flat-fee-form') {
    event.preventDefault();
    const fee = inputToCents(event.target.fee.value);
    if (fee === null) return toast('Taxa inválida.', true);
    saveStore({ delivery_fee_cents: fee }, 'Taxa salva!');
  } else if (event.target.id === 'printer-form') {
    event.preventDefault();
    const cur = printSettings();
    saveStore({ print_settings: { ...readPrinterForm(event.target), auto_print: false, station_id: cur.station_id || null, station_label: cur.station_label || null, station_set_at: cur.station_set_at || null } }, 'Impressora configurada!');
  } else if (event.target.id === 'wa-mode-form') {
    event.preventDefault();
    saveWaModeForm(event.target);
  } else if (event.target.id === 'wa-qr-test-form') {
    event.preventDefault();
    sendWaQrTest(event.target);
  } else if (event.target.id === 'wa-api-form') {
    event.preventDefault();
    saveWaApiForm(event.target);
  } else if (event.target.id === 'wa-test-form') {
    event.preventDefault();
    sendWaTest(event.target);
  } else if (event.target.id === 'whatsapp-form') {
    event.preventDefault();
    saveWhatsappForm(event.target);
  } else if (event.target.id === 'customer-bday-form') {
    event.preventDefault();
    const f = event.target;
    if (Boolean(f.day.value) !== Boolean(f.month.value)) return toast('Escolha o dia e o mês.', true);
    updateCustomerCrm(f.dataset.id, { birthday: f.day.value ? `${f.month.value}-${f.day.value}` : '' }, 'Aniversário salvo!');
  } else if (event.target.id === 'birthday-form') {
    event.preventDefault();
    saveBirthdaySettings(event.target);
  } else if (event.target.id === 'profile-form') {
    event.preventDefault();
    saveProfile(event.target);
  } else if (event.target.id === 'promo-form') {
    event.preventDefault();
    sendPromo(event.target);
  } else if (event.target.id === 'staff-new-form') {
    event.preventDefault();
    createStaff(event.target);
  }
});

/* ---------------- Pedidos ---------------- */

const canDispatch = order => order.delivery_type === 'delivery' && ['accepted', 'preparing'].includes(order.status);

const normalizeStreet = s => normalizeText(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Quadra/rua do pedido: a escolhida pelo cliente, ou um palpite pelo endereço (o caixa confirma ao despachar).
// Só existe para bairros com lista (hoje, as quadras de Garatucaia); os outros agrupam só pelo bairro.
function orderStreet(order) {
  if (order.delivery_street) return { street: order.delivery_street, guessed: false };

  const zone = state.zones.find(z => z.name === order.delivery_zone);
  const address = ` ${normalizeStreet(order.address)} `;

  // Condomínio: casa = quadra + lote ("E 25", "K-20", "g17", "Qd H lote 12").
  const quadras = new Map((zone?.streets || [])
    .map(s => normalizeStreet(s).match(/^(?:quadra|qd|q) ([a-z0-9]+)$/))
    .map((m, i) => (m ? [m[1], zone.streets[i]] : null))
    .filter(Boolean));

  if (quadras.size) {
    const explicit = address.match(/ (?:quadra|qdra|qda|qd|q) ?([a-z]) /);

    if (explicit && quadras.has(explicit[1])) return { street: quadras.get(explicit[1]), guessed: true };

    // Letra + número do lote, mas não "R. O, 05" / "Rua D 19" (aí a letra é da rua, não da quadra).
    for (const m of address.matchAll(/ ([a-z]) ?(\d{1,3}) /g)) {
      const before = address.slice(0, m.index);

      if (!/(^| )(r|rua|av)$/.test(before) && quadras.has(m[1])) return { street: quadras.get(m[1]), guessed: true };
    }
  }

  for (const street of (zone?.streets || []).filter(s => !/^(quadra|qd|q)\b/i.test(s))) {
    const name = normalizeStreet(street).replace(/^(rua|r|avenida|av|travessa|tv|estrada|rodovia|rod)\s+/, '');

    if (!name) continue;

    // "Rua A" só casa com "rua a"/"r a" (letra solta é ambígua); nome comprido casa em qualquer lugar.
    const hit = name.length <= 2
      ? new RegExp(` (rua|r) ${name} `).test(address)
      : address.includes(` ${name} `) || address.includes(name);

    if (hit) return { street, guessed: true };
  }

  return { street: null, guessed: false };
}

function courierInfoHtml(order) {
  const parts = [];
  const { street, guessed } = order.delivery_type === 'delivery' ? orderStreet(order) : {};

  if (street) parts.push(`🏘️ ${escapeHtml(street)}${guessed ? ' <span class="muted">(palpite pelo endereço)</span>' : ''}`);

  if (order.courier_name) {
    parts.push(`🛵 ${escapeHtml(order.courier_name)} · despachado por ${escapeHtml(order.dispatched_by || '—')} às ${timeOf(order.dispatched_at)}`);

    if (order.courier_issue) parts.push(`<strong class="status-cancelled">⚠️ Entregador apontou diferença: ${escapeHtml(order.courier_issue)}</strong>`);
    else if (order.courier_confirmed_at) parts.push(`<span class="paid-text">✅ Entregador conferiu os itens às ${timeOf(order.courier_confirmed_at)}</span>`);
    else if (order.status === 'out_for_delivery') parts.push('⏳ Entregador ainda não conferiu os itens');
  }

  return parts.length ? `<br>${parts.join('<br>')}` : '';
}

// Como juntar as entregas: pela quadra quando o bairro tem lista (Garatucaia); senão, pelo bairro.
function routeKey(order) {
  const { street } = orderStreet(order);
  const zone = order.delivery_zone || 'Sem bairro';

  return street ? `${zone} · ${street}` : zone;
}

// Bairro pelo endereço digitado ("Rua 3, Garatucaia" → Garatucaia). Lugares que ficam DENTRO
// de outro bairro ganham dele: "Ladeira do Hugo, Garatucaia" → Ladeira do Hugo; "Recanto,
// Garatucaia" → Recanto; "Sertão do Canta Galo" → Sertão (não Canta Galo). Igual no app.js e admin.js.
// Apelidos de bairro, bairros "grandes" e caminhos de entrega vêm do cadastro da loja
// (stores.delivery_rules; hoje só a Garatucaia tem). Loja sem regras: acha o bairro só pelo nome
// cadastrado e não sugere caminhos. Site e worker são publicados juntos, então não há "reserva" aqui
// (uma reserva com os bairros da Garatucaia vazaria para as outras lojas).
function deliveryRules() {
  const rules = state.store?.delivery_rules;
  return rules && typeof rules === 'object' ? rules : {};
}

function detectZoneFromAddress(text, zones) {
  const plain = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const address = ` ${plain(text)} `;

  if (address.trim().length < 4) return null;

  const hits = [];

  for (const zone of zones || []) {
    const name = plain(zone.name);
    const aliases = [name, ...(deliveryRules().aliases?.[name] || [])];
    const alias = aliases.filter(a => address.includes(` ${a} `)).sort((a, b) => b.length - a.length)[0];

    if (alias) hits.push({ zone, len: alias.length, broad: (deliveryRules().broad || []).includes(name) });
  }

  // O lugar mais específico ganha do bairro "grande"; entre iguais, o nome mais comprido.
  hits.sort((a, b) => (a.broad - b.broad) || (b.len - a.len));

  return hits[0]?.zone || null;
}

// Caminhos de entrega saindo da loja (como o entregador anda de verdade): bairros do mesmo
// caminho vão juntos, na ordem das paradas. Cada parada casa pelo bairro do pedido ou, se não
// der, pelo endereço (ex.: "Ladeira do Hugo" escrito no endereço de um pedido de Caetés).
// Garatucaia (o bairro da loja) continua agrupada por quadra.
// Caminhos em stores.delivery_rules.routes (só a Garatucaia tem; outra loja só se pedir).
const routeLines = () => deliveryRules().routes || [];

// { line, stop } do pedido, ou null se o bairro não está em nenhum caminho.
function routeLineOf(order) {
  const zone = normalizeText(order.delivery_zone);
  const address = normalizeText(order.address);
  // Parada mais longe primeiro: "Sertão do Canta Galo" é o sertão, não o Canta Galo.
  const find = text => {
    for (const line of routeLines()) {
      for (let stop = line.stops.length - 1; stop >= 0; stop--) {
        if (line.stops[stop].some(w => text.includes(w))) return { line, stop };
      }
    }
    return null;
  };
  const byZone = zone ? find(zone) : null;

  if (!byZone) return null;

  // O endereço pode ser mais preciso dentro do mesmo caminho (bairro Canta Galo, endereço no Sertão).
  const byAddress = address ? find(address) : null;

  return byAddress && byAddress.line === byZone.line && byAddress.stop > byZone.stop ? byAddress : byZone;
}

function stopName(order) {
  return order.delivery_zone || 'Sem bairro';
}

// Pedidos de entrega ainda na loja: juntos pela quadra/bairro, e pelos caminhos (delivery_rules.routes).
function routeSuggestionsHtml() {
  if (state.ordersDate !== todaySaoPaulo()) return '';

  const waiting = state.orders.filter(o => o.delivery_type === 'delivery' && ['received', 'accepted', 'preparing'].includes(o.status));
  const groups = new Map();
  const lines = new Map();

  for (const o of waiting) {
    const onLine = routeLineOf(o);

    if (onLine) {
      if (!lines.has(onLine.line)) lines.set(onLine.line, []);
      lines.get(onLine.line).push({ o, stop: onLine.stop });
      continue;
    }

    const key = routeKey(o);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  const together = [...groups.entries()].filter(([, list]) => list.length >= 2);
  const lineTrips = [...lines.entries()].filter(([, list]) => list.length >= 2);

  if (!together.length && !lineTrips.length) return '';

  return `
    <div class="card">
      <strong>🛵 Rotas sugeridas — dá para levar juntos</strong>
      <ul class="order-items">${lineTrips.map(([line, list]) => `
        <li><span>🧭 ${escapeHtml(line.name)}</span><span>${list.sort((a, b) => a.stop - b.stop).map(({ o }) => `#${escapeHtml(o.order_number)} (${escapeHtml(stopName(o))})`).join(' → ')}</span></li>`).join('')}
      ${together.map(([key, list]) => `
        <li><span>📍 ${escapeHtml(key)}</span><span>${list.map(o => `#${escapeHtml(o.order_number)}`).join(' + ')}</span></li>`).join('')}
      </ul>
    </div>`;
}

// Outros pedidos esperando no mesmo caminho do pedido (para o despacho), na ordem das paradas.
function sameLineOrders(order) {
  const mine = routeLineOf(order);

  if (!mine) return [];

  return state.orders
    .filter(o => o.id !== order.id && o.delivery_type === 'delivery' && ['received', 'accepted', 'preparing'].includes(o.status))
    .map(o => ({ o, at: routeLineOf(o) }))
    .filter(x => x.at && x.at.line === mine.line && routeKey(x.o) !== routeKey(order))
    .sort((a, b) => a.at.stop - b.at.stop)
    .map(x => x.o);
}

// Topo do cartão do pedido: número, cliente e endereço juntos, em destaque.
function orderIdentityHtml(order) {
  const { street, guessed } = order.delivery_type === 'pickup' ? {} : orderStreet(order);
  const where = order.delivery_type === 'pickup'
    ? '<span class="oi-addr">🏪 Retirada na loja</span>'
    : `<span class="oi-addr">📍 ${order.address ? escapeHtml(order.address) : 'Endereço não informado — confirme com o cliente'}</span>
       ${order.delivery_zone || street ? `<span class="oi-zone">${[order.delivery_zone, street ? `${street}${guessed ? ' (palpite)' : ''}` : ''].filter(Boolean).map(escapeHtml).join(' · ')}</span>` : ''}`;

  return `
    <div class="order-id">
      <span class="oi-num">#${escapeHtml(order.order_number)}</span>
      <div class="oi-who">
        <span class="oi-name">${customerNameHtml(order.customer_name, order.customers?.highlight)}</span>
        ${where}
      </div>
    </div>`;
}

function orderHtml(order) {
  const next = NEXT_STATUS[order.status];
  const nextLabel = next === 'out_for_delivery' && order.delivery_type === 'pickup' ? 'Pronto p/ retirada' : STATUS_LABELS[next];
  const phoneDigits = String(order.customer_phone || '').replace(/\D/g, '');

  return `
    <article class="card">
      <div class="order-head">
        <div>
          ${orderIdentityHtml(order)}
          <span class="muted" style="font-size:12px"><span title="Código que o cliente e o entregador veem">código do cliente: <strong>${escapeHtml(order.public_code || '—')}</strong></span></span><br>
          ${order.customer_id ? `<button class="btn small" data-customer="${order.customer_id}" style="margin:4px 0">👤 Ver perfil</button>` : ''}
          <span class="muted">${timeOf(order.created_at)} · ${SOURCE_LABELS[order.source] || ''} · ${order.delivery_type === 'pickup' ? 'Retirada' : 'Entrega'}</span>
        </div>
        <div style="text-align:right">
          <strong class="status-${order.status}">${STATUS_LABELS[order.status]}</strong><br>
          ${timerHtml(order)}
        </div>
      </div>
      <ul class="order-items">
        ${order.order_items.map(i => `<li><span>${i.quantity}× ${escapeHtml(i.product_name)}${weightNoteHtml(order, i)}</span><span>${money(i.subtotal_cents)}</span></li>`).join('')}
        ${order.delivery_fee_cents ? `<li class="muted"><span>Taxa de entrega</span><span>${money(order.delivery_fee_cents)}</span></li>` : ''}
        ${order.fee_waived === 'vip' ? '<li class="muted"><span>Entrega</span><span>⭐ grátis (cliente VIP)</span></li>' : ''}
        ${order.discount_cents ? `<li class="muted"><span>Desconto${order.discount_reason === 'aniversario' ? ' 🎂 aniversário' : order.discount_reason === 'cupom' ? ' 🎁 cupom' : ''}</span><span>− ${money(order.discount_cents)}</span></li>` : ''}
        <li><strong>Total</strong><strong>${money(order.total_cents)}</strong></li>
      </ul>
      ${order.pdv_closing_id ? '<p class="muted" style="margin:0 0 6px">🔒 Já entrou num Fechamento PDV (não pode mais ser alterado)</p>' : ''}
      ${order.scheduled && !['delivered', 'cancelled'].includes(order.status) ? '<p class="status-cancelled" style="margin:0 0 6px"><strong>🌙 Pedido feito com a loja fechada — processar na abertura</strong></p>' : ''}
      <div class="muted" style="font-size:14px;line-height:1.6">
        💳 ${paymentText(order)} · ${paymentBadge(order)}${order.change_for_cents ? ` · troco para ${money(order.change_for_cents)} (levar ${money(order.change_for_cents - cashDue(order))})` : ''}<br>
        📱 <a href="https://wa.me/55${escapeHtml(phoneDigits)}" target="_blank" rel="noopener">${escapeHtml(order.customer_phone)}</a><br>
        ${order.notes ? `📝 ${escapeHtml(order.notes)}` : ''}
        ${order.status === 'cancelled' && order.cancel_reason ? `<br><span class="status-cancelled">✖ Motivo: ${escapeHtml(order.cancel_reason)}</span>${order.cancelled_by ? ` · por ${escapeHtml(order.cancelled_by)}` : ''}` : ''}
        ${courierInfoHtml(order)}
      </div>
      <div class="row" style="margin-top:12px">
        ${next === 'accepted'
          ? `<button class="btn primary small" data-advance="${order.id}" data-status="accepted">✅ Aceitar pedido</button>`
          : canDispatch(order) && next === 'out_for_delivery'
            ? `<button class="btn primary small" data-dispatch="${order.id}">🛵 Conferir e despachar</button>`
            : next ? `<button class="btn primary small" data-advance="${order.id}" data-status="${next}">→ ${nextLabel}</button>` : ''}
        ${canDispatch(order) && order.status === 'accepted' ? `<button class="btn small" data-dispatch="${order.id}">🛵 Despachar direto</button>` : ''}
        ${next && next !== 'delivered' && !order.pdv_closing_id ? `<button class="btn small btn-finish" data-advance="${order.id}" data-status="delivered" data-finish="1">✅ Finalizar pedido</button>` : ''}
        ${order.status !== 'cancelled' ? `<button class="btn small" data-pay="${order.id}" data-paid="${order.payment_status === 'paid' ? 'pending' : 'paid'}">${order.payment_status === 'paid' ? '↩ Desmarcar pago' : '💵 Marcar como pago'}</button>` : ''}
        ${state.ordersView === 'delivered' && order.status === 'delivered' && !order.pdv_closing_id ? `<button class="btn small" data-reopen-order="${order.id}">↩ Reabrir pedido</button>` : ''}
        ${order.status !== 'cancelled' && order.payment_status !== 'paid' && !order.pdv_closing_id ? `<button class="btn small" data-edit-order="${order.id}">✏️ Editar pedido</button>` : ''}
        ${order.status !== 'cancelled' && order.payment_status !== 'paid' && !order.pdv_closing_id ? `<button class="btn small" data-discount="${order.id}">🏷️ Desconto</button>` : ''}
        ${next ? `<button class="btn danger small" data-cancel="${order.id}">Cancelar</button>` : ''}
        <button class="btn small" data-print="${order.id}">🖨️ Imprimir</button>
        ${phoneDigits.length >= 10 ? `<button class="btn small" data-notify="${order.id}">💬 Avisar cliente</button>` : ''}
      </div>
    </article>`;
}

/* ---------------- Cronômetro do pedido ---------------- */

// Tempo desde que o pedido foi feito. Em andamento: conta ao vivo; finalizado: tempo total.
function elapsedText(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => String(n).padStart(2, '0');

  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// Prazo prometido do pedido (Loja > Geral): entrega ou retirada, contado da hora do pedido.
function deadlineMinutes(order) {
  return (order.delivery_type === 'pickup' ? state.store.pickup_minutes : state.store.delivery_minutes) || 45;
}

function orderDeadline(order) {
  return new Date(order.created_at).getTime() + deadlineMinutes(order) * 60000;
}

// Situação do prazo: folga (verde), reta final = últimos 25% do prazo (amarelo), passou (vermelho).
function deadlineInfo(start, deadline, now = Date.now()) {
  const left = deadline - now;
  const minutesLeft = Math.ceil(left / 60000);

  if (left < 0) return { cls: 'late', text: `🔴 Passou do prazo (+${Math.floor(-left / 60000)} min)` };
  if (left <= (deadline - start) * 0.25) return { cls: 'warn', text: `🟡 Prazo acabando · faltam ${minutesLeft} min` };

  return { cls: 'ok', text: `🟢 No prazo · faltam ${minutesLeft} min` };
}

function timerHtml(order) {
  const start = new Date(order.created_at).getTime();
  const deadline = orderDeadline(order);

  if (order.closed_at) {
    const end = new Date(order.closed_at).getTime();
    const onTime = order.status !== 'delivered' ? '' : end <= deadline ? ' · no prazo' : ` · ${Math.floor((end - deadline) / 60000)} min além do prazo`;
    return `<span class="timer done" title="Tempo total do pedido">⏱ ${elapsedText(end - start)}${onTime}</span>`;
  }

  const info = deadlineInfo(start, deadline);
  return `<span class="timer ${info.cls}" data-timer="${start}" data-deadline="${deadline}" title="Prazo: até ${timeOf(new Date(deadline).toISOString())}">⏱ ${elapsedText(Date.now() - start)}</span>
    <br><span class="deadline ${info.cls}" data-deadline-text="${deadline}" data-start="${start}">${info.text}</span>`;
}

function tickTimers() {
  for (const el of document.querySelectorAll('[data-timer]')) {
    const start = Number(el.dataset.timer);
    el.textContent = `⏱ ${elapsedText(Date.now() - start)}`;
    el.className = `timer ${deadlineInfo(start, Number(el.dataset.deadline)).cls}`;
  }

  for (const el of document.querySelectorAll('[data-deadline-text]')) {
    const info = deadlineInfo(Number(el.dataset.start), Number(el.dataset.deadlineText));
    el.textContent = info.text;
    el.className = `deadline ${info.cls}`;
  }

  // A faixa de alertas acompanha o relógio (um pedido pode passar do prazo sem recarregar a lista).
  const bar = document.getElementById('orders-alerts');
  if (bar) bar.innerHTML = ordersAlertsHtml();
}

// Alertas agrupados no topo da lista: um resumo por tipo, em vez de um aviso por pedido.
function ordersAlertsHtml() {
  if (state.ordersDate !== todaySaoPaulo()) return '';

  const now = Date.now();
  const open = state.orders.filter(o => !['delivered', 'cancelled'].includes(o.status));
  const late = open.filter(o => orderDeadline(o) < now);
  const closing = open.filter(o => !late.includes(o) && deadlineInfo(new Date(o.created_at).getTime(), orderDeadline(o), now).cls === 'warn');
  const waiting = open.filter(o => o.status === 'received' && now - new Date(o.created_at).getTime() > 5 * 60000);
  const outOfStock = state.products.filter(p => p.featured && !p.available);
  const nums = list => list.map(o => `#${escapeHtml(o.order_number)}`).join(', ');
  const lines = [];

  if (late.length) lines.push(`<strong class="status-cancelled">🔴 ${late.length === 1 ? `O pedido ${nums(late)} passou do prazo` : `${late.length} pedidos passaram do prazo (${nums(late)})`}</strong>`);
  if (waiting.length) lines.push(`⏳ ${waiting.length === 1 ? `O pedido ${nums(waiting)} está esperando aceite` : `${waiting.length} pedidos esperando aceite (${nums(waiting)})`} há mais de 5 min`);
  if (closing.length) lines.push(`🟡 ${closing.length === 1 ? `O pedido ${nums(closing)} está com o prazo acabando` : `${closing.length} pedidos com o prazo acabando (${nums(closing)})`}`);
  const unconfirmed = open.filter(o => o.courier_id && !o.courier_confirmed_at && now - new Date(o.dispatched_at).getTime() > 10 * 60000);
  const issues = open.filter(o => o.courier_issue);

  if (issues.length) lines.push(`<strong class="status-cancelled">⚠️ Entregador apontou diferença nos itens: ${nums(issues)}</strong>`);
  if (unconfirmed.length) lines.push(`🛵 Entregador ainda não conferiu os itens há mais de 10 min: ${nums(unconfirmed)}`);
  if (outOfStock.length) lines.push(`📦 ${outOfStock.length === 1 ? `"${escapeHtml(outOfStock[0].name)}" (Mais Vendidos) está esgotado` : `${outOfStock.length} produtos dos Mais Vendidos estão esgotados`}`);

  return lines.length ? `<div class="card warn" style="line-height:1.7"><strong>⚠️ Atenção</strong><br>${lines.join('<br>')}</div>` : '';
}

function ordersSummaryText() {
  if (!isAdminUser()) return `${state.orders.length} pedido(s)`;

  const revenue = state.orders.filter(o => o.status === 'delivered').reduce((s, o) => s + o.total_cents, 0);
  return `${state.orders.length} pedido(s) · entregue: ${money(revenue)}`;
}

// Cada situação num lugar: em andamento, entregues e cancelados (abas).
const ORDER_VIEWS = [
  ['active', '🔥 Em andamento', o => !['delivered', 'cancelled'].includes(o.status)],
  ['delivered', '✅ Finalizados', o => o.status === 'delivered'],
  ['cancelled', '✖ Cancelados', o => o.status === 'cancelled'],
];

function ordersListHtml() {
  const view = ORDER_VIEWS.find(([key]) => key === state.ordersView) || ORDER_VIEWS[0];
  const list = state.orders.filter(view[2]);
  const empty = {
    active: state.orders.length
      ? 'Nenhum pedido em andamento agora. 🎉<br>A página atualiza sozinha e toca um alerta quando chegar um pedido.'
      : 'Nenhum pedido neste dia ainda.<br>A página atualiza sozinha e toca um alerta quando chegar um pedido.',
    delivered: 'Nenhum pedido finalizado neste dia.',
    cancelled: 'Nenhum pedido cancelado neste dia.',
  }[view[0]];

  return `
    <div id="orders-alerts">${ordersAlertsHtml()}</div>
    <nav class="tabs sub-tabs">
      ${ORDER_VIEWS.map(([key, label, test]) => `<button data-orders-view="${key}" class="${view[0] === key ? 'active' : ''}">${label} (${state.orders.filter(test).length})</button>`).join('')}
    </nav>
    ${view[0] === 'active' ? routeSuggestionsHtml() : ''}
    ${list.length ? list.map(orderHtml).join('') : `<p class="empty">${empty}</p>`}`;
}

function ordersHtml() {
  if (state.newOrder) return posHtml();

  return `
    <button class="btn primary block" id="new-order" style="margin-bottom:12px">➕ Novo pedido (balcão, WhatsApp, telefone)</button>
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      ${isAdminUser() ? `<input type="date" id="orders-date" value="${state.ordersDate}" class="btn small" />` : '<span class="muted">Pedidos em andamento e pagamentos do seu caixa aberto</span>'}
      <span class="muted" id="orders-summary">${ordersSummaryText()}</span>
    </div>
    <div id="orders-list">${ordersListHtml()}</div>`;
}

// Atualiza só a lista (a atualização automática não pode apagar o formulário de novo pedido).
function refreshOrdersView() {
  const list = document.getElementById('orders-list');

  // Com a tela de novo pedido aberta, a atualização automática não mexe em nada.
  if (state.tab !== 'orders' || state.newOrder) return;

  if (!list) return renderTab();

  list.innerHTML = ordersListHtml();
  document.getElementById('orders-summary').textContent = ordersSummaryText();
}

async function loadOrders() {
  maybeClaimPrintStation();

  try {
    const data = await api(`/api/admin/orders?date=${state.ordersDate}`);
    const ids = new Set(data.orders.map(o => o.id));

    const fresh = state.knownOrderIds ? data.orders.filter(o => !state.knownOrderIds.has(o.id)) : [];

    if (fresh.length) {
      beep();
      toast('🔔 Pedido novo chegou!');
      // Impressão automática: todo pedido novo (do cliente e do caixa), só no computador da impressora.
      if (autoPrintHere()) printOrders(fresh);
    }

    state.knownOrderIds = ids;

    // Versão nova publicada: recarrega o painel sozinho, desde que o dono não esteja
    // no meio de algo (janela aberta, pedido sendo montado ou campo sendo digitado).
    loadedVersion = loadedVersion || data.app_version;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);

    if (data.app_version && data.app_version !== loadedVersion && !state.newOrder && !document.getElementById('modal') && !typing) {
      location.reload();
      return;
    }
    state.orders = data.orders;

    refreshOrdersView();
  } catch (err) {
    toast(err.message, true);
  }
}

// Cancelar exige escolher o motivo (fica no pedido e no resumo do Histórico).
function openCancelModal(orderId) {
  const order = findOrder(orderId);

  const modal = openModal(`
    <div class="sheet-head"><h2 style="margin:0">✖ Cancelar pedido${order ? ` #${escapeHtml(order.order_number)}` : ''}</h2><button type="button" data-close-modal aria-label="Fechar">✕</button></div>
    <form id="cancel-form">
      <p style="margin-top:0"><strong>Por que o pedido está sendo cancelado?</strong></p>
      <div class="cancel-reasons">
        ${[...CANCEL_REASONS, 'Outro motivo'].map(r => `<label class="check"><input type="radio" name="reason" value="${escapeHtml(r)}" required /> ${escapeHtml(r)}</label>`).join('')}
      </div>
      <div class="field" id="cancel-other" hidden><label>Qual motivo?</label><input name="other" maxlength="200" /></div>
      <button class="btn danger block" type="submit">Cancelar pedido</button>
    </form>`);

  const form = modal.querySelector('#cancel-form');

  form.addEventListener('change', () => {
    const other = form.reason.value === 'Outro motivo';
    modal.querySelector('#cancel-other').hidden = !other;
    form.other.required = other;
    if (other) form.other.focus();
  });

  form.addEventListener('submit', event => {
    event.preventDefault();

    const reason = form.reason.value === 'Outro motivo' ? form.other.value.trim() : form.reason.value;

    if (reason.length < 3) return toast('Escreva o motivo do cancelamento.', true);

    closeModal();
    notifyOnStatusChange(orderId, 'cancelled');
    updateOrderStatus(orderId, 'cancelled', { cancel_reason: reason });
  });
}

async function updateOrderStatus(orderId, status, extra = {}) {
  try {
    await api(`/api/admin/orders/${orderId}`, { method: 'PATCH', body: JSON.stringify({ status, ...extra }) });
    await refreshAfterOrderChange();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- Produtos ---------------- */

function variantRowHtml(variant = {}) {
  return `
    <div class="variant-row" data-variant-id="${escapeHtml(variant.id || '')}" data-vkey="${escapeHtml(variant.id || `novo-${Math.random().toString(36).slice(2)}`)}">
      <label class="variant-thumb" title="Foto desta opção (vazio = usa a foto do produto)">
        ${variant.image_url ? `<img src="${escapeHtml(variant.image_url)}" alt="" />` : '<span>📷</span>'}
        <input type="file" data-vphoto accept="image/jpeg,image/png,image/webp" hidden />
      </label>
      ${variant.image_url ? `<button type="button" class="btn small" data-vphoto-remove="${escapeHtml(variant.id)}" title="Tirar a foto desta opção">tirar foto</button>` : ''}
      <input class="btn small" data-vname maxlength="60" placeholder="${storeCopy('Ex.: simples, duplo, Coca-Cola', 'Ex.: 5 kg, Coca-Cola, Morango')}" value="${escapeHtml(variant.name || '')}" />
      <input class="btn small" data-vprice inputmode="decimal" placeholder="Preço" value="${variant.price_cents != null ? centsToInput(variant.price_cents) : ''}" />
      <label><input type="checkbox" data-vavailable ${variant.available === false ? '' : 'checked'} /> Disponível</label>
      <button type="button" class="btn small danger" data-remove-variant aria-label="Remover variação">✕</button>
      <span class="muted" style="font-size:12px;width:100%;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${storeFeatures().bulk !== false ? `🍻 levando <input class="btn small" data-vbulkqty type="number" min="2" max="100" placeholder="12" style="width:64px" value="${variant.bulk_qty ?? ''}" />
        sai por R$ <input class="btn small" data-vbulkprice inputmode="decimal" placeholder="0,00" style="width:84px" value="${variant.bulk_price_cents != null ? centsToInput(variant.bulk_price_cents) : ''}" />` : ''}
        · custo R$ <input class="btn small" data-vcost inputmode="decimal" placeholder="opcional" style="width:84px" value="${variant.cost_cents != null ? centsToInput(variant.cost_cents) : ''}" />
      </span>
    </div>`;
}

/* ----- Itens do combo (o que sai do futuro estoque quando o produto é vendido) ----- */

// Opções do combo = variações do formulário (inclusive as novas, ainda sem id).
function componentOptionTags(selected) {
  const rows = [...document.querySelectorAll('#variants .variant-row')];
  const options = rows.map(row => [row.dataset.vkey, row.querySelector('[data-vname]').value.trim() || '(opção sem nome)']);
  const removed = selected && !options.some(([key]) => key === selected)
    ? `<option value="${escapeHtml(selected)}" selected>(opção removida)</option>` : '';
  return `<option value="">Todas as opções</option>${options.map(([key, name]) => `<option value="${escapeHtml(key)}" ${key === selected ? 'selected' : ''}>Só em: ${escapeHtml(name)}</option>`).join('')}${removed}`;
}

function componentVariantTags(productId, selected) {
  const product = state.products.find(p => p.id === productId);
  const variants = product?.variants || [];
  return variants.map(v => `<option value="${escapeHtml(v.id)}" ${v.id === selected ? 'selected' : ''}>${escapeHtml(v.name)}</option>`).join('');
}

function componentRowHtml(component = {}, variants = []) {
  const selfId = state.editingProductId;
  const products = state.products.filter(p => p.id !== selfId).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const variantTags = componentVariantTags(component.product_id, component.variant_id);
  const optionName = variants.find(v => v.id === component.combo_variant_id)?.name;

  return `
    <div class="component-row">
      <select class="btn small" data-coption ${variants.length ? '' : 'hidden'}>
        <option value="">Todas as opções</option>
        ${variants.map(v => `<option value="${escapeHtml(v.id)}" ${v.id === component.combo_variant_id ? 'selected' : ''}>Só em: ${escapeHtml(v.name)}</option>`).join('')}
        ${component.combo_variant_id && !optionName ? `<option value="${escapeHtml(component.combo_variant_id)}" selected>(opção removida)</option>` : ''}
      </select>
      <input class="btn small" data-cqty type="number" min="1" max="99" value="${component.qty || 1}" aria-label="Quantidade" />
      <select class="btn small" data-cproduct>
        <option value="">Escolha o produto…</option>
        ${products.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === component.product_id ? 'selected' : ''}>${escapeHtml(p.name)}${p.available ? '' : ' (inativo)'}</option>`).join('')}
      </select>
      <select class="btn small" data-cvariant ${variantTags ? '' : 'hidden'}>${variantTags}</select>
      <button type="button" class="btn small danger" data-remove-component aria-label="Tirar item do combo">✕</button>
    </div>`;
}

// Nomes/quantidade de opções mudaram: atualiza o "Todas as opções / Só em: X" de cada item.
function refreshComponentOptions() {
  const rows = document.querySelectorAll('#components .component-row');
  const hasVariants = Boolean(document.querySelector('#variants .variant-row'));
  for (const row of rows) {
    const select = row.querySelector('[data-coption]');
    const current = select.value;
    select.innerHTML = componentOptionTags(current);
    select.hidden = !hasVariants;
  }
}

function componentsSectionHtml(product) {
  if (!state.componentsReady) return '';
  const components = product.components || [];
  return `
      <div class="field">
        <label>📦 Itens do combo (opcional): o que sai do estoque quando este produto é vendido. Com opções, dá para dizer o que muda em cada uma (ex.: o sabor do energético).</label>
        <div id="components">${components.map(c => componentRowHtml(c, product.variants || [])).join('')}</div>
        <button type="button" class="btn small" id="add-component">+ Adicionar item do combo</button>
      </div>`;
}

// Lê os itens do combo do formulário. Devolve a lista ou o texto do erro.
function readComponentRows(form) {
  const keys = [...form.querySelectorAll('#variants .variant-row')].map(row => row.dataset.vkey);
  const components = [];

  for (const row of form.querySelectorAll('#components .component-row')) {
    const productId = row.querySelector('[data-cproduct]').value;
    const variantSelect = row.querySelector('[data-cvariant]');
    const option = row.querySelector('[data-coption]').value;
    const qty = Number(row.querySelector('[data-cqty]').value);

    if (!productId) return 'Escolha o produto de cada item do combo (ou tire a linha com ✕).';
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return 'A quantidade de cada item do combo vai de 1 a 99.';

    const index = option ? keys.indexOf(option) : null;
    if (option && index < 0) return 'Um item do combo aponta para uma opção que foi removida.';

    components.push({
      product_id: productId,
      variant_id: variantSelect.hidden ? null : variantSelect.value || null,
      qty,
      combo_variant_index: index,
    });
  }

  return components;
}

// Dia da semana em São Paulo (0=domingo..6=sábado), mesmo cálculo do worker (nowInSaoPaulo).
function weekdaySaoPaulo(ms) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date(ms));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
}

// Preço promocional valendo agora (mesma regra do servidor); null = sem promoção.
function promoPriceNow(product) {
  const now = Date.now();

  if (product.promo_price_cents == null || product.variants?.length || product.promo_price_cents >= product.price_cents) return null;
  if (product.promo_weekdays?.length && !product.promo_weekdays.includes(weekdaySaoPaulo(now))) return null;
  if (product.promo_starts_at && new Date(product.promo_starts_at).getTime() > now) return null;
  if (product.promo_ends_at && new Date(product.promo_ends_at).getTime() <= now) return null;

  return product.promo_price_cents;
}

// datetime-local (horário de São Paulo, UTC-3 sem horário de verão) <-> ISO.
function toLocalInput(iso) {
  if (!iso) return '';
  return new Date(new Date(iso).getTime() - 3 * 3600000).toISOString().slice(0, 16);
}

function fromLocalInput(value) {
  return value ? new Date(`${value}:00-03:00`).toISOString() : null;
}

// Campo de dinheiro opcional: vazio = null; inválido = undefined (erro).
function optionalCents(text) {
  if (!String(text || '').trim()) return null;
  const cents = inputToCents(text);
  return cents === null ? undefined : cents;
}

function productFormHtml() {
  const isNew = state.editingProductId === 'new';
  const product = isNew ? (state.newAsAddon ? { is_addon: true, category: 'Adicionais' } : {}) : state.products.find(p => p.id === state.editingProductId) || {};
  const categories = [...new Set(state.products.map(p => p.category))];
  const variants = product.variants || [];
  // Variações/combo ficam escondidas por padrão (a maioria dos produtos não usa) — só vêm
  // já abertas se o produto já tiver alguma cadastrada, pra nunca esconder dado existente.
  const hasAdvanced = Boolean(variants.length || (product.components || []).length);

  return `
    <form id="product-form">
      <div class="sheet-head"><h2 style="margin:0">${isNew ? 'Novo produto' : 'Editar produto'}</h2><button type="button" id="cancel-edit" aria-label="Fechar">✕</button></div>
      <label class="product-photo-picker" title="Toque na foto para trocar">
        ${product.image_url
          ? `<img class="variant-photo" src="${escapeHtml(product.image_url)}" alt="" />`
          : `<div class="variant-photo product-photo-empty"><span>📷<br>Toque para adicionar foto</span></div>`}
        <input type="file" name="photo" data-pphoto accept="image/jpeg,image/png,image/webp" hidden />
      </label>
      <p class="muted" style="font-size:12px;margin:-6px 0 10px;text-align:center">${product.image_url ? 'Toque na foto acima para trocar' : 'Toque no quadro acima para escolher uma foto'}</p>
      <div class="field"><label>Nome</label><input name="name" required maxlength="120" value="${escapeHtml(product.name || '')}" /></div>
      <div class="grid-2">
        <div class="field" id="price-field" ${variants.length ? 'hidden' : ''}><label>Preço (R$)</label><input name="price" inputmode="decimal" placeholder="0,00" value="${product.price_cents != null && !variants.length ? centsToInput(product.price_cents) : ''}" /></div>
        <div class="field"><label>Categoria</label><input name="category" list="categories" maxlength="60" placeholder="Ex.: Bebidas" value="${escapeHtml(product.category || '')}" />
          <datalist id="categories">${categories.map(c => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
        </div>
      </div>
      <div id="promo-fields" ${variants.length ? 'hidden' : ''}>
        <div class="grid-2">
          <div class="field"><label>🔥 Preço promocional (R$, vazio = sem promoção)</label><input name="promo_price" inputmode="decimal" placeholder="Ex.: 4,99" value="${product.promo_price_cents != null ? centsToInput(product.promo_price_cents) : ''}" /></div>
          <div class="field"><label>Começa (vazio = já)</label><input name="promo_starts" type="datetime-local" value="${toLocalInput(product.promo_starts_at)}" /></div>
          <div class="field"><label>Termina (vazio = até tirar)</label><input name="promo_ends" type="datetime-local" value="${toLocalInput(product.promo_ends_at)}" /></div>
        </div>
        <p class="muted" style="font-size:12px;margin-top:-6px">Com horário de término, o cardápio mostra "Termina em X min" e a oferta some sozinha quando acabar.</p>
        <div class="field">
          <label>Dias da semana (nenhum marcado = todo dia, dentro do horário acima)</label>
          <div class="weekday-checks">
            ${['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((label, day) => `
              <label class="check"><input type="checkbox" name="promo_weekday" value="${day}" ${product.promo_weekdays?.includes(day) ? 'checked' : ''} /> ${label}</label>
            `).join('')}
          </div>
        </div>
      </div>
      ${storeFeatures().chill !== false ? `<div class="field"><label>🧊 Engradado gelado: + R$ por engradado (vazio = sem a opção)</label><input name="chill_fee" inputmode="decimal" placeholder="Ex.: 5,00" value="${product.chill_fee_cents != null ? centsToInput(product.chill_fee_cents) : ''}" /></div>` : ''}
      <div class="grid-2" id="simple-fields" ${variants.length ? 'hidden' : ''}>
        ${storeFeatures().bulk !== false ? `<div class="field"><label>🍻 Engradado: levando quantas?</label><input name="bulk_qty" type="number" min="2" max="100" placeholder="Ex.: 12 (vazio = sem engradado)" value="${product.bulk_qty ?? ''}" /></div>
        <div class="field"><label>… sai por (R$)</label><input name="bulk_price" inputmode="decimal" placeholder="Ex.: 60,00" value="${product.bulk_price_cents != null ? centsToInput(product.bulk_price_cents) : ''}" /></div>` : ''}
        <div class="field"><label>Custo da unidade (R$, opcional — para o lucro estimado)</label><input name="cost" inputmode="decimal" placeholder="opcional" value="${product.cost_cents != null ? centsToInput(product.cost_cents) : ''}" /></div>
      </div>
      <div class="field"><label>Descrição (opcional)</label><textarea name="description" rows="2" maxlength="500">${escapeHtml(product.description || '')}</textarea></div>
      <button type="button" class="btn small" id="toggle-advanced" ${hasAdvanced ? 'hidden' : ''}>▸ Variações / combo (avançado)</button>
      <div id="advanced-fields" ${hasAdvanced ? '' : 'hidden'}>
        <div class="field">
          <label>Variações (opcional). Ex.: Carvão 2,5 kg / 5 kg, ou sabores. Com variações, o cliente escolhe a opção e cada uma tem o seu preço.</label>
          <div id="variants">${variants.map(variantRowHtml).join('')}</div>
          <button type="button" class="btn small" id="add-variant">+ Adicionar variação</button>
        </div>
        ${componentsSectionHtml(product)}
      </div>
      <div class="field"><label>Situação</label>
        <select name="status">
          <option value="active" ${product.available === false ? '' : 'selected'}>✅ Ativo (aparece no cardápio)</option>
          <option value="estoque" ${product.available === false && product.inactive_reason !== 'preco' ? 'selected' : ''}>⛔ Inativo — estoque</option>
          <option value="preco" ${product.available === false && product.inactive_reason === 'preco' ? 'selected' : ''}>⛔ Inativo — erro/conferência de preço</option>
        </select>
        ${product.available === false && product.inactive_reason === 'preco' ? '<p class="muted" style="font-size:12px;margin:4px 0 0">Depois de conferir o preço, mude para ✅ Ativo e salve.</p>' : ''}
      </div>
      <label class="check"><input type="checkbox" name="featured" ${product.featured ? 'checked' : ''} /> ⭐ Mostrar em "Mais Vendidos" (topo do cardápio)</label>
      <label class="check"><input type="checkbox" name="suggest" ${product.suggest ? 'checked' : ''} /> 🧊 Sugerir no carrinho ("Leve junto")</label>
      <label class="check"><input type="checkbox" name="is_addon" ${product.is_addon ? 'checked' : ''} /> 🔥 Turbine seu lanche (adicional: aparece só dentro dos lanches, fora do cardápio geral)</label>
      <label class="check"><input type="checkbox" name="removable_cheddar" ${product.removable_cheddar ? 'checked' : ''} /> 🧀 Vem com cheddar (o cliente pode marcar "Retirar o cheddar")</label>
      ${storeFeatures().weight !== false ? `<label class="check"><input type="checkbox" name="sold_by_weight" ${product.sold_by_weight ? 'checked' : ''} /> ⚖️ Vendido por kg (o cliente vê "preço estimado" e a equipe ajusta o valor na balança)</label>
      <div class="field"><label>⚖️ Preço do quilo (R$) — aparece no cardápio como "R$ X /kg"</label><input name="kg_price" inputmode="decimal" placeholder="Ex.: 17,99" value="${product.kg_price_cents != null ? centsToInput(product.kg_price_cents) : ''}" /></div>` : ''}
      <div class="row">
        <button class="btn primary" type="submit" style="flex:1">Salvar</button>
        ${isNew ? '' : `<button class="btn danger" type="button" data-delete="${product.id}">🗑 Excluir</button>`}
      </div>
    </form>`;
}

// Busca sem diferenciar acentos nem maiúsculas ("agua" acha "Água").
function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function productListHtml() {
  let products = searchAdminProducts(state.productSearch);

  if (!state.products.length) return '<p class="empty">Nenhum produto cadastrado ainda.</p>';

  if (!products.length) return `<p class="empty">Nenhum produto encontrado para "${escapeHtml(state.productSearch.trim())}".</p>`;

  if (state.productView === 'inactive') return inactiveProductsHtml(products);

  // Adicionais ("Turbine seu lanche") ficam só na visão própria, fora do cardápio e da lista.
  if (state.productView === 'addons') return addonsListHtml(products.filter(p => p.is_addon));

  products = products.filter(p => !p.is_addon);

  if (!products.length) return '<p class="empty">Nenhum produto encontrado.</p>';

  // Visão "cardápio": igual ao que o cliente vê (só os ativos); toque para editar.
  if (state.productView === 'grid') {
    return menuGridHtml(products.filter(p => p.available), 'edit', !state.productSearch.trim());
  }

  return productCardsHtml(products);
}

function addonsListHtml(addons) {
  return `
    <p class="muted" style="margin:0 0 8px;font-size:13px">🔥 Aparecem em "Turbine seu lanche" quando o cliente abre um lanche. Não aparecem no cardápio geral; o valor entra no pedido como item separado.</p>
    ${isAdminUser() ? '<button class="btn primary" id="new-addon" style="width:100%;margin-bottom:12px">+ Novo adicional</button>' : ''}
    ${addons.length ? productCardsHtml(addons) : '<p class="empty">Nenhum adicional cadastrado.</p>'}`;
}

function productCardsHtml(products) {
  return products.map((p, i) => `
    ${i === 0 || products[i - 1].category !== p.category ? `<h2 class="section-title">${escapeHtml(p.category)}</h2>` : ''}
    <div class="card admin-product">
      ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" loading="lazy" />` : '<div class="no-photo">🛒</div>'}
      <div class="info">
        <strong>${escapeHtml(p.name)}</strong>
        <span class="price">${p.variants.length ? `a partir de ${money(p.price_cents)}` : money(p.price_cents)}</span>
        ${p.variants.length ? `<span class="badge">${p.variants.length} opções</span>` : ''}
        ${p.components?.length ? `<span class="badge">📦 combo: ${p.components.length} ${p.components.length === 1 ? 'item' : 'itens'}</span>` : ''}
        ${p.featured ? '<span class="badge">⭐ Mais Vendidos</span>' : ''}
        ${p.suggest ? '<span class="badge">🧊 Leve junto</span>' : ''}
        ${p.available ? '' : `<span class="badge off">⛔ Inativo · ${INACTIVE_LABELS[p.inactive_reason] || INACTIVE_LABELS.estoque}</span>`}
      </div>
      <div class="row" style="justify-content:flex-end">
        ${inactiveButtonsHtml(p)}
        ${isAdminUser() ? `<button class="btn small" data-edit="${p.id}">Editar</button>
        <button class="btn small danger" data-delete="${p.id}">🗑</button>` : ''}
      </div>
    </div>`).join('');
}

/* ---------------- Produtos inativos ---------------- */

// Inativo = o cliente não vê. Todo inativo tem motivo.
const INACTIVE_LABELS = { estoque: '📦 Estoque', preco: '💲 Erro/conferência de preço' };

function daysSince(iso) {
  if (!iso) return '';
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? 'desde hoje' : days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

// Botões de um produto: inativar (escolhendo o motivo) ou reativar.
function inactiveButtonsHtml(p) {
  if (p.available) {
    return `
      <button class="btn small" data-inactivate="${p.id}" data-reason="estoque" title="Some do cardápio até voltar ao estoque">📦 Inativar por estoque</button>
      ${isAdminUser() ? `<button class="btn small" data-inactivate="${p.id}" data-reason="preco" title="Some do cardápio até o preço ser conferido">💲 Inativar p/ conferir preço</button>` : ''}`;
  }

  if (p.inactive_reason === 'preco') {
    return isAdminUser()
      ? `<button class="btn small" data-edit="${p.id}">✏️ Corrigir preço</button>
         <button class="btn small primary" data-reactivate="${p.id}">✅ Preço conferido · reativar</button>`
      : '<span class="muted" style="font-size:12px">Aguardando o administrador conferir o preço</span>';
  }

  return `
    <button class="btn small primary" data-reactivate="${p.id}">✅ Voltou ao estoque · reativar</button>
    ${isAdminUser() ? `<button class="btn small" data-inactivate="${p.id}" data-reason="preco">💲 Mudar p/ conferência de preço</button>` : ''}`;
}

function inactiveProductsHtml(products) {
  const inactive = products.filter(p => !p.available);

  if (!inactive.length) {
    return `<div class="card"><p style="margin:0">✔ Nenhum produto inativo${state.productSearch.trim() ? ' nessa busca' : ''}. Tudo está aparecendo para o cliente.</p></div>`;
  }

  const groups = ['preco', 'estoque'].map(reason => ({
    reason,
    items: inactive.filter(p => (p.inactive_reason || 'estoque') === reason)
      .sort((a, b) => String(a.inactive_since || '').localeCompare(String(b.inactive_since || '')) || a.name.localeCompare(b.name)),
  })).filter(g => g.items.length);

  const help = {
    preco: 'Produtos com preço errado ou a conferir. Corrija o preço (✏️) e depois reative. Enquanto isso, nem o cardápio nem o Novo pedido vendem.',
    estoque: 'Produtos sem estoque. Quando chegar, é só reativar.',
  };

  return `
    <p class="muted" style="margin:0 0 8px;font-size:13px">Produto inativo <strong>não aparece para o cliente</strong>. Para inativar outro, use os botões na visão ☰ Lista.</p>
    ${groups.map(g => `
      <h2 class="section-title">${INACTIVE_LABELS[g.reason]} <span class="muted">(${g.items.length})</span></h2>
      <p class="muted" style="margin:-4px 0 8px;font-size:13px">${help[g.reason]}</p>
      ${g.items.map(p => `
        <div class="card admin-product">
          ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" loading="lazy" />` : '<div class="no-photo">🛒</div>'}
          <div class="info">
            <strong>${escapeHtml(p.name)}</strong>
            <span class="price">${p.variants.length ? `a partir de ${money(p.price_cents)}` : money(p.price_cents)}${p.bulk_qty ? ` · ${p.bulk_qty} por ${money(p.bulk_price_cents)}` : ''}</span>
            <span class="muted" style="font-size:12px">${escapeHtml(p.category || '')} · inativo ${daysSince(p.inactive_since)}</span>
          </div>
          <div class="row" style="justify-content:flex-end">${inactiveButtonsHtml(p)}</div>
        </div>`).join('')}`).join('')}`;
}

function productsHtml() {
  const inactiveCount = state.products.filter(p => !p.available).length;

  return `
    <div class="row" style="margin-bottom:12px">
      ${isAdminUser() ? '<button class="btn primary" id="new-product" style="flex:1">+ Novo produto</button>' : '<p class="muted" style="flex:1;margin:0;font-size:13px">Você pode inativar ou reativar produto por estoque (visões Lista e Inativos). Preço e cadastro são com o administrador.</p>'}
      <div class="view-toggle">
        <button data-product-view="grid" class="${state.productView === 'grid' ? 'active' : ''}">🖼️ Cardápio</button>
        <button data-product-view="list" class="${state.productView === 'list' ? 'active' : ''}">☰ Lista</button>
        <button data-product-view="inactive" class="${state.productView === 'inactive' ? 'active' : ''}">⛔ Inativos (${inactiveCount})</button>
        <button data-product-view="addons" class="${state.productView === 'addons' ? 'active' : ''}">🔥 Adicionais (${state.products.filter(p => p.is_addon).length})</button>
      </div>
    </div>
    ${state.productView === 'grid' ? `<p class="muted" style="margin:0 0 8px;font-size:13px">Igual ao que o cliente vê: só produtos ativos. Toque num produto para editar.${inactiveCount ? ` Os ${inactiveCount} inativos ficam em <button class="btn small" data-product-view="inactive">⛔ Inativos</button>.` : ''}</p>` : ''}
    ${state.products.length ? `
      <div class="search-bar">
        <input id="product-search" type="search" placeholder="🔎 Buscar produto no painel" autocomplete="off" value="${escapeHtml(state.productSearch)}" />
      </div>` : ''}
    <div id="product-list">${productListHtml()}</div>`;
}

/* ---------------- Sugestões (só recomenda; nada acontece sozinho) ---------------- */

async function loadSuggestions() {
  state.suggestions = { loading: true };
  renderTab();

  try {
    state.suggestions = await api('/api/admin/suggestions');
  } catch (err) {
    state.suggestions = { error: err.message };
  }

  if (state.tab === 'suggestions') renderTab();
}

function suggestionsHtml() {
  const d = state.suggestions;

  if (!d || d.loading) return '<p class="muted">Calculando sugestões…</p>';
  if (d.error) return `<p class="status-cancelled">${escapeHtml(d.error)}</p><button class="btn" id="suggestions-reload">Tentar de novo</button>`;

  const productLine = (p, extra) => `
    <li><span>${escapeHtml(p.name)} ${extra ? `<span class="muted">· ${extra}</span>` : ''}</span>
      <button class="btn small" data-edit="${escapeHtml(p.id)}">Abrir produto</button></li>`;
  const section = (title, help, body) => `
    <div class="card" style="margin-bottom:12px">
      <h3 style="margin:0 0 4px">${title}</h3>
      <p class="muted" style="margin:0 0 8px;font-size:13px">${help}</p>
      ${body}
    </div>`;
  const empty = text => `<p class="muted" style="margin:0">${text}</p>`;
  const c = d.cart_stats;
  const rate = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

  return `
    <div class="card" style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <span>💡 Aqui o sistema <strong>só sugere</strong>. Nenhum preço, cupom ou mensagem muda sem você confirmar.</span>
      <button class="btn small" id="suggestions-reload" style="margin-left:auto">Atualizar</button>
    </div>

    ${section('🎁 Cupom de compensação', 'Pedidos dos últimos 14 dias com atraso grande (mais de 20 min além do prazo) ou cancelados por culpa da loja. Você escolhe o valor; o cupom é aplicado sozinho no próximo pedido do cliente. Nenhuma mensagem é enviada.',
      d.coupon_candidates.length ? `<ul class="order-items">${d.coupon_candidates.map(o => `
        <li style="flex-wrap:wrap;gap:6px">
          <span><strong>#${o.number}</strong> · ${escapeHtml(o.customer_name || '')} · ${money(o.total_cents)}<br><span class="muted">${escapeHtml(o.why)} · ${dateTimeOf(o.created_at)}</span></span>
          <span style="display:flex;gap:6px;align-items:center">
            R$ <input id="coupon-${o.id}" inputmode="decimal" placeholder="5,00" style="width:70px" />
            <button class="btn small primary" data-coupon-create="${o.id}">Criar cupom</button>
            <button class="btn small" data-coupon-dismiss="${o.id}">Não precisa</button>
          </span>
        </li>`).join('')}</ul>` : empty('Nenhum pedido com problema. 👍'))}

    ${section('⭐ Avaliações dos clientes', d.reviews.count ? `Média <strong>${String(d.reviews.average).replace('.', ',')}</strong> de 5 em ${d.reviews.count} avaliação(ões).` : 'O cliente avalia na página do pedido depois de entregue.',
      d.reviews.list.length ? `<ul class="order-items">${d.reviews.list.map(r => `
        <li><span>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} · #${r.orders?.order_number || ''} ${escapeHtml(r.orders?.customer_name || '')}${r.comment ? `<br><span class="muted">“${escapeHtml(r.comment)}”</span>` : ''}</span>
        <span class="muted">${dateTimeOf(r.created_at)}</span></li>`).join('')}</ul>` : empty('Ainda sem avaliações.'))}

    ${section('🔎 Procuraram e não acharam', 'Buscas no cardápio nos últimos 30 dias que não encontraram nenhum produto. Pode ser produto para começar a vender (ou um nome que o cliente escreve diferente).',
      d.missing_searches.length ? `<ul class="order-items">${d.missing_searches.map(t => `<li><span>“${escapeHtml(t.term)}”</span><span class="muted">${t.count}×</span></li>`).join('')}</ul>` : empty('Nenhuma busca sem resultado ainda.'))}

    ${section('🛒 Carrinhos: começaram x viraram pedido', 'Aparelhos que colocaram algo no carrinho do cardápio comparado com pedidos feitos pelo site. Só estatística; ninguém recebe mensagem automática.',
      `<ul class="order-items">
        <li><span>Últimos 7 dias</span><span>${c.started_7d} começaram · ${c.ordered_7d} pedidos · <strong>${rate(c.ordered_7d, c.started_7d)}</strong></span></li>
        <li><span>Últimos 30 dias</span><span>${c.started_30d} começaram · ${c.ordered_30d} pedidos · <strong>${rate(c.ordered_30d, c.started_30d)}</strong></span></li>
        <li><span>Chegaram a digitar o WhatsApp (30 dias)</span><span>${c.with_phone_30d} · ${c.recovered_30d} viraram pedido</span></li>
      </ul>
      ${c.tracking_since ? `<p class="muted" style="font-size:12px;margin:6px 0 0">Contando desde ${dateTimeOf(c.tracking_since)}.</p>` : '<p class="muted" style="font-size:12px;margin:6px 0 0">A contagem começou agora; os números aparecem conforme os clientes usarem o cardápio.</p>'}`)}

    ${section('🧺 Muito adicionado, pouco comprado', 'Produtos que entraram em 5 ou mais carrinhos nos últimos 30 dias mas quase nunca viraram pedido. Vale conferir preço, foto ou descrição.',
      d.adds_no_buy.length ? `<ul class="order-items">${d.adds_no_buy.map(p => productLine(p, `${p.adds} carrinhos · ${p.orders} pedidos`)).join('')}</ul>` : empty('Nada para mostrar ainda.'))}

    ${storeFeatures().smart_suggestions === false ? '' : section('🧊 Costumam ir junto com gelo', 'Pelas vendas reais (pelo menos 2 pedidos com os dois juntos). Bom para deixar em destaque ou montar combo.',
      d.with_ice.length ? `<ul class="order-items">${d.with_ice.map(p => productLine(p)).join('')}</ul>` : empty('Ainda não há vendas suficientes com gelo.'))}

    ${d.enough_data ? `
      ${section('📉 Vendendo pouco — talvez uma promoção?', 'Produtos com 1 ou 2 unidades vendidas nos últimos 30 dias (fora os que já estão em promoção). Abra o produto para criar uma promoção com horário, se quiser.',
        d.low_sales.length ? `<ul class="order-items">${d.low_sales.map(p => productLine(p, `${p.sold_30d} vendido(s)`)).join('')}</ul>` : empty('Nenhum.'))}
      ${section('💤 Parados', 'Disponíveis há mais de 60 dias e sem nenhuma venda nesse período.',
        d.stagnant.length ? `<ul class="order-items">${d.stagnant.map(p => productLine(p, escapeHtml(p.category || ''))).join('')}</ul>` : empty('Nenhum.'))}`
    : section('📉 Vendendo pouco / 💤 Parados', `Essas sugestões só aparecem com pelo menos 30 pedidos no mês, para não sugerir promoção com base em chute. Pedidos nos últimos 30 dias: <strong>${d.orders_30d}</strong>.`, '')}`;
}

async function createCoupon(orderId, button) {
  const input = document.getElementById(`coupon-${orderId}`);
  const cents = inputToCents(input?.value);

  if (!cents) {
    input?.focus();
    return toast('Digite o valor do cupom.', true);
  }

  const order = state.suggestions.coupon_candidates.find(o => o.id === orderId);

  if (!confirm(`Criar cupom de ${money(cents)} para ${order?.customer_name || 'o cliente'}? Ele será descontado sozinho no próximo pedido.`)) return;

  button.disabled = true;

  try {
    await api('/api/admin/coupons', { method: 'POST', body: JSON.stringify({ order_id: orderId, amount_cents: cents, reason: order?.why }) });
    toast('Cupom criado ✓');
    loadSuggestions();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
}

async function dismissCoupon(orderId, button) {
  button.disabled = true;

  try {
    await api('/api/admin/coupons', { method: 'POST', body: JSON.stringify({ order_id: orderId, action: 'dismiss' }) });
    state.suggestions.coupon_candidates = state.suggestions.coupon_candidates.filter(o => o.id !== orderId);
    renderTab();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
}

function openProductForm(productId) {
  if (!isAdminUser()) {
    state.productView = 'list';
    renderTab();
    return toast('Só o administrador edita produtos. Use "Inativar por estoque" / "Reativar" na lista.', true);
  }

  state.editingProductId = productId;
  openModal(productFormHtml());
}

function closeProductForm() {
  state.editingProductId = null;
  closeModal();
}

// Recorte/zoom manual da foto principal do produto: um modal pequeno (empilhado por cima
// do formulário de cadastro, sem fechá-lo) onde dá pra arrastar a foto e ampliar até o
// enquadramento ficar do jeito que a pessoa quer, em vez de confiar só no recorte
// automático do resizeImage() abaixo. Reaproveita o mesmo visual de "sheet" do painel,
// mas com id/lógica própria — abrir com openModal() fecharia o formulário por trás.
function cropModalHtml() {
  return `
    <div class="sheet-head"><h2 style="margin:0">Ajustar foto</h2><button type="button" data-crop-close aria-label="Fechar">✕</button></div>
    <div class="crop-canvas-wrap"><canvas id="crop-canvas" width="640" height="640"></canvas></div>
    <div class="field"><label>Zoom</label><input type="range" id="crop-zoom" min="1" max="3" step="0.01" value="1" /></div>
    <p class="muted" style="font-size:12px;margin:-6px 0 10px;text-align:center">Arraste a foto para posicionar</p>
    <div class="row">
      <button type="button" class="btn" data-crop-close style="flex:1">Cancelar</button>
      <button type="button" class="btn primary" id="crop-confirm" style="flex:1">Usar essa foto</button>
    </div>`;
}

function closeCropModal() {
  document.getElementById('crop-modal')?.remove();
}

async function openCropModal(file, input) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    toast('Não foi possível abrir essa imagem.', true);
    input.value = '';
    return;
  }

  const SIZE = 640; // resolução do canvas de edição
  const OUTPUT_SIZE = 800; // resolução final salva (igual ao resizeImage())

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop popup';
  backdrop.id = 'crop-modal';
  backdrop.innerHTML = `<div class="sheet">${cropModalHtml()}</div>`;
  backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) cancel(); });
  app.appendChild(backdrop);

  const canvas = backdrop.querySelector('#crop-canvas');
  const ctx = canvas.getContext('2d');
  const zoomInput = backdrop.querySelector('#crop-zoom');

  // "cover": a foto sempre preenche o quadrado inteiro, sem sobra em volta.
  const baseScale = Math.max(SIZE / bitmap.width, SIZE / bitmap.height);
  let zoom = 1;
  let offsetX = 0;
  let offsetY = 0;

  function clampOffset() {
    const scale = baseScale * zoom;
    const maxX = Math.max(0, (bitmap.width * scale - SIZE) / 2);
    const maxY = Math.max(0, (bitmap.height * scale - SIZE) / 2);
    offsetX = Math.min(maxX, Math.max(-maxX, offsetX));
    offsetY = Math.min(maxY, Math.max(-maxY, offsetY));
  }

  function draw() {
    const scale = baseScale * zoom;
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.drawImage(bitmap, SIZE / 2 - w / 2 - offsetX, SIZE / 2 - h / 2 - offsetY, w, h);
  }

  draw();

  let dragging = false;
  let startX = 0, startY = 0, startOffX = 0, startOffY = 0;

  canvas.addEventListener('pointerdown', event => {
    dragging = true;
    canvas.setPointerCapture(event.pointerId);
    startX = event.clientX;
    startY = event.clientY;
    startOffX = offsetX;
    startOffY = offsetY;
  });
  canvas.addEventListener('pointermove', event => {
    if (!dragging) return;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    offsetX = startOffX - (event.clientX - startX) * ratio;
    offsetY = startOffY - (event.clientY - startY) * ratio;
    clampOffset();
    draw();
  });
  const stopDrag = event => { dragging = false; canvas.releasePointerCapture?.(event.pointerId); };
  canvas.addEventListener('pointerup', stopDrag);
  canvas.addEventListener('pointercancel', stopDrag);

  zoomInput.addEventListener('input', () => {
    zoom = Number(zoomInput.value);
    clampOffset();
    draw();
  });

  function cancel() {
    closeCropModal();
    input.value = '';
  }

  backdrop.querySelectorAll('[data-crop-close]').forEach(btn => btn.addEventListener('click', cancel));

  backdrop.querySelector('#crop-confirm').addEventListener('click', async () => {
    const out = document.createElement('canvas');
    out.width = OUTPUT_SIZE;
    out.height = OUTPUT_SIZE;
    const octx = out.getContext('2d');
    const outScale = OUTPUT_SIZE / SIZE;
    const scale = baseScale * zoom * outScale;
    const w = bitmap.width * scale;
    const h = bitmap.height * scale;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(bitmap, OUTPUT_SIZE / 2 - w / 2 - offsetX * outScale, OUTPUT_SIZE / 2 - h / 2 - offsetY * outScale, w, h);

    const blob = await new Promise(resolve => out.toBlob(resolve, 'image/webp', 0.9));
    closeCropModal();

    if (!blob) {
      toast('Não foi possível processar a foto.', true);
      input.value = '';
      return;
    }

    const croppedFile = new File([blob], 'produto.webp', { type: 'image/webp' });
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(croppedFile);
    input.files = dataTransfer.files;
    input.dataset.manualCrop = '1';

    const picker = input.closest('.product-photo-picker');
    picker.querySelector('.variant-photo').outerHTML = `<img class="variant-photo" src="${URL.createObjectURL(croppedFile)}" alt="" />`;
  });
}

// Padroniza a foto no navegador antes de enviar (igual às do cardápio): quadrada 800×800,
// fundo branco, sem a sobra branca das bordas e com o produto centralizado.
// Também economiza o armazenamento do Supabase.
async function resizeImage(file, size = 800) {
  try {
    const bitmap = await createImageBitmap(file);
    const src = document.createElement('canvas');
    src.width = bitmap.width;
    src.height = bitmap.height;
    const sctx = src.getContext('2d');
    sctx.fillStyle = '#fff';
    sctx.fillRect(0, 0, src.width, src.height);
    sctx.drawImage(bitmap, 0, 0);

    // Corta a sobra quase branca em volta do produto.
    const { data } = sctx.getImageData(0, 0, src.width, src.height);
    let top = src.height, left = src.width, right = -1, bottom = -1;
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const i = (y * src.width + x) * 4;
        if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
          if (x < left) left = x;
          if (x > right) right = x;
          if (y < top) top = y;
          if (y > bottom) bottom = y;
        }
      }
    }
    if (right < left || bottom < top) { left = 0; top = 0; right = src.width - 1; bottom = src.height - 1; }
    const cw = right - left + 1;
    const ch = bottom - top + 1;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    const scale = (size * 0.9) / Math.max(cw, ch);
    const w = Math.round(cw * scale);
    const h = Math.round(ch * scale);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, left, top, cw, ch, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);

    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.86));

    return blob && blob.type === 'image/webp' ? blob : file;
  } catch {
    return file;
  }
}

async function submitProductForm(form) {
  const variants = [];

  for (const row of form.querySelectorAll('.variant-row')) {
    const name = row.querySelector('[data-vname]').value.trim();
    const priceText = row.querySelector('[data-vprice]').value;
    const variantPrice = inputToCents(priceText);

    if (!name) {
      toast('Toda variação precisa de um nome.', true);
      return;
    }

    if (!priceText.trim() || variantPrice === null) {
      toast(`Preço inválido na variação "${name}".`, true);
      return;
    }

    const bulkQty = row.querySelector('[data-vbulkqty]')?.value.trim() || '';
    const bulkPrice = optionalCents(row.querySelector('[data-vbulkprice]')?.value || '');
    const cost = optionalCents(row.querySelector('[data-vcost]')?.value || '');

    if (bulkPrice === undefined || cost === undefined) return toast(`Valor inválido na variação "${name}".`, true);
    if (Boolean(bulkQty) !== (bulkPrice !== null)) return toast(`Na variação "${name}", informe a quantidade e o preço do engradado (ou deixe os dois vazios).`, true);

    variants.push({
      id: row.dataset.variantId || null,
      name,
      price_cents: variantPrice,
      available: row.querySelector('[data-vavailable]').checked,
      bulk_qty: bulkQty ? Number(bulkQty) : null,
      bulk_price_cents: bulkPrice,
      cost_cents: cost,
    });
  }

  const advancedVisible = !form.querySelector('#advanced-fields')?.hidden;
  const variantsPayload = advancedVisible ? variants : undefined;
  const components = advancedVisible && state.componentsReady ? readComponentRows(form) : undefined;

  if (typeof components === 'string') return toast(components, true);

  const price = variants.length ? null : inputToCents(form.price.value);

  if (!variants.length && (!form.price.value.trim() || price === null)) {
    toast('Informe o preço do produto.', true);
    return;
  }

  const bulkQty = form.bulk_qty?.value.trim() || '';
  const bulkPrice = optionalCents(form.bulk_price?.value || '');
  const cost = optionalCents(form.cost?.value || '');

  if (bulkPrice === undefined || cost === undefined) return toast('Valor inválido no engradado ou no custo.', true);
  if (!variants.length && Boolean(bulkQty) !== (bulkPrice !== null)) return toast('Informe a quantidade e o preço do engradado (ou deixe os dois vazios).', true);

  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  button.textContent = 'Salvando…';

  const fields = {
    name: form.name.value,
    category: form.category.value,
    description: form.description.value,
    available: form.status.value === 'active',
    ...(form.status.value === 'active' ? {} : { inactive_reason: form.status.value }),
    featured: form.featured.checked,
    suggest: form.suggest.checked,
    is_addon: Boolean(form.is_addon?.checked),
    removable_cheddar: Boolean(form.removable_cheddar?.checked),
    sold_by_weight: Boolean(form.sold_by_weight?.checked),
    kg_price_cents: optionalCents(form.kg_price?.value || '') ?? null,
    ...(variantsPayload !== undefined ? { variants: variantsPayload } : {}),
    ...(components !== undefined ? { components } : {}),
    chill_fee_cents: optionalCents(form.chill_fee?.value || '') ?? null,
    ...(variants.length ? { promo_price_cents: null, promo_weekdays: null } : {
      promo_price_cents: optionalCents(form.promo_price.value) ?? null,
      promo_starts_at: fromLocalInput(form.promo_starts.value),
      promo_ends_at: fromLocalInput(form.promo_ends.value),
      promo_weekdays: [...form.querySelectorAll('input[name="promo_weekday"]:checked')].map(el => Number(el.value)),
    }),
    ...(variants.length
      ? { bulk_qty: null, bulk_price_cents: null }
      : { price_cents: price, bulk_qty: bulkQty ? Number(bulkQty) : null, bulk_price_cents: bulkPrice, cost_cents: cost }),
  };

  try {
    const isNew = state.editingProductId === 'new';
    const { product } = isNew
      ? await api('/api/admin/products', { method: 'POST', body: JSON.stringify(fields) })
      : await api(`/api/admin/products/${state.editingProductId}`, { method: 'PATCH', body: JSON.stringify(fields) });

    const savedVariants = [...(product.variants || [])].sort((a, b) => a.sort_order - b.sort_order);
    const rows = [...form.querySelectorAll('#variants .variant-row')];

    for (const [index, row] of rows.entries()) {
      const variantFile = row.querySelector('[data-vphoto]')?.files[0];
      const variantId = savedVariants[index]?.id;

      if (variantFile && variantId) {
        const blob = await resizeImage(variantFile);
        await api(`/api/admin/products/${product.id}/photo?variant=${variantId}`, {
          method: 'POST',
          body: blob,
          headers: { 'Content-Type': blob.type },
        });
      }
    }

    const file = form.photo.files[0];

    if (file) {
      // Foto ajustada no modal de recorte (openCropModal) já está no enquadramento certo
      // (800×800 webp) — não passa pelo recorte automático de novo.
      const blob = form.photo.dataset.manualCrop === '1' ? file : await resizeImage(file);
      await api(`/api/admin/products/${product.id}/photo`, {
        method: 'POST',
        body: blob,
        headers: { 'Content-Type': blob.type },
      });
    }

    closeProductForm();
    await loadBootstrap();
    toast('Produto salvo!');
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
    button.textContent = 'Salvar';
  }
}

async function saveProduct(productId, fields) {
  try {
    await api(`/api/admin/products/${productId}`, { method: 'PATCH', body: JSON.stringify(fields) });
    await loadBootstrap();
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

async function deleteProduct(productId) {
  try {
    await api(`/api/admin/products/${productId}`, { method: 'DELETE' });
    closeProductForm();
    await loadBootstrap();
    toast('Produto excluído.');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- Grade estilo cardápio (Produtos e Novo pedido) ---------------- */

const FEATURED_TITLE = '⭐ Mais Vendidos';

// Seções na mesma ordem do cardápio: destaques primeiro, depois as categorias.
function gridSections(products, withFeatured = true) {
  const sections = [];
  const featured = products.filter(p => p.featured).sort((a, b) => a.featured_order - b.featured_order);

  if (withFeatured && featured.length) sections.push({ title: FEATURED_TITLE, products: featured });

  for (const category of new Set(products.map(p => p.category))) {
    sections.push({ title: category, products: products.filter(p => p.category === category) });
  }

  return sections;
}

function tilePriceHtml(p) {
  if (p.sold_by_weight && p.kg_price_cents) return `${money(p.kg_price_cents)}<small> /kg</small>`;
  if (!p.variants.length) return money(p.price_cents);

  const prices = p.variants.filter(v => v.available !== false).map(v => v.price_cents);
  const min = prices.length ? Math.min(...prices) : p.price_cents;

  return prices.length && min !== Math.max(...prices) ? `<small>a partir de</small> ${money(min)}` : money(min);
}

// mode "edit": toque abre a edição. mode "pos": toque adiciona ao novo pedido.
function tileHtml(p, mode) {
  const inOrder = mode === 'pos' ? state.newOrder.items.filter(i => i.product_id === p.id).reduce((s, i) => s + i.qty, 0) : 0;

  const options = p.variants.length ? `<span class="tile-options">${p.variants.length} opções</span>` : '';
  // Na grade de Produtos, o botão de inativar fica ao lado do preço (por isso o preço vai por último).
  const offButton = mode === 'edit' && p.available;

  const tile = `
    <button type="button" class="tile ${p.available ? '' : 'off'}" data-tile="${p.id}" data-mode="${mode}">
      ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" loading="lazy" />` : '<div class="no-photo">🛒</div>'}
      <span class="tile-name">${escapeHtml(p.name)}</span>
      ${offButton ? options : ''}
      <span class="tile-price">${tilePriceHtml(p)}</span>
      ${inOrder ? `<span class="tile-qty">${inOrder}</span>` : ''}
      ${p.available ? '' : `<span class="tile-flag">${p.inactive_reason === 'preco' ? 'Conferir preço' : 'Sem estoque'}</span>`}
      ${mode === 'edit' && p.featured ? '<span class="tile-star">⭐</span>' : ''}
      ${offButton ? '' : options}
    </button>`;

  if (!offButton) return tile;

  return `
    <div class="tile-wrap">
      ${tile}
      <button type="button" class="tile-off" data-inactivate="${p.id}" data-reason="estoque" data-confirm="1" title="Inativar (sem estoque)" aria-label="Inativar ${escapeHtml(p.name)}">⛔</button>
    </div>`;
}

function menuGridHtml(products, mode, withFeatured = true) {
  const sections = gridSections(products, withFeatured);

  if (!sections.length) return '<p class="empty">Nenhum produto encontrado.</p>';

  const prefix = `grid-${mode}`;

  return `
    ${sections.length > 1 ? `<nav class="categories grid-nav">${sections.map((s, i) => `<button type="button" data-grid-cat="${prefix}-${i}">${escapeHtml(s.title)}</button>`).join('')}</nav>` : ''}
    ${sections.map((s, i) => `
      <section id="${prefix}-${i}" class="grid-section">
        <h2 class="section-title">${escapeHtml(s.title)} <span class="muted">(${s.products.length})</span></h2>
        <div class="tiles">${s.products.map(p => tileHtml(p, mode)).join('')}</div>
      </section>`).join('')}`;
}

function searchAdminProducts(query, products = state.products) {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);

  if (!terms.length) return products;

  return products.filter(p => {
    const text = normalizeText([p.name, p.description, p.category, ...p.variants.map(v => v.name)].join(' '));
    return terms.every(term => text.includes(term));
  });
}

// Janela por cima da tela (fica dentro de #app, para os eventos do painel funcionarem).
function openModal(html, attrs = {}) {
  closeModal();

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.id = 'modal';
  Object.entries(attrs).forEach(([k, v]) => backdrop.setAttribute(k, v));
  backdrop.innerHTML = `<div class="sheet">${html}</div>`;
  backdrop.addEventListener('mousedown', event => {
    if (event.target === backdrop) closeModal();
  });

  app.appendChild(backdrop);
  document.body.style.overflow = 'hidden';
  return backdrop;
}

function closeModal() {
  document.getElementById('modal')?.remove();
  document.body.style.overflow = '';
}

/* ---------------- Novo pedido (painel) ---------------- */

function newOrderFormHtml() {
  const radio = (name, value, label, checked) =>
    `<label><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} /> ${label}</label>`;

  return `
    <form class="card" id="new-order-form" autocomplete="off">
      <div class="sheet-head"><h2 style="margin:0">➕ Novo pedido</h2><button type="button" id="cancel-new-order" aria-label="Fechar">✕</button></div>
      <div class="field"><label>Origem</label>
        <div class="choices">
          ${radio('source', 'balcao', '🏪 Balcão', true)}
          ${radio('source', 'whatsapp', '💬 WhatsApp', false)}
          ${radio('source', 'telefone', '📞 Telefone', false)}
        </div>
      </div>
      <div class="grid-2">
        <div class="field"><label>WhatsApp <span id="no-phone-hint">(opcional no balcão; com ele o pedido vai pro perfil do cliente)</span></label><input name="customer_phone" inputmode="tel" maxlength="20" placeholder="(24) 99999-9999 — acha o cadastro" /></div>
        <div class="field"><label>Nome do cliente <span id="no-name-hint">(opcional no balcão)</span></label><input name="customer_name" maxlength="80" /></div>
      </div>
      <div id="no-customer-info"></div>
      <div class="field" style="margin-bottom:4px"><label>Itens do pedido</label></div>
      <div id="no-items">${newOrderItemsHtml()}</div>
      <div class="field"><label>Entrega</label>
        <div class="choices">
          ${radio('delivery_type', 'pickup', 'Retirada / balcão', true)}
          ${radio('delivery_type', 'delivery', 'Entrega', false)}
        </div>
      </div>
      ${activeZones().length ? `
        <div class="field" id="no-zone" hidden><label>Bairro</label>
          <select name="delivery_zone_id">
            <option value="">Escolha o bairro…</option>
            ${activeZones().map(z => `<option value="${z.id}">${escapeHtml(z.name)} — ${z.fee_cents ? money(z.fee_cents) : 'grátis'}</option>`).join('')}
          </select>
        </div>` : ''}
      <div class="field" id="no-address" hidden><label>Endereço de entrega</label><textarea name="address" rows="2" maxlength="300"></textarea></div>
      <div class="field"><label>Pagamento</label>
        <div class="choices">
          ${STAFF_PAYMENT_CHOICES.map((m, i) => radio('payment_method', m, m === 'fiado' ? '📒 Fiado' : PAYMENT_LABELS[m], i === 0)).join('')}
        </div>
      </div>
      <div class="field" id="no-change"><label>Troco para (opcional)</label><input name="change_for" inputmode="decimal" placeholder="Ex.: 100" /></div>
      <div class="field"><label>Desconto em R$ (opcional)</label><input name="discount" inputmode="decimal" placeholder="0,00" /></div>
      <div class="field"><label>Observação (opcional)</label><input name="notes" maxlength="500" /></div>
      <label class="check"><input type="checkbox" name="paid" /> 💵 Já está pago (entra no caixa agora; no 📒 Fiado, vai para a conta do cliente)</label>
      <label class="check"><input type="checkbox" name="delivered" /> ✅ Entregue na hora</label>
      <div id="no-total">${newOrderTotalHtml('pickup')}</div>
      <button class="btn primary block" type="submit">Lançar pedido</button>
    </form>`;
}

// Mesma regra do servidor: cada engradado completo sai pelo preço do engradado (se compensar).
function linePrice(qty, unit, bulkQty, bulkPrice) {
  if (bulkQty > 1 && bulkPrice != null && bulkPrice < bulkQty * unit && qty >= bulkQty) {
    const packs = Math.floor(qty / bulkQty);
    return { total: packs * bulkPrice + (qty % bulkQty) * unit, packs };
  }

  return { total: qty * unit, packs: 0 };
}

function chillPacksOf(i) {
  if (!i.chill_fee_cents) return 0;
  return i.bulk_qty > 1 ? Math.floor(i.qty / i.bulk_qty) : i.qty;
}

const itemTotal = i => {
  // Por kg com valor da balança: vale o valor pesado.
  if (i.by_weight && i.weighed) return { total: i.weighed, packs: 0 };
  const line = linePrice(i.qty, i.price, i.bulk_qty, i.bulk_price_cents);
  const chill = i.chilled ? chillPacksOf(i) * i.chill_fee_cents : 0;
  return { ...line, total: line.total + chill };
};

function newOrderSubtotal() {
  return state.newOrder.items.reduce((sum, i) => sum + itemTotal(i).total, 0);
}

function activeZones() {
  return (state.zones || []).filter(z => z.active);
}

function newOrderTotalHtml(deliveryType, zoneId, discount = 0) {
  const subtotal = newOrderSubtotal();
  let fee = 0;

  if (deliveryType === 'delivery') {
    fee = activeZones().length ? (activeZones().find(z => z.id === zoneId)?.fee_cents || 0) : state.store.delivery_fee_cents;
  }

  // Cliente VIP (achado pelo telefone): o servidor também zera a taxa.
  if (state.newOrder?.vip) fee = 0;

  return `
    <div class="totals">
      ${fee || discount ? `<div><span>Subtotal</span><span>${money(subtotal)}</span></div>` : ''}
      ${fee ? `<div><span>Taxa de entrega</span><span>${money(fee)}</span></div>` : ''}
      ${discount ? `<div><span>Desconto</span><span>− ${money(discount)}</span></div>` : ''}
      <div class="grand"><span>Total</span><span>${money(Math.max(0, subtotal + fee - discount))}</span></div>
    </div>`;
}

function newOrderItemsHtml() {
  const items = state.newOrder.items;

  if (!items.length) return '<p class="muted" style="margin:0 0 12px">Nenhum produto adicionado ainda.</p>';

  return items.map(i => `
    <div class="cart-line">
      <span class="name">${escapeHtml(i.name)}<br><span class="muted">${money(i.price)} · subtotal ${money(itemTotal(i).total)}${itemTotal(i).packs ? ` · 🍻 ${itemTotal(i).packs} engradado(s)` : ''}</span>${i.by_weight ? `<br><button type="button" class="btn small" data-no-weigh="${i.key}" style="margin-top:4px">⚖️ ${i.weighed ? `Pesado: ${money(i.weighed)} (mudar)` : 'Valor da balança'}</button>` : ''}${chillPacksOf(i) ? `<br><button type="button" class="btn small" data-no-chill="${i.key}" style="margin-top:4px">${i.chilled ? '✅' : '⬜'} 🧊 Gelado (+ ${money(i.chill_fee_cents)}${chillPacksOf(i) > 1 ? ` × ${chillPacksOf(i)}` : ''})</button>` : ''}</span>
      <span class="qty">
        <button type="button" data-no-dec="${i.key}">−</button><span>${i.qty}</span><button type="button" data-no-inc="${i.key}">+</button>
      </span>
    </div>`).join('') + '<div style="height:12px"></div>';
}

// Tela de caixa: cardápio em grade à esquerda (toque = adiciona) e o pedido à direita.
function posHtml() {
  return `
    <div class="pos">
      <div class="pos-menu">
        <div class="search-bar"><input id="pos-search" type="search" placeholder="🔎 Filtrar produtos (Enter adiciona o primeiro)" autocomplete="off" value="${escapeHtml(state.newOrder.search)}" /></div>
        <div id="pos-grid">${posGridHtml()}</div>
      </div>
      <div class="pos-side">${newOrderFormHtml()}</div>
    </div>
    <div class="pos-bar" id="pos-bar">${posBarHtml()}</div>`;
}

// Sem busca: só o que está disponível no cardápio. Com busca: tudo (dá pra vender esgotado no balcão).
function posGridHtml() {
  const query = state.newOrder.search.trim();
  const products = query ? searchAdminProducts(query) : state.products.filter(p => p.available);

  return menuGridHtml(products, 'pos', !query);
}

function posBarHtml() {
  const count = state.newOrder.items.reduce((s, i) => s + i.qty, 0);
  return `<button class="btn primary" id="pos-go-cart"><span>🧾 Ver pedido (${count})</span><span>${money(newOrderSubtotal())}</span></button>`;
}

function variantPickerHtml(product) {
  return `
    <div class="sheet-head"><h2 style="margin:0">${escapeHtml(product.name)}</h2><button type="button" data-close-modal aria-label="Fechar">✕</button></div>
    ${product.image_url ? `<img class="variant-photo" src="${escapeHtml(product.image_url)}" alt="" />` : ''}
    ${product.variants.map(v => {
      const key = `${product.id}:${v.id}`;
      const qty = state.newOrder.items.find(i => i.key === key)?.qty || 0;

      return `
        <div class="cart-line">
          <span class="name">${escapeHtml(v.name)}${v.available ? '' : ' <span class="badge off">esgotado no site</span>'}<br><span class="price">${money(v.price_cents)}</span></span>
          ${qty
            ? `<span class="qty"><button type="button" data-no-dec="${key}">−</button><span>${qty}</span><button type="button" data-no-inc="${key}">+</button></span>`
            : `<button type="button" class="btn small primary" data-no-add="${product.id}" data-variant="${v.id}">Adicionar</button>`}
        </div>`;
    }).join('')}
    <button type="button" class="btn primary block" data-close-modal style="margin-top:16px">Pronto</button>`;
}

function posTileClick(productId) {
  const product = state.products.find(p => p.id === productId);

  if (!product) return;

  if (product.variants.length) {
    openModal(variantPickerHtml(product), { 'data-picker': productId });
  } else {
    addNewOrderItem(productId, null);
  }
}

// Redesenha o que depende dos itens: lista, total, selos de quantidade na grade, barra do celular e o seletor de variações.
function refreshNewOrder() {
  const form = document.getElementById('new-order-form');

  if (!form) return;

  document.getElementById('no-items').innerHTML = newOrderItemsHtml();
  document.getElementById('no-total').innerHTML = newOrderTotalHtml(form.delivery_type.value, form.delivery_zone_id?.value, inputToCents(form.discount.value) || 0);
  document.getElementById('pos-bar').innerHTML = posBarHtml();

  for (const tile of document.querySelectorAll('#pos-grid [data-tile]')) {
    const product = state.products.find(p => p.id === tile.dataset.tile);
    if (product) tile.outerHTML = tileHtml(product, 'pos');
  }

  const picker = document.querySelector('#modal[data-picker]');

  if (picker) {
    const product = state.products.find(p => p.id === picker.dataset.picker);
    picker.querySelector('.sheet').innerHTML = variantPickerHtml(product);
  }
}

function closeNewOrder() {
  state.newOrder = null;
  closeModal();
  renderTab();
}

function addNewOrderItem(productId, variantId) {
  const product = state.products.find(p => p.id === productId);
  const variant = variantId ? product.variants.find(v => v.id === variantId) : null;
  const key = `${productId}:${variantId || ''}`;
  const existing = state.newOrder.items.find(i => i.key === key);

  if (existing) {
    existing.qty = Math.min(existing.qty + 1, 99);
    existing.weighed = null;
  } else {
    state.newOrder.items.push({
      key,
      product_id: productId,
      variant_id: variant?.id || null,
      name: variant ? `${product.name} - ${variant.name}` : product.name,
      price: variant ? variant.price_cents : promoPriceNow(product) ?? product.price_cents,
      bulk_qty: (variant || product).bulk_qty,
      bulk_price_cents: (variant || product).bulk_price_cents,
      chill_fee_cents: product.chill_fee_cents,
      chilled: false,
      by_weight: Boolean(product.sold_by_weight),
      weighed: null,
      qty: 1,
    });
  }

  refreshNewOrder();
}

function changeNewOrderQty(key, delta) {
  const item = state.newOrder.items.find(i => i.key === key);

  if (!item) return;

  item.qty = Math.min(item.qty + delta, 99);
  item.weighed = null; // mudou a quantidade: pesa de novo
  state.newOrder.items = state.newOrder.items.filter(i => i.qty > 0);
  refreshNewOrder();
}

// Ao trocar a origem, ajusta os padrões: balcão = retirada. "Já está pago" e "Entregue na hora"
// começam sempre desmarcados (quem vende marca quando for o caso).
function syncNewOrderForm(changed) {
  const form = document.getElementById('new-order-form');
  const balcao = form.source.value === 'balcao';

  if (changed === 'source') {
    form.delivery_type.value = balcao ? 'pickup' : 'delivery';
  }

  document.getElementById('no-name-hint').hidden = !balcao;
  document.getElementById('no-phone-hint').textContent = balcao
    ? '(opcional no balcão; com ele o pedido vai pro perfil do cliente)'
    : '(obrigatório)';
  document.getElementById('no-address').hidden = form.delivery_type.value !== 'delivery';
  const zoneField = document.getElementById('no-zone');
  if (zoneField) zoneField.hidden = form.delivery_type.value !== 'delivery';
  document.getElementById('no-change').hidden = form.payment_method.value !== 'dinheiro';
  refreshNewOrder();
}

async function submitNewOrder(form) {
  if (!state.newOrder.items.length) return toast('Adicione pelo menos um produto.', true);

  const changeText = form.change_for.value.trim();
  const change = changeText ? inputToCents(changeText) : null;

  if (changeText && change === null) return toast('Valor do troco inválido.', true);

  const discount = inputToCents(form.discount.value);

  if (discount === null) return toast('Valor do desconto inválido.', true);

  const button = form.querySelector('[type=submit]');
  button.disabled = true;
  button.textContent = 'Lançando…';

  try {
    const result = await api('/api/admin/orders', {
      method: 'POST',
      body: JSON.stringify({
        source: form.source.value,
        customer_name: form.customer_name.value,
        customer_phone: form.customer_phone.value,
        delivery_type: form.delivery_type.value,
        address: form.address.value,
        delivery_zone_id: form.delivery_zone_id?.value || null,
        payment_method: form.payment_method.value,
        change_for_cents: form.payment_method.value === 'dinheiro' ? change : null,
        discount_cents: discount,
        notes: form.notes.value,
        paid: form.paid.checked,
        delivered: form.delivered.checked,
        items: state.newOrder.items.map(i => ({ product_id: i.product_id, variant_id: i.variant_id, quantity: i.qty, chilled: Boolean(i.chilled && chillPacksOf(i)), ...(i.by_weight && i.weighed ? { weighed_cents: i.weighed } : {}) })),
      }),
    });

    toast(`Pedido #${result.order_number} lançado — ${money(result.total_cents)}`);
    state.knownOrderIds?.add(result.id); // não bipar pelo próprio pedido
    closeNewOrder();
    await refreshAfterOrderChange();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
    button.textContent = 'Lançar pedido';
  }
}

/* ---------------- Pagamento ---------------- */

const SOURCE_LABELS = { site: '🌐 Site', balcao: '🏪 Balcão', whatsapp: '💬 WhatsApp', telefone: '📞 Telefone' };

function paymentBadge(order) {
  if (order.status === 'cancelled') return '<span class="badge">—</span>';

  return order.payment_status === 'paid'
    ? '<span class="badge paid">✅ Pago</span>'
    : '<span class="badge off">⏳ Pendente</span>';
}

const PAYMENT_ICONS = { dinheiro: '💵', pix: '📲', debito: '💳', credito: '💳', cartao: '💳', fiado: '📒' };

// Quanto do pedido é no fiado (inteiro ou a parte do dividido).
function fiadoPart(order) {
  if (Array.isArray(order.payment_split)) return order.payment_split.filter(p => p.method === 'fiado').reduce((s, p) => s + p.cents, 0);
  return order.payment_method === 'fiado' ? order.total_cents : 0;
}

// Item vendido por kg: estimado x pesado e o botão da balança (só antes de pagar).
function weightNoteHtml(order, i) {
  if (!i.by_weight) return '';
  const open = order.payment_status !== 'paid' && !['delivered', 'cancelled'].includes(order.status) && !order.pdv_closing_id;
  const info = i.weighed_at
    ? `<br><span class="muted" style="font-size:12px">⚖️ pesado${i.estimated_cents != null && i.estimated_cents !== i.subtotal_cents ? ` (estimado ${money(i.estimated_cents)})` : ''}${i.weighed_by ? ` · ${escapeHtml(i.weighed_by)}` : ''}</span>`
    : '<br><span class="muted" style="font-size:12px">⚖️ por kg · valor estimado</span>';
  return info + (open && i.id ? ` <button type="button" class="btn small" data-weigh-item="${i.id}" data-order="${order.id}">⚖️ ${i.weighed_at ? 'Pesar de novo' : 'Valor da balança'}</button>` : '');
}

async function weighOrderItem(orderId, itemId) {
  const order = findOrder(orderId);
  const item = order?.order_items.find(i => i.id === itemId);
  if (!item) return;
  const text = prompt(`${item.quantity}× ${item.product_name}\nEstimado: ${money(item.estimated_cents ?? item.subtotal_cents)}\n\nValor da balança (R$):`, centsToInput(item.subtotal_cents));
  if (text === null) return;
  const cents = inputToCents(text);
  if (!cents || cents <= 0) return toast('Valor inválido.', true);
  try {
    await api(`/api/admin/orders/${orderId}/items/${itemId}/weigh`, { method: 'POST', body: JSON.stringify({ subtotal_cents: cents }) });
    toast(`Valor pesado salvo: ${money(cents)}.`);
    await refreshAfterOrderChange();
  } catch (err) {
    toast(err.message, true);
  }
}

// "Pix" ou, se dividido, "Pix R$ 20,00 + Dinheiro R$ 21,99".
function paymentText(order) {
  if (Array.isArray(order.payment_split)) {
    return order.payment_split.map(p => `${PAYMENT_LABELS[p.method] || p.method} ${money(p.cents)}`).join(' + ');
  }

  return PAYMENT_LABELS[order.payment_method] || '';
}

// Quanto do pedido é pago em dinheiro (o troco é calculado sobre isso).
function cashDue(order) {
  if (Array.isArray(order.payment_split)) {
    return order.payment_split.filter(p => p.method === 'dinheiro').reduce((s, p) => s + p.cents, 0);
  }

  return order.payment_method === 'fiado' ? 0 : order.total_cents;
}

function findOrder(orderId) {
  return state.orders.find(o => o.id === orderId)
    || state.history.data?.orders.find(o => o.id === orderId)
    || state.cash?.open?.summary?.pending_orders.find(o => o.id === orderId)
    || null;
}

// Janela "como o cliente pagou?" (a forma escolhida no pedido vem destacada).
function openPaymentPicker(orderId, { deliver = false } = {}) {
  const order = findOrder(orderId) || { id: orderId };

  const modal = openModal(`
    <div class="sheet-head"><h2 style="margin:0">${deliver ? '✅ Entregar pedido' : '💵 Marcar como pago'}</h2><button type="button" data-close-modal aria-label="Fechar">✕</button></div>
    <p style="margin:4px 0 14px">
      Pedido <strong>#${escapeHtml(order.order_number ?? '')}</strong>${order.customer_name ? ` · ${escapeHtml(order.customer_name)}` : ''}<br>
      <span class="price" style="font-size:22px">${money(order.total_cents)}</span>
      ${order.change_for_cents ? `<br><span class="muted">Troco para ${money(order.change_for_cents)} (levar ${money(order.change_for_cents - cashDue(order))})</span>` : ''}
    </p>
    <strong>Como o cliente pagou?</strong>
    <div class="pay-options">
      ${STAFF_PAYMENT_CHOICES.map(method => [method, PAYMENT_LABELS[method]]).map(([method, label]) => `
        <button type="button" class="btn pay-option ${order.payment_method === method ? 'primary' : ''}" data-pay-method="${method}" data-order="${orderId}" data-deliver="${deliver ? '1' : ''}">
          <span style="font-size:26px">${PAYMENT_ICONS[method]}</span>${label}
          ${order.payment_method === method ? '<small>escolhido no pedido</small>' : ''}
        </button>`).join('')}
    </div>
    ${splitPayHtml(order)}
    ${deliver ? `<button type="button" class="btn block" data-pay-method="" data-order="${orderId}" data-deliver="1" style="margin-top:10px">Ainda não pagou (só marcar como entregue)</button>` : ''}`);

  const form = modal.querySelector('#split-pay-form');
  const updateRest = () => {
    const first = inputToCents(form.first_value.value);
    const rest = order.total_cents - (first || 0);

    form.querySelector('#split-pay-rest').textContent = first > 0 && rest > 0
      ? `Restante: ${money(rest)} no ${PAYMENT_LABELS[form.second.value]}`
      : `Total do pedido: ${money(order.total_cents)}`;
  };

  form.addEventListener('input', updateRest);
  form.addEventListener('change', updateRest);
  updateRest();

  form.addEventListener('submit', event => {
    event.preventDefault();

    const firstCents = inputToCents(form.first_value.value);

    if (form.first.value === form.second.value) return toast('Escolha duas formas diferentes.', true);
    if (!firstCents || firstCents >= order.total_cents) return toast(`Informe um valor maior que zero e menor que ${money(order.total_cents)}.`, true);

    choosePayment(orderId, form.first.value, deliver, { first_method: form.first.value, first_cents: firstCents, second_method: form.second.value });
  });
}

// Parte "dividido em duas formas" da janela de pagamento (já vem preenchida se o cliente dividiu no pedido).
function splitPayHtml(order) {
  const split = Array.isArray(order.payment_split) ? order.payment_split : null;
  const first = split?.[0].method || 'pix';
  const second = split?.[1].method || 'dinheiro';
  const select = (name, selected) => `<select name="${name}" class="btn small">${STAFF_PAYMENT_CHOICES.map(m => [m, PAYMENT_LABELS[m]]).map(([m, label]) => `<option value="${m}" ${m === selected ? 'selected' : ''}>${PAYMENT_ICONS[m]} ${label}</option>`).join('')}</select>`;

  return `
    <details style="margin-top:12px" ${split ? 'open' : ''}>
      <summary><strong>➗ Pagou dividido em duas formas</strong>${split ? ' <small class="muted">(escolhido no pedido)</small>' : ''}</summary>
      <form id="split-pay-form" style="margin-top:10px">
        <div class="row" style="align-items:center">${select('first', first)}<input name="first_value" inputmode="decimal" placeholder="Valor (R$)" value="${split ? centsToInput(split[0].cents) : ''}" style="flex:1;min-width:110px" /></div>
        <div class="row" style="align-items:center;margin-top:8px"><span>Restante em</span>${select('second', second)}</div>
        <p class="muted" id="split-pay-rest" style="font-size:14px"></p>
        <button type="submit" class="btn primary block">Confirmar pagamento dividido</button>
      </form>
    </details>`;
}

async function choosePayment(orderId, method, deliver, split = null) {
  // WhatsApp da entrega precisa abrir ainda dentro do clique.
  if (deliver) notifyOnStatusChange(orderId, 'delivered');

  closeModal();

  const body = deliver ? { status: 'delivered' } : {};

  if (split) Object.assign(body, { payment_status: 'paid', payment_split: split });
  else if (method) Object.assign(body, { payment_status: 'paid', payment_method: method });
  else body.payment_status = 'pending';

  try {
    await api(`/api/admin/orders/${orderId}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast(split
      ? `${deliver ? 'Entregue e pago' : 'Pago'} dividido: ${PAYMENT_LABELS[split.first_method]} + ${PAYMENT_LABELS[split.second_method]}.`
      : method ? `${deliver ? 'Entregue e pago' : 'Pago'} no ${PAYMENT_LABELS[method]}.` : 'Entregue (pagamento pendente).');
    await refreshAfterOrderChange();
  } catch (err) {
    toast(err.message, true);
  }
}

async function reopenOrder(orderId) {
  const order = findOrder(orderId);
  if (!order) return;

  const reason = prompt(`Reabrir o pedido #${order.order_number}?\nEle volta para "Em preparação" e o pagamento já registrado é preservado (não é estornado).\n\nMotivo da reabertura:`);
  if (reason === null) return;
  if (reason.trim().length < 3) return toast('Escreva o motivo da reabertura.', true);

  try {
    await api(`/api/admin/orders/${orderId}/reopen`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
    toast(`Pedido #${order.order_number} reaberto.`);
    await refreshAfterOrderChange();
  } catch (err) {
    toast(err.message, true);
  }
}

async function updateOrderPayment(orderId, paymentStatus) {
  try {
    await api(`/api/admin/orders/${orderId}`, { method: 'PATCH', body: JSON.stringify({ payment_status: paymentStatus }) });
    toast(paymentStatus === 'paid' ? 'Pedido marcado como pago.' : 'Pagamento desmarcado.');
    await refreshAfterOrderChange();
  } catch (err) {
    toast(err.message, true);
  }
}

// Mantém pedidos, histórico e caixa em dia depois de mexer num pedido.
async function refreshAfterOrderChange() {
  await loadOrders();
  if (state.tab === 'history') await loadHistory();
  if (state.tab === 'cash') await loadCash();
}

/* ---------------- Histórico de pedidos ---------------- */

function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00-03:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function setHistoryRange(range) {
  const today = todaySaoPaulo();
  const h = state.history;

  if (range === 'today') { h.from = today; h.to = today; }
  if (range === 'yesterday') { h.from = shiftDate(today, -1); h.to = h.from; }
  if (range === '7') { h.from = shiftDate(today, -6); h.to = today; }
  if (range === '30') { h.from = shiftDate(today, -29); h.to = today; }
  if (range === 'month') { h.from = `${today.slice(0, 8)}01`; h.to = today; }

  loadHistory();
}

function readHistoryFilters() {
  const h = state.history;
  h.from = document.getElementById('history-from').value || todaySaoPaulo();
  h.to = document.getElementById('history-to').value || h.from;
  h.status = document.getElementById('history-status').value;
  h.payment = document.getElementById('history-payment').value;

  if (h.from > h.to) [h.from, h.to] = [h.to, h.from];
}

async function loadHistory() {
  const h = state.history;
  const params = new URLSearchParams({ from: h.from, to: h.to });

  if (h.status) params.set('status', h.status);
  if (h.payment) params.set('payment', h.payment);

  try {
    h.data = await api(`/api/admin/order-history?${params}`);
    if (state.tab === 'history') renderTab();
  } catch (err) {
    toast(err.message, true);
  }
}

function dateTimeOf(iso) {
  return iso ? `${dateOf(iso)} ${timeOf(iso)}` : '—';
}

// Por que os pedidos do período foram cancelados (do motivo mais comum para o menos).
function cancelReasonsHtml(orders) {
  const cancelled = orders.filter(o => o.status === 'cancelled');

  if (!cancelled.length) return '';

  const counts = {};
  for (const o of cancelled) {
    const reason = o.cancel_reason || 'Sem motivo informado (antes desta função)';
    counts[reason] = (counts[reason] || 0) + 1;
  }

  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  return `
    <div class="card">
      <strong>✖ Por que os pedidos foram cancelados</strong>
      <ul class="order-items">${rows.map(([reason, n]) => `<li><span>${escapeHtml(reason)}</span><span><strong>${n}</strong> <span class="muted">(${Math.round((n / cancelled.length) * 100)}%)</span></span></li>`).join('')}</ul>
    </div>`;
}

function historyListHtml() {
  const terms = normalizeText(state.history.search).split(/\s+/).filter(Boolean);
  const orders = state.history.data.orders.filter(o => {
    const text = normalizeText(`${o.order_number} ${o.public_code || ""} ${o.customer_name} ${o.customer_phone}`);
    return terms.every(term => text.includes(term));
  });

  if (!orders.length) return '<p class="empty">Nenhum pedido encontrado.</p>';

  return `
    <div class="table-wrap">
      <table class="history">
        <thead><tr>
          <th>#</th><th>Criado</th><th>Fechado</th><th>Cliente</th><th>Origem</th><th>Status</th><th>Pagamento</th><th class="num">Total</th><th></th>
        </tr></thead>
        <tbody>
          ${orders.map(o => `
            <tr class="${o.status === 'cancelled' ? 'cancelled' : ''}">
              <td><strong>${escapeHtml(o.order_number)}</strong></td>
              <td>${dateTimeOf(o.created_at)}</td>
              <td>${dateTimeOf(o.closed_at)}</td>
              <td>${o.customer_id ? `<button class="link" data-customer="${o.customer_id}">${escapeHtml(o.customer_name)}</button>` : escapeHtml(o.customer_name)}</td>
              <td>${SOURCE_LABELS[o.source] || escapeHtml(o.source)}<br><span class="muted">${o.delivery_type === 'pickup' ? 'Retirada' : 'Entrega'}</span></td>
              <td class="status-${o.status}">${STATUS_LABELS[o.status]}${o.cancel_reason ? `<br><span class="muted">${escapeHtml(o.cancel_reason)}</span>` : ''}</td>
              <td>${paymentText(o)}<br>${paymentBadge(o)}</td>
              <td class="num"><strong>${money(o.total_cents)}</strong></td>
              <td>${o.status !== 'cancelled' ? `<button class="btn small" data-pay="${o.id}" data-paid="${o.payment_status === 'paid' ? 'pending' : 'paid'}" title="${o.payment_status === 'paid' ? 'Desmarcar pago' : 'Marcar como pago'}">${o.payment_status === 'paid' ? '↩' : '💵'}</button>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function historyTabHtml() {
  const h = state.history;
  if (!isAdminUser()) {
    if (!h.data) { loadHistory(); return '<p class="empty">Carregando pagamentos do seu caixa…</p>'; }
    return `<p class="muted">Pagamentos do seu caixa aberto. Fechamentos anteriores ficam na aba Caixa.</p><input id="history-search" class="btn" placeholder="Buscar pedido ou cliente" value="${escapeHtml(h.search)}" /><div id="history-list">${historyListHtml()}</div>`;
  }
  const options = (list, current) => list.map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('');

  const filters = `
    <div class="card">
      <div class="row" style="margin-bottom:10px">
        ${[['today', 'Hoje'], ['yesterday', 'Ontem'], ['7', '7 dias'], ['30', '30 dias'], ['month', 'Este mês']].map(([k, l]) => `<button class="btn small" data-range="${k}">${l}</button>`).join('')}
      </div>
      <div class="filters">
        <label>De <input type="date" id="history-from" value="${h.from}" class="btn small" /></label>
        <label>Até <input type="date" id="history-to" value="${h.to}" class="btn small" /></label>
        <select id="history-status" class="btn small">${options([['', 'Todos os status'], ['open', 'Em andamento'], ...Object.entries(STATUS_LABELS)], h.status)}</select>
        <select id="history-payment" class="btn small">${options([['', 'Todos os pagamentos'], ['paid', '✅ Pagos'], ['pending', '⏳ Pendentes']], h.payment)}</select>
        <button class="btn primary small" id="history-apply">Filtrar</button>
      </div>
    </div>`;

  if (!h.data) return `${filters}<p class="empty">Carregando…</p>`;

  const s = h.data.summary;

  return `
    ${filters}
    <div class="stats">
      <div class="card"><span class="muted">Pedidos</span><strong>${s.count}</strong>${s.cancelled ? `<span class="muted">${s.cancelled} cancelado(s)</span>` : ''}</div>
      ${s.hidden ? '' : `<div class="card"><span class="muted">Total vendido</span><strong>${money(s.total_cents)}</strong></div>`}
      <div class="card"><span class="muted">✅ Pago</span><strong>${money(s.paid_cents)}</strong></div>
      <div class="card"><span class="muted">⏳ Pendente</span><strong>${money(s.pending_cents)}</strong></div>
    </div>
    ${cancelReasonsHtml(h.data.orders)}
    ${h.data.truncated ? '<p class="muted">Mostrando os 1000 pedidos mais recentes do período. Diminua o período para ver todos.</p>' : ''}
    <div class="search-bar"><input id="history-search" type="search" placeholder="🔎 Buscar por número, cliente ou telefone" autocomplete="off" value="${escapeHtml(h.search)}" /></div>
    <div id="history-list">${historyListHtml()}</div>`;
}

/* ---------------- Caixa ---------------- */

async function loadCash() {
  try {
    state.cash = await api('/api/admin/cash');
    if (state.tab === 'cash') renderTab();
  } catch (err) {
    toast(err.message, true);
  }
}

function differenceHtml(counted, expected) {
  const diff = counted - expected;

  if (diff === 0) return '<span class="paid-text">✔ confere</span>';

  return diff > 0
    ? `<span class="paid-text">sobra ${money(diff)}</span>`
    : `<span class="status-cancelled">falta ${money(-diff)}</span>`;
}

function cashTabHtml() {
  if (!state.cash) return '<p class="empty">Carregando caixa…</p>';

  const { open, history } = state.cash;

  // Caixa aberto por outra pessoa: o funcionário não vê os valores dele.
  if (open?.other) {
    return `<div class="card"><h2 style="margin-top:0">💰 Caixa aberto</h2><p class="muted" style="margin:0">Aberto por <strong>${escapeHtml(open.opened_by_name || 'outra pessoa')}</strong> às ${timeOf(open.opened_at)}. Só quem abriu (ou o administrador) vê e fecha este caixa.</p></div>`;
  }

  const historyHtml = history.length
    ? `<p class="muted" style="font-size:13px">Turnos anteriores: <button class="btn small" data-finance-tab="historico">📚 Ver histórico</button></p>`
    : '';

  if (!open) {
    return `
      <form class="card" id="cash-open-form">
        <h2 style="margin-top:0">💰 Caixa fechado</h2>
        <p class="muted">Abra o caixa no começo do expediente. Tudo que for pago enquanto ele estiver aberto entra na conferência.</p>
        <div class="field"><label>Troco inicial em dinheiro (R$)</label><input name="opening" inputmode="decimal" placeholder="0,00" /></div>
        <button class="btn primary" type="submit">Abrir caixa</button>
      </form>
      ${isAdminUser() && history.length && dateOf(history[0].closed_at) === dateOf(new Date().toISOString()) ? `
        <div class="card">
          <strong>✔ Caixa de hoje fechado às ${timeOf(history[0].closed_at)}</strong>
          <p class="muted" style="margin:6px 0 10px">Próximo passo: gerar o fechamento dos pedidos entregues para passar para o PDV da loja.</p>
          <button class="btn primary small" data-pdv-today>🧮 Fechamento PDV de hoje</button>
        </div>` : ''}
      ${historyHtml}`;
  }

  const s = open.summary;

  return cashOpenHtml(open, s, historyHtml);
}

function cashSessionsTableHtml(history) {
  return history.length ? `
    <h2 class="section-title">💰 Turnos de caixa</h2>
    <div class="table-wrap">
      <table class="history">
        <thead><tr><th>Aberto</th><th>Fechado</th><th class="num">Dinheiro</th><th class="num">Cartão</th><th class="num">Pix</th><th class="num">Vendas</th></tr></thead>
        <tbody>
          ${history.map(c => `
            <tr>
              <td>${dateTimeOf(c.opened_at)}</td>
              <td>${dateTimeOf(c.closed_at)}</td>
              <td class="num">${money(c.counted_cash_cents)}<br>${differenceHtml(c.counted_cash_cents, c.expected_cash_cents)}</td>
              <td class="num">${money(c.counted_card_cents)}<br>${differenceHtml(c.counted_card_cents, c.expected_card_cents)}</td>
              <td class="num">${money(c.counted_pix_cents)}<br>${differenceHtml(c.counted_pix_cents, c.expected_pix_cents)}</td>
              <td class="num"><strong>${money(c.sales_total_cents)}</strong>${c.sangrias_cents || c.suprimentos_cents ? `<br><span class="muted">sangria ${money(c.sangrias_cents)} · supr. ${money(c.suprimentos_cents)}</span>` : ''}${c.notes ? `<br><span class="muted">${escapeHtml(c.notes)}</span>` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<div class="card"><p class="muted" style="margin:0">Nenhum turno de caixa fechado ainda.</p></div>';
}

function cashOpenHtml(open, s, historyHtml) {
  return `
    <div class="card">
      <h2 style="margin:0">💰 Caixa aberto</h2>
      <span class="muted">desde ${dateTimeOf(open.opened_at)} · ${s.paid_orders_count} pedido(s) pago(s)</span>
    </div>
    <div class="stats">
      <div class="card"><span class="muted">💵 Dinheiro</span><strong>${money(s.sales_cash_cents)}</strong></div>
      <div class="card"><span class="muted">💳 Cartão (déb. + créd.)</span><strong>${money(s.sales_card_cents)}</strong></div>
      <div class="card"><span class="muted">📲 Pix</span><strong>${money(s.sales_pix_cents)}</strong></div>
      <div class="card"><span class="muted">Total vendido</span><strong>${money(s.sales_total_cents)}</strong></div>
      ${s.sales_fiado_cents ? `<div class="card"><span class="muted">📒 Vendido no fiado</span><strong>${money(s.sales_fiado_cents)}</strong><span class="muted">na conta dos clientes (não entra na gaveta)</span></div>` : ''}
    </div>
    ${s.credit_payments?.length ? `
      <div class="card">
        <strong>📒 Recebido de dívidas do fiado</strong>
        <ul class="order-items">
          ${s.credit_received_cash_cents ? `<li><span>💵 Dinheiro</span><span>${money(s.credit_received_cash_cents)}</span></li>` : ''}
          ${s.credit_received_card_cents ? `<li><span>💳 Cartão</span><span>${money(s.credit_received_card_cents)}</span></li>` : ''}
          ${s.credit_received_pix_cents ? `<li><span>📲 Pix</span><span>${money(s.credit_received_pix_cents)}</span></li>` : ''}
        </ul>
        <span class="muted">${s.credit_payments.map(e => `${timeOf(e.created_at)} ${escapeHtml(e.customer_name)} ${e.amount_cents < 0 ? '' : '(estorno) −'}${money(Math.abs(e.amount_cents))}`).join(' · ')}</span>
      </div>` : ''}
    <div class="card">
      <strong>Dinheiro na gaveta (esperado)</strong>
      <ul class="order-items">
        <li><span>Troco inicial</span><span>${money(open.opening_cents)}</span></li>
        <li><span>+ Vendas em dinheiro</span><span>${money(s.sales_cash_cents)}</span></li>
        ${s.credit_received_cash_cents ? `<li><span>+ Fiado recebido em dinheiro</span><span>${money(s.credit_received_cash_cents)}</span></li>` : ''}
        <li><span>+ Suprimentos</span><span>${money(s.suprimentos_cents)}</span></li>
        <li><span>− Sangrias</span><span>${money(s.sangrias_cents)}</span></li>
        <li><strong>= Esperado na gaveta</strong><strong>${money(s.expected_cash_cents)}</strong></li>
      </ul>
      ${s.movements.length ? `<span class="muted">Movimentações: ${s.movements.map(m => `${timeOf(m.created_at)} ${m.type === 'sangria' ? '−' : '+'}${money(m.amount_cents)}${m.description ? ` (${escapeHtml(m.description)})` : ''}`).join(' · ')}</span>` : ''}
    </div>
    ${s.pending_orders.length ? `
      <div class="card warn">
        <strong>⚠️ ${s.pending_orders.length} pedido(s) deste caixa ainda sem pagamento marcado</strong>
        <ul class="order-items">${s.pending_orders.map(o => `<li><span>#${escapeHtml(o.order_number)} ${escapeHtml(o.customer_name)} · ${STATUS_LABELS[o.status]}</span><span>${money(o.total_cents)} <button class="btn small" data-pay="${o.id}" data-paid="paid">💵</button></span></li>`).join('')}</ul>
      </div>` : ''}
    <form class="card" id="cash-movement-form">
      <strong>Sangria / suprimento</strong>
      <div class="filters" style="margin-top:8px">
        <select name="type" class="btn small"><option value="sangria">− Sangria (retirada)</option><option value="suprimento">+ Suprimento (reforço de troco)</option></select>
        <input name="amount" inputmode="decimal" placeholder="Valor" class="btn small" style="width:110px" />
        <input name="description" maxlength="200" placeholder="Motivo (opcional)" class="btn small" style="flex:1;min-width:140px" />
        <button class="btn small" type="submit">Registrar</button>
      </div>
    </form>
    <form class="card" id="cash-close-form">
      <h2 style="margin-top:0">Fechar caixa</h2>
      <p class="muted">Conte o dinheiro da gaveta e confira os valores da maquininha e do Pix.</p>
      <div class="close-grid">
        <div class="field"><label>💵 Dinheiro contado (esperado ${money(s.expected_cash_cents)})</label><input name="cash" inputmode="decimal" placeholder="0,00" required /></div>
        <div class="field"><label>💳 Cartão na maquininha (esperado ${money(s.expected_card_cents)})</label><input name="card" inputmode="decimal" placeholder="0,00" required /></div>
        <div class="field"><label>📲 Pix recebido (esperado ${money(s.expected_pix_cents)})</label><input name="pix" inputmode="decimal" placeholder="0,00" required /></div>
      </div>
      <div class="field"><label>Observação (opcional)</label><input name="notes" maxlength="500" /></div>
      <button class="btn primary" type="submit">Fechar caixa</button>
    </form>
    ${historyHtml}`;
}

async function openCash(form) {
  const opening = inputToCents(form.opening.value);

  if (opening === null) return toast('Valor inválido.', true);

  try {
    await api('/api/admin/cash/open', { method: 'POST', body: JSON.stringify({ opening_cents: opening }) });
    toast('Caixa aberto!');
    await loadCash();
  } catch (err) {
    toast(err.message, true);
  }
}

async function addCashMovement(form) {
  const amount = inputToCents(form.amount.value);

  if (!amount) return toast('Informe o valor.', true);

  try {
    await api('/api/admin/cash/movement', {
      method: 'POST',
      body: JSON.stringify({ type: form.type.value, amount_cents: amount, description: form.description.value }),
    });
    toast(form.type.value === 'sangria' ? 'Sangria registrada.' : 'Suprimento registrado.');
    await loadCash();
  } catch (err) {
    toast(err.message, true);
  }
}

async function closeCash(form) {
  const values = { cash: inputToCents(form.cash.value), card: inputToCents(form.card.value), pix: inputToCents(form.pix.value) };

  if (Object.values(values).some(v => v === null)) return toast('Valor inválido.', true);

  const s = state.cash.open.summary;
  const lines = [
    ['Dinheiro', values.cash, s.expected_cash_cents],
    ['Cartão', values.card, s.expected_card_cents],
    ['Pix', values.pix, s.expected_pix_cents],
  ].map(([label, counted, expected]) => {
    const diff = counted - expected;
    return `${label}: ${money(counted)} (${diff === 0 ? 'confere' : diff > 0 ? `sobra ${money(diff)}` : `falta ${money(-diff)}`})`;
  });

  if (!confirm(`Fechar o caixa?\n\n${lines.join('\n')}${s.pending_orders.length ? `\n\n⚠️ ${s.pending_orders.length} pedido(s) ainda sem pagamento marcado.` : ''}`)) return;

  try {
    await api('/api/admin/cash/close', {
      method: 'POST',
      body: JSON.stringify({
        counted_cash_cents: values.cash,
        counted_card_cents: values.card,
        counted_pix_cents: values.pix,
        notes: form.notes.value,
      }),
    });
    toast('Caixa fechado!');
    await loadCash();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- Clientes ---------------- */

function dateOf(iso) {
  return iso ? new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—';
}

function formatPhone(digits) {
  const d = String(digits || '');

  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;

  return d;
}

function whatsappLink(digits, text = '') {
  return `https://wa.me/55${escapeHtml(digits)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

const birthdaySoon = c => c.birthday_in_days != null && c.birthday_in_days >= 0 && c.birthday_in_days <= 7;

// Cliente em destaque (customers.highlight): nome em dourado com coroa.
function customerNameHtml(name, highlight) {
  return highlight ? `<span class="name-star">👑 ${escapeHtml(name)}</span>` : escapeHtml(name);
}

function tierBadge(customer) {
  const d = customer.birthday_in_days;

  return [
    customer.is_vip ? '<span class="badge vip">⭐ VIP · entrega grátis</span>' : '',
    `<span class="badge tier-${customer.tier}">${escapeHtml(customer.tier_label)}</span>`,
    birthdaySoon(customer) ? `<span class="badge bday">🎂 ${d === 0 ? 'Aniversário HOJE' : `aniversário em ${d} dia(s)`}</span>` : '',
    customer.stopped
      ? `<span class="badge stopped">🚨 Parou de comprar (pedia a cada ~${customer.avg_interval_days} dias, sumiu há ${customer.days_since_last_order})</span>`
      : customer.inactive ? `<span class="badge off">💤 Sumido há ${customer.days_since_last_order} dias</span>` : '',
  ].join('');
}

async function loadCustomers() {
  try {
    const data = await api('/api/admin/customers');
    state.customers = data.customers;
    state.customerTiers = data.tiers;
    state.inactiveDays = data.inactive_days;
    state.birthdayConfig = data.birthday;

    if (state.tab === 'customers' && !state.customerDetail) renderTab();
  } catch (err) {
    toast(err.message, true);
  }
}

function filteredCustomers() {
  const terms = normalizeText(state.customerSearch).split(/\s+/).filter(Boolean);

  return (state.customers || []).filter(c => {
    const special = { inactive: c.inactive, stopped: c.stopped, vip: c.is_vip, birthday: birthdaySoon(c) };

    if (state.customerFilter in special) {
      if (!special[state.customerFilter]) return false;
    } else if (state.customerFilter && c.tier !== state.customerFilter) {
      return false;
    }

    const text = normalizeText(`${c.name} ${c.phone} ${formatPhone(c.phone)} ${c.address || ''}`);
    return terms.every(term => text.includes(term));
  });
}

function customerListHtml() {
  const customers = filteredCustomers();

  if (!customers.length) {
    return `<p class="empty">${state.customers.length ? 'Nenhum cliente encontrado.' : 'Nenhum cliente ainda.<br>Todo pedido feito no cardápio cria (ou atualiza) o perfil do cliente automaticamente, pelo WhatsApp.'}</p>`;
  }

  return customers.map(c => `
    <button class="card customer-row" data-customer="${c.id}">
      <div class="info">
        <strong>${customerNameHtml(c.name, c.highlight)}</strong>
        <span class="muted">${escapeHtml(formatPhone(c.phone))}</span>
        <div>${tierBadge(c)}</div>
      </div>
      <div class="customer-numbers">
        ${c.total_spent_cents == null ? '' : `<strong class="price">${money(c.total_spent_cents)}</strong>`}
        <span class="muted">${c.total_orders_count} pedido(s)${c.legacy_orders_count ? ` · ${c.legacy_orders_count} no Olá Click` : ''}</span>
        <span class="muted">último: ${dateOf(c.last_order_at)}</span>
      </div>
    </button>`).join('');
}

function customersTabHtml() {
  if (state.customerDetail) return customerDetailHtml();

  const nav = `
    <nav class="tabs sub-tabs">
      <button data-customer-view="list" class="${state.customerView === 'list' ? 'active' : ''}">👥 Clientes</button>
      ${isAdminUser() ? `<button data-customer-view="credit" class="${state.customerView === 'credit' ? 'active' : ''}">📒 Fiado</button>` : ''}
      ${isAdminUser() ? `<button data-customer-view="carts" class="${state.customerView === 'carts' ? 'active' : ''}">🛒 Carrinhos abandonados</button>` : ''}
    </nav>`;

  if (state.customerView === 'carts') return nav + abandonedCartsHtml();
  if (state.customerView === 'credit' && isAdminUser()) return nav + creditListHtml();

  if (!state.customers) return `${nav}<p class="empty">Carregando clientes…</p>`;

  return nav + customerListPageHtml();
}

async function loadCarts() {
  try {
    state.carts = (await api('/api/admin/abandoned-carts')).carts;
  } catch (err) {
    state.carts = [];
    toast(err.message, true);
  }

  if (state.tab === 'customers' && state.customerView === 'carts' && !state.customerDetail) renderTab();
}

function abandonedCartsHtml() {
  if (!state.carts) {
    loadCarts();
    return '<p class="empty">Carregando…</p>';
  }

  const intro = '<div class="card"><p class="muted" style="margin:0;font-size:13px">Clientes que digitaram o WhatsApp no checkout, mas não fecharam o pedido (entre 30 minutos e 3 dias atrás). O lembrete só aparece para quem autorizou mensagens.</p></div>';

  if (!state.carts.length) return `${intro}<p class="empty">Nenhum carrinho abandonado agora. 🎉</p>`;

  return intro + state.carts.map(c => {
    const first = String(c.customer_name || '').trim().split(/\s+/)[0] || '';
    const text = `Oi${first ? `, ${first}` : ''}! Aqui é da ${state.store.name}. Vi que você montou um pedido e não finalizou — ficou alguma dúvida? Seu carrinho continua salvo, é só abrir o cardápio: ${location.origin} 😊`;

    return `
      <div class="card">
        <div class="order-head">
          <div><strong>${escapeHtml(c.customer_name || 'Sem nome')}</strong> <span class="muted">· ${escapeHtml(formatPhone(c.phone))} · ${dateTimeOf(c.updated_at)}</span></div>
          <strong>${money(c.subtotal_cents)}</strong>
        </div>
        <ul class="order-items">${c.items.map(i => `<li><span>${i.quantity}× ${escapeHtml(i.name || 'produto')}</span></li>`).join('')}</ul>
        ${c.reminded_at ? `<span class="muted">✅ Lembrete enviado ${dateTimeOf(c.reminded_at)}</span>` : c.can_message
          ? `<a class="btn small primary" href="${whatsappLink(c.phone, text)}" target="_blank" rel="noopener" data-cart-remind="${c.id}" style="text-decoration:none">💬 Mandar lembrete</a>`
          : '<span class="muted">Cliente não autorizou mensagens.</span>'}
      </div>`;
  }).join('');
}

function customerListPageHtml() {

  const all = state.customers;
  const count = key => all.filter(c => c.tier === key).length;
  const filters = [
    ['', `Todos (${all.length})`],
    ['vip', `⭐ VIP (${all.filter(c => c.is_vip).length})`],
    ['birthday', `🎂 Aniversário esta semana (${all.filter(birthdaySoon).length})`],
    ['stopped', `🚨 Pararam de comprar (${all.filter(c => c.stopped).length})`],
    ...state.customerTiers.map(t => [t.key, `${t.label} (${count(t.key)})`]),
    ['inactive', `💤 Sumidos (${all.filter(c => c.inactive).length})`],
  ];
  const rule = t => [t.min_spent_cents != null ? `gastou ${money(t.min_spent_cents)}` : null, t.min_orders ? `${t.min_orders} pedidos` : null].filter(Boolean).join(' ou ');
  const revenue = all.reduce((sum, c) => sum + c.total_spent_cents, 0);

  return `
    <div class="card">
      <strong>${all.length} cliente(s)</strong>${isAdminUser() ? ` · faturamento total ${money(revenue)}` : ''}
      <p class="muted" style="margin:6px 0 0;font-size:13px">
        Níveis: ${state.customerTiers.filter(t => t.min_orders || t.min_spent_cents).map(t => `${escapeHtml(t.label)} = ${rule(t)}`).join(' · ')}.
        Pedidos cancelados não contam; os pedidos feitos no Olá Click contam para o número de pedidos (o valor gasto lá não veio na importação). 💤 Sumido = sem pedir há mais de ${state.inactiveDays} dias.
        🚨 Parou de comprar = fez 3 ou mais pedidos e está bem atrasado em relação ao próprio ritmo (mais que o dobro do intervalo de sempre).
        ⭐ VIP = marcado pelo senhor no perfil do cliente: não paga entrega.
      </p>
    </div>
    <div class="search-bar"><input id="customer-search" type="search" placeholder="🔎 Buscar por nome, telefone ou endereço" autocomplete="off" value="${escapeHtml(state.customerSearch)}" /></div>
    <div class="categories" style="position:static">
      ${filters.map(([key, label]) => `<button data-tier-filter="${key}" class="${state.customerFilter === key ? 'active' : ''}">${escapeHtml(label)}</button>`).join('')}
    </div>
    <div id="customer-list">${customerListHtml()}</div>`;
}

/* ---------------- Fiado (crediário) ---------------- */

// Linha curta com a situação do fiado do cliente (novo pedido, cadastro).
function creditLineHtml(c) {
  const balance = c.credit_balance_cents || 0;
  if (!c.credit_enabled && !balance) return '';
  const available = Math.max(0, (c.credit_enabled ? c.credit_limit_cents : 0) - balance);
  return `<br><span class="credit-line">📒 Fiado: ${c.credit_enabled ? `liberado · limite ${money(c.credit_limit_cents)}` : 'não liberado'}
    · ${balance > 0 ? `<strong class="status-cancelled">deve ${money(balance)}</strong>` : balance < 0 ? `<strong class="status-delivered">crédito a favor ${money(-balance)}</strong>` : 'nada em aberto'}
    ${c.credit_enabled ? ` · pode comprar ${money(available)}` : ''}</span>`;
}

function newRequestId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

async function loadCustomerCredit(customerId) {
  try {
    const data = await api(`/api/admin/customers/${customerId}/credit`);
    if (state.customerDetail?.customer.id === customerId) {
      state.customerCredit = data;
      const box = document.getElementById('credit-box');
      if (box) box.outerHTML = customerCreditHtml();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

const CREDIT_KIND_ICONS = { compra: '🛒', estorno_compra: '↩️', pagamento: '💵', ajuste: '✏️', estorno: '↩️' };

function customerCreditHtml() {
  const data = state.customerCredit;
  const admin = isAdminUser();

  if (!data || data.customer.id !== state.customerDetail?.customer.id) {
    return '<div class="card" id="credit-box"><strong>📒 Fiado (crediário)</strong><p class="muted" style="margin:6px 0 0">Carregando…</p></div>';
  }

  const { credit: cr, entries } = data;
  const balance = cr.balance_cents;

  return `
    <div class="card credit-box" id="credit-box">
      <div class="order-head">
        <strong>📒 Fiado (crediário)</strong>
        <span class="badge ${cr.enabled ? 'paid' : 'off'}">${cr.enabled ? `✅ Liberado · limite ${money(cr.limit_cents)}` : '⛔ Não liberado'}</span>
      </div>
      <div class="credit-balance ${balance > 0 ? 'owes' : balance < 0 ? 'favor' : ''}">
        ${balance > 0 ? `Deve <strong>${money(balance)}</strong>` : balance < 0 ? `Crédito a favor <strong>${money(-balance)}</strong>` : 'Nada em aberto'}
      </div>
      ${cr.enabled ? `<p class="muted" style="margin:0 0 10px">Pode comprar no fiado até mais <strong>${money(cr.available_cents)}</strong>.</p>` : ''}

      ${admin ? `
        <form id="credit-settings-form" class="row" style="align-items:center;margin-bottom:12px">
          <label class="check" style="margin:0"><input type="checkbox" name="enabled" ${cr.enabled ? 'checked' : ''} /> Liberar fiado</label>
          <span>limite R$</span><input name="limit" inputmode="decimal" value="${centsToInput(cr.limit_cents)}" style="width:110px" />
          <button class="btn small" type="submit">Salvar</button>
        </form>` : ''}

      <form id="credit-payment-form" class="credit-form">
        <strong>💵 Receber pagamento do fiado</strong>
        <div class="row" style="align-items:center;margin-top:6px">
          <span>R$</span><input name="amount" inputmode="decimal" placeholder="0,00" value="${balance > 0 ? centsToInput(balance) : ''}" style="width:120px" />
          <select name="method" class="btn small">${CREDIT_PAY_CHOICES.map(m => `<option value="${m}">${PAYMENT_ICONS[m]} ${PAYMENT_LABELS[m]}</option>`).join('')}</select>
        </div>
        <input name="note" maxlength="300" placeholder="Observação (opcional)" style="margin-top:6px;width:100%" />
        <button class="btn primary block" type="submit" style="margin-top:8px">Registrar pagamento</button>
      </form>

      ${admin ? `
        <details style="margin-top:10px">
          <summary><strong>✏️ Ajuste / saldo do caderno</strong> <span class="muted">(só administrador, sempre com motivo)</span></summary>
          <form id="credit-adjust-form" class="credit-form" style="margin-top:8px">
            <div class="row" style="align-items:center">
              <select name="direction" class="btn small">
                <option value="up">➕ Aumentar a dívida</option>
                <option value="down">➖ Diminuir a dívida</option>
              </select>
              <span>R$</span><input name="amount" inputmode="decimal" placeholder="0,00" style="width:120px" />
            </div>
            <input name="note" maxlength="300" placeholder="Motivo (ex.: saldo do caderno em 26/09)" style="margin-top:6px;width:100%" required />
            <button class="btn block" type="submit" style="margin-top:8px">Lançar ajuste</button>
          </form>
        </details>` : ''}

      <div class="row" style="justify-content:space-between;align-items:center;margin-top:14px">
        <strong>Extrato (${entries.length})</strong>
        ${entries.length ? '<button class="btn small" type="button" id="credit-print">🖨️ Imprimir extrato</button>' : ''}
      </div>
      ${entries.length ? `<ul class="credit-entries">${entries.map(e => `
        <li class="${e.reversed ? 'reversed' : ''}">
          <div class="order-head">
            <span>${CREDIT_KIND_ICONS[e.kind] || ''} <strong>${escapeHtml(e.label)}</strong>${e.method ? ` · ${PAYMENT_LABELS[e.method]}` : ''}${e.order_number ? ` · pedido #${escapeHtml(e.order_number)}` : ''}</span>
            <strong class="${e.amount_cents > 0 ? 'status-cancelled' : 'status-delivered'}">${e.amount_cents > 0 ? '+' : '−'}${money(Math.abs(e.amount_cents))}</strong>
          </div>
          <span class="muted">${dateOf(e.created_at)} ${timeOf(e.created_at)} · ${escapeHtml(e.created_by_name)} · saldo ${money(e.balance_after_cents)}</span>
          ${e.note ? `<br><span class="muted">📝 ${escapeHtml(e.note)}</span>` : ''}
          ${e.reversed ? '<br><span class="badge off">estornado</span>' : ''}
          ${admin && !e.reversed && ['pagamento', 'ajuste'].includes(e.kind) ? `<br><button class="btn small" type="button" data-credit-reverse="${e.id}">↩️ Estornar (lançado errado)</button>` : ''}
        </li>`).join('')}</ul>` : '<p class="muted" style="margin:6px 0 0">Nenhum lançamento ainda.</p>'}
      <p class="muted" style="font-size:12px;margin:10px 0 0">🔒 O extrato do fiado não pode ser apagado nem alterado. Erro se corrige com estorno, e tudo fica registrado com quem fez e quando.</p>
    </div>`;
}

async function saveCreditSettings(form) {
  const limit = inputToCents(form.limit.value || '0');
  if (limit === null) return toast('Limite inválido.', true);
  const id = state.customerDetail.customer.id;
  const enabled = form.enabled.checked;
  if (!confirm(enabled ? `Liberar fiado para ${state.customerDetail.customer.name} com limite de ${money(limit)}?` : `Bloquear o fiado de ${state.customerDetail.customer.name}? (a dívida continua no extrato)`)) return;
  try {
    await api(`/api/admin/customers/${id}`, { method: 'PATCH', body: JSON.stringify({ credit_enabled: enabled, credit_limit_cents: limit }) });
    toast(enabled ? 'Fiado liberado.' : 'Fiado bloqueado.');
    state.creditList = null;
    await loadCustomerCredit(id);
  } catch (err) {
    toast(err.message, true);
  }
}

async function creditPost(path, body, form, message) {
  const button = form?.querySelector('[type=submit]');
  if (button) button.disabled = true;
  const id = state.customerDetail.customer.id;
  try {
    state.customerCredit = await api(`/api/admin/customers/${id}/credit/${path}`, { method: 'POST', body: JSON.stringify(body) });
    state.creditList = null;
    const box = document.getElementById('credit-box');
    if (box) box.outerHTML = customerCreditHtml();
    toast(message);
  } catch (err) {
    toast(err.message, true);
    if (button) button.disabled = false;
  }
}

function submitCreditPayment(form) {
  const amount = inputToCents(form.amount.value);
  if (!amount || amount <= 0) return toast('Informe o valor recebido.', true);
  const balance = state.customerCredit?.credit.balance_cents || 0;
  const label = PAYMENT_LABELS[form.method.value];
  const extra = amount > balance ? `\n\nAtenção: é mais do que ele deve (${money(Math.max(0, balance))}). A diferença fica como crédito a favor dele.` : '';
  if (!confirm(`Registrar pagamento de ${money(amount)} no ${label} do fiado de ${state.customerDetail.customer.name}?${extra}`)) return;
  // O mesmo request_id em caso de clique duplo: o servidor lança uma vez só.
  form.dataset.requestId ||= newRequestId();
  creditPost('payment', { amount_cents: amount, method: form.method.value, note: form.note.value, request_id: form.dataset.requestId }, form, 'Pagamento registrado no fiado. ✅');
}

function submitCreditAdjust(form) {
  const amount = inputToCents(form.amount.value);
  if (!amount || amount <= 0) return toast('Informe o valor do ajuste.', true);
  if (form.note.value.trim().length < 3) return toast('Escreva o motivo do ajuste.', true);
  const up = form.direction.value === 'up';
  if (!confirm(`${up ? 'AUMENTAR' : 'DIMINUIR'} a dívida de ${state.customerDetail.customer.name} em ${money(amount)}?\nMotivo: ${form.note.value.trim()}`)) return;
  form.dataset.requestId ||= newRequestId();
  creditPost('adjust', { amount_cents: up ? amount : -amount, note: form.note.value, request_id: form.dataset.requestId }, form, 'Ajuste lançado no fiado.');
}

function reverseCreditEntry(entryId) {
  const entry = state.customerCredit?.entries.find(e => e.id === entryId);
  if (!entry) return;
  const note = prompt(`Estornar "${entry.label}" de ${money(Math.abs(entry.amount_cents))} (${dateOf(entry.created_at)})?\nEscreva o motivo:`);
  if (note === null) return;
  if (note.trim().length < 3) return toast('Escreva o motivo do estorno.', true);
  creditPost('reverse', { entry_id: entryId, note }, null, 'Lançamento estornado.');
}

function printCreditStatement() {
  const data = state.customerCredit;
  if (!data) return;
  const { customer: c, credit: cr, entries } = data;
  const rows = [...entries].reverse().map(e => `
    <div class="item"><span>${dateOf(e.created_at)} ${escapeHtml(e.label)}${e.order_number ? ` #${escapeHtml(e.order_number)}` : ''}${e.method ? ` (${PAYMENT_LABELS[e.method]})` : ''}</span><span>${e.amount_cents > 0 ? '+' : '-'}${money(Math.abs(e.amount_cents))}</span></div>`).join('');
  printDocument(`
    <div class="receipt">
      <div class="center big">EXTRATO DO FIADO</div>
      <div class="center">${escapeHtml(state.store?.name || '')}</div>
      <div class="center">${dateOf(new Date().toISOString())} ${timeOf(new Date().toISOString())}</div>
      <div class="sep"></div>
      <div class="big">${escapeHtml(c.name)}</div>
      <div>Tel: ${escapeHtml(formatPhone(c.phone))}</div>
      <div class="sep"></div>
      ${rows}
      <div class="sep"></div>
      <div class="item big"><span>${cr.balance_cents >= 0 ? 'SALDO DEVEDOR' : 'CRÉDITO A FAVOR'}</span><span>${money(Math.abs(cr.balance_cents))}</span></div>
    </div>`);
}

// Aba Clientes > 📒 Fiado (só administrador): quem deve, quem tem crédito e a cópia do livro.
async function loadCreditList() {
  try {
    state.creditList = await api('/api/admin/credit');
  } catch (err) {
    state.creditList = { customers: [], receivable_cents: 0, credit_in_favor_cents: 0 };
    toast(err.message, true);
  }
  if (state.tab === 'customers' && state.customerView === 'credit' && !state.customerDetail) renderTab();
}

function creditListHtml() {
  if (!state.creditList) {
    loadCreditList();
    return '<p class="empty">Carregando…</p>';
  }
  const { customers, receivable_cents: receivable, credit_in_favor_cents: favor } = state.creditList;
  const owing = customers.filter(c => c.balance_cents > 0);
  const favorList = customers.filter(c => c.balance_cents < 0);
  const clean = customers.filter(c => c.balance_cents === 0);
  const row = c => `
    <button class="card customer-row" data-customer="${c.id}">
      <div class="info">
        <strong>${escapeHtml(c.name)}</strong>
        <span class="muted">${escapeHtml(formatPhone(c.phone))} · ${c.enabled ? `limite ${money(c.limit_cents)}` : '⛔ fiado bloqueado'}</span>
        <span class="muted">${c.last_payment_at ? `último pagamento ${dateOf(c.last_payment_at)}` : 'nenhum pagamento ainda'}</span>
      </div>
      <div class="side"><strong class="${c.balance_cents > 0 ? 'status-cancelled' : c.balance_cents < 0 ? 'status-delivered' : ''}">${c.balance_cents > 0 ? money(c.balance_cents) : c.balance_cents < 0 ? `crédito ${money(-c.balance_cents)}` : 'R$ 0,00'}</strong></div>
    </button>`;

  return `
    <div class="stats">
      <div class="card"><span class="muted">📒 A receber do fiado</span><strong>${money(receivable)}</strong><span class="muted">${owing.length} cliente(s) devendo</span></div>
      <div class="card"><span class="muted">Crédito a favor de clientes</span><strong>${money(favor)}</strong></div>
    </div>
    <div class="card">
      <strong>🔒 Cópia de segurança</strong>
      <p class="muted" style="margin:6px 0 10px">O livro do fiado não pode ser apagado nem alterado, nem pelo sistema. Mesmo assim, baixe uma cópia de vez em quando (abre no Excel).</p>
      <a class="btn small" href="/api/admin/credit/export" download>⬇️ Baixar livro do fiado (planilha)</a>
    </div>
    <p class="muted" style="font-size:13px">Para liberar fiado para um cliente: abra o cliente em 👥 Clientes → 📒 Fiado → "Liberar fiado" e o limite.</p>
    ${owing.length ? `<h2 class="section-title">Devendo (${owing.length})</h2>${owing.map(row).join('')}` : '<p class="empty">Ninguém devendo no fiado. 🎉</p>'}
    ${favorList.length ? `<h2 class="section-title">Com crédito a favor (${favorList.length})</h2>${favorList.map(row).join('')}` : ''}
    ${clean.length ? `<h2 class="section-title">Fiado liberado, nada em aberto (${clean.length})</h2>${clean.map(row).join('')}` : ''}`;
}

async function openCustomer(customerId) {
  try {
    state.tab = 'customers';
    state.customerDetail = await api(`/api/admin/customers/${customerId}`);
    state.customerCredit = null;
    render();
    window.scrollTo(0, 0);
    loadCustomerCredit(customerId);
    if (!state.customers) loadCustomers();
  } catch (err) {
    toast(err.message, true);
  }
}

function customerDetailHtml() {
  const { customer: c, orders, top_products: top } = state.customerDetail;

  return `
    <button class="btn small" id="back-customers" style="margin-bottom:12px">← Voltar para clientes</button>
    <div class="card">
      <h2 style="margin:0 0 6px">${customerNameHtml(c.name, c.highlight)}</h2>
      <div>${tierBadge(c)}</div>
      <p style="margin:10px 0 0;line-height:1.7">
        📱 <a href="${whatsappLink(c.phone)}" target="_blank" rel="noopener">${escapeHtml(formatPhone(c.phone))}</a><br>
        ${c.address ? `📍 ${escapeHtml(c.address)}${c.delivery_zone ? ` (${escapeHtml(c.delivery_zone)})` : ''}<br>` : ''}
        ${c.email ? `✉️ ${escapeHtml(c.email)}<br>` : ''}
        🗓️ Cliente desde ${dateOf(c.source === 'olaclick' ? c.created_at : (c.first_order_at || c.created_at))}${c.source === 'olaclick' ? ' · <span class="badge">veio do Olá Click</span>' : ''}
      </p>
    </div>
    <div class="stats">
      ${c.total_spent_cents == null ? '' : `<div class="card"><span class="muted">Total gasto</span><strong>${money(c.total_spent_cents)}</strong></div>`}
      <div class="card"><span class="muted">Pedidos</span><strong>${c.total_orders_count}</strong>${c.legacy_orders_count ? `<span class="muted">${c.orders_count} aqui + ${c.legacy_orders_count} no Olá Click</span>` : ''}${c.cancelled_count ? `<span class="muted">+ ${c.cancelled_count} cancelado(s)</span>` : ''}</div>
      ${c.average_ticket_cents == null ? '' : `<div class="card"><span class="muted">Ticket médio</span><strong>${money(c.average_ticket_cents)}</strong></div>`}
      <div class="card"><span class="muted">Último pedido</span><strong>${dateOf(c.last_order_at)}</strong>${c.days_since_last_order != null ? `<span class="muted">há ${c.days_since_last_order} dia(s)</span>` : ''}</div>
      <div class="card"><span class="muted">Costuma pedir</span><strong>${c.avg_interval_days != null ? `a cada ~${c.avg_interval_days} dia(s)` : '—'}</strong>${top[0] ? `<span class="muted">favorito: ${escapeHtml(top[0].name)}</span>` : ''}</div>
    </div>
    ${customerCrmHtml(state.customerDetail)}
    ${customerCreditHtml()}
    ${top.length ? `
      <div class="card">
        <strong>Mais compra</strong>
        <ul class="order-items">${top.map(p => `<li><span>${p.quantity}× ${escapeHtml(p.name)}</span><span>${money(p.spent_cents)}</span></li>`).join('')}</ul>
      </div>` : ''}
    <form class="card" id="customer-notes-form" data-id="${c.id}">
      <div class="field" style="margin:0 0 10px">
        <label>Observações sobre o cliente (só o senhor vê)</label>
        <textarea name="notes" rows="3" maxlength="1000" placeholder="${storeCopy('Ex.: prefere o lanche sem cebola, portão azul, paga no Pix…', 'Ex.: prefere Heineken bem gelada, portão azul, paga sempre no Pix…')}">${escapeHtml(c.notes || '')}</textarea>
      </div>
      <button class="btn primary small" type="submit">Salvar observação</button>
    </form>
    ${state.customerDetail.financial_history_hidden ? '<p class="muted">O histórico financeiro do cliente é exclusivo do administrador.</p>' : `<h2 class="section-title">Histórico de pedidos (${orders.length})</h2>`}
    ${orders.length ? orders.map(o => `
      <div class="card">
        <div class="order-head">
          <div><strong>#${escapeHtml(o.order_number)}</strong> <span class="muted">· ${dateOf(o.created_at)} ${timeOf(o.created_at)} · ${o.delivery_type === 'pickup' ? 'Retirada' : 'Entrega'} · ${paymentText(o)}</span></div>
          <strong class="status-${o.status}">${STATUS_LABELS[o.status]}</strong>
        </div>
        <ul class="order-items">
          ${o.order_items.map(i => `<li><span>${i.quantity}× ${escapeHtml(i.product_name)}</span><span>${money(i.subtotal_cents)}</span></li>`).join('')}
          <li><strong>Total</strong><strong>${money(o.total_cents)}</strong></li>
        </ul>
        ${o.notes ? `<span class="muted">📝 ${escapeHtml(o.notes)}</span>` : ''}
      </div>`).join('') : state.customerDetail.financial_history_hidden ? '' : '<p class="empty">Nenhum pedido.</p>'}`;
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

// VIP, aniversário, autorização de mensagens, hora de repor e mensagens prontas.
function customerCrmHtml({ customer: c, repeat = [], birthday_offer: offer }) {
  if (!isAdminUser()) return '';

  const [bm, bd] = (c.birthday || '').split('-');
  const first = String(c.name || '').trim().split(/\s+/)[0] || '';
  const store = state.store.name;
  const menu = location.origin;
  const messages = [];

  if (birthdaySoon(c) || offer) {
    messages.push(['🎂 Parabéns', `Oi, ${first}! 🎂 A ${store} deseja um feliz aniversário!${offer ? ` Pra comemorar, seu próximo pedido pelo cardápio tem ${offer} — já sai automático, é só pedir: ${menu}` : ''} 🍻`]);
  }

  if (c.stopped || c.inactive) {
    messages.push(['💬 Sentimos sua falta', `Oi, ${first}! Aqui é da ${store}. Faz tempo que você não pede com a gente — tá tudo bem? 😊 Se precisar de algo, é só pedir por aqui: ${menu}`]);
  }

  if (repeat.length) {
    messages.push(['🔁 Lembrete de reposição', `Oi, ${first}! Aqui é da ${store}. Vimos que já deve estar na hora de repor ${repeat.slice(0, 2).map(r => r.name).join(' e ')}. Quer que a gente leve? É só pedir: ${menu}`]);
  }

  return `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <span>${c.is_vip ? '<strong>⭐ Cliente VIP</strong> — não paga taxa de entrega' : 'Cliente comum (paga a taxa de entrega)'}</span>
        <button class="btn small ${c.is_vip ? '' : 'primary'}" data-customer-vip="${c.id}">${c.is_vip ? 'Tirar VIP' : '⭐ Tornar VIP'}</button>
      </div>
      <form id="customer-bday-form" data-id="${c.id}" class="row" style="align-items:center;margin-top:10px">
        <span>🎂 Aniversário:</span>
        <select name="day" class="btn small"><option value="">dia</option>${Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).map(d => `<option ${d === bd ? 'selected' : ''}>${d}</option>`).join('')}</select>
        <select name="month" class="btn small"><option value="">mês</option>${MONTHS.map((m, i) => { const v = String(i + 1).padStart(2, '0'); return `<option value="${v}" ${v === bm ? 'selected' : ''}>${m}</option>`; }).join('')}</select>
        <button class="btn small" type="submit">Salvar</button>
        ${offer ? `<span class="paid-text">🎁 Presente ativo agora: ${escapeHtml(offer)} no próximo pedido</span>` : ''}
      </form>
      <div class="row" style="justify-content:space-between;align-items:center;margin-top:10px">
        <span>${c.marketing_opt_in ? `✅ Autorizou lembretes e novidades pelo WhatsApp${c.opt_in_at ? ` <span class="muted">(${dateOf(c.opt_in_at)})</span>` : ''}` : '🚫 Não autorizou lembretes pelo WhatsApp'}</span>
        <button class="btn small" data-customer-optin="${c.id}">${c.marketing_opt_in ? 'Remover autorização' : 'Cliente autorizou'}</button>
      </div>
    </div>
    ${repeat.length ? `
      <div class="card">
        <strong>🔁 Hora de repor</strong> <span class="muted">(pelo ritmo de compra dele)</span>
        <ul class="order-items">${repeat.map(r => `<li><span>${escapeHtml(r.name)}</span><span class="muted">a cada ~${r.every_days} dias · última há ${r.days_since}</span></li>`).join('')}</ul>
      </div>` : ''}
    ${messages.length ? `
      <div class="card">
        <strong>Mensagens prontas</strong>
        ${c.marketing_opt_in
          ? `<div class="row" style="margin-top:8px">${messages.map(([label, text]) => `<a class="btn small" href="${whatsappLink(c.phone, text)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">${label}</a>`).join('')}</div>`
          : '<p class="muted" style="margin:6px 0 0">O cliente ainda não autorizou receber mensagens. Quando ele autorizar (no cardápio, ou falando com o senhor), os botões aparecem aqui.</p>'}
      </div>` : ''}`;
}

async function updateCustomerCrm(customerId, fields, message) {
  try {
    const { customer } = await api(`/api/admin/customers/${customerId}`, { method: 'PATCH', body: JSON.stringify(fields) });
    state.customerDetail = await api(`/api/admin/customers/${customerId}`);
    const listed = state.customers?.find(c => c.id === customerId);
    if (listed) Object.assign(listed, { is_vip: customer.is_vip, birthday: customer.birthday, marketing_opt_in: customer.marketing_opt_in, birthday_in_days: state.customerDetail.customer.birthday_in_days });
    renderTab();
    toast(message);
  } catch (err) {
    toast(err.message, true);
  }
}

async function saveCustomerNotes(form) {
  const button = form.querySelector('[type=submit]');
  button.disabled = true;

  try {
    await api(`/api/admin/customers/${form.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ notes: form.notes.value }) });
    state.customerDetail.customer.notes = form.notes.value;
    toast('Observação salva!');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.disabled = false;
  }
}

/* ---------------- Despacho (conferência do caixa) ---------------- */

async function openDispatchModal(orderId) {
  const order = findOrder(orderId);

  if (!order) return;

  let couriers = [];

  try {
    couriers = (await api('/api/admin/couriers')).couriers;
  } catch (err) {
    return toast(err.message, true);
  }

  const zone = state.zones.find(z => z.name === order.delivery_zone);
  const { street } = orderStreet(order);
  const streets = zone?.streets || [];
  const word = streets.length && streets.every(s => /^quadra\b/i.test(s)) ? 'Quadra' : 'Rua';
  // Mesma quadra (Garatucaia) ou mesmo bairro (os outros).
  const sameStreet = state.orders.filter(o => o.id !== order.id && o.delivery_type === 'delivery' && ['received', 'accepted', 'preparing'].includes(o.status) && routeKey(o) === routeKey(order));
  // Outros bairros do mesmo caminho (Conceição → Porto Real → Verde Mar, etc.).
  const sameLine = sameLineOrders(order);

  const modal = openModal(`
    <div class="sheet-head"><h2 style="margin:0">🛵 Conferir e despachar #${escapeHtml(order.order_number)}</h2><button type="button" data-close-modal aria-label="Fechar">✕</button></div>
    <form id="dispatch-form">
      <p class="muted" style="margin-top:0">${escapeHtml(order.customer_name)} · ${escapeHtml(order.address || '')}${order.delivery_zone ? ` · ${escapeHtml(order.delivery_zone)}` : ''}</p>
      <strong>1. Confira cada item antes de entregar ao entregador</strong>
      <div style="margin:6px 0 12px">
        ${order.order_items.map((i, n) => `<label class="check"><input type="checkbox" name="item${n}" required /> <strong>${i.quantity}×</strong> ${escapeHtml(i.product_name)}</label>`).join('')}
      </div>
      ${streets.length ? `
        <div class="field"><label>2. ${word}</label>
          <select name="street">
            <option value="">Sem ${word.toLowerCase()} definida</option>
            ${streets.map(s => `<option ${s === street ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
          </select>
        </div>` : ''}
      ${sameStreet.length ? `<p class="paid-text" style="margin-top:0">💡 ${street ? `Mesma ${word.toLowerCase()}` : 'Mesmo bairro'}: ${sameStreet.map(o => `#${escapeHtml(o.order_number)}`).join(', ')} também ${sameStreet.length > 1 ? 'estão' : 'está'} esperando — dá para mandar junto com o mesmo entregador.</p>` : ''}
      ${sameLine.length ? `<p class="paid-text" style="margin-top:0">🧭 Mesmo caminho (${escapeHtml(routeLineOf(order).line.name)}): ${sameLine.map(o => `#${escapeHtml(o.order_number)} (${escapeHtml(stopName(o))})`).join(', ')} também ${sameLine.length > 1 ? 'estão' : 'está'} esperando — manda junto com o mesmo entregador.</p>` : ''}
      ${couriers.length ? `
        <div class="field"><label>${streets.length ? '3' : '2'}. Entregador</label>
          <select name="courier" required>
            <option value="">Escolha…</option>
            ${couriers.map(c => `<option value="${c.id}" ${couriers.length === 1 ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
        <p class="muted" style="font-size:13px">O entregador vai confirmar no celular dele que pegou exatamente estes itens.</p>
        <button class="btn primary block" type="submit">Despachar</button>`
      : `<p class="status-cancelled">Nenhum entregador cadastrado. Cadastre em Loja → 👤 Usuários (função Entregador) para usar a conferência dupla.</p>
        <button class="btn block" type="button" id="dispatch-no-courier">Só marcar "Saiu para entrega"</button>`}
    </form>`);

  const form = modal.querySelector('#dispatch-form');

  modal.querySelector('#dispatch-no-courier')?.addEventListener('click', () => {
    if (!form.checkValidity()) return form.reportValidity();
    closeModal();
    notifyOnStatusChange(orderId, 'out_for_delivery');
    updateOrderStatus(orderId, 'out_for_delivery');
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    notifyOnStatusChange(orderId, 'out_for_delivery');

    try {
      await api(`/api/admin/orders/${orderId}/dispatch`, {
        method: 'POST',
        body: JSON.stringify({ checked: true, courier_id: form.courier.value, delivery_street: form.street?.value || '' }),
      });
      closeModal();
      toast(`Pedido #${order.order_number} despachado!`);
      await refreshAfterOrderChange();
    } catch (err) {
      toast(err.message, true);
      button.disabled = false;
    }
  });
}

/* ---------------- Tela do entregador ---------------- */

const isCourier = () => state.me?.role === 'entregador';
// Administrador vê tudo; funcionário (caixa) não vê faturamento da loja nem mexe em preço/configuração.
const isAdminUser = () => state.me?.role === 'admin';
let courierKnown = null;

async function loadCourier() {
  try {
    const data = await api('/api/admin/courier/orders');
    const upcoming = data.upcoming || [];
    const ids = new Set([...data.active, ...upcoming].map(o => o.id));

    // Apita quando chega pedido de entrega na loja e quando uma entrega cai para ele.
    if (courierKnown) {
      if (data.active.some(o => !courierKnown.has(o.id))) {
        beep();
        navigator.vibrate?.([200, 100, 200]);
        toast('🛵 Entrega nova para você!');
      } else if (upcoming.some(o => !courierKnown.has(o.id))) {
        beep();
        navigator.vibrate?.([200, 100, 200]);
        toast('🔔 Pedido novo para entrega chegou na loja!');
      }
    }

    courierKnown = ids;

    loadedVersion = loadedVersion || data.app_version;
    if (data.app_version && data.app_version !== loadedVersion && !document.getElementById('modal')) {
      location.reload();
      return;
    }

    state.courier = data;

    if (!document.getElementById('modal')) renderCourier();
  } catch (err) {
    toast(err.message, true);
  }
}

function courierOrderHtml(o) {
  const paid = o.payment_status === 'paid';
  const cash = cashDue(o);
  // Cidade da loja (Loja > Geral > Rodapé: "Cidade, estado e CEP", sem o CEP) ajuda o Maps a achar a rua certa.
  const city = String(state.store?.profile?.address_line2 || '').split('·')[0].trim();
  const mapQuery = encodeURIComponent([o.address, o.delivery_zone, city].filter(Boolean).join(', '));
  const phone = String(o.customer_phone || '').replace(/\D/g, '');

  return `
    <article class="card">
      <h3 style="margin:0">Pedido ${escapeHtml(o.public_code)} · ${escapeHtml(o.customer_name)}</h3>
      <p style="margin:6px 0">📍 ${escapeHtml(o.address || '')}${o.delivery_zone ? ` · ${escapeHtml(o.delivery_zone)}` : ''}</p>
      ${o.notes ? `<p class="muted" style="margin:0 0 6px">📝 ${escapeHtml(o.notes)}</p>` : ''}
      <ul class="order-items">${o.order_items.map(i => `<li><span><strong>${i.quantity}×</strong> ${escapeHtml(i.product_name)}</span></li>`).join('')}</ul>
      <p style="font-size:17px;margin:8px 0">${paid
        ? '✅ <strong>Já está pago</strong> — não cobrar'
        : `💰 Cobrar <strong>${money(o.total_cents)}</strong> · ${escapeHtml(paymentText(o))}${o.change_for_cents ? `<br>💵 Levar troco: <strong>${money(o.change_for_cents - cash)}</strong> (cliente paga com ${money(o.change_for_cents)})` : ''}`}</p>
      ${o.courier_issue ? `<p class="status-cancelled">⚠️ Você apontou: ${escapeHtml(o.courier_issue)}</p>` : ''}
      ${o.courier_confirmed_at
        ? `<div class="row">
            <a class="btn small" href="https://www.google.com/maps/search/?api=1&query=${mapQuery}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">🗺️ Mapa</a>
            ${phone.length >= 10 ? `<a class="btn small" href="https://wa.me/55${escapeHtml(phone)}" target="_blank" rel="noopener" style="text-decoration:none;color:inherit">💬 Cliente</a>` : ''}
            <button class="btn primary" data-courier-done="${o.id}">✅ Entregue</button>
          </div>`
        : `<p class="muted" style="margin:0 0 8px">Antes de sair, confira se pegou exatamente estes itens.</p>
          <div class="row">
            <button class="btn primary" data-courier-ok="${o.id}">✅ Conferi — peguei exatamente isso</button>
            <button class="btn danger small" data-courier-issue="${o.id}">⚠️ Tem diferença</button>
          </div>`}
    </article>`;
}

function renderCourier() {
  const d = state.courier;
  const active = d?.active || [];
  const groups = new Map();

  for (const o of active) {
    const key = o.delivery_street || o.delivery_zone || 'Outras';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  app.innerHTML = `
    <header class="header">
      <img src="${escapeHtml(document.querySelector('meta[name="store-logo"]')?.content || 'assets/logo.png')}" alt="" />
      <div><h1>Minhas entregas</h1><p class="muted" style="margin:0">👤 ${escapeHtml(state.me.name)}</p></div>
      <div class="spacer"></div>
      <button class="btn small" id="logout">Sair</button>
    </header>
    ${state.push?.ready && !state.push.thisDevice && 'Notification' in window && Notification.permission !== 'denied'
      ? '<button class="btn primary block" id="push-on" style="margin-bottom:12px">🔔 Ativar aviso de pedido novo neste celular</button>'
      : state.push?.thisDevice ? '<p class="muted" style="margin:0 0 10px;font-size:13px">🔔 Avisos ligados neste celular.</p>' : ''}
    ${!d ? '<p class="empty">Carregando…</p>' : !active.length
      ? '<p class="empty">Nenhuma entrega com você agora.<br>A tela atualiza sozinha e apita quando chegar uma.</p>'
      : [...groups.entries()].map(([key, list]) => `<h2 class="section-title">📍 ${escapeHtml(key)}${list.length > 1 ? ` · ${list.length} entregas juntas` : ''}</h2>${list.map(courierOrderHtml).join('')}`).join('')}
    ${d?.upcoming?.length ? `
      <div class="card warn">
        <strong>🔔 Chegando na loja (${d.upcoming.length}) — vai se preparando</strong>
        <ul class="order-items">${d.upcoming.map(o => `<li><span>Pedido ${escapeHtml(o.public_code)} · ${escapeHtml([o.delivery_zone, o.delivery_street].filter(Boolean).join(' · ') || 'Entrega')}</span><span class="muted">${STATUS_LABELS[o.status]} · ${timeOf(o.created_at)}</span></li>`).join('')}</ul>
      </div>` : ''}
    ${d?.delivered_today?.length ? `
      <div class="card"><strong>Entregues hoje (${d.delivered_today.length})</strong>
        <ul class="order-items">${d.delivered_today.map(o => `<li><span>${escapeHtml(o.public_code)} ${escapeHtml(o.customer_name)}</span><span>${timeOf(o.closed_at)}</span></li>`).join('')}</ul>
      </div>` : ''}`;
}

async function courierConfirm(orderId, ok) {
  let issue = '';

  if (!ok) {
    issue = (prompt('Qual é a diferença? (ex.: veio 11 latas em vez de 12)') || '').trim();
    if (issue.length < 3) return;
  }

  try {
    await api(`/api/admin/courier/orders/${orderId}/confirm`, { method: 'POST', body: JSON.stringify({ ok, issue }) });
    toast(ok ? 'Conferido! Boa entrega 🛵' : 'Diferença enviada para a loja.');
    await loadCourier();
  } catch (err) {
    toast(err.message, true);
  }
}

function openCourierDelivered(orderId) {
  const o = state.courier?.active.find(x => x.id === orderId);

  if (!o) return;

  const modal = openModal(`
    <div class="sheet-head"><h2 style="margin:0">✅ Entregar pedido ${escapeHtml(o.public_code)}</h2><button type="button" data-close-modal aria-label="Fechar">✕</button></div>
    ${o.payment_status === 'paid'
      ? `<p>Pedido já pago.</p><button class="btn primary block" data-courier-pay="">Confirmar entrega</button>`
      : fiadoPart(o) > 0
      ? `<p style="margin-top:0">📒 <strong>Fiado combinado com a loja</strong>: ${escapeHtml(paymentText(o))}.
          ${fiadoPart(o) < o.total_cents ? `<br>Receba <strong>${money(o.total_cents - fiadoPart(o))}</strong> na hora (a parte que não é fiado).` : '<br>Não precisa receber nada.'}</p>
        <button class="btn primary block" data-courier-pay="">Confirmar entrega</button>`
      : `<p style="margin-top:0">Recebeu <strong>${money(o.total_cents)}</strong>. Como o cliente pagou?</p>
        <div class="pay-options">
          ${PAYMENT_CHOICES.map(m => `<button type="button" class="btn pay-option ${o.payment_method === m && !o.payment_split ? 'primary' : ''}" data-courier-pay="${m}"><span style="font-size:26px">${PAYMENT_ICONS[m]}</span>${PAYMENT_LABELS[m]}</button>`).join('')}
        </div>
        ${o.payment_split ? `<button type="button" class="btn primary block" data-courier-pay="split" style="margin-top:10px">Como combinado: ${escapeHtml(paymentText(o))}</button>` : ''}`}`);

  modal.addEventListener('click', async event => {
    const btn = event.target.closest('[data-courier-pay]');

    if (!btn) return;

    const choice = btn.dataset.courierPay;
    const body = choice === 'split'
      ? { payment_split: { first_method: o.payment_split[0].method, first_cents: o.payment_split[0].cents, second_method: o.payment_split[1].method } }
      : choice ? { payment_method: choice } : {};

    btn.disabled = true;

    try {
      await api(`/api/admin/courier/orders/${orderId}/delivered`, { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      toast(`Pedido ${o.public_code} entregue! ✅`);
      await loadCourier();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });
}

/* ---------------- Auditoria ---------------- */

const AUDIT_FILTERS = [
  ['', 'Tudo'],
  ['product', 'Produtos e preços'],
  ['credit', '📒 Fiado'],
  ['order.cancel', 'Cancelamentos'],
  ['order.discount', 'Descontos'],
  ['order.add_items', 'Itens adicionados'],
  ['order.edit_items', 'Itens removidos/editados'],
  ['order.reopen', 'Pedidos reabertos'],
  ['order.refund', 'Estornos (pagamento desmarcado)'],
  ['order.paid', 'Pagamentos marcados'],
  ['order.dispatch', 'Despachos (conferência do caixa)'],
  ['order.courier', 'Conferência do entregador'],
  ['order.delivered', 'Entregas do entregador'],
  ['cash', 'Caixa'],
  ['pdv', 'Fechamento PDV'],
  ['staff', 'Usuários'],
  ['store', 'Configurações da loja'],
  ['zone', 'Bairros e taxas'],
  ['coupon', 'Cupons de compensação'],
];

async function loadAudit() {
  const a = state.audit;

  try {
    const params = new URLSearchParams({ from: a.from, to: a.to });
    if (a.action) params.set('action', a.action);
    a.entries = (await api(`/api/admin/audit?${params}`)).entries;
  } catch (err) {
    a.entries = [];
    toast(err.message, true);
  }

  if (state.tab === 'store' && state.storeTab === 'auditoria') renderTab();
}

function storeAuditHtml() {
  const a = state.audit;

  if (!a.entries) {
    loadAudit();
  }

  return `
    <div class="card">
      <h2 style="margin-top:0">📜 Auditoria</h2>
      <p class="muted" style="font-size:13px;margin-top:0">Quem mudou preço, cancelou, deu desconto, desmarcou pagamento, despachou, mexeu no caixa ou nos usuários.</p>
      <div class="filters">
        <label>De <input type="date" id="audit-from" value="${a.from}" class="btn small" /></label>
        <label>Até <input type="date" id="audit-to" value="${a.to}" class="btn small" /></label>
        <select id="audit-action" class="btn small">${AUDIT_FILTERS.map(([v, l]) => `<option value="${v}" ${a.action === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn primary small" id="audit-apply">Filtrar</button>
      </div>
    </div>
    ${!a.entries ? '<p class="empty">Carregando…</p>' : !a.entries.length ? '<div class="card"><p class="muted" style="margin:0">Nada registrado neste período.</p></div>' : `
      <div class="table-wrap">
        <table class="history">
          <thead><tr><th>Quando</th><th>Quem</th><th>O que</th></tr></thead>
          <tbody>${a.entries.map(e => `
            <tr><td>${dateTimeOf(e.created_at)}</td><td><strong>${escapeHtml(e.user_name)}</strong></td><td>${escapeHtml(e.summary)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>`}`;
}

/* ---------------- Caixa → Fechamento PDV ---------------- */

const dayLabel = ymd => String(ymd || '').split('-').reverse().join('/');
const periodLabel = (from, to) => (from === to ? dayLabel(from) : `${dayLabel(from)} a ${dayLabel(to)}`);
// Período do fechamento PDV com horário (sem horário ou dia inteiro = só as datas).
const pdvPeriodLabel = (from, to, fromTime, toTime) => {
  const ft = fromTime || '00:00';
  const tt = toTime || '23:59';

  if (ft === '00:00' && tt === '23:59') return periodLabel(from, to);

  return from === to ? `${dayLabel(from)}, das ${ft} às ${tt}` : `${dayLabel(from)} ${ft} a ${dayLabel(to)} ${tt}`;
};

// Aba "💰 Caixa": o turno (todos), o fechamento PDV e o resumo do dia (administrador) e um histórico só.
// Ordem = fluxo do dia: abre o caixa → trabalha → fecha o caixa → gera o fechamento PDV.
function cashAreaHtml() {
  const sections = [
    ['caixa', '💰 Caixa do turno'],
    ...(isAdminUser() ? [['fechamento', '🧮 Fechamento PDV'], ['resumo', '📅 Resumo do dia']] : []),
    ['historico', '📚 Histórico'],
  ];

  if (!sections.some(([key]) => key === state.financeTab)) state.financeTab = 'caixa';

  const body = {
    caixa: () => cashTabHtml(),
    fechamento: () => `${openCashWarningHtml()}${pdvGenerateHtml()}`,
    resumo: () => dailySummaryHtml(),
    historico: () => cashHistoryHtml(),
  }[state.financeTab]();

  return `
    <nav class="tabs sub-tabs">
      ${sections.map(([key, label]) => `<button data-finance-tab="${key}" class="${state.financeTab === key ? 'active' : ''}">${label}</button>`).join('')}
    </nav>
    ${body}`;
}

// Fechamento PDV com o caixa ainda aberto: avisa (a conferência da gaveta ainda não foi feita).
function openCashWarningHtml() {
  const open = state.cash?.open;

  if (!open) return '';

  return `
    <div class="card warn">
      <strong>⚠️ O caixa do turno ainda está aberto</strong> (desde ${dateTimeOf(open.opened_at)}${open.opened_by_name ? `, por ${escapeHtml(open.opened_by_name)}` : ''}).
      <p class="muted" style="margin:6px 0 8px">O ideal é fechar o caixa (conferir gaveta, maquininha e Pix) antes de finalizar o fechamento PDV.</p>
      <button class="btn small" data-finance-tab="caixa">💰 Ir para o caixa</button>
    </div>`;
}

// Histórico único: fechamentos PDV (administrador) + turnos de caixa.
function cashHistoryHtml() {
  if (isAdminUser() && state.pdv.detail) return pdvHistoryHtml();

  const turns = state.cash ? cashSessionsTableHtml(state.cash.history) : '<p class="empty">Carregando…</p>';

  return `
    ${isAdminUser() ? `<h2 class="section-title">🧮 Fechamentos PDV</h2>${pdvHistoryHtml()}` : ''}
    ${turns}`;
}

/* ----- Resumo do dia ----- */

async function loadDailySummary() {
  try {
    state.daily.data = (await api(`/api/admin/daily-summary?date=${state.daily.date}`)).summary;
  } catch (err) {
    // Guarda o erro (com a data) para a tela não ficar tentando de novo sem parar.
    state.daily.data = { date: state.daily.date, error: err.message };
  }

  if (state.tab === 'cash' && state.financeTab === 'resumo') renderTab();
}

function dailySummaryHtml() {
  const d = state.daily;
  const s = d.data;
  const header = `
    <div class="card row" style="justify-content:space-between;align-items:center">
      <strong>📅 Resumo do dia</strong>
      <input type="date" id="daily-date" value="${d.date}" class="btn small" />
    </div>`;

  if (!s || s.date !== d.date) {
    if (!d.loading) {
      d.loading = true;
      loadDailySummary().finally(() => { d.loading = false; });
    }
    return `${header}<p class="empty">Carregando…</p>`;
  }

  if (s.error) return `${header}<p class="empty">${escapeHtml(s.error)}</p>`;

  const o = s.occurrences;
  const reasons = Object.entries(o.cancel_reasons);
  const paymentRows = Object.entries(s.payments).filter(([, v]) => v).map(([m, v]) => `<li><span>${PAYMENT_LABELS[m] || m}</span><span>${money(v)}</span></li>`).join('');

  return `
    ${header}
    <div class="stats">
      <div class="card"><span class="muted">Faturamento</span><strong>${money(s.revenue_cents)}</strong>${s.pending_cents ? `<span class="muted">${money(s.pending_cents)} ainda a receber</span>` : ''}</div>
      <div class="card"><span class="muted">Lucro estimado</span><strong>${money(s.profit_cents)}</strong><span class="muted">${s.profit_based_on_cost ? 'pelo custo cadastrado' : ''}${s.profit_based_on_cost ? ' + ' : ''}margem padrão ${s.margin_percent}%</span></div>
      <div class="card"><span class="muted">Pedidos</span><strong>${s.orders_count}</strong>${s.cancelled_count ? `<span class="muted">+ ${s.cancelled_count} cancelado(s)</span>` : ''}</div>
      <div class="card"><span class="muted">Ticket médio</span><strong>${money(s.average_ticket_cents)}</strong></div>
    </div>
    ${s.top_products.length ? `
      <div class="card"><strong>🏆 Produtos que mais saíram</strong>
        <ul class="order-items">${s.top_products.map(p => `<li><span>${p.quantity}× ${escapeHtml(p.name)}</span><span>${money(p.total_cents)}</span></li>`).join('')}</ul>
      </div>` : ''}
    ${paymentRows ? `<div class="card"><strong>💳 Recebido por forma de pagamento</strong><ul class="order-items">${paymentRows}</ul></div>` : ''}
    <div class="card ${s.out_of_stock.length ? 'warn' : ''}"><strong>📦 Estoque crítico</strong>
      <p class="muted" style="margin:6px 0 0">${s.out_of_stock.length
        ? `Esgotados entre os Mais Vendidos / Leve junto: ${s.out_of_stock.map(escapeHtml).join(', ')}.`
        : 'Nenhum produto em destaque esgotado.'} <br>(O sistema não controla estoque; aqui aparecem os produtos marcados como esgotado.)</p>
    </div>
    <div class="card"><strong>⚠️ Ocorrências</strong>
      <ul class="order-items">
        <li><span>Cancelamentos</span><span>${s.cancelled_count ? reasons.map(([r, n]) => `${escapeHtml(r)} (${n})`).join(', ') : 'nenhum'}</span></li>
        <li><span>Entregues fora do prazo</span><span>${o.late_count ? `${o.late_count}: ${o.late_orders.map(n => `#${n}`).join(', ')}` : 'nenhum'}</span></li>
        <li><span>Diferença apontada pelo entregador</span><span>${o.courier_issues.length ? o.courier_issues.map(i => `#${i.order_number}: ${escapeHtml(i.issue)}`).join('; ') : 'nenhuma'}</span></li>
        <li><span>Estornos (pagamento desmarcado)</span><span>${o.refunds.length || 'nenhum'}</span></li>
        <li><span>Descontos dados no painel</span><span>${o.discounts_given || 'nenhum'}${s.discounts_cents ? ` · total de descontos ${money(s.discounts_cents)}` : ''}</span></li>
      </ul>
    </div>
    <p class="muted" style="font-size:13px">Todo dia às 22:30 este resumo chega no celular de quem ativou os avisos. Lucro estimado = preço − custo cadastrado no produto; sem custo, usa a margem padrão (Loja → Geral), menos os descontos.</p>`;
}

function setPdvRange(range) {
  const today = todaySaoPaulo();
  const shift = days => {
    const d = new Date(`${today}T12:00:00-03:00`);
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  };

  Object.assign(state.pdv, { fromTime: '00:00', toTime: '23:59' });
  if (range === 'today') Object.assign(state.pdv, { from: today, to: today });
  if (range === 'yesterday') Object.assign(state.pdv, { from: shift(1), to: shift(1) });
  if (range === '7') Object.assign(state.pdv, { from: shift(6), to: today });

  state.pdv.preview = null;
  renderTab();
}

// Relatório do fechamento (mesmo desenho para o gerado agora e para o do histórico).
function pdvReportHtml(s, { from, to, fromTime, toTime, closing } = {}) {
  const row = (label, value, strong) => `<li><span>${strong ? `<strong>${label}</strong>` : label}</span><span>${strong ? `<strong>${value}</strong>` : value}</span></li>`;
  const p = s.payments || {};
  const unpaid = s.unpaid_cents ?? 0;

  return `
    <div class="card">
      <h2 style="margin-top:0">${closing ? `Fechamento nº ${escapeHtml(closing.number)}` : 'FECHAMENTO DO PERÍODO'}</h2>
      <p class="muted" style="margin-top:0">Período: <strong>${pdvPeriodLabel(from, to, fromTime, toTime)}</strong>${closing ? `<br>Finalizado em ${dateTimeOf(closing.finalized_at)} por <strong>${escapeHtml(closing.finalized_by_name)}</strong>` : ''}</p>
      <ul class="order-items">
        ${row('Quantidade de pedidos', s.orders_count)}
        ${row('Valor dos produtos', money(s.products_cents))}
        ${row('Taxas de entrega', money(s.delivery_fees_cents))}
        ${row('Descontos', `− ${money(s.discounts_cents)}`)}
        ${row('Total final', money(s.total_cents), true)}
      </ul>
      <h3 style="margin:16px 0 4px">FORMAS DE PAGAMENTO</h3>
      <ul class="order-items">
        ${row('📲 PIX', money(p.pix))}
        ${row('💵 Dinheiro', money(p.dinheiro))}
        ${row('💳 Débito', money(p.debito))}
        ${row('💳 Crédito', money(p.credito))}
        ${p.cartao ? row('💳 Cartão (sem débito/crédito informado)', money(p.cartao)) : ''}
        ${row('Total recebido', money(s.received_cents), true)}
      </ul>
      ${s.divergence_cents
        ? `<div class="card warn" style="margin:12px 0 0">
            <strong class="status-cancelled">⚠️ Divergência no fechamento: ${money(Math.abs(s.divergence_cents))}</strong>
            <p class="muted" style="margin:6px 0 0">${s.divergence_cents > 0 ? 'O total recebido está menor que o total final.' : 'O total recebido está maior que o total final.'}
            ${unpaid ? ` Pedidos entregues sem pagamento marcado: ${s.unpaid_orders.map(n => `#${escapeHtml(n)}`).join(', ')} (${money(unpaid)}). Marque como pago na aba 🧾 Histórico (pedidos) e gere de novo.` : ''}</p>
          </div>`
        : '<p class="paid-text" style="margin:12px 0 0">✔ O total das formas de pagamento bate com o total final.</p>'}
      ${closing?.order_numbers?.length ? `<p class="muted" style="font-size:12px;margin:12px 0 0">Pedidos incluídos: ${closing.order_numbers.map(n => `#${escapeHtml(n)}`).join(', ')}</p>` : ''}
    </div>`;
}

function pdvGenerateHtml() {
  const d = state.pdv;
  const pv = d.preview;

  const form = `
    <div class="card">
      <h2 style="margin-top:0">🧮 Fechamento PDV</h2>
      <p class="muted" style="margin-top:0">Resumo dos pedidos <strong>entregues</strong> do período que ainda não entraram em nenhum fechamento, para passar para o PDV da loja. Depois de finalizado, esses pedidos nunca mais entram em outro fechamento.</p>
      <div class="row" style="margin-bottom:10px">
        ${[['today', 'Hoje'], ['yesterday', 'Ontem'], ['7', '7 dias']].map(([k, l]) => `<button class="btn small" data-pdv-range="${k}">${l}</button>`).join('')}
      </div>
      <div class="filters">
        <label>De <input type="date" id="pdv-from" value="${d.from}" class="btn small" /> <input type="time" id="pdv-from-time" value="${d.fromTime}" class="btn small" aria-label="Hora inicial" /></label>
        <label>Até <input type="date" id="pdv-to" value="${d.to}" class="btn small" /> <input type="time" id="pdv-to-time" value="${d.toTime}" class="btn small" aria-label="Hora final" /></label>
        <button class="btn primary small" id="pdv-generate">Gerar fechamento</button>
      </div>
    </div>`;

  if (!pv) return form;

  if (!pv.summary.orders_count) {
    return `${form}
      <div class="card"><p style="margin:0">Nenhum pedido entregue e ainda não fechado em ${pdvPeriodLabel(pv.from, pv.to, pv.from_time, pv.to_time)}.</p>
      ${pv.open_orders.length ? `<p class="muted" style="margin:8px 0 0">Ainda em andamento (ficam para depois): ${pv.open_orders.map(n => `#${escapeHtml(n)}`).join(', ')}</p>` : ''}</div>`;
  }

  return `${form}
    ${pdvReportHtml(pv.summary, { from: pv.from, to: pv.to, fromTime: pv.from_time, toTime: pv.to_time })}
    ${pv.open_orders.length ? `<div class="card warn"><strong>⚠️ ${pv.open_orders.length} pedido(s) do período ainda não foram entregues</strong><p class="muted" style="margin:6px 0 0">Eles ficaram de fora deste fechamento e entram num próximo: ${pv.open_orders.map(n => `#${escapeHtml(n)}`).join(', ')}</p></div>` : ''}
    <div class="row">
      <button class="btn" id="pdv-print">🖨️ Imprimir</button>
      <button class="btn primary" id="pdv-finalize">✅ Finalizar fechamento</button>
    </div>`;
}

async function generatePdv(button) {
  const d = state.pdv;
  d.from = document.getElementById('pdv-from').value || d.from;
  d.to = document.getElementById('pdv-to').value || d.to;
  d.fromTime = document.getElementById('pdv-from-time').value || '00:00';
  d.toTime = document.getElementById('pdv-to-time').value || '23:59';
  button.disabled = true;

  try {
    d.preview = await api(`/api/admin/pdv/preview?from=${d.from}&to=${d.to}&from_time=${d.fromTime}&to_time=${d.toTime}`);
    renderTab();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
}

async function finalizePdv(button) {
  const pv = state.pdv.preview;
  const s = pv.summary;
  const warning = s.divergence_cents ? `\n\n⚠️ ATENÇÃO: há divergência de ${money(Math.abs(s.divergence_cents))}.` : '';

  if (!confirm(`Finalizar o fechamento de ${pdvPeriodLabel(pv.from, pv.to, pv.from_time, pv.to_time)}?\n\n${s.orders_count} pedido(s) · total ${money(s.total_cents)}\n\nEsses pedidos ficam marcados como fechados e não entram mais em nenhum outro fechamento.${warning}`)) return;

  button.disabled = true;

  try {
    const { closing } = await api('/api/admin/pdv/finalize', {
      method: 'POST',
      body: JSON.stringify({ from: pv.from, to: pv.to, from_time: pv.from_time, to_time: pv.to_time, order_ids: pv.order_ids, expected_total_cents: s.total_cents }),
    });

    toast(`Fechamento nº ${closing.number} finalizado!`);
    state.pdv.preview = null;
    state.financeTab = 'historico';
    await openPdvClosing(closing.id);
    loadPdvClosings();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
}

async function loadPdvClosings() {
  try {
    state.pdv.closings = (await api('/api/admin/pdv/closings')).closings;
    if (state.tab === 'cash' && state.financeTab === 'historico' && !state.pdv.detail) renderTab();
  } catch (err) {
    toast(err.message, true);
  }
}

async function openPdvClosing(id) {
  try {
    state.pdv.detail = (await api(`/api/admin/pdv/closings/${id}`)).closing;
    state.tab = 'cash';
    state.financeTab = 'historico';
    render();
    window.scrollTo(0, 0);
  } catch (err) {
    toast(err.message, true);
  }
}

function pdvHistoryHtml() {
  const d = state.pdv;

  if (d.detail) {
    const c = d.detail;

    return `
      <div class="row" style="margin-bottom:12px">
        <button class="btn small" id="pdv-back">← Voltar</button>
        <button class="btn small" id="pdv-print-detail">🖨️ Imprimir</button>
      </div>
      ${pdvReportHtml(c, { from: c.period_from, to: c.period_to, fromTime: c.period_from_time, toTime: c.period_to_time, closing: c })}`;
  }

  if (!d.closings) return '<p class="empty">Carregando fechamentos…</p>';
  if (!d.closings.length) return '<div class="card"><p class="muted" style="margin:0">Nenhum fechamento finalizado ainda.</p></div>';

  return `
    <div class="table-wrap">
      <table class="history">
        <thead><tr><th>Nº</th><th>Período</th><th class="num">Pedidos</th><th class="num">Total final</th><th>Finalizado</th><th></th></tr></thead>
        <tbody>
          ${d.closings.map(c => `
            <tr>
              <td><strong>${escapeHtml(c.number)}</strong></td>
              <td>${pdvPeriodLabel(c.period_from, c.period_to, c.period_from_time, c.period_to_time)}</td>
              <td class="num">${c.orders_count}</td>
              <td class="num"><strong>${money(c.total_cents)}</strong>${c.divergence_cents ? `<br><span class="status-cancelled">⚠️ ${money(Math.abs(c.divergence_cents))}</span>` : ''}</td>
              <td>${dateTimeOf(c.finalized_at)}<br><span class="muted">${escapeHtml(c.finalized_by_name)}</span></td>
              <td><button class="btn small" data-pdv-open="${c.id}">Abrir</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

// Versão para impressão (papel da impressora configurada).
function printPdv(s, { from, to, fromTime, toTime, closing } = {}) {
  const p = s.payments || {};
  const item = (label, value) => `<div class="item"><span>${label}</span><span>${value}</span></div>`;
  const line = '<div class="sep"></div>';
  const settings = printSettings();

  printDocument(`
    <div class="receipt">
      ${settings.header ? `<div class="center big">${escapeHtml(settings.header)}</div>` : ''}
      <div class="center big">${closing ? `FECHAMENTO Nº ${escapeHtml(closing.number)}` : 'FECHAMENTO (PRÉVIA)'}</div>
      <div class="center">Período: ${pdvPeriodLabel(from, to, fromTime, toTime)}</div>
      ${closing ? `<div class="center">Finalizado ${dateTimeOf(closing.finalized_at)}</div><div class="center">por ${escapeHtml(closing.finalized_by_name)}</div>` : `<div class="center">Gerado ${dateTimeOf(new Date().toISOString())}</div>`}
      ${line}
      <div class="big">FECHAMENTO DO PERÍODO</div>
      ${item('Qtd. de pedidos', s.orders_count)}
      ${item('Valor dos produtos', money(s.products_cents))}
      ${item('Taxas de entrega', money(s.delivery_fees_cents))}
      ${item('Descontos', `- ${money(s.discounts_cents)}`)}
      <div class="item big"><span>TOTAL FINAL</span><span>${money(s.total_cents)}</span></div>
      ${line}
      <div class="big">FORMAS DE PAGAMENTO</div>
      ${item('PIX', money(p.pix))}
      ${item('Dinheiro', money(p.dinheiro))}
      ${item('Débito', money(p.debito))}
      ${item('Crédito', money(p.credito))}
      ${p.cartao ? item('Cartão (não inform.)', money(p.cartao)) : ''}
      <div class="item big"><span>TOTAL RECEBIDO</span><span>${money(s.received_cents)}</span></div>
      ${line}
      <div class="center">${s.divergence_cents ? `*** DIVERGÊNCIA: ${money(Math.abs(s.divergence_cents))} ***` : 'Formas de pagamento conferem com o total.'}</div>
    </div>`, settings);
}

/* ---------------- Editar pedido (remover/mudar quantidade/adicionar item) ---------------- */

function openEditOrderModal(orderId) {
  const order = findOrder(orderId);
  if (!order) return;

  const modal = openModal(`
    <div class="sheet-head"><h2 style="margin:0">✏️ Editar pedido #${escapeHtml(order.order_number)}</h2><button type="button" data-close-modal aria-label="Fechar">✕</button></div>
    <p class="muted">Tire, mude a quantidade ou adicione itens. O preço é sempre recalculado pelo servidor.</p>
    <div id="edit-order-items"></div>
    <p class="muted" style="margin:14px 0 0">Adicionar produto:</p>
    <div class="search-bar"><input id="add-order-search" type="search" placeholder="🔎 Buscar produto" autocomplete="off" /></div>
    <div id="add-order-products"></div>`);

  const renderItems = () => {
    const current = findOrder(orderId);
    if (!current) return closeModal();
    const onlyOne = current.order_items.length <= 1;
    modal.querySelector('#edit-order-items').innerHTML = current.order_items.map(i => `
      <div class="cart-line">
        <span class="name">${escapeHtml(i.product_name)}${i.variant_name ? ` — ${escapeHtml(i.variant_name)}` : ''}<br><span class="muted">${money(i.subtotal_cents)}</span></span>
        ${i.by_weight
          ? '<span class="muted" style="font-size:12px">⚖️ ajuste pela balança</span>'
          : `<span class="qty"><button type="button" data-edit-item-qty="${i.id}" data-delta="-1">−</button><span>${i.quantity}</span><button type="button" data-edit-item-qty="${i.id}" data-delta="1">+</button></span>`}
        <button type="button" class="btn small danger" data-remove-order-item="${i.id}"${onlyOne ? ' disabled title="Não dá pra tirar o último item"' : ''}>🗑</button>
      </div>`).join('');
  };

  const renderProducts = () => {
    const query = modal.querySelector('#add-order-search').value.trim();
    const products = query ? searchAdminProducts(query) : state.products.filter(p => p.available);
    modal.querySelector('#add-order-products').innerHTML = products.slice(0, 80).map(product => `
      <div class="cart-line">
        <span class="name">${escapeHtml(product.name)}<br><span class="muted">${money(promoPriceNow(product) ?? product.price_cents)}</span></span>
        ${product.variants?.length
          ? `<button type="button" class="btn small primary" data-add-existing-product="${product.id}">Escolher</button>`
          : `<button type="button" class="btn small primary" data-add-existing-product="${product.id}">Adicionar</button>`}
      </div>`).join('') || '<p class="muted">Nenhum produto encontrado.</p>';
  };

  modal.querySelector('#add-order-search').addEventListener('input', renderProducts);

  modal.addEventListener('click', async event => {
    const removeBtn = event.target.closest('[data-remove-order-item]');
    if (removeBtn) {
      if (removeBtn.disabled) return;
      if (!confirm('Tirar este item do pedido?')) return;
      await removeOrderItem(orderId, removeBtn.dataset.removeOrderItem, renderItems);
      return;
    }

    const qtyBtn = event.target.closest('[data-edit-item-qty]');
    if (qtyBtn) {
      const current = findOrder(orderId);
      const item = current?.order_items.find(i => i.id === qtyBtn.dataset.editItemQty);
      if (!item) return;
      const newQty = item.quantity + Number(qtyBtn.dataset.delta);
      if (newQty < 1 || newQty > 99) return;
      await changeOrderItemQty(orderId, item.id, newQty, renderItems);
      return;
    }

    const addBtn = event.target.closest('[data-add-existing-product]');
    if (addBtn) {
      const product = state.products.find(p => p.id === addBtn.dataset.addExistingProduct);
      if (!product) return;
      if (product.variants?.length) {
        addBtn.closest('#add-order-products').innerHTML = variantPickerHtmlForExisting(product, orderId);
      } else {
        await submitAddedOrderItem(orderId, { product_id: product.id, quantity: 1 }, renderItems, renderProducts);
      }
      return;
    }

    const variantBtn = event.target.closest('[data-add-existing-variant]');
    if (variantBtn) {
      await submitAddedOrderItem(orderId, { product_id: variantBtn.dataset.addExistingVariant, variant_id: variantBtn.dataset.variant, quantity: 1 }, renderItems, renderProducts);
      return;
    }

    if (event.target.closest('[data-add-order-back]')) renderProducts();
  });

  renderItems();
  renderProducts();
  modal.querySelector('#add-order-search').focus();
}

function variantPickerHtmlForExisting(product, orderId) {
  return `<div class="sheet-head"><strong>${escapeHtml(product.name)}</strong><button type="button" data-add-order-back="1">← Voltar</button></div>${product.variants.map(v => `
    <div class="cart-line"><span class="name">${escapeHtml(v.name)}<br><span class="muted">${money(v.price_cents)}</span></span>
    <button type="button" class="btn small primary" data-add-existing-variant="${product.id}" data-variant="${v.id}" data-order="${orderId}">Adicionar</button></div>`).join('')}`;
}

async function submitAddedOrderItem(orderId, item, renderItems, renderProducts) {
  try {
    await api(`/api/admin/orders/${orderId}/items`, { method: 'POST', body: JSON.stringify({ items: [item] }) });
    toast('Item adicionado ao pedido.');
    await refreshAfterOrderChange();
    if (renderItems) renderItems();
    if (renderProducts) renderProducts();
  } catch (err) {
    toast(err.message, true);
  }
}

async function removeOrderItem(orderId, itemId, renderItems) {
  try {
    await api(`/api/admin/orders/${orderId}/items/${itemId}`, { method: 'DELETE' });
    toast('Item removido do pedido.');
    await refreshAfterOrderChange();
    if (renderItems) renderItems();
  } catch (err) {
    toast(err.message, true);
  }
}

async function changeOrderItemQty(orderId, itemId, quantity, renderItems) {
  try {
    await api(`/api/admin/orders/${orderId}/items/${itemId}`, { method: 'PATCH', body: JSON.stringify({ quantity }) });
    await refreshAfterOrderChange();
    if (renderItems) renderItems();
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- Desconto no pedido ---------------- */

function openDiscountModal(orderId) {
  const order = findOrder(orderId);

  if (!order) return;

  const modal = openModal(`
    <div class="sheet-head"><h2 style="margin:0">🏷️ Desconto no pedido #${escapeHtml(order.order_number)}</h2><button type="button" data-close-modal aria-label="Fechar">✕</button></div>
    <form id="discount-form">
      <p class="muted">Produtos ${money(order.subtotal_cents)}${order.delivery_fee_cents ? ` + entrega ${money(order.delivery_fee_cents)}` : ''}</p>
      <div class="field"><label>Desconto em R$ (0 para tirar)</label><input name="discount" inputmode="decimal" value="${order.discount_cents ? centsToInput(order.discount_cents) : ''}" placeholder="0,00" /></div>
      <p id="discount-total" style="font-size:18px"></p>
      <button class="btn primary block" type="submit">Salvar desconto</button>
    </form>`);

  const form = modal.querySelector('#discount-form');
  const base = order.subtotal_cents + order.delivery_fee_cents;
  const update = () => {
    const d = inputToCents(form.discount.value) || 0;
    modal.querySelector('#discount-total').innerHTML = `Novo total: <strong>${money(Math.max(0, base - d))}</strong>`;
  };

  form.addEventListener('input', update);
  update();
  form.discount.focus();

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const discount = inputToCents(form.discount.value);

    if (discount === null || discount >= base) return toast('O desconto precisa ser menor que o total do pedido.', true);

    try {
      await api(`/api/admin/orders/${orderId}`, { method: 'PATCH', body: JSON.stringify({ discount_cents: discount }) });
      closeModal();
      toast(discount ? `Desconto de ${money(discount)} aplicado.` : 'Desconto removido.');
      await refreshAfterOrderChange();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------------- Usuários do painel ---------------- */

const STAFF_ROLE_LABELS = { admin: 'Administrador', caixa: 'Funcionário (caixa)', entregador: 'Entregador' };

async function loadStaff() {
  try {
    state.staff = (await api('/api/admin/staff')).staff;
  } catch (err) {
    state.staff = [];
    toast(err.message, true);
  }

  if (state.tab === 'store' && state.storeTab === 'usuarios') renderTab();
}

function storeStaffHtml() {
  if (state.me?.role !== 'admin') return '<div class="card"><p class="muted" style="margin:0">Só administrador pode ver os usuários.</p></div>';

  if (!state.staff) {
    loadStaff();
    return '<div class="card"><p class="muted" style="margin:0">Carregando…</p></div>';
  }

  return `
    <div class="card">
      <h2 style="margin-top:0">👤 Usuários do painel</h2>
      <p class="muted" style="font-size:13px;margin-top:0">Cada pessoa entra com o próprio nome e PIN. O nome de quem entrou fica registrado (por exemplo, em quem finalizou o Fechamento PDV). A senha do painel continua funcionando e entra como "Administrador".</p>
      ${state.staff.length ? `<ul class="order-items">${state.staff.map(s => `
        <li style="align-items:center;flex-wrap:wrap;gap:6px">
          <span>${s.active ? '' : '🚫 '}<strong>${escapeHtml(s.name)}</strong> <span class="muted">· ${STAFF_ROLE_LABELS[s.role] || s.role}${s.active ? '' : ' · desativado'}</span></span>
          <span class="row" style="gap:6px">
            <button class="btn small" data-staff-pin="${s.id}">🔑 PIN</button>
            <select class="btn small" data-staff-role-select="${s.id}">${Object.entries(STAFF_ROLE_LABELS).map(([v, l]) => `<option value="${v}" ${s.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <button class="btn small ${s.active ? 'danger' : ''}" data-staff-toggle="${s.id}">${s.active ? 'Desativar' : 'Reativar'}</button>
          </span>
        </li>`).join('')}</ul>` : '<p class="muted">Nenhum usuário ainda.</p>'}
    </div>
    <form class="card" id="staff-new-form" autocomplete="off">
      <strong>➕ Novo usuário</strong>
      <div class="grid-2" style="margin-top:8px">
        <div class="field"><label>Nome</label><input name="name" maxlength="60" required /></div>
        <div class="field"><label>PIN (4 a 6 números)</label><input name="pin" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" required /></div>
      </div>
      <div class="field"><label>Função</label>
        <select name="role">
          <option value="caixa">Caixa</option>
          <option value="entregador">Entregador (só vê as entregas dele no celular)</option>
          <option value="admin">Administrador (também gerencia usuários e vê a auditoria)</option>
        </select>
      </div>
      <button class="btn primary" type="submit">Criar usuário</button>
    </form>`;
}

async function createStaff(form) {
  const button = form.querySelector('[type=submit]');
  button.disabled = true;

  try {
    await api('/api/admin/staff', { method: 'POST', body: JSON.stringify({ name: form.name.value, pin: form.pin.value, role: form.role.value }) });
    toast(`Usuário ${form.name.value.trim()} criado!`);
    await loadStaff();
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
}

async function updateStaff(id, fields, message = 'Usuário atualizado.') {
  try {
    await api(`/api/admin/staff/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
    toast(message);
    await loadStaff();
  } catch (err) {
    toast(err.message, true);
  }
}

function openStaffPinModal(id) {
  const s = state.staff?.find(u => u.id === id);

  if (!s) return;

  const modal = openModal(`
    <div class="sheet-head"><h2 style="margin:0">🔑 Novo PIN de ${escapeHtml(s.name)}</h2><button type="button" data-close-modal aria-label="Fechar">✕</button></div>
    <form id="staff-pin-form" autocomplete="off">
      <div class="field"><label>PIN (4 a 6 números)</label><input name="pin" inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" required /></div>
      <button class="btn primary block" type="submit">Salvar PIN</button>
    </form>`);

  const form = modal.querySelector('#staff-pin-form');
  form.pin.focus();
  form.addEventListener('submit', event => {
    event.preventDefault();
    closeModal();
    updateStaff(id, { pin: form.pin.value }, 'PIN alterado.');
  });
}

/* ---------------- Loja ---------------- */

const STORE_TABS = [
  ['geral', '⚙️ Geral'],
  ['horarios', '🕗 Horários'],
  ['taxa', '🛵 Taxa de entrega'],
  ['impressora', '🖨️ Impressora'],
  ['whatsapp', '💬 WhatsApp'],
  ['avisos', '🔔 Avisos no celular'],
  ['usuarios', '👤 Usuários'],
  ['auditoria', '📜 Auditoria'],
];

const DAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function storeHtml() {
  // Funcionário só usa os avisos no celular.
  if (!isAdminUser()) state.storeTab = 'avisos';

  const body = {
    geral: storeGeneralHtml,
    horarios: storeHoursHtml,
    taxa: storeZonesHtml,
    impressora: storePrinterHtml,
    whatsapp: storeWhatsappHtml,
    avisos: storePushHtml,
    usuarios: storeStaffHtml,
    auditoria: storeAuditHtml,
  }[state.storeTab]();

  return `
    <nav class="tabs sub-tabs">
      ${STORE_TABS.filter(([key]) => (isAdminUser() ? true : key === 'avisos')).map(([key, label]) => `<button data-store-tab="${key}" class="${state.storeTab === key ? 'active' : ''}">${label}</button>`).join('')}
    </nav>
    ${body}`;
}

function openStatusText(s) {
  if (s.effective_open) return s.closes_at ? `Aberta até ${s.closes_at}` : 'Aberta';
  return s.opens_text ? `Fechada · abre ${s.opens_text}` : 'Fechada';
}

function storeGeneralHtml() {
  const s = state.store;

  return `
    <div class="card row" style="justify-content:space-between">
      <div>
        <strong>A loja está ${s.effective_open ? 'ABERTA' : 'FECHADA'}</strong> <span class="muted">(${escapeHtml(openStatusText(s))})</span><br>
        <span class="muted">${s.auto_hours
          ? '🕗 Abertura automática ligada: a loja abre e fecha sozinha pelo horário.'
          : (s.effective_open ? 'Clientes podem fazer pedidos.' : 'Clientes veem o cardápio, mas não conseguem pedir.')}</span>
      </div>
      ${s.auto_hours
        ? '<button class="btn" data-store-tab="horarios">Ver horários</button>'
        : `<button class="btn ${s.is_open ? 'danger' : 'primary'}" id="toggle-open">${s.is_open ? 'Fechar loja' : 'Abrir loja'}</button>`}
    </div>
    <form class="card" id="store-form">
      <div class="field"><label>Nome da loja</label><input name="name" required maxlength="80" value="${escapeHtml(s.name)}" /></div>
      <div class="field"><label>WhatsApp da loja (com DDD, só números)</label><input name="whatsapp" inputmode="tel" maxlength="20" placeholder="24999999999" value="${escapeHtml(s.whatsapp || '')}" /></div>
      <div class="field"><label>Pedido mínimo (R$)</label><input name="min_order" inputmode="decimal" value="${centsToInput(s.min_order_cents)}" /></div>
      <div class="grid-2">
        <div class="field"><label>Prazo de entrega (minutos)</label><input name="delivery_minutes" type="number" min="5" max="240" required value="${s.delivery_minutes ?? 45}" /></div>
        <div class="field"><label>Prazo de retirada (minutos)</label><input name="pickup_minutes" type="number" min="5" max="240" required value="${s.pickup_minutes ?? 20}" /></div>
      </div>
      <p class="muted" style="font-size:13px;margin-top:-4px">Contado a partir da hora do pedido. Aparece para o cliente como previsão e marca os pedidos em verde, amarelo (prazo acabando) e vermelho (passou do prazo).</p>
      <label class="check"><input type="checkbox" name="auto_accept" ${s.auto_accept !== false ? 'checked' : ''} /> ✅ Aceitar pedidos automaticamente (o pedido já chega aceito e o cliente recebe o aviso na hora; desligado, aparece o botão "Aceitar pedido")</label>
      <label class="check"><input type="checkbox" name="accept_scheduled" ${s.accept_scheduled ? 'checked' : ''} /> 🌙 Aceitar pedidos com a loja fechada (ficam aguardando a abertura; o cliente é avisado que não será entregue na hora)</label>
      <div class="field"><label>Margem de lucro padrão (%) — usada no lucro estimado dos produtos sem custo cadastrado</label><input name="margin" type="number" min="0" max="100" required value="${s.default_margin_percent ?? 30}" /></div>
      <button class="btn primary" type="submit">Salvar</button>
    </form>
    ${profileFormHtml()}
    ${birthdayFormHtml()}`;
}

// Dados que aparecem no rodapé do cardápio (stores.profile). Campo vazio = não aparece.
function profileFormHtml() {
  const p = state.store.profile || {};

  return `
    <form class="card" id="profile-form">
      <h2 style="margin-top:0">📍 Rodapé do cardápio</h2>
      <p class="muted" style="font-size:13px;margin-top:0">O que o cliente vê no fim do cardápio. Campo vazio não aparece.</p>
      <div class="field"><label>Frase abaixo do nome</label><input name="tagline" maxlength="120" placeholder="${storeCopy('Hambúrgueres · Combos · Bebidas', 'Bebidas · Mercearia · Conveniência')}" value="${escapeHtml(p.tagline || '')}" /></div>
      <div class="field"><label>Instagram (sem @)</label><input name="instagram" maxlength="60" placeholder="minhaloja" value="${escapeHtml(p.instagram || '')}" /></div>
      <div class="field"><label>Endereço (rua e bairro)</label><input name="address_line1" maxlength="120" value="${escapeHtml(p.address_line1 || '')}" /></div>
      <div class="field"><label>Cidade, estado e CEP</label><input name="address_line2" maxlength="120" value="${escapeHtml(p.address_line2 || '')}" /></div>
      <div class="field"><label>Busca do botão "Como chegar" (Google Maps; vazio = nome da loja + endereço)</label><input name="maps_query" maxlength="200" value="${escapeHtml(p.maps_query || '')}" /></div>
      <div class="field"><label>Categorias ocultas do cardápio (separadas por vírgula)</label><input name="hidden_categories" maxlength="600" placeholder="Ex.: Varejos" value="${escapeHtml((p.hidden_categories || []).join(', '))}" /><small class="muted">Os produtos continuam preservados no banco e no histórico; apenas deixam de aparecer para o cliente.</small></div>
      <label class="check"><input type="checkbox" name="alcohol_notice" ${p.alcohol_notice !== false ? 'checked' : ''} /> 🔞 Mostrar o aviso "proibida a venda para menores de 18 anos · se beber, não dirija"</label>
      <details style="margin-top:12px">
        <summary>⚙️ Recursos do cardápio desta loja</summary>
        <p class="muted" style="font-size:13px">Desative recursos específicos da Mercearia para uma loja que não os utiliza. A regra também é aplicada no servidor.</p>
        ${[
          ['chill', '🧊 Engradado gelado'],
          ['bulk', '🍻 Preço por engradado'],
          ['weight', '⚖️ Venda por kg'],
          ['category_min_orders', '📦 Mínimo por categoria'],
          ['smart_suggestions', '💡 Sugestões inteligentes'],
        ].map(([key, label]) => `<label class="check"><input type="checkbox" name="feature_${key}" ${(p.features?.[key] !== false) ? 'checked' : ''} /> ${label}</label>`).join('')}
      </details>
      <button class="btn primary" type="submit">Salvar rodapé</button>
    </form>`;
}

async function saveProfile(form) {
  const field = name => form.elements.namedItem(name);
  const hiddenCategories = field('hidden_categories').value
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const saved = await saveStore({
    profile: {
      tagline: field('tagline').value.trim(),
      instagram: field('instagram').value.trim().replace(/^@+/, ''),
      address_line1: field('address_line1').value.trim(),
      address_line2: field('address_line2').value.trim(),
      maps_query: field('maps_query').value.trim(),
      hidden_categories: hiddenCategories,
      alcohol_notice: field('alcohol_notice').checked,
      features: ['chill', 'bulk', 'weight', 'category_min_orders', 'smart_suggestions']
        .reduce((features, key) => ({ ...features, [key]: field(`feature_${key}`).checked }), {}),
    },
  }, 'Rodapé salvo!');

  const persisted = saved?.profile?.hidden_categories || [];
  if (saved && JSON.stringify(persisted) !== JSON.stringify(hiddenCategories)) {
    toast('O servidor não confirmou as categorias ocultas. Tente novamente.', true);
  }
}

function birthdayFormHtml() {
  const b = { enabled: true, type: 'percent', value: 10, amount_cents: 1000, max_cents: 2000, days_before: 3, days_after: 3, min_days_registered: 30, ...(state.store.birthday_settings || {}) };

  return `
    <form class="card" id="birthday-form">
      <h2 style="margin-top:0">🎂 Presente de aniversário</h2>
      <p class="muted" style="font-size:13px;margin-top:0">Desconto automático, uma vez por ano, no pedido feito perto do aniversário do cliente. O cliente informa o aniversário no checkout (ou o senhor cadastra no perfil dele).</p>
      <label class="check"><input type="checkbox" name="enabled" ${b.enabled ? 'checked' : ''} /> Presente ligado</label>
      <div class="grid-2">
        <div class="field"><label>Tipo</label>
          <select name="type"><option value="percent" ${b.type === 'percent' ? 'selected' : ''}>Porcentagem dos produtos</option><option value="amount" ${b.type === 'amount' ? 'selected' : ''}>Valor fixo (R$)</option></select>
        </div>
        <div class="field"><label>Porcentagem (%)</label><input name="value" type="number" min="1" max="100" value="${b.value}" /></div>
        <div class="field"><label>Valor fixo (R$)</label><input name="amount" inputmode="decimal" value="${centsToInput(b.amount_cents)}" /></div>
        <div class="field"><label>Limite do desconto em % (R$, 0 = sem limite)</label><input name="max" inputmode="decimal" value="${centsToInput(b.max_cents)}" /></div>
        <div class="field"><label>Vale a partir de quantos dias antes</label><input name="days_before" type="number" min="0" max="15" value="${b.days_before}" /></div>
        <div class="field"><label>Até quantos dias depois</label><input name="days_after" type="number" min="0" max="15" value="${b.days_after}" /></div>
      </div>
      <p class="muted" style="font-size:13px">Para evitar esperteza, aniversário informado pelo próprio cliente só vale depois de ${b.min_days_registered} dias cadastrado (o que o senhor cadastra no perfil vale na hora).</p>
      <button class="btn primary" type="submit">Salvar presente</button>
    </form>`;
}

function saveBirthdaySettings(form) {
  const amount = inputToCents(form.amount.value);
  const max = inputToCents(form.max.value);

  if (amount === null || max === null) return toast('Valor inválido.', true);

  saveStore({
    birthday_settings: {
      enabled: form.enabled.checked,
      type: form.type.value,
      value: Number(form.value.value),
      amount_cents: amount,
      max_cents: max,
      days_before: Number(form.days_before.value),
      days_after: Number(form.days_after.value),
      min_days_registered: state.store.birthday_settings?.min_days_registered ?? 30,
    },
  }, 'Presente de aniversário salvo!');
}

async function saveStore(fields, message = 'Configurações salvas!') {
  try {
    const { store } = await api('/api/admin/store', { method: 'PATCH', body: JSON.stringify(fields) });
    state.store = store;
    render();
    toast(message);
    return store;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

function submitStoreForm(form) {
  const minOrder = inputToCents(form.min_order.value);

  if (minOrder === null) return toast('Valor inválido.', true);

  saveStore({
    name: form.name.value,
    whatsapp: form.whatsapp.value,
    min_order_cents: minOrder,
    delivery_minutes: Number(form.delivery_minutes.value),
    pickup_minutes: Number(form.pickup_minutes.value),
    default_margin_percent: Number(form.margin.value),
    accept_scheduled: form.accept_scheduled.checked,
    auto_accept: form.auto_accept.checked,
  });
}

/* ----- Avisos de pedido novo no celular ----- */

const isStandaloneApp = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIosDevice = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

async function currentPushSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;

  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

async function loadPushStatus() {
  try {
    const [status, sub] = await Promise.all([api('/api/admin/push'), currentPushSubscription().catch(() => null)]);
    state.push = { ...status, thisDevice: Boolean(sub) };
  } catch (err) {
    state.push = { error: err.message, devices: [] };
  }

  if (isCourier()) {
    if (!document.getElementById('modal')) renderCourier();
  } else if (state.tab === 'store' && state.storeTab === 'avisos') {
    renderTab();
  }
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /iphone/i.test(ua) ? 'iPhone' : /ipad/i.test(ua) ? 'iPad' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'Mac' : 'Aparelho';
  const browser = /edg\//i.test(ua) ? 'Edge' : /crios|chrome/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'navegador';
  return `${os} · ${browser}${isStandaloneApp() ? ' (app)' : ''}`;
}

function storePushHtml() {
  const p = state.push;

  if (!p) {
    state.push = undefined;
    loadPushStatus();
    return '<div class="card"><p class="muted" style="margin:0">Carregando…</p></div>';
  }

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iosNeedsInstall = isIosDevice() && !isStandaloneApp();
  const blocked = supported && Notification.permission === 'denied';

  let action;

  if (!p.ready) {
    action = '<p class="status-cancelled" style="margin:0">⚠️ A chave dos avisos ainda não foi cadastrada no Cloudflare (veja o passo abaixo).</p>';
  } else if (iosNeedsInstall) {
    action = `<p style="margin:0">📲 No iPhone, os avisos só funcionam com o painel <strong>instalado como app</strong>:<br>
      toque em <strong>Compartilhar ⬆️</strong> → <strong>"Adicionar à Tela de Início"</strong>, abra o painel pelo ícone novo e volte nesta tela.</p>`;
  } else if (!supported) {
    action = '<p class="status-cancelled" style="margin:0">Este navegador não aceita avisos. Use o Chrome (Android/computador) ou o painel instalado como app no iPhone.</p>';
  } else if (blocked) {
    action = '<p class="status-cancelled" style="margin:0">Os avisos foram <strong>bloqueados</strong> neste aparelho. Libere nas configurações do navegador (🔒 ao lado do endereço → Notificações → Permitir) e recarregue.</p>';
  } else if (p.thisDevice) {
    action = `<p style="margin:0 0 10px">✅ <strong>Este aparelho recebe os avisos.</strong></p>
      <div class="row"><button class="btn primary" id="push-test">🔔 Enviar aviso de teste</button><button class="btn danger" id="push-off">Desativar neste aparelho</button></div>`;
  } else {
    action = '<button class="btn primary block" id="push-on">🔔 Ativar avisos neste aparelho</button>';
  }

  return `
    <div class="card">
      <h2 style="margin-top:0">🔔 Aviso de pedido novo no celular</h2>
      <p class="muted" style="font-size:13px;margin-top:0">Quando um cliente faz pedido pelo cardápio, chega uma notificação (com som e vibração) em todos os aparelhos ativados — mesmo com o painel fechado. Tocando nela, o painel abre.</p>
      ${action}
    </div>
    ${p.devices?.length ? `
      <div class="card">
        <strong>Aparelhos que recebem os avisos (${p.devices.length})</strong>
        <ul class="order-items">${p.devices.map(d => `<li><span>${d.audience === 'courier' ? '🛵' : '📱'} ${escapeHtml(d.device || 'Aparelho')}</span><span class="muted">desde ${dateOf(d.created_at)}</span></li>`).join('')}</ul>
      </div>` : ''}
    ${p.ready && state.me?.role === 'admin' ? `
      <form class="card" id="promo-form">
        <h2 style="margin-top:0">📣 Mandar promoção</h2>
        <p class="muted" style="font-size:13px;margin-top:0"><strong>${p.promo_devices || 0}</strong> celular(es) de clientes aceitaram receber promoções (pelo pop-up "Fique por dentro das promoções" do cardápio). Tocando no aviso, o cliente cai no cardápio.</p>
        <div class="field"><label>Título (até 60 letras)</label><input name="title" maxlength="60" required placeholder="${storeCopy('Ex.: 🍔 Confira o combo de hoje!', 'Ex.: 🍺 Latão Brahma em promoção!')}" /></div>
        <div class="field"><label>Mensagem (até 180 letras)</label><textarea name="body" rows="2" maxlength="180" required placeholder="Ex.: Só hoje, levando 12 sai por R$ 55. Peça já pelo cardápio!"></textarea></div>
        <button class="btn primary" type="submit" ${p.promo_devices ? '' : 'disabled'}>📣 Enviar para ${p.promo_devices || 0} celular(es)</button>
      </form>` : ''}
    ${p.ready ? '' : `
      <div class="card">
        <strong>Ativar a chave dos avisos (uma vez só)</strong>
        <p class="muted" style="font-size:13px;margin-bottom:0">No Claude Code, digite:<br><code>!cd "C:\\Users\\joaov\\Desktop\\Ultrion\\ponto-x-delivery"; npx wrangler secret bulk .vapid.json</code></p>
      </div>`}`;
}

async function enablePush(button) {
  button.disabled = true;

  try {
    const permission = await Notification.requestPermission();

    if (permission !== 'granted') throw new Error('Permissão de notificação não concedida.');

    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.push.public_key),
    });

    await api('/api/admin/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON(), device: deviceName() }) });
    toast('Avisos ativados neste aparelho! 🔔');
  } catch (err) {
    toast(err.message, true);
  }

  await loadPushStatus();
}

async function disablePush() {
  try {
    const sub = await currentPushSubscription();

    if (sub) {
      await api('/api/admin/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }

    toast('Avisos desativados neste aparelho.');
  } catch (err) {
    toast(err.message, true);
  }

  await loadPushStatus();
}

async function sendPromo(form) {
  if (!confirm(`Enviar "${form.title.value.trim()}" para os celulares dos clientes?`)) return;

  const button = form.querySelector('[type=submit]');
  button.disabled = true;

  try {
    const r = await api('/api/admin/promo', { method: 'POST', body: JSON.stringify({ title: form.title.value, body: form.body.value }) });
    toast(`Promoção enviada para ${r.sent} celular(es)! 📣`);
    form.reset();
  } catch (err) {
    toast(err.message, true);
  }

  button.disabled = false;
}

async function testPush(button) {
  button.disabled = true;

  try {
    const r = await api('/api/admin/push/test', { method: 'POST' });
    toast(`Aviso de teste enviado para ${r.sent} aparelho(s).`);
  } catch (err) {
    toast(err.message, true);
  }

  button.disabled = false;
}

// Pop-up ao abrir o painel perguntando se quer ativar os avisos neste aparelho.
// Fica fora de #app (e não usa openModal) para o recarregamento dos pedidos não fechá-lo.
const PUSH_PROMPT_KEY = (() => {
  const query = new URLSearchParams(location.search).get('loja');
  const slug = query || document.documentElement.dataset.store || 'pontox';
  const safeSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'pontox';
  return safeSlug === 'pontox' ? 'pontox-push-prompt-snooze' : `${safeSlug}-push-prompt-snooze`;
})();

async function maybeAskPush() {
  if (document.getElementById('push-prompt')) return;

  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const iosNeedsInstall = isIosDevice() && !isStandaloneApp();

  if (!supported && !iosNeedsInstall) return;
  if (supported && Notification.permission === 'denied') return;

  try {
    if (Number(localStorage.getItem(PUSH_PROMPT_KEY) || 0) > Date.now()) return;
  } catch {}

  await loadPushStatus();

  const p = state.push;

  if (!p || p.error || !p.ready || p.thisDevice) return;

  const body = iosNeedsInstall
    ? `<p style="margin-top:0">No iPhone, os avisos só funcionam com o painel <strong>instalado como app</strong>:</p>
       <p>toque em <strong>Compartilhar ⬆️</strong> → <strong>"Adicionar à Tela de Início"</strong> e abra o painel pelo ícone novo.</p>
       <button type="button" class="btn primary block" data-push-prompt="later">Entendi</button>`
    : `<p style="margin-top:0">Quer receber uma notificação (com som e vibração) neste aparelho sempre que chegar um pedido novo — mesmo com o painel fechado?</p>
       <div class="row">
         <button type="button" class="btn" data-push-prompt="later">Agora não</button>
         <button type="button" class="btn primary" data-push-prompt="yes">🔔 Ativar avisos</button>
       </div>`;

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.id = 'push-prompt';
  backdrop.innerHTML = `<div class="sheet"><h2>🔔 Ativar avisos de pedido novo?</h2>${body}</div>`;

  backdrop.addEventListener('click', async event => {
    const btn = event.target.closest('[data-push-prompt]');

    if (!btn && event.target !== backdrop) return;

    if (btn?.dataset.pushPrompt === 'yes') {
      await enablePush(btn);
    } else {
      // "Agora não": pergunta de novo só amanhã.
      try {
        localStorage.setItem(PUSH_PROMPT_KEY, String(Date.now() + 24 * 60 * 60 * 1000));
      } catch {}
    }

    backdrop.remove();
  });

  document.body.appendChild(backdrop);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ----- Horários ----- */

function storeHoursHtml() {
  const s = state.store;

  return `
    <form class="card" id="hours-form">
      <h2 style="margin-top:0">🕗 Horário de funcionamento</h2>
      <label class="check"><input type="checkbox" name="auto_hours" ${s.auto_hours ? 'checked' : ''} /> Abrir e fechar a loja automaticamente por este horário</label>
      <p class="muted" style="font-size:13px;margin-top:0">Desligado, quem manda é o botão "Abrir/Fechar loja" da aba Geral. Para fechar depois da meia-noite, é só colocar o fechamento menor que a abertura (ex.: 18:00 às 02:00).</p>
      <div class="hours">
        ${s.hours.map(h => `
          <div class="hours-row" data-day="${h.day}">
            <label class="check" style="margin:0"><input type="checkbox" data-h-enabled ${h.enabled ? 'checked' : ''} /> ${DAY_NAMES[h.day]}</label>
            <input type="time" data-h-open value="${h.open}" class="btn small" />
            <span class="muted">às</span>
            <input type="time" data-h-close value="${h.close === '24:00' ? '23:59' : h.close}" class="btn small" />
          </div>`).join('')}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" type="submit">Salvar horários</button>
        <button class="btn" type="button" id="hours-copy">Copiar o horário de domingo para todos os dias</button>
      </div>
      <p class="muted" style="font-size:13px;margin-bottom:0">Agora: <strong>${escapeHtml(openStatusText(s))}</strong></p>
    </form>`;
}

function readHoursForm(form) {
  return [...form.querySelectorAll('.hours-row')].map(row => ({
    day: Number(row.dataset.day),
    enabled: row.querySelector('[data-h-enabled]').checked,
    open: row.querySelector('[data-h-open]').value || '08:00',
    close: row.querySelector('[data-h-close]').value || '22:00',
  }));
}

function copyFirstDayHours() {
  const rows = [...document.querySelectorAll('#hours-form .hours-row')];
  const [first] = rows;

  for (const row of rows.slice(1)) {
    row.querySelector('[data-h-enabled]').checked = first.querySelector('[data-h-enabled]').checked;
    row.querySelector('[data-h-open]').value = first.querySelector('[data-h-open]').value;
    row.querySelector('[data-h-close]').value = first.querySelector('[data-h-close]').value;
  }
}

/* ----- Taxa de entrega por bairro ----- */

function storeZonesHtml() {
  const zones = state.zones;
  const active = zones.filter(z => z.active).length;

  return `
    <div class="card">
      <h2 style="margin-top:0">🛵 Taxa de entrega por bairro</h2>
      <p class="muted" style="font-size:13px;margin:0">O cliente escolhe o bairro no checkout e a taxa entra sozinha no total. Bairro desativado some da lista.
      ${active ? '' : '<br><strong>Nenhum bairro ativo:</strong> vale a taxa única abaixo para qualquer endereço.'}</p>
    </div>
    ${zones.map(z => `
      <form class="card zone-form" data-zone-id="${z.id}">
        <div class="zone-row">
          <input name="name" maxlength="80" value="${escapeHtml(z.name)}" class="btn small" />
          <label class="muted">R$ <input name="fee" inputmode="decimal" value="${centsToInput(z.fee_cents)}" class="btn small" style="width:90px" /></label>
          <label class="check" style="margin:0"><input type="checkbox" name="active" ${z.active ? 'checked' : ''} /> Ativo</label>
          <button class="btn small primary" type="submit">Salvar</button>
          <button class="btn small danger" type="button" data-zone-delete="${z.id}">🗑</button>
        </div>
        <details style="margin-top:8px">
          <summary class="muted" style="font-size:13px">🏘️ Quadras deste bairro (${z.streets?.length || 0}) — só para bairros divididos em quadras (ex.: condomínio com quadra e lote). Vazio = as entregas são juntadas só pelo bairro.</summary>
          <textarea name="streets" rows="4" class="btn small" style="width:100%;margin-top:6px;text-align:left" placeholder="Uma por linha. Ex.:&#10;Quadra A&#10;Quadra B&#10;Quadra C">${escapeHtml((z.streets || []).join('\n'))}</textarea>
        </details>
      </form>`).join('')}
    <form class="card" id="zone-new-form">
      <strong>Adicionar bairro</strong>
      <div class="zone-row" style="margin-top:8px">
        <input name="name" maxlength="80" placeholder="Nome do bairro" class="btn small" required />
        <label class="muted">R$ <input name="fee" inputmode="decimal" placeholder="0,00" class="btn small" style="width:90px" /></label>
        <button class="btn small primary" type="submit">Adicionar</button>
      </div>
    </form>
    <form class="card" id="flat-fee-form">
      <strong>Taxa única</strong> <span class="muted">(usada só quando não há nenhum bairro ativo)</span>
      <div class="zone-row" style="margin-top:8px">
        <label class="muted">R$ <input name="fee" inputmode="decimal" value="${centsToInput(state.store.delivery_fee_cents)}" class="btn small" style="width:90px" /></label>
        <button class="btn small primary" type="submit">Salvar</button>
      </div>
    </form>`;
}

async function saveZone(form) {
  const fee = inputToCents(form.fee.value);

  if (fee === null) return toast('Taxa inválida.', true);

  try {
    const body = { name: form.name.value, fee_cents: fee };

    if (form.dataset.zoneId) {
      body.active = form.active.checked;
      body.streets = form.streets.value.split('\n').map(s => s.trim()).filter(Boolean);
      await api(`/api/admin/zones/${form.dataset.zoneId}`, { method: 'PATCH', body: JSON.stringify(body) });
    } else {
      await api('/api/admin/zones', { method: 'POST', body: JSON.stringify(body) });
    }

    await loadBootstrap();
    renderTab();
    toast('Taxa de entrega salva!');
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteZone(zoneId) {
  try {
    await api(`/api/admin/zones/${zoneId}`, { method: 'DELETE' });
    await loadBootstrap();
    renderTab();
    toast('Bairro excluído.');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ----- Impressora ----- */

const PRINT_DEFAULTS = {
  paper: '80',
  font_size: 14,
  copies: 1,
  show_prices: true,
  auto_print: false,
  header: '',
  footer: 'Obrigado pela preferência! 🍻',
};

// Computador da impressora: o aparelho que fez a última "Impressão teste" (fica gravado na loja,
// print_settings.station_id). Só ele imprime sozinho os pedidos novos — senão o celular do dono
// e os outros aparelhos com o painel aberto também tentariam imprimir.
const DEVICE_KEY = (() => {
  const query = new URLSearchParams(location.search).get('loja');
  const slug = query || document.documentElement.dataset.store || 'pontox';
  const safeSlug = String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'pontox';
  return safeSlug === 'pontox' ? 'pontox-device-id' : `${safeSlug}-device-id`;
})();

function deviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `d${Date.now()}${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

function autoPrintHere() {
  const station = printSettings().station_id;
  return Boolean(station) && station === deviceId();
}

async function setPrintStation(body, message) {
  try {
    const { store, changed } = await api('/api/admin/print-station', { method: 'POST', body: JSON.stringify(body) });
    state.store = store;
    if (changed && message) toast(message);
    if (state.tab === 'orders') refreshOrdersView(); else renderTab();
  } catch (err) {
    toast(err.message, true);
  }
}

function claimPrintStation(onlyIfEmpty = false) {
  return setPrintStation({ device_id: deviceId(), label: deviceLabel(), only_if_empty: onlyIfEmpty }, '🖨️ Pronto! Este computador agora imprime sozinho todo pedido novo.');
}

// Computador (não celular/tablet) — só ele assume a impressão sozinho.
function isDesktopDevice() {
  return !/android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) && !(navigator.maxTouchPoints > 1 && /mac/i.test(navigator.platform || ''));
}

// Sem computador da impressora definido: o primeiro computador com o painel aberto assume.
let stationChecked = false;
function maybeClaimPrintStation() {
  if (stationChecked || isCourier() || !isDesktopDevice() || printSettings().station_id) return;
  stationChecked = true;
  claimPrintStation(true);
}

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /windows/i.test(ua) ? 'Windows' : /android/i.test(ua) ? 'Android' : /iphone|ipad/i.test(ua) ? 'iPhone/iPad' : /mac/i.test(ua) ? 'Mac' : 'computador';
  return `${os} · ${state.me?.name || 'painel'}`;
}

function printSettings() {
  return { ...PRINT_DEFAULTS, header: state.store.name, ...(state.store.print_settings || {}) };
}

function storePrinterHtml() {
  const p = printSettings();

  return `
    <form class="card" id="printer-form">
      <h2 style="margin-top:0">🖨️ Impressora</h2>
      <div class="grid-2">
        <div class="field"><label>Largura do papel</label>
          <select name="paper">
            <option value="80" ${p.paper === '80' ? 'selected' : ''}>80 mm (térmica padrão)</option>
            <option value="58" ${p.paper === '58' ? 'selected' : ''}>58 mm (térmica pequena)</option>
            <option value="a4" ${p.paper === 'a4' ? 'selected' : ''}>Folha A4 (impressora comum)</option>
          </select>
        </div>
        <div class="field"><label>Tamanho da letra</label>
          <select name="font_size">
            ${[12, 13, 14, 15, 16, 18].map(n => `<option value="${n}" ${Number(p.font_size) === n ? 'selected' : ''}>${n}${n === 14 ? ' (recomendado)' : ''}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Vias por pedido</label>
          <select name="copies">${[1, 2, 3].map(n => `<option value="${n}" ${Number(p.copies) === n ? 'selected' : ''}>${n} via${n > 1 ? 's' : ''}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Cabeçalho do cupom</label><input name="header" maxlength="60" value="${escapeHtml(p.header)}" /></div>
      </div>
      <div class="field"><label>Rodapé do cupom</label><input name="footer" maxlength="120" value="${escapeHtml(p.footer)}" /></div>
      <label class="check"><input type="checkbox" name="show_prices" ${p.show_prices ? 'checked' : ''} /> Mostrar preços no cupom</label>
      <div class="card" style="margin:8px 0">
        <strong>🖨️ Impressão automática</strong>
        <p class="muted" style="margin:4px 0 0;font-size:14px">${p.station_id
          ? (autoPrintHere()
            ? '✅ <strong>Este computador</strong> é o da impressora: todo pedido novo (do cliente e do caixa) sai impresso sozinho aqui, com o painel aberto.'
            : `Quem imprime sozinho é outro aparelho (${escapeHtml(p.station_label || 'computador da loja')}${p.station_set_at ? `, desde ${dateTimeOf(p.station_set_at)}` : ''}). Para trocar, abra esta tela no computador certo e toque em "🖨️ Imprimir os pedidos por este computador".`)
          : 'Desligada. No computador da impressora, toque em "🖨️ Imprimir os pedidos por este computador" abaixo.'}</p>
        <div class="row" style="margin-top:6px">
          ${autoPrintHere() ? '' : '<button class="btn small primary" type="button" id="print-station-here">🖨️ Imprimir os pedidos por este computador</button>'}
          ${p.station_id ? '<button class="btn small" type="button" id="print-station-off">Desligar impressão automática</button>' : ''}
        </div>
      </div>
      <div class="row">
        <button class="btn primary" type="submit">Salvar</button>
        <button class="btn" type="button" id="print-test">🖨️ Imprimir teste</button>
      </div>
    </form>
    <div class="card">
      <strong>Como imprimir sem aparecer a janela de impressão</strong>
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:0">
        Por segurança, todo navegador mostra a janela de impressão antes de imprimir. Para o computador do balcão imprimir direto:<br>
        <strong>Jeito fácil:</strong> na pasta do projeto no computador, dê dois cliques em <code>painel-impressora.cmd</code> (abre o painel já imprimindo direto na impressora padrão). Na primeira vez, entre no painel e toque em "🖨️ Imprimir os pedidos por este computador".<br>
        <strong>Ou manualmente:</strong><br>
        1. Deixe a impressora térmica como <strong>impressora padrão</strong> do Windows.<br>
        2. Clique com o botão direito no atalho do Google Chrome → <strong>Propriedades</strong>.<br>
        3. No campo <strong>Destino</strong>, depois de <code>chrome.exe"</code>, acrescente um espaço e <code>--kiosk-printing</code> → OK.<br>
        4. Feche todas as janelas do Chrome e abra pelo atalho. Pronto: o painel imprime direto na térmica, e com "Imprimir sozinho" ligado, cada pedido novo sai impresso.
      </p>
    </div>`;
}

function readPrinterForm(form) {
  return {
    paper: form.paper.value,
    font_size: Number(form.font_size.value),
    copies: Number(form.copies.value),
    header: form.header.value.trim(),
    footer: form.footer.value.trim(),
    show_prices: form.show_prices.checked,
    auto_print: form.auto_print.checked,
  };
}

function receiptHtml(order, p) {
  const price = cents => (p.show_prices ? money(cents) : '');
  const line = '<div class="sep"></div>';

  return `
    <div class="receipt">
      ${p.header ? `<div class="center big">${escapeHtml(p.header)}</div>` : ''}
      <div class="center">${dateOf(order.created_at)} ${timeOf(order.created_at)}</div>
      ${line}
      <div class="center order-no">#${escapeHtml(order.order_number)}</div>
      <div class="center">${order.delivery_type === 'pickup' ? 'RETIRADA NA LOJA' : 'ENTREGA'} · ${SOURCE_LABELS[order.source]?.replace(/^\S+\s/, '') || ''}</div>
      ${line}
      <div class="box">
        <div class="label">CLIENTE</div>
        <div class="huge">${escapeHtml(order.customer_name)}</div>
        ${order.customer_phone ? `<div>Tel: ${escapeHtml(order.customer_phone)}</div>` : ''}
      </div>
      ${order.delivery_type !== 'pickup' && (order.address || order.delivery_zone) ? `
        <div class="box">
          <div class="label">ENDEREÇO DE ENTREGA</div>
          ${order.address ? `<div class="huge">${escapeHtml(order.address)}</div>` : ''}
          ${order.delivery_zone || order.delivery_street ? `<div class="big">${[order.delivery_zone, order.delivery_street].filter(Boolean).map(escapeHtml).join(' · ')}</div>` : ''}
        </div>` : ''}
      ${line}
      ${order.order_items.map(i => `<div class="item"><span>${i.quantity}x ${escapeHtml(i.product_name)}</span><span>${price(i.subtotal_cents)}</span></div>`).join('')}
      ${line}
      ${p.show_prices && order.delivery_fee_cents ? `<div class="item"><span>Taxa de entrega</span><span>${money(order.delivery_fee_cents)}</span></div>` : ''}
      ${p.show_prices && order.discount_cents ? `<div class="item"><span>Desconto</span><span>- ${money(order.discount_cents)}</span></div>` : ''}
      ${p.show_prices ? `<div class="item big"><span>TOTAL</span><span>${money(order.total_cents)}</span></div>` : ''}
      <div><b>Pagamento:</b> ${paymentText(order)} ${fiadoPart(order) > 0 ? '(NO FIADO)' : order.payment_status === 'paid' ? '(PAGO)' : '(a receber)'}</div>
      ${fiadoPart(order) > 0 ? `${line}<div class="big">FIADO: ${money(fiadoPart(order))}</div><div>Na conta do cliente.</div><br><br><div class="center">______________________________</div><div class="center">Assinatura do cliente</div>` : ''}
      ${order.change_for_cents ? `<div><b>Troco para:</b> ${money(order.change_for_cents)} (levar ${money(order.change_for_cents - cashDue(order))})</div>` : ''}
      ${order.notes ? `${line}<div><b>Obs:</b> ${escapeHtml(order.notes)}</div>` : ''}
      ${p.footer ? `${line}<div class="center">${escapeHtml(p.footer)}</div>` : ''}
    </div>`;
}

// Imprime por um iframe escondido, com o tamanho de papel configurado.
function printOrders(orders, settings = printSettings()) {
  const copies = Math.max(1, Number(settings.copies) || 1);
  const receipts = orders.flatMap(o => Array.from({ length: copies }, () => receiptHtml(o, settings)));

  printDocument(receipts.join(''), settings);
}

function printDocument(bodyHtml, settings = printSettings()) {
  const width = settings.paper === '58' ? '48mm' : settings.paper === '80' ? '72mm' : '180mm';
  const page = settings.paper === 'a4' ? 'A4' : `${settings.paper}mm auto`;

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(iframe);

  iframe.contentDocument.write(`<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${page}; margin: 2mm; }
    /* Térmica: letra grossa (negrito, sem serifa) e preto puro, para não sair fraca. */
    * { color: #000 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { margin: 0; font-family: Arial, Helvetica, sans-serif; font-weight: 700; font-size: ${settings.font_size}px; line-height: 1.3; }
    .receipt { width: ${width}; page-break-after: always; }
    .receipt:last-child { page-break-after: auto; }
    .center { text-align: center; }
    .big { font-size: 1.3em; font-weight: 900; }
    .sep { border-top: 2px dashed #000; margin: 5px 0; }
    .item { display: flex; justify-content: space-between; gap: 6px; }
    /* Notinha: número do pedido, cliente e endereço bem destacados. */
    .order-no { font-size: 3em; font-weight: 900; line-height: 1.05; }
    .box { border: 3px solid #000; border-radius: 4px; padding: 4px 6px; margin: 5px 0; }
    .label { font-size: 0.8em; letter-spacing: 1px; }
    .huge { font-size: 1.5em; font-weight: 900; line-height: 1.2; word-break: break-word; }
  </style></head><body>${bodyHtml}</body></html>`);
  iframe.contentDocument.close();

  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => iframe.remove(), 60000);
  }, 250);
}

function printTest(form) {
  printOrders([{
    order_number: 123, public_code: "48213", daily_number: 7,
    created_at: new Date().toISOString(),
    source: 'site',
    delivery_type: 'delivery',
    customer_name: 'Cliente Teste',
    customer_phone: '(24) 99999-9999',
    address: 'Rua Exemplo, 100 — casa azul',
    delivery_zone: 'Centro',
    order_items: [
      { quantity: 2, product_name: 'Latão Brahma 473 ml', subtotal_cents: 1200 },
      { quantity: 1, product_name: 'Carvão - 5,5 kg', subtotal_cents: 2999 },
    ],
    delivery_fee_cents: 500,
    total_cents: 4699,
    payment_method: 'dinheiro',
    payment_status: 'pending',
    change_for_cents: 5000,
    notes: 'Tocar a campainha',
  }], { ...printSettings(), ...readPrinterForm(form) });
}

/* ----- WhatsApp ----- */

const WHATSAPP_TEMPLATES = [
  ['received', '📥 Pedido recebido',
    'Olá, {nome}! 👋 Aqui é da *{loja}*.\n\nRecebemos seu pedido *#{pedido}* e já vamos conferir. 😉\n\n{itens}\n\n*Total: {total}* · {pagamento}{troco}\n\nAcompanhe em tempo real: {link}\nQualquer dúvida é só responder aqui.'],
  ['accepted', '✅ Pedido aceito',
    'Oba, {nome}! Seu pedido *#{pedido}* foi aceito ✅\n\n⏰ Previsão: {previsao}.\n\nAcompanhe: {link}'],
  ['preparing', '🧊 Em preparação',
    '{nome}, seu pedido *#{pedido}* já está sendo separado com todo cuidado! 🧊🍺\nLogo, logo ele sai daqui.'],
  ['out_for_delivery', '🛵 Saiu para entrega',
    '🛵 Boa notícia, {nome}! Seu pedido *#{pedido}* acabou de sair para entrega e já está a caminho.\n\n📍 {endereco}\n💰 *{total}* · pagamento na entrega ({pagamento}){troco}\n\nAcompanhe: {link}'],
  ['ready_pickup', '🏪 Pronto para retirada',
    '{nome}, seu pedido *#{pedido}* está pronto e te esperando aqui na *{loja}*! 🏪\nÉ só chegar e retirar. Total: *{total}* ({pagamento}).'],
  ['delivered', '💛 Entregue / agradecimento',
    'Pedido *#{pedido}* entregue! ✅\nObrigado pela preferência, {nome}! 💛\n\nFoi tudo certo? Sua opinião ajuda muito a gente. Até a próxima! 🍻'],
  ['cancelled', '😕 Cancelado',
    '{nome}, infelizmente seu pedido *#{pedido}* foi cancelado. 😕\nSe quiser, responda esta mensagem que a gente te ajuda a refazer o pedido ou tirar qualquer dúvida.'],
];

// Pedido de exemplo para a prévia das mensagens.
const WA_SAMPLE_ORDER = {
  id: 'exemplo', order_number: 123, public_code: '48213', customer_name: 'Maria Souza', customer_phone: '24999999999',
  order_items: [{ quantity: 2, product_name: 'Latão Brahma 473 ml' }, { quantity: 1, product_name: 'Carvão - 5,5 kg' }],
  total_cents: 4199, payment_method: 'dinheiro', change_for_cents: 5000, address: 'Rua Exemplo, 100', delivery_type: 'delivery',
  created_at: new Date().toISOString(),
};

const WHATSAPP_VARIABLES = '{nome} {pedido} {itens} {total} {pagamento} {troco} {endereco} {previsao} {link} {loja}';

function whatsappTemplate(key) {
  const custom = state.store.whatsapp_templates?.[key];
  return custom || WHATSAPP_TEMPLATES.find(([k]) => k === key)[2];
}

// Mensagem para a etapa atual do pedido (retirada usa "pronto para retirada" no lugar de "saiu para entrega").
function templateKeyFor(order, status = order.status) {
  if (status === 'out_for_delivery' && order.delivery_type === 'pickup') return 'ready_pickup';
  return status;
}

function whatsappMessage(order, key) {
  const firstName = String(order.customer_name || '').trim().split(/\s+/)[0] || 'cliente';
  const values = {
    nome: firstName,
    pedido: order.public_code || order.order_number, // cliente vê o código aleatório
    itens: (order.order_items || []).map(i => `• ${i.quantity}x ${i.product_name}`).join('\n'),
    total: money(order.total_cents),
    pagamento: paymentText(order),
    troco: order.change_for_cents ? `\n💵 Troco para ${money(order.change_for_cents)}` : '',
    endereco: order.address || 'retirada na loja',
    previsao: order.created_at
      ? `${order.delivery_type === 'pickup' ? 'pronto para retirar' : 'chega'} até as ${timeOf(new Date(orderDeadline(order)).toISOString())}`
      : 'em breve',
    link: `${location.origin}/?pedido=${order.id}`,
    loja: state.store.name,
  };

  return whatsappTemplate(key).replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));
}

function whatsappUrl(order, key) {
  let digits = String(order.customer_phone || '').replace(/\D/g, '');
  if (digits.length > 11 && digits.startsWith('55')) digits = digits.slice(2);

  return `https://wa.me/55${digits}?text=${encodeURIComponent(whatsappMessage(order, key))}`;
}

function openWhatsapp(order, key) {
  window.open(whatsappUrl(order, key), 'whatsapp-cliente');
}

// Ao mudar o status, abre o WhatsApp com a mensagem da nova etapa (se ligado nas configurações).
// Chamado direto no clique: fora dele o navegador bloqueia a janela.
function notifyOnStatusChange(orderId, status) {
  if (['api', 'qr'].includes(state.store.whatsapp_settings?.mode) || state.store.whatsapp_settings?.auto_open === false) return;

  const order = state.orders.find(o => o.id === orderId);

  if (!order || String(order.customer_phone || '').replace(/\D/g, '').length < 10) return;

  openWhatsapp(order, templateKeyFor(order, status));
}

const WA_STATUS_LABELS = {
  APPROVED: ['✅ Aprovado', 'paid'],
  PENDING: ['⏳ Em análise na Meta', ''],
  IN_APPEAL: ['⏳ Em recurso', ''],
  REJECTED: ['❌ Rejeitado', 'off'],
  PAUSED: ['⏸ Pausado', 'off'],
  DISABLED: ['⛔ Desativado', 'off'],
  NAO_CRIADO: ['➖ Ainda não enviado', ''],
};

const WA_STEP_LABELS = {
  received: 'Pedido recebido', accepted: 'Pedido aceito', preparing: 'Em preparação', out_for_delivery: 'Saiu para entrega',
  ready_pickup: 'Pronto para retirada', delivered: 'Entregue', cancelled: 'Cancelado',
};

async function loadWaStatus() {
  try {
    state.waStatus = await api('/api/admin/whatsapp');
  } catch (err) {
    state.waStatus = { error: err.message, templates: [] };
  }

  if (state.tab === 'store' && state.storeTab === 'whatsapp') renderTab();
}

// Parte automática da aba WhatsApp: modo, conexão, modelos, teste, histórico e passo a passo.
function waApiHtml() {
  const s = state.store.whatsapp_settings || {};
  const w = state.waStatus;
  const apiMode = s.mode === 'api';
  const autoSend = s.auto_send || {};

  if (!w) return '<div class="card"><p class="muted" style="margin:0">Carregando conexão com o WhatsApp…</p></div>';

  const ready = w.token_configured && s.phone_number_id && w.phone && !w.error;
  const approved = (w.templates || []).filter(t => t.status === 'APPROVED').length;
  const bold = text => escapeHtml(text).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');

  return `
    <form class="card" id="wa-api-form">
      <h2 style="margin-top:0">🤖 WhatsApp automático (API oficial da Meta)</h2>
      <div class="wa-status">
        <div>${w.token_configured ? '✅ Token de acesso da Meta cadastrado' : '❌ Token de acesso da Meta <strong>não cadastrado</strong> (passo 6 do guia abaixo)'}</div>
        <div>${w.phone ? `✅ Número conectado: <strong>${escapeHtml(w.phone.display_phone_number)}</strong> (${escapeHtml(w.phone.verified_name || '')}${w.phone.quality_rating ? ` · qualidade ${escapeHtml(w.phone.quality_rating)}` : ''})` : '❌ Número ainda não conectado'}</div>
        <div>${approved === 6 ? '✅' : w.waba_id ? '⏳' : '❌'} Modelos de mensagem aprovados: <strong>${approved} de 6</strong></div>
        ${w.error ? `<div class="status-cancelled">⚠️ ${escapeHtml(w.error)}</div>` : ''}
      </div>
      <div class="grid-2" style="margin-top:12px">
        <div class="field"><label>ID do número de telefone (Phone number ID)</label><input name="phone_number_id" inputmode="numeric" maxlength="30" value="${escapeHtml(s.phone_number_id || '')}" placeholder="Ex.: 123456789012345" /></div>
        <div class="field"><label>ID da conta do WhatsApp Business (WABA ID)</label><input name="waba_id" inputmode="numeric" maxlength="30" value="${escapeHtml(s.waba_id || '')}" placeholder="Ex.: 109876543210987" /></div>
      </div>
      <div class="row">
        <button class="btn primary" type="submit">Salvar IDs</button>
        <button class="btn" type="button" id="wa-refresh">🔄 Verificar conexão</button>
      </div>
      ${apiMode && !ready ? '<p class="status-cancelled" style="font-size:13px;margin-bottom:0">Modo automático ligado, mas a conexão ainda não está completa: enquanto isso, nenhuma mensagem sai sozinha.</p>' : ''}
    </form>

    <div class="card">
      <strong>Modelos de mensagem</strong>
      <p class="muted" style="font-size:13px;margin:4px 0 10px">A Meta só deixa a loja iniciar conversa com modelos aprovados por ela. A aprovação costuma levar de alguns minutos a 24 horas.</p>
      ${(w.templates || []).map(t => {
        const [label, cls] = WA_STATUS_LABELS[t.status] || [t.status ? escapeHtml(t.status) : '—', ''];
        return `
          <details class="wa-template">
            <summary><span>${WA_STEP_LABELS[t.key]} <span class="muted">(${t.name})</span></span><span class="badge ${cls}">${label}</span></summary>
            <div class="wa-preview">${bold(t.body)}</div>
          </details>`;
      }).join('')}
      <div class="row" style="margin-top:10px">
        <button class="btn primary" type="button" id="wa-create-templates" ${w.token_configured && s.waba_id ? '' : 'disabled'}>📤 Enviar modelos para aprovação da Meta</button>
      </div>
    </div>

    <form class="card" id="wa-test-form">
      <strong>Enviar mensagem de teste</strong>
      <div class="zone-row" style="margin-top:8px">
        <input name="phone" inputmode="tel" maxlength="20" placeholder="Seu WhatsApp com DDD" class="btn small" style="flex:1;min-width:180px" />
        <button class="btn small primary" type="submit" ${ready && apiMode ? '' : 'disabled'}>Enviar teste</button>
      </div>
      <p class="muted" style="font-size:12px;margin-bottom:0">Manda o modelo "Pedido recebido" com dados de exemplo. Precisa do modo automático ligado e do modelo aprovado.</p>
    </form>

    ${w.log?.length ? `
      <div class="card">
        <strong>Últimos envios automáticos</strong>
        <ul class="order-items">${w.log.map(m => `<li><span>${dateTimeOf(m.created_at)} · +${escapeHtml(m.phone)} · ${escapeHtml(m.template.replace('pontox_pedido_', ''))}</span><span class="${m.status === 'sent' ? 'paid-text' : 'status-cancelled'}" title="${escapeHtml(m.error || '')}">${m.status === 'sent' ? '✅ enviado' : `❌ ${escapeHtml((m.error || 'erro').slice(0, 60))}`}</span></li>`).join('')}</ul>
      </div>` : ''}

    <details class="card">
      <summary><strong>📋 Passo a passo para conectar o WhatsApp automático</strong></summary>
      <ol class="guide">
        <li><strong>Número exclusivo:</strong> separe um número de celular só para isso. Ele <strong>não pode estar em uso</strong> no aplicativo do WhatsApp (se estiver, apague a conta dele no app antes).</li>
        <li><strong>Conta empresarial na Meta:</strong> entre em <a href="https://business.facebook.com" target="_blank" rel="noopener">business.facebook.com</a> com o seu Facebook e crie o portfólio da empresa. Em <em>Central de segurança</em>, faça a <strong>verificação da empresa</strong> com o CNPJ.</li>
        <li><strong>App da Meta:</strong> em <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com/apps</a> → <em>Criar app</em> → tipo <em>Empresa</em> → escolha o portfólio da loja → no app, adicione o produto <strong>WhatsApp</strong>.</li>
        <li><strong>Número na API:</strong> em <em>WhatsApp → Configuração da API</em>, clique em <em>Adicionar número de telefone</em>, coloque o nome da loja e confirme o código por SMS. Cadastre também uma <strong>forma de pagamento</strong> na conta do WhatsApp (a Meta cobra alguns centavos por mensagem).</li>
        <li><strong>IDs:</strong> ainda em <em>Configuração da API</em>, copie a <em>Identificação do número de telefone</em> e a <em>Identificação da conta do WhatsApp Business</em>, cole nos campos acima e clique em <strong>Salvar</strong>.</li>
        <li><strong>Token permanente:</strong> em business.facebook.com → <em>Configurações do negócio → Usuários do sistema</em> → <em>Adicionar</em> (função Administrador) → <em>Atribuir ativos</em> (o app e a conta do WhatsApp, controle total) → <em>Gerar token</em> com as permissões <code>whatsapp_business_messaging</code> e <code>whatsapp_business_management</code> e validade <strong>Nunca</strong>. Depois, no Claude Code, digite o comando abaixo e cole o token quando ele pedir (o token fica guardado só no Cloudflare, nunca no site):<br><code>!cd "C:\\Users\\joaov\\Desktop\\Ultrion\\ponto-x-delivery"; npx wrangler secret put WHATSAPP_TOKEN</code></li>
        <li>Volte aqui, clique em <strong>🔄 Verificar conexão</strong> e depois em <strong>📤 Enviar modelos para aprovação</strong>.</li>
        <li>Quando os 6 modelos estiverem <strong>✅ Aprovados</strong>, escolha <strong>🤖 Automático</strong>, salve e faça um <strong>teste</strong> com o seu número.</li>
      </ol>
    </details>`;
}

async function saveWaApiForm(form) {
  const ok = await saveStore({
    whatsapp_settings: {
      ...(state.store.whatsapp_settings || {}),
      phone_number_id: form.phone_number_id.value.replace(/\D/g, ''),
      waba_id: form.waba_id.value.replace(/\D/g, ''),
    },
  }, 'WhatsApp salvo!');

  if (ok) {
    state.waStatus = undefined;
    loadWaStatus();
  }
}

async function createWaTemplates(button) {
  button.disabled = true;
  button.textContent = 'Enviando…';

  try {
    const { results } = await api('/api/admin/whatsapp/templates', { method: 'POST' });
    const failed = results.filter(r => !r.ok);
    toast(failed.length ? `${failed.length} modelo(s) com erro: ${failed[0].error}` : 'Modelos enviados para aprovação da Meta!', Boolean(failed.length));
  } catch (err) {
    toast(err.message, true);
  }

  await loadWaStatus();
}

async function sendWaTest(form) {
  const button = form.querySelector('[type=submit]');
  button.disabled = true;

  try {
    await api('/api/admin/whatsapp/test', { method: 'POST', body: JSON.stringify({ phone: form.phone.value }) });
    toast('Mensagem de teste enviada! Confira o WhatsApp.');
  } catch (err) {
    toast(err.message, true);
  }

  await loadWaStatus();
}

/* ----- WhatsApp da loja (QR Code) ----- */

let waQrTimer = null;

async function loadWaQr() {
  clearTimeout(waQrTimer);

  try {
    state.waQr = await api('/api/admin/wa-qr');
  } catch (err) {
    state.waQr = { error: err.message, configured: true, log: [], queue: {} };
  }

  const onPage = state.tab === 'store' && state.storeTab === 'whatsapp';

  if (onPage && !document.getElementById('modal')) {
    // Não redesenha se a pessoa estiver digitando no teste.
    if (!document.activeElement?.closest?.('#wa-qr-test-form')) renderTab();
  }

  // Enquanto espera o QR ser lido (ou reconecta), confere de novo a cada 3 segundos.
  const st = state.waQr?.service?.state;

  if (onPage && (st === 'qr' || st === 'connecting')) waQrTimer = setTimeout(loadWaQr, 3000);
}

function waPhoneOf(me) {
  const digits = String(me?.id || '').split(/[:@]/)[0].replace(/\D/g, '');
  if (!digits) return '';
  const local = digits.startsWith('55') ? digits.slice(2) : digits;
  return local.length >= 10 ? `(${local.slice(0, 2)}) ${local.slice(2, -4)}-${local.slice(-4)}` : `+${digits}`;
}

const WA_OUTBOX_LABELS = {
  pending: ['⏳ na fila', ''],
  sending: ['📤 enviando', ''],
  sent: ['✅ enviado', 'paid-text'],
  failed: ['❌ falhou', 'status-cancelled'],
  skipped: ['➖ não enviado', 'muted'],
};

// Escolha do jeito de avisar o cliente + em quais etapas.
function waModeHtml(settings) {
  const mode = settings.mode || 'manual';
  const autoSend = settings.auto_send || {};

  return `
    <form class="card" id="wa-mode-form">
      <h2 style="margin-top:0">📲 Como o cliente é avisado</h2>
      <div class="choices" style="margin-bottom:12px">
        <label><input type="radio" name="mode" value="manual" ${mode === 'manual' ? 'checked' : ''} /> ✋ <strong>Manual</strong> — abre o WhatsApp com a mensagem pronta e você aperta enviar</label>
        <label><input type="radio" name="mode" value="qr" ${mode === 'qr' ? 'checked' : ''} /> 📱 <strong>Automático pelo WhatsApp da loja</strong> (conectado por QR Code) — a mensagem sai sozinha</label>
        <label><input type="radio" name="mode" value="api" ${mode === 'api' ? 'checked' : ''} /> 🤖 Automático pela API oficial da Meta (precisa de cadastro e aprovação na Meta)</label>
      </div>
      <div class="field"><label>No automático, avisar quando o pedido estiver:</label>
        <div class="wa-steps">
          ${Object.entries(WA_STEP_LABELS).map(([key, label]) => `<label class="check" style="margin:0"><input type="checkbox" name="send_${key}" ${autoSend[key] === false ? '' : 'checked'} /> ${label}</label>`).join('')}
        </div>
      </div>
      <button class="btn primary" type="submit">Salvar</button>
    </form>`;
}

async function saveWaModeForm(form) {
  const autoSend = {};
  for (const key of Object.keys(WA_STEP_LABELS)) autoSend[key] = form[`send_${key}`].checked;

  const ok = await saveStore({
    whatsapp_settings: { ...(state.store.whatsapp_settings || {}), mode: form.mode.value, auto_send: autoSend },
  }, 'WhatsApp salvo!');

  if (ok) {
    state.waQr = null;
    state.waStatus = null;
    renderTab();
  }
}

function waQrHtml() {
  const q = state.waQr;

  if (!q) return '<div class="card"><p class="muted" style="margin:0">Verificando o WhatsApp da loja…</p></div>';

  if (!q.configured) {
    return `<div class="card warn"><strong>🔴 Servidor do WhatsApp ainda não configurado</strong>
      <p class="muted" style="margin:6px 0 0">O serviço que envia as mensagens roda no servidor da Oracle. Assim que ele estiver no ar, esta tela mostra o QR Code para conectar.</p></div>`;
  }

  const svc = q.service;
  const st = svc?.state;
  const online = st === 'open';
  const statusLine = q.error
    ? `🔴 <strong>Servidor do WhatsApp fora do ar</strong><br><span class="muted">${escapeHtml(q.error)}</span>`
    : online
      ? `🟢 <strong>Conectado</strong> · ${escapeHtml(waPhoneOf(svc.me))}${svc.me?.name ? ` (${escapeHtml(svc.me.name)})` : ''}`
      : st === 'qr'
        ? '🟡 <strong>Aguardando você ler o QR Code</strong>'
        : st === 'connecting'
          ? '🟡 <strong>Conectando…</strong>'
          : '🔴 <strong>Desconectado</strong> — as mensagens automáticas ficam paradas na fila';
  const queue = q.queue || {};
  const settingsMode = state.store.whatsapp_settings?.mode;

  return `
    <div class="card">
      <h2 style="margin-top:0">📱 WhatsApp da loja</h2>
      <div class="wa-qr-status">${statusLine}</div>
      ${svc?.last_error && !online ? `<p class="muted" style="font-size:12px;margin:6px 0 0">${escapeHtml(svc.last_error)}</p>` : ''}
      ${st === 'qr' && svc.qr ? `
        <div class="wa-qr-box">
          <img src="${svc.qr}" alt="QR Code do WhatsApp" />
          <ol class="guide">
            <li>No celular da loja, abra o <strong>WhatsApp</strong> (o número que vai mandar os avisos).</li>
            <li>Toque em <strong>⋮</strong> (Android) ou <strong>Configurações</strong> (iPhone) → <strong>Dispositivos conectados</strong> → <strong>Conectar dispositivo</strong>.</li>
            <li>Aponte a câmera para este QR Code. Pronto: esta tela fica 🟢 sozinha.</li>
          </ol>
        </div>` : ''}
      <div class="row" style="margin-top:12px">
        ${!online && st !== 'qr' ? '<button class="btn primary" type="button" data-wa-qr="connect">📱 Conectar WhatsApp</button>' : ''}
        ${online || st === 'connecting' || st === 'qr' ? '<button class="btn" type="button" data-wa-qr="restart">🔄 Reconectar</button>' : ''}
        ${online || st === 'qr' ? '<button class="btn danger" type="button" data-wa-qr="logout">⛔ Desconectar</button>' : ''}
        <button class="btn" type="button" id="wa-qr-refresh">Atualizar</button>
      </div>
      ${settingsMode !== 'qr' ? '<p class="status-cancelled" style="font-size:13px;margin-bottom:0">Para as mensagens saírem sozinhas, escolha "Automático pelo WhatsApp da loja" acima e salve.</p>' : ''}
      <p class="muted" style="font-size:12px;margin-bottom:0">Mudar o status do pedido nunca espera o WhatsApp: a mensagem entra numa fila e sai em segundos. Se o WhatsApp estiver desconectado, ela espera (até 6 horas) e tenta de novo.</p>
    </div>

    <form class="card" id="wa-qr-test-form">
      <strong>Enviar mensagem de teste</strong>
      <div class="zone-row" style="margin-top:8px">
        <input name="phone" inputmode="tel" maxlength="20" placeholder="WhatsApp com DDD" class="btn small" style="flex:1;min-width:180px" />
        <button class="btn small primary" type="submit" ${online ? '' : 'disabled'}>Enviar teste</button>
      </div>
      <p class="muted" style="font-size:12px;margin-bottom:0">Manda a mensagem "Pedido recebido" com dados de exemplo.</p>
    </form>

    <div class="card">
      <strong>Envios automáticos</strong>
      <p class="muted" style="font-size:13px;margin:4px 0 8px">Últimas 24 h: ✅ ${queue.sent || 0} enviada(s) · ⏳ ${(queue.pending || 0) + (queue.sending || 0)} na fila · ❌ ${queue.failed || 0} com erro · ➖ ${queue.skipped || 0} não enviada(s)</p>
      ${q.log?.length ? `<ul class="order-items">${q.log.map(m => {
        const [label, cls] = WA_OUTBOX_LABELS[m.status] || [m.status, ''];
        return `
          <li>
            <span>${dateTimeOf(m.created_at)} · #${escapeHtml(m.orders?.public_code || '—')} · ${escapeHtml(WA_STEP_LABELS[m.event] || m.event)} · ${escapeHtml(formatPhone(m.phone))}
              ${m.last_error && m.status !== 'sent' ? `<br><span class="muted" style="font-size:12px">${escapeHtml(m.last_error)}</span>` : ''}</span>
            <span><span class="${cls}">${label}</span>${['failed', 'skipped'].includes(m.status) ? ` <button class="btn small" type="button" data-wa-retry="${m.id}">Reenviar</button>` : ''}</span>
          </li>`;
      }).join('')}</ul>` : '<p class="muted" style="margin:0">Nenhum envio ainda.</p>'}
    </div>`;
}

async function waQrAction(action, button) {
  if (action === 'logout' && !confirm('Desconectar o WhatsApp da loja? As mensagens automáticas param até conectar de novo pelo QR Code.')) return;

  button.disabled = true;
  button.textContent = action === 'connect' ? 'Gerando QR Code…' : 'Aguarde…';

  try {
    const service = await api(`/api/admin/wa-qr/${action}`, { method: 'POST' });
    state.waQr = { ...(state.waQr || {}), service, error: null };
    if (action === 'logout') toast('WhatsApp desconectado.');
  } catch (err) {
    toast(err.message, true);
  }

  await loadWaQr();
}

async function sendWaQrTest(form) {
  const button = form.querySelector('[type=submit]');
  button.disabled = true;

  try {
    await api('/api/admin/wa-qr/test', { method: 'POST', body: JSON.stringify({ phone: form.phone.value }) });
    toast('Mensagem de teste enviada! Confira o WhatsApp.');
  } catch (err) {
    toast(err.message, true);
  }

  button.disabled = false;
}

async function retryWaMessage(id, button) {
  button.disabled = true;

  try {
    await api('/api/admin/wa-qr/retry', { method: 'POST', body: JSON.stringify({ id }) });
    toast('Mensagem voltou para a fila.');
  } catch (err) {
    toast(err.message, true);
  }

  await loadWaQr();
}

function storeWhatsappHtml() {
  const settings = state.store.whatsapp_settings || {};
  const mode = settings.mode || 'manual';

  if (mode === 'api' && state.waStatus === null) {
    state.waStatus = undefined;
    loadWaStatus();
  }

  if (state.waQr === null) {
    state.waQr = undefined;
    loadWaQr();
  }

  return waModeHtml(settings) + (mode === 'api' ? waApiHtml() : waQrHtml()) + manualWhatsappHtml(settings);
}

function manualWhatsappHtml(settings) {

  return `
    <form class="card" id="whatsapp-form">
      <h2 style="margin-top:0">✍️ Mensagens para o cliente</h2>
      <p class="muted" style="font-size:13px;margin-top:0">Usadas no modo manual (botão <strong>💬 Avisar cliente</strong>) e no <strong>automático pelo WhatsApp da loja</strong>. Na API da Meta valem os modelos aprovados por ela.</p>
      <label class="check"><input type="checkbox" name="auto_open" ${settings.auto_open !== false ? 'checked' : ''} /> Ao mudar o status do pedido, abrir o WhatsApp com a mensagem pronta (é só apertar enviar)</label>
      <p class="muted" style="font-size:13px">Em todo pedido também tem o botão <strong>💬 Avisar cliente</strong>, que manda a mensagem da etapa atual.<br>
        Variáveis que você pode usar: <code>${WHATSAPP_VARIABLES}</code>. Use *asteriscos* para <b>negrito</b> no WhatsApp.</p>
      ${WHATSAPP_TEMPLATES.map(([key, label]) => `
        <div class="field">
          <label>${label} <button type="button" class="link" data-wa-preview="${key}">ver exemplo</button> · <button type="button" class="link" data-wa-reset="${key}">voltar ao padrão</button></label>
          <textarea name="${key}" rows="5" maxlength="1500">${escapeHtml(whatsappTemplate(key))}</textarea>
          <div class="wa-preview" id="wa-preview-${key}" hidden></div>
        </div>`).join('')}
      <button class="btn primary" type="submit">Salvar mensagens</button>
    </form>
`;
}

function previewTemplate(key) {
  const form = document.getElementById('whatsapp-form');
  const box = document.getElementById(`wa-preview-${key}`);
  const original = state.store.whatsapp_templates;

  // Usa o texto que está no campo agora (mesmo sem salvar).
  state.store.whatsapp_templates = { ...(original || {}), [key]: form[key].value };
  const text = whatsappMessage(WA_SAMPLE_ORDER, key);
  state.store.whatsapp_templates = original;

  box.innerHTML = escapeHtml(text).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
  box.hidden = !box.hidden;
}

function saveWhatsappForm(form) {
  const templates = {};

  for (const [key, , fallback] of WHATSAPP_TEMPLATES) {
    const value = form[key].value.trim();
    if (value && value !== fallback) templates[key] = value;
  }

  saveStore({ whatsapp_templates: templates, whatsapp_settings: { ...(state.store.whatsapp_settings || {}), auto_open: form.auto_open.checked } }, 'Mensagens salvas!');
}

/* ---------------- Início ---------------- */

async function loadBootstrap() {
  const data = await api('/api/admin/bootstrap');
  state.store = data.store;
  state.products = data.products;
  state.componentsReady = Boolean(data.components_ready);
  state.zones = data.delivery_zones || [];
  state.me = data.me || null;

  const pill = document.getElementById('store-pill');
  if (pill) {
    pill.textContent = openStatusText(state.store);
    pill.className = `status-pill ${state.store.effective_open ? 'open' : 'closed'}`;
  }

  if (state.tab === 'products') renderTab();
}

async function start() {
  try {
    await loadBootstrap();
  } catch {
    renderLogin();
    return;
  }

  clearInterval(refreshTimer);

  // Entregador: só a tela de entregas dele.
  if (isCourier()) {
    renderCourier();
    await loadCourier();
    refreshTimer = setInterval(loadCourier, 20000);
    // Aviso no celular dele: pedido novo de entrega e entrega despachada para ele.
    maybeAskPush().catch(() => {});
    return;
  }

  render();
  await loadOrders();
  maybeAskPush().catch(() => {});

  clearInterval(refreshTimer);
  // Computador da impressora confere a cada 5 s (imprime assim que o pedido chega); os outros, a cada 20 s.
  let lastPoll = 0;
  refreshTimer = setInterval(() => {
    const every = autoPrintHere() ? 5000 : 20000;
    if (Date.now() - lastPoll < every - 500) return;
    lastPoll = Date.now();
    if (state.ordersDate === todaySaoPaulo()) loadOrders();
  }, 5000);

  // Cronômetro dos pedidos (a cada segundo) e situação da loja (abre/fecha pelo horário).
  clearInterval(timerTicker);
  timerTicker = setInterval(tickTimers, 1000);
  clearInterval(storeTicker);
  storeTicker = setInterval(() => loadBootstrap().catch(() => {}), 5 * 60 * 1000);
}

start();
