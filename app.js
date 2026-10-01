// Multi-loja (endereço de teste): ?loja=apelido escolhe a loja (ex.: ...workers.dev/?loja=pontox).
// Fica guardado num cookie; "?loja=" vazio volta para a loja principal. No domínio próprio da loja o servidor ignora.
(() => {
  const loja = new URLSearchParams(location.search).get('loja');
  if (loja === null) return;
  const slug = loja.toLowerCase().replace(/[^a-z0-9-]/g, '');
  document.cookie = slug ? `loja=${slug}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax; Secure` : 'loja=; Path=/; Max-Age=0';
})();

// O host workers.dev é compartilhado entre lojas; cada loja precisa de seu próprio estado local.
const storageSlug = (() => {
  const query = new URLSearchParams(location.search).get('loja');
  const slug = query || document.documentElement.dataset.store || 'pontox';
  return String(slug).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'pontox';
})();
const LEGACY_STORAGE_KEYS = {
  cart: 'garatucaia-cart',
  chill: 'garatucaia-chill',
  'last-order': 'garatucaia-last-order',
  customer: 'garatucaia-customer',
  orders: 'garatucaia-orders',
  device: 'garatucaia_device',
  'install-dismissed': 'garatucaia-install-dismissed',
  'promos-on': 'garatucaia-promos-on',
  'reorder-missing': 'garatucaia-reorder-missing',
  'save-snooze': 'garatucaia-save-snooze',
  'order-push-snooze': 'garatucaia-order-push-snooze',
  'promos-snooze': 'garatucaia-promos-snooze',
};
const storeKey = name => storageSlug === 'garatucaia'
  ? LEGACY_STORAGE_KEYS[name] || `garatucaia-${name}`
  : `${storageSlug}-${name}`;
const CART_KEY = storeKey('cart');
const CHILL_KEY = storeKey('chill'); // engradados que o cliente quer gelados (chave do carrinho → true)
const NO_CHEDDAR_KEY = storeKey('no-cheddar'); // itens que o cliente pediu sem cheddar (chave do carrinho → true)
const LAST_ORDER_KEY = storeKey('last-order');
const CUSTOMER_KEY = storeKey('customer');
const ORDERS_KEY = storeKey('orders');
const isBurgerStore = () => document.documentElement.dataset.store === 'pontox';
const storeCopy = (burger, market) => isBurgerStore() ? burger : market;

// Vitrine cinematográfica (ver armProductShowcases, mais abaixo): só liga se o GSAP e o
// ScrollTrigger carregaram do CDN. Sem eles (ou com "reduzir movimento" ativado), a vitrine
// continua funcionando no baseline CSS puro (rolagem/snap nativo), só sem os efeitos.
const gsapReady = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';
if (gsapReady) gsap.registerPlugin(ScrollTrigger);
const voiceExample = () => storeCopy('Fale os itens com as quantidades. Ex.: "dois X-Tudo e uma Coca-Cola".', 'Fale os produtos com as quantidades, do seu jeito. Ex.: "um gelo, três latão Brahma e três latão Heineken".');

// Foto indisponível usa uma identificação neutra, sem mostrar uma imagem quebrada.
document.addEventListener('error', event => {
  const img = event.target;
  if (!isBurgerStore() || !(img instanceof HTMLImageElement) || !img.matches('.photo img, .cart-thumb, .variant-photo, .variant-thumb img, .leve-item img')) return;
  const fallback = document.createElement('span');
  fallback.className = `${img.className} no-photo`;
  fallback.textContent = '🍽️';
  fallback.setAttribute('role', 'img');
  fallback.setAttribute('aria-label', 'Foto indisponível');
  img.replaceWith(fallback);
}, true);

const STATUS_STEPS = [
  ['received', 'Pedido recebido'],
  ['accepted', 'Pedido aceito'],
  ['preparing', 'Em preparação'],
  ['out_for_delivery', 'Saiu para entrega'],
  ['delivered', 'Entregue'],
];

const PAYMENT_LABELS = { pix: 'Pix', debito: 'Débito', credito: 'Crédito', dinheiro: 'Dinheiro', cartao: 'Cartão' };
// Formas oferecidas no checkout ('cartao' só existe em pedido antigo).
const PAYMENT_CHOICES = ['pix', 'debito', 'credito', 'dinheiro'];

const state = {
  store: null,
  products: [],
  addons: [],
  cart: loadJson(CART_KEY, {}),
  chill: loadJson(CHILL_KEY, {}),
  noCheddar: loadJson(NO_CHEDDAR_KEY, {}),
  search: '',
  insights: null, // VIP, presente de aniversário e "hora de repor" do cliente deste aparelho
  vip: false,
};

const app = document.getElementById('app');

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
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
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || 'Algo deu errado. Tente de novo.');
  }

  return data;
}

/* ---------------- Carrinho ---------------- */

// Chave do carrinho: "produtoId:variacaoId" (variação vazia = produto sem variações).
function cartKey(productId, variantId, addons) {
  const spec = Object.entries(addons || {})
    .filter(([, qty]) => qty > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, qty]) => `${id}*${qty}`)
    .join(',');
  return spec ? `${productId}:${variantId || ''}:${spec}` : `${productId}:${variantId || ''}`;
}

// Adicionais de uma linha do carrinho (por unidade do lanche). null = algum não existe mais.
function addonsOfKey(spec) {
  if (!spec) return [];
  const list = spec.split(',').map(part => {
    const [id, qty] = part.split('*');
    return { product: state.addons.find(a => a.id === id && a.available !== false), qty: Number(qty) };
  });
  return list.every(a => a.product && a.qty > 0) ? list : null;
}

function addonsTotal(addons) {
  return (addons || []).reduce((sum, a) => sum + a.product.price_cents * a.qty, 0);
}

function productById(id) {
  return state.products.find(p => p.id === id) || state.addons.find(p => p.id === id);
}

// Adicionais ("Turbine seu lanche") não entram no cardápio geral: só aparecem dentro dos lanches.
function setMenuProducts(products) {
  state.products = products.filter(p => !p.is_addon);
  state.addons = products.filter(p => p.is_addon);
}

function isLanche(product) {
  return Boolean(product) && !product.is_addon && /hamburg|lanche/.test(normalizeText(product.category));
}

function lancheWithAddons(product) {
  return isLanche(product) && !product.variants.length && state.addons.some(a => a.available !== false);
}

function resolveCartKey(key) {
  const [productId, variantId, addonSpec] = key.split(':');
  const product = productById(productId);

  if (!product) return null;

  // Esgotado não fica no carrinho. Adicional só existe dentro de um lanche.
  if (product.available === false || product.is_addon) return null;

  if (addonSpec) {
    const addons = isLanche(product) && !product.variants.length ? addonsOfKey(addonSpec) : null;
    if (!addons) return null;
    const base = promoNow(product)?.price_cents ?? product.price_cents;
    return { product, variant: null, addons, price: base + addonsTotal(addons), bulk: null, name: product.name };
  }

  if (product.variants.length) {
    const variant = product.variants.find(v => v.id === variantId && v.available !== false);
    return variant ? { product, variant, price: variant.price_cents, bulk: bulkOf(variant), name: `${product.name} - ${variant.name}` } : null;
  }

  // Promoção com horário (o servidor confere de novo ao fechar o pedido).
  const promo = promoNow(product);

  return variantId ? null : { product, variant: null, price: promo ? promo.price_cents : product.price_cents, bulk: bulkOf(product), name: product.name };
}

// Engradado de um produto/variação: só vale se sair mais barato que as unidades soltas.
function storeFeatures() {
  return state.store?.features || {};
}

function bulkOf(item) {
  if (storeFeatures().bulk === false) return null;
  const qty = item?.bulk_qty;
  const price = item?.bulk_price_cents;

  return qty > 1 && price != null && price < qty * item.price_cents ? { qty, price } : null;
}

// Mesma conta do servidor: cada engradado completo sai pelo preço do engradado; o resto, unitário.
function linePrice(qty, unit, bulk) {
  if (bulk && qty >= bulk.qty) {
    const packs = Math.floor(qty / bulk.qty);
    return { total: packs * bulk.price + (qty % bulk.qty) * unit, packs, saved: packs * (bulk.qty * unit - bulk.price) };
  }

  return { total: qty * unit, packs: 0, saved: 0 };
}

// "🍻 Levando 12: R$ 60,00 (sai R$ 5,00 cada)" — e quanto falta para chegar lá.
function bulkHintHtml(item, inCart = 0) {
  const bulk = bulkOf(item);

  if (!bulk) return '';

  const missing = inCart % bulk.qty ? bulk.qty - (inCart % bulk.qty) : 0;

  return `<span class="bulk-hint">🍻 Levando ${bulk.qty}: <strong>${money(bulk.price)}</strong> (sai ${money(Math.round(bulk.price / bulk.qty))} cada)${inCart && missing ? ` · faltam ${missing} pro preço de engradado` : ''}</span>`;
}

function noCheddarToggleHtml(key, on) {
  return `<button type="button" class="chill-toggle ${on ? 'on' : ''}" data-nocheddar="${key}">${on ? '❌' : '⬜'} 🧀 Retirar o cheddar</button>`;
}

function toggleNoCheddar(key) {
  if (state.noCheddar[key]) delete state.noCheddar[key];
  else state.noCheddar[key] = true;
  saveJson(NO_CHEDDAR_KEY, state.noCheddar);
}

// Engradado gelado: quantos engradados podem ir gelados (mesma regra do servidor).
function chillInfo(entry) {
  if (storeFeatures().chill === false) return null;
  const fee = entry.product.chill_fee_cents;

  if (!fee) return null;

  const bulkQty = (entry.variant || entry.product).bulk_qty || entry.product.bulk_qty;
  const packs = bulkQty > 1 ? Math.floor(entry.qty / bulkQty) : entry.qty;

  return packs > 0 ? { fee, packs, on: Boolean(state.chill[entry.key]) } : null;
}

function cartEntries() {
  return Object.entries(state.cart)
    .map(([key, qty]) => ({ key, qty, ...resolveCartKey(key) }))
    .filter(entry => entry.product && entry.qty > 0)
    .map(entry => {
      const line = linePrice(entry.qty, entry.price, entry.bulk);
      const chill = chillInfo(entry);
      const chillTotal = chill?.on ? chill.packs * chill.fee : 0;

      // Vem com cheddar por padrão; o cliente pode pedir para retirar (não muda o preço).
      const noCheddar = entry.product.removable_cheddar ? Boolean(state.noCheddar[entry.key]) : null;

      return { ...entry, line, chill, noCheddar, total: line.total + chillTotal };
    });
}

// Regra de pedido mínimo por categoria na entrega (ex.: cigarros) que o carrinho ainda não cumpre.
function categoryMinProblem() {
  if (storeFeatures().category_min_orders === false) return null;
  const entries = cartEntries();
  const subtotal = cartSubtotal();

  return (state.store?.category_min_orders || []).find(rule => subtotal < rule.min_cents
    && entries.some(e => normalizeText(e.product.category).includes(normalizeText(rule.match)))) || null;
}

function cartCount() {
  return cartEntries().reduce((sum, e) => sum + e.qty, 0);
}

function cartSubtotal() {
  return cartEntries().reduce((sum, e) => sum + e.total, 0);
}

function productCartCount(productId) {
  return cartEntries().filter(e => e.product.id === productId).reduce((sum, e) => sum + e.qty, 0);
}

// Id aleatório do aparelho (não identifica ninguém): só para contar carrinhos iniciados.
function deviceId() {
  let id = null;

  try { id = localStorage.getItem(storeKey('device')); } catch {}

  if (!id) {
    id = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(storeKey('device'), id); } catch {}
  }

  return id;
}

const cartEventSent = new Set();

function trackCartAdd(productId) {
  if (cartEventSent.has(productId)) return;

  cartEventSent.add(productId);
  fetch('/api/cart-event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product_id: productId, device: deviceId() }), keepalive: true }).catch(() => {});
}

function setQty(key, qty) {
  if (qty > (state.cart[key] || 0)) trackCartAdd(key.split(':')[0]);

  if (qty <= 0) {
    delete state.cart[key];
  } else {
    state.cart[key] = Math.min(qty, 99);
  }

  saveJson(CART_KEY, state.cart);
}

function cleanCart() {
  for (const key of Object.keys(state.cart)) {
    if (!resolveCartKey(key)) delete state.cart[key];
  }

  saveJson(CART_KEY, state.cart);
}

/* ---------------- Cardápio ---------------- */

function storeStatusText(store) {
  if (store.is_open) return store.closes_at ? `Aberto até ${store.closes_at}` : 'Aberto';
  return store.opens_text ? `Fechado · abre ${store.opens_text}` : 'Fechado';
}

function headerHtml() {
  const store = state.store;
  const logo = escapeHtml(document.querySelector('meta[name="store-logo"]')?.content || 'assets/logo.png');
  const burger = isBurgerStore();

  return `
    <header class="header compact ${burger ? 'burger-header' : ''}">
      <div class="brand-lockup">
        <img src="${logo}" alt="${escapeHtml(store?.name || '')}" />
        <div>
          <h1>${escapeHtml(store?.name || '')}</h1>
          <p>
            ${store ? `<span class="status-pill ${store.is_open ? 'open' : 'closed'}">${storeStatusText(store)}</span>` : ''}
            ${store && !store.delivery_zones?.length && store.delivery_fee_cents ? ` · Entrega ${money(store.delivery_fee_cents)}` : ''}
            ${store && store.min_order_cents ? ` · Mínimo ${money(store.min_order_cents)}` : ''}
          </p>
        </div>
      </div>
      <div class="spacer"></div>
      ${accountButtonHtml()}
    </header>`;
}

// Um slide por combo cadastrado (mesmas fotos/preços do cardápio); sem combo, cai no destaque único de sempre.
function pontoxHeroSlideHtml(product, eyebrow) {
  const action = product.variants.length
    ? `<button class="btn primary" data-choose="${product.id}">Pedir agora</button>`
    : `<button class="btn primary" data-inc="${cartKey(product.id)}">Pedir agora</button>`;

  return `<div class="pontox-hero-slide">
    <div class="pontox-hero-copy"><span class="eyebrow">${escapeHtml(eyebrow)}</span><h2>${escapeHtml(product.name)}</h2>
      ${product.description ? `<p>${escapeHtml(product.description)}</p>` : '<p>Monte seu pedido do seu jeito.</p>'}
      <div class="pontox-hero-bottom"><strong>${productPriceHtml(product)}</strong>${action}</div>
    </div><div class="pontox-hero-photo">${productPhotoHtml(product)}</div>
  </div>`;
}

function pontoxHeroHtml() {
  if (!isBurgerStore() || state.search.trim()) return '';

  const combos = state.products
    .filter(p => p.available !== false && /combo/i.test(p.category || ''))
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

  const slides = combos.length
    ? combos.map(p => pontoxHeroSlideHtml(p, 'Combo da casa'))
    : (() => {
        const product = state.products.find(p => p.available !== false && p.featured)
          || state.products.find(p => p.available !== false && /hamb[uú]rg|x-/i.test(p.name));
        return product ? [pontoxHeroSlideHtml(product, 'O sabor da casa')] : [];
      })();

  if (!slides.length) return '';

  const dots = slides.length > 1
    ? `<div class="pontox-hero-dots">${slides.map((_, i) => `<button type="button" class="pontox-hero-dot ${i === 0 ? 'on' : ''}" data-hero-dot="${i}" aria-label="Ver destaque ${i + 1}"></button>`).join('')}</div>`
    : '';

  return `<section class="pontox-hero" aria-label="Destaque da casa">
    <div class="pontox-hero-track">${slides.join('')}</div>
    ${dots}
  </section>`;
}

// Vídeo que "monta" o hambúrguer conforme a pessoa rola a tela (substitui o carrossel de
// combos por enquanto; ele continua definido acima, só não é chamado daqui).
function pontoxScrollVideoHeroHtml() {
  if (!isBurgerStore() || state.search.trim()) return '';
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return ''; // sem efeito de movimento

  // O hambúrguer que aparece sendo montado no vídeo é o "Ponto X", o especial da casa —
  // deixa ele pedível ali mesmo, com destaque, sem precisar rolar até o cardápio.
  const special = state.products.find(p => p.available !== false && p.name.trim().toLowerCase() === 'ponto x');
  const specialAction = !special ? '' : (special.variants.length
    ? `<button class="btn primary pontox-scroll-hero-add" data-choose="${special.id}">Adicionar</button>`
    : `<button class="btn primary pontox-scroll-hero-add" data-inc="${cartKey(special.id)}">Adicionar</button>`);

  return `<section class="pontox-scroll-hero" aria-label="Montagem do hambúrguer">
    <div class="pontox-scroll-hero-sticky">
      <video class="pontox-scroll-video" src="assets/burger-assembly.mp4#t=0.8" poster="assets/burger-assembly-poster.jpg" muted playsinline preload="auto"></video>
      <div class="pontox-scroll-hero-copy">
        ${special ? `<div class="pontox-scroll-hero-product">
          <span class="pontox-scroll-hero-badge">★ Especial da casa</span>
          <div class="pontox-scroll-hero-product-row">
            <div><strong>${escapeHtml(special.name)}</strong><span class="pontox-scroll-hero-price">${productPriceHtml(special)}</span></div>
            ${specialAction}
          </div>
        </div>` : ''}
        <button type="button" class="btn small" data-skip-hero>Ver cardápio ↓</button>
      </div>
    </div>
  </section>`;
}

function productPhotoHtml(product) {
  return product.image_url
    ? `<img src="${escapeHtml(product.image_url)}" alt="" loading="lazy" />`
    : `<div class="no-photo">${storeCopy('🍽️', '🛒')}</div>`;
}

function productPriceHtml(product) {
  // Vendido por kg: mostra o preço do quilo.
  if (storeFeatures().weight !== false && product.sold_by_weight && product.kg_price_cents) return `${money(product.kg_price_cents)}<small class="muted"> /kg</small>`;
  if (!product.variants.length) return money(product.price_cents);

  const prices = product.variants.map(v => v.price_cents);
  const min = Math.min(...prices);

  return min === Math.max(...prices) ? money(min) : `<small class="muted">a partir de</small> ${money(min)}`;
}

function isDrinkProduct(product) {
  return /bebida|refrigerante|suco|água|agua|cerveja|drink/i.test(`${product.category || ''} ${product.name || ''}`);
}

function productHtml(product) {
  const off = product.available === false;
  let action;

  if (off) {
    action = `<button class="btn small" data-similar="${product.id}">Ver parecidos</button>`;
  } else if (product.variants.length) {
    const count = productCartCount(product.id);
    const chooseLabel = normalizeText(`${product.category || ''} ${product.name || ''}`).includes('acai')
      ? (count ? `Monte seu açaí (${count})` : 'Monte seu açaí')
      : (count ? `Escolher (${count})` : 'Escolher');
    action = `<button class="btn small primary" data-choose="${product.id}">${chooseLabel}</button>`;
  } else if (lancheWithAddons(product)) {
    const count = productCartCount(product.id);
    action = `<button class="btn small primary" data-choose="${product.id}">${count ? `Adicionar (${count})` : 'Adicionar'}</button>`;
  } else {
    const key = cartKey(product.id);
    const qty = state.cart[key] || 0;
    action = qty
      ? `<span class="qty">
           <button data-dec="${key}" aria-label="Diminuir">−</button>
           <span>${qty}</span>
           <button data-inc="${key}" aria-label="Aumentar">+</button>
         </span>`
      : `<button class="btn small primary" data-inc="${key}">Adicionar</button>`;
  }

  const promo = !off && promoNow(product);
  const hot = !off && state.today?.top_products?.includes(product.id);
  const isNewProduct = !off && isNew(product);

  // Card sempre com as mesmas "faixas": nome (2 linhas), oferta (1 linha), preço + botão embaixo.
  return `
    <article class="product ${off ? 'is-off' : ''} ${promo ? 'is-promo' : ''}" data-pid="${product.id}">
      <div class="photo">
        ${productPhotoHtml(product)}
        <div class="photo-badges">
          ${off ? '<span class="pbadge off">Esgotado</span>' : ''}
          ${!off && storeFeatures().chill !== false && product.chill_fee_cents ? '<span class="pbadge cold">❄️ Gelado</span>' : ''}
          ${!off && storeFeatures().weight !== false && product.sold_by_weight ? '<span class="pbadge weight">⚖️ Por kg</span>' : ''}
          ${hot ? '<span class="pbadge hot" title="Muito pedido hoje">🔥 Em alta</span>' : ''}
          ${isNewProduct ? '<span class="pbadge new">✨ Novidade</span>' : ''}
        </div>
        ${promo ? `<span class="promo-ribbon">-${Math.max(1, Math.round((1 - promo.price_cents / product.price_cents) * 100))}%</span>` : ''}
      </div>
      <div class="info">
        <h3>${escapeHtml(product.name)}</h3>
        <div class="deal-row">${off ? '' : dealHtml(product, promo)}</div>
        <div class="bottom">
          <span class="price">${promo ? `<s class="old-price">${money(product.price_cents)}</s> <span class="promo-price">${money(promo.price_cents)}</span>` : productPriceHtml(product)}</span>
          ${action}
        </div>
      </div>
    </article>`;
}

// Faixa de oferta do card: promoção com horário (com contagem real) ou preço por quantidade.
function dealHtml(product, promo) {
  if (promo) {
    return `<span class="deal">🔥 Oferta</span>${promo.ends_at ? ` <span class="deal-sub" data-ends="${escapeHtml(promo.ends_at)}">${countdownText(promo.ends_at)}</span>` : ''}`;
  }

  const bulk = !product.variants.length && bulkOf(product);

  if (bulk) {
    return `<button type="button" class="deal" data-bulk="${cartKey(product.id)}" data-bulk-qty="${bulk.qty}" title="Adicionar ${bulk.qty}">🔥 ${bulk.qty} un. por ${money(bulk.price)}</button> <span class="deal-sub">${money(Math.round(bulk.price / bulk.qty))}/un.</span>`;
  }

  if (product.variants.some(v => v.available !== false && bulkOf(v))) return '<span class="deal">🔥 Preço por quantidade</span>';

  return '';
}

/* ----- Promoção com horário: relógio sincronizado com o servidor ----- */

const nowMs = () => Date.now() + (state.timeOffset || 0);

// Dia da semana em São Paulo (0=domingo..6=sábado), mesmo cálculo do worker (nowInSaoPaulo).
function weekdaySaoPaulo(ms) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date(ms));
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
}

function promoNow(product) {
  const p = product.promo;

  if (!p || product.variants?.length) return null;

  const now = nowMs();

  if (p.weekdays?.length && !p.weekdays.includes(weekdaySaoPaulo(now))) return null;

  const starts = p.starts_at ? new Date(p.starts_at).getTime() : null;
  const ends = p.ends_at ? new Date(p.ends_at).getTime() : null;

  return (!starts || starts <= now) && (!ends || ends > now) ? p : null;
}

// Selo "Novidade": produto cadastrado há menos de 14 dias.
const NEW_PRODUCT_DAYS = 14;

function isNew(product) {
  if (!product.created_at) return false;
  return nowMs() - new Date(product.created_at).getTime() < NEW_PRODUCT_DAYS * 24 * 60 * 60 * 1000;
}

function countdownText(endsAt) {
  const min = Math.floor((new Date(endsAt).getTime() - nowMs()) / 60000);

  if (min < 1) return 'Termina em instantes';
  if (min < 60) return `Termina em ${min} min`;
  if (min < 24 * 60) return `Termina em ${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}min` : ''}`;
  return `Até ${new Date(endsAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })}`;
}

// A cada 20 s: atualiza as contagens; quando uma promoção começa ou acaba, redesenha o cardápio.
let promoSignature = '';

setInterval(() => {
  for (const el of document.querySelectorAll('[data-ends]')) el.textContent = countdownText(el.dataset.ends);

  const signature = state.products.filter(p => promoNow(p)).map(p => p.id).join();

  if (promoSignature && signature !== promoSignature && document.getElementById('menu-body') && !document.getElementById('sheet')) {
    cleanCart();
    renderMenu();
  }

  promoSignature = signature;
}, 20000);

// Carrossel de combos na tela inicial: avança sozinho a cada 5s. Um único intervalo global
// (nunca criado dentro do render) evita duplicar timers a cada atualização da tela.
setInterval(() => {
  const track = document.querySelector('.pontox-hero-track');
  const slides = track?.querySelectorAll('.pontox-hero-slide');

  if (!track || !slides || slides.length < 2) return;

  const width = track.clientWidth;
  const next = width ? (Math.round(track.scrollLeft / width) + 1) % slides.length : 0;
  track.scrollTo({ left: next * width, behavior: 'smooth' });
  document.querySelectorAll('.pontox-hero-dot').forEach((dot, i) => dot.classList.toggle('on', i === next));
}, 5000);

// Vídeo-scroll do topo: carrega assim que o site abre (o 1º quadro e a imagem de capa
// aparecem na hora, nada fica preto) e avança junto com o scroll (sem tocar/som). Sempre
// reconsulta o DOM a cada passo, então sobrevive a re-renderizações do #menu-body.

function armScrollVideo() {
  const video = document.querySelector('.pontox-scroll-video');
  if (!video || video.dataset.armed) return;
  video.dataset.armed = '1';
  // Já mostra o quadro certo assim que o vídeo carrega (sem esperar a primeira rolagem).
  video.addEventListener('loadeddata', updateScrollVideo, { once: true });
  if (video.readyState >= 2) updateScrollVideo();
}

const HERO_VIDEO_START = 0.8;
const HERO_VIDEO_END = 6.2;
let heroScrollTicking = false;
function updateScrollVideo() {
  const section = document.querySelector('.pontox-scroll-hero');
  const video = document.querySelector('.pontox-scroll-video');
  if (!section || !video || !video.duration) return;
  const rect = section.getBoundingClientRect();
  const total = rect.height - window.innerHeight;
  const progress = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 0;
  // A rolagem percorre só o trecho com movimento (sem reencodar o arquivo): antes de 0,8s é
  // só o pão parado e depois de 6,2s o lanche já está pronto e a câmera fica parada.
  const start = Math.min(HERO_VIDEO_START, video.duration);
  const end = Math.min(HERO_VIDEO_END, video.duration);
  video.currentTime = start + progress * Math.max(0, end - start);
}

window.addEventListener('scroll', () => {
  armScrollVideo();
  if (heroScrollTicking) return;
  heroScrollTicking = true;
  requestAnimationFrame(() => { updateScrollVideo(); heroScrollTicking = false; });
}, { passive: true });

// Cards de produto entram com fade+subida ao rolar, uma vez por produto (não repete a
// animação em re-renders causados por +/- do carrinho — só na primeira vez que aquele
// produto aparece na tela nesta visita). Sempre reconsulta o DOM, então sobrevive à
// re-renderização de #menu-body a cada clique de +/-.
const revealedProductIds = new Set();
let productRevealObserver = null;

function armProductReveal() {
  return;

  // Cards da vitrine cinematográfica (.menu-section-scroll) têm a própria entrada, via
  // armProductShowcases() — não competem com esse observer de "revelar ao rolar a página".
  const cards = document.querySelectorAll('#menu-body .products:not(.menu-section-scroll) .product[data-pid]');
  if (!cards.length) return;

  productRevealObserver?.disconnect();
  productRevealObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      revealedProductIds.add(entry.target.dataset.pid);
      entry.target.classList.add('is-visible');
      productRevealObserver.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  cards.forEach(card => {
    if (revealedProductIds.has(card.dataset.pid)) card.classList.add('is-visible');
    else productRevealObserver.observe(card);
  });
}

// Vitrine cinematográfica (.menu-section-scroll): o card mais próximo do centro do
// contêiner ganha destaque (maior, mais opaco), a foto tem parallax próprio, e o nome/preço
// sobem suavemente quando um card vira o "líder". Desktop (≥860px): a rolagem vertical da
// página "pina" a seção e avança a trilha (ScrollTrigger.scrub). Celular: rolagem horizontal
// nativa com snap — GSAP só lê a posição e escreve escala/opacidade/parallax por cima, nunca
// é dono do gesto (o scroll nativo já suprime o click sintético depois de um arrasto; a
// guarda em showcaseDragStart cobre o caso de flick rápido no iOS). Sem GSAP ou com "reduzir
// movimento" ativado, a navegação simples por scroll-snap (CSS puro) já funciona sozinha —
// tudo isso é aditivo, nunca pré-condição para rolar/pedir.
const showcaseScrollState = new Map(); // id da <section> → scrollLeft salvo (só celular, sobrevive ao re-render)
const showcaseDragStart = new WeakMap(); // contêiner → scrollLeft no último pointerdown (evita abrir produto após arrasto)
const SHOWCASE_DESKTOP_MIN = 860; // mesmo breakpoint já usado na grade (styles.css)
let showcaseResizeTimer = null;

function killShowcases() {
  if (!gsapReady) return;
  ScrollTrigger.getAll().filter(st => st.vars.id?.startsWith('showcase-')).forEach(st => st.kill());
}

function saveShowcaseScroll() {
  document.querySelectorAll('#menu-body .products.menu-section-scroll').forEach(track => {
    const section = track.closest('section');
    if (section) showcaseScrollState.set(section.id, track.scrollLeft);
  });
}

function buildShowcaseCardMeta(cards) {
  return cards.map(el => ({ el, pid: el.dataset.pid, center: el.offsetLeft + el.offsetWidth / 2, width: el.offsetWidth || 260 }));
}

// Aplica escala/opacidade/parallax conforme a distância de cada card ao centro do contêiner
// (aritmética pura, sem getBoundingClientRect por frame) e dispara a microanimação de
// "encaixe" no .info só quando o card líder (mais próximo do centro) muda de identidade.
function applyShowcaseProximity(track, cardMeta, currentOffset, leadState) {
  const viewportHalf = track.clientWidth / 2;
  const falloff = cardMeta[0]?.width || 260;
  let leader = null;

  cardMeta.forEach(meta => {
    const distance = meta.center - currentOffset - viewportHalf;
    const closeness = 1 - Math.min(1, Math.abs(distance) / (falloff * 1.15));
    // Só escala (nunca opacidade): opacidade via GSAP brigava com a transition CSS do
    // card base e podia deixar um card "preso" quase invisível — visibilidade sempre 100%.
    gsap.set(meta.el, { scale: gsap.utils.interpolate(0.92, 1, closeness) });

    const img = meta.el.querySelector('.photo img, .photo .no-photo');
    if (img) {
      const parallax = Math.max(-1, Math.min(1, distance / (falloff * 1.6)));
      gsap.set(img, { yPercent: parallax * 6, scale: 1.12 });
    }

    if (!leader || closeness > leader.closeness) leader = { pid: meta.pid, el: meta.el, closeness };
  });

  if (leader && leader.pid !== leadState.currentCenterPid) {
    leadState.currentCenterPid = leader.pid;
    const info = leader.el.querySelector('.info');
    if (info) gsap.fromTo(info, { y: 14, opacity: .5 }, { y: 0, opacity: 1, duration: .35, ease: 'back.out(1.6)', overwrite: 'auto' });
  }
}

function armShowcaseDesktop(section, track, cards) {
  const cardMeta = buildShowcaseCardMeta(cards);
  const leadState = { currentCenterPid: null };
  const speedFactor = 0.6; // desacelera o avanço da trilha em relação ao scroll da página
  const maxPin = window.innerHeight * 2.2; // teto: categorias com muitos produtos não viram um túnel de scroll
  const anim = gsap.to(track, { x: () => -(track.scrollWidth - track.clientWidth), ease: 'none' });

  ScrollTrigger.create({
    id: `showcase-${section.id}`,
    trigger: section,
    start: 'top 132px', // mesmo offset de .search-bar + .categories fixos (styles.css)
    end: () => '+=' + Math.min(maxPin, Math.max(1, track.scrollWidth - track.clientWidth) * speedFactor),
    pin: track,
    scrub: 0.4,
    invalidateOnRefresh: true,
    animation: anim,
    onUpdate: () => applyShowcaseProximity(track, cardMeta, -Number(gsap.getProperty(track, 'x')), leadState),
  });

  applyShowcaseProximity(track, cardMeta, 0, leadState);
}

function armShowcaseMobile(track, cards) {
  const cardMeta = buildShowcaseCardMeta(cards);
  const leadState = { currentCenterPid: null };
  let ticking = false;
  let settleTimer = null;
  const update = () => applyShowcaseProximity(track, cardMeta, track.scrollLeft, leadState);

  track.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(() => { update(); ticking = false; });
    }
    // "Encaixe": recalcula quando a rolagem para de vez (scrollend nativo, com fallback por
    // debounce em navegadores que ainda não suportam o evento).
    clearTimeout(settleTimer);
    settleTimer = setTimeout(update, 150);
  }, { passive: true });
  track.addEventListener('scrollend', update, { passive: true });

  update();
}

function armProductShowcases() {
  // A faixa usa apenas o scroll horizontal nativo; não pinamos nem animamos a página.
  return;

  const containers = document.querySelectorAll('#menu-body .products.menu-section-scroll');
  if (!containers.length) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const desktop = window.innerWidth >= SHOWCASE_DESKTOP_MIN;

  containers.forEach(track => {
    const section = track.closest('section');
    if (!section) return;

    // Restaura a posição salva (celular) antes de qualquer cálculo, pra não "voltar ao
    // início" a cada re-render (+/- do carrinho, poll de promoção a cada 20s...).
    const savedLeft = showcaseScrollState.get(section.id);
    if (savedLeft) track.scrollLeft = savedLeft;

    // Guarda de clique-vs-arrasto: vale sempre, mesmo sem GSAP/com reduzir movimento.
    track.addEventListener('pointerdown', () => showcaseDragStart.set(track, track.scrollLeft), { passive: true });

    if (reduced || !gsapReady) return; // baseline CSS (scroll-snap simples) já é suficiente

    const cards = Array.from(track.querySelectorAll('.product[data-pid]'));
    if (cards.length < 2) return; // sem "vizinhos" não há efeito de destaque central pra fazer

    if (desktop) armShowcaseDesktop(section, track, cards);
    else armShowcaseMobile(track, cards);
  });
}

// Cruzar 860px muda o mecanismo (pin+scrub vs. rolagem nativa), não só o tamanho — por isso
// precisa rearmar do zero, não só re-medir.
window.addEventListener('resize', () => {
  clearTimeout(showcaseResizeTimer);
  showcaseResizeTimer = setTimeout(() => { killShowcases(); armProductShowcases(); }, 200);
});

// Foto pequena de uma linha do carrinho: a da variação (ex.: Red Bull Tradicional), senão a do produto.
function cartPhotoHtml(product, variant) {
  const url = variant?.image_url || product?.image_url;

  return url
    ? `<img class="cart-thumb" src="${escapeHtml(url)}" alt="" loading="lazy" />`
    : '<span class="cart-thumb no-photo">🛒</span>';
}

// Produto vendido por kg: o preço mostrado é estimado; a loja pesa e cobra o valor da balança.
const WEIGHT_NOTICE_HTML = '<p class="weight-notice">⚖️ <strong>Produto vendido por kg.</strong> O preço é uma estimativa: na loja a gente pesa e o valor final pode mudar um pouquinho, para mais ou para menos, conforme o peso.</p>';

function cartHasWeight() {
  return storeFeatures().weight !== false && cartEntries().some(e => e.product?.sold_by_weight);
}

// Janela para escolher as variações (ex.: Carvão 2,5 kg / 5 kg) e as quantidades.
function openVariants(productId) {
  const product = productById(productId);

  if (!product) return;

  const sheet = openSheet(`
    <div class="sheet-head"><h2>${escapeHtml(product.name)}</h2><button data-close aria-label="Fechar">✕</button></div>
    ${product.image_url ? `<img class="variant-photo" src="${escapeHtml(product.image_url)}" alt="" />` : ''}
    ${product.description && !isDrinkProduct(product) ? `<p class="muted">${escapeHtml(product.description)}</p>` : ''}
    ${storeFeatures().weight !== false && product.sold_by_weight && product.kg_price_cents ? `<p class="kg-price">${money(product.kg_price_cents)} <small>o quilo</small></p>` : ''}
    ${storeFeatures().weight !== false && product.sold_by_weight ? WEIGHT_NOTICE_HTML : ''}
    ${product.variants.map(variant => {
      const key = cartKey(product.id, variant.id);
      const qty = state.cart[key] || 0;

      const bulk = bulkOf(variant);

      return `
        <div class="cart-line">
          ${variant.image_url ? cartPhotoHtml(product, variant) : ''}
          <span class="name">${escapeHtml(variant.name)}<br><span class="price">${money(variant.price_cents)}</span>${bulk ? `<br>${bulkHintHtml(variant, qty)}` : ''}</span>
          <span style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            ${qty
              ? `<span class="qty"><button data-vdec="${key}">−</button><span>${qty}</span><button data-vinc="${key}">+</button></span>`
              : `<button class="btn small primary" data-vinc="${key}">Adicionar</button>`}
            ${bulk ? `<button class="btn small" data-vbulk="${key}" data-bulk-qty="${bulk.qty}">+ ${bulk.qty}</button>` : ''}
          </span>
        </div>`;
    }).join('')}
    <div class="sheet-product-actions">
      <button class="btn block" data-close style="margin-top:16px">Continuar comprando</button>
    </div>
  `);

  sheet.addEventListener('click', event => {
    const btn = event.target.closest('button');

    if (!btn) return;

    if (btn.dataset.vinc) {
      const before = state.cart[btn.dataset.vinc] || 0;
      setQty(btn.dataset.vinc, before + 1);
      if (!before) addedFeedback(resolveCartKey(btn.dataset.vinc)?.name);
    } else if (btn.dataset.vdec) {
      setQty(btn.dataset.vdec, (state.cart[btn.dataset.vdec] || 0) - 1);
    } else if (btn.dataset.vbulk) {
      setQty(btn.dataset.vbulk, (state.cart[btn.dataset.vbulk] || 0) + Number(btn.dataset.bulkQty));
    } else {
      return;
    }

    keepSheetScroll(() => openVariants(productId));
    refreshCartUi();
  });
}

// Clique no card (fora dos botões) abre o detalhe do produto: foto grande, descrição
// completa e a mesma ação de sempre. Produto com variação reaproveita openVariants();
// esgotado reaproveita openSimilar() — mesmo comportamento que os botões já tinham.
function openProduct(productId) {
  const product = productById(productId);

  if (!product) return;
  if (product.variants.length) return openVariants(productId);
  if (product.available === false) return openSimilar(productId);

  if (lancheWithAddons(product)) return openLanche(productId);

  const promo = promoNow(product);
  const key = cartKey(product.id);
  const qty = state.cart[key] || 0;

  const sheet = openSheet(`
    <div class="sheet-head"><h2>${escapeHtml(product.name)}</h2><button data-close aria-label="Fechar">✕</button></div>
    ${product.image_url ? `<img class="variant-photo" src="${escapeHtml(product.image_url)}" alt="" />` : ''}
    ${product.description && !isDrinkProduct(product) ? `<p class="muted">${escapeHtml(product.description)}</p>` : ''}
    ${storeFeatures().weight !== false && product.sold_by_weight && product.kg_price_cents ? `<p class="kg-price">${money(product.kg_price_cents)} <small>o quilo</small></p>` : ''}
    ${storeFeatures().weight !== false && product.sold_by_weight ? WEIGHT_NOTICE_HTML : ''}
    <div class="deal-row">${dealHtml(product, promo)}</div>
    <div class="cart-line">
      <span class="name"><span class="price">${promo ? `<s class="old-price">${money(product.price_cents)}</s> <span class="promo-price">${money(promo.price_cents)}</span>` : productPriceHtml(product)}</span></span>
      <span class="qty">
        ${qty
          ? `<button data-dec="${key}" aria-label="Diminuir">−</button><span>${qty}</span><button data-inc="${key}" aria-label="Aumentar">+</button>`
          : '<span class="muted">Escolha a quantidade abaixo</span>'}
      </span>
    </div>
    ${product.removable_cheddar ? `<p style="margin:10px 0 0">${noCheddarToggleHtml(key, Boolean(state.noCheddar[key]))}</p>` : ''}
    <div class="sheet-product-actions">
      ${qty === 0 ? `<button class="btn primary block" data-inc="${key}" style="margin-top:16px">Adicionar</button>` : ''}
      <button class="btn block" data-close style="margin-top:8px">Continuar comprando</button>
    </div>
  `);

  sheet.addEventListener('click', event => {
    const btn = event.target.closest('button');

    if (!btn) return;

    if (btn.dataset.inc) {
      const before = state.cart[btn.dataset.inc] || 0;
      setQty(btn.dataset.inc, before + 1);
      if (!before) addedFeedback(resolveCartKey(btn.dataset.inc)?.name);
    } else if (btn.dataset.dec) {
      setQty(btn.dataset.dec, (state.cart[btn.dataset.dec] || 0) - 1);
    } else if (btn.dataset.bulk) {
      setQty(btn.dataset.bulk, (state.cart[btn.dataset.bulk] || 0) + Number(btn.dataset.bulkQty));
      addedFeedback(`${btn.dataset.bulkQty} un.`);
    } else if (btn.dataset.nocheddar) {
      toggleNoCheddar(btn.dataset.nocheddar);
    } else {
      return;
    }

    keepSheetScroll(() => openProduct(productId));
    refreshCartUi();
  });
}

// Lanche: o cliente escolhe a quantidade e os adicionais ("Turbine seu lanche") e só depois
// adiciona. Cada combinação vira uma linha própria no carrinho, com os adicionais embaixo.
function openLanche(productId) {
  state.lancheDraft = { productId, qty: 1, addons: {} };
  renderLancheSheet();
}

// Lápis do carrinho: reabre o lanche com a quantidade e os adicionais daquela linha.
function editLanche(key) {
  const entry = cartEntries().find(e => e.key === key);
  if (!entry) return;
  state.lancheDraft = {
    productId: entry.product.id,
    qty: entry.qty,
    addons: Object.fromEntries((entry.addons || []).map(a => [a.product.id, a.qty])),
    editKey: key,
  };
  renderLancheSheet();
}

function renderLancheSheet() {
  const draft = state.lancheDraft;
  const product = productById(draft?.productId);

  if (!product) return closeSheet();

  const promo = promoNow(product);
  const base = promo ? promo.price_cents : product.price_cents;
  const addons = state.addons.filter(a => a.available !== false);
  const unit = base + addons.reduce((sum, a) => sum + a.price_cents * (draft.addons[a.id] || 0), 0);
  const inCart = productCartCount(product.id);

  const sheet = openSheet(`
    <div class="sheet-head"><h2>${escapeHtml(product.name)}</h2><button data-close aria-label="Fechar">✕</button></div>
    ${product.image_url ? `<img class="variant-photo" src="${escapeHtml(product.image_url)}" alt="" />` : ''}
    ${product.description ? `<p class="muted">${escapeHtml(product.description)}</p>` : ''}
    <div class="deal-row">${dealHtml(product, promo)}</div>
    <p class="price" style="margin:4px 0 0">${promo ? `<s class="old-price">${money(product.price_cents)}</s> <span class="promo-price">${money(promo.price_cents)}</span>` : money(base)}</p>
    <div class="turbine">
      <h3>🔥 Turbine seu lanche</h3>
      ${addons.map(addon => {
        const qty = draft.addons[addon.id] || 0;
        return `
          <div class="cart-line">
            <span class="name">${escapeHtml(addon.name)}<br><span class="price">+ ${money(addon.price_cents)}</span></span>
            ${qty
              ? `<span class="qty"><button data-adec="${addon.id}" aria-label="Diminuir">−</button><span>${qty}</span><button data-ainc="${addon.id}" aria-label="Aumentar">+</button></span>`
              : `<button class="btn small" data-ainc="${addon.id}">+ Adicionar</button>`}
          </div>`;
      }).join('')}
    </div>
    <div class="lanche-confirm">
      <span class="qty"><button data-ldec aria-label="Diminuir">−</button><span>${draft.qty}</span><button data-linc aria-label="Aumentar">+</button></span>
      <button class="btn primary" data-ladd style="flex:1">${draft.editKey ? 'Salvar' : 'Adicionar'} · ${money(unit * draft.qty)}</button>
    </div>
    ${inCart && !draft.editKey ? `<p class="muted" style="margin:8px 0 0;font-size:13px;text-align:center">Você já tem ${inCart} no carrinho.</p>` : ''}
  `);

  sheet.addEventListener('click', event => {
    const btn = event.target.closest('button');

    if (!btn) return;

    if (btn.dataset.ainc) {
      draft.addons[btn.dataset.ainc] = Math.min((draft.addons[btn.dataset.ainc] || 0) + 1, 10);
    } else if (btn.dataset.adec) {
      draft.addons[btn.dataset.adec] = Math.max((draft.addons[btn.dataset.adec] || 0) - 1, 0);
    } else if ('linc' in btn.dataset) {
      draft.qty = Math.min(draft.qty + 1, 99);
    } else if ('ldec' in btn.dataset) {
      draft.qty = Math.max(draft.qty - 1, 1);
    } else if ('ladd' in btn.dataset) {
      const key = cartKey(product.id, null, draft.addons);
      if (draft.editKey) {
        // Troca a linha editada pela nova combinação no mesmo lugar (se já existir igual, soma nela).
        if (key !== draft.editKey && state.cart[key]) {
          state.cart[key] = Math.min(state.cart[key] + draft.qty, 99);
          delete state.cart[draft.editKey];
        } else {
          state.cart = Object.fromEntries(Object.entries(state.cart).map(([k, q]) => (k === draft.editKey ? [key, draft.qty] : [k, q])));
        }
        saveJson(CART_KEY, state.cart);
        state.lancheDraft = null;
        refreshCartUi();
        openCart();
        return;
      }
      setQty(key, (state.cart[key] || 0) + draft.qty);
      state.lancheDraft = null;
      closeSheet();
      refreshCartUi();
      addedFeedback(product.name);
      return;
    } else {
      return;
    }

    keepSheetScroll(renderLancheSheet);
  });
}

const FEATURED_TITLE = '⭐ Mais Vendidos';

// Feriados nacionais fixos (mesma lista do servidor).
const FIXED_HOLIDAYS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];

// Manhã de domingo ou feriado (6h às 14h, horário de São Paulo)?
function isRestMorning() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(new Date(nowMs())).map(p => [p.type, p.value]));
  const hour = Number(parts.hour) % 24;

  return hour >= 6 && hour < 14 && (parts.weekday === 'Sun' || FIXED_HOLIDAYS.includes(`${parts.month}-${parts.day}`));
}

// Vitrine do modo ressaca: primeiro o que mais vendeu em manhãs assim (histórico real), depois água, isotônico, refri, snacks.
function hangoverProducts() {
  if (storeFeatures().smart_suggestions === false || isBurgerStore()) return [];
  if (!isRestMorning()) return [];

  const picked = [];
  const seen = new Set();
  const add = p => {
    if (p && p.available !== false && !seen.has(p.id) && picked.length < 8) {
      picked.push(p);
      seen.add(p.id);
    }
  };

  (state.recs?.rest_morning || []).forEach(id => add(productById(id)));
  ['agua mineral', 'agua de coco', 'isotonico', 'gatorade', 'energetico', 'coca', 'guarana', 'suco', 'salgadinho', 'biscoito'].forEach(word => add(findByKeyword(word, seen)));

  return picked;
}

// Seções do cardápio: primeiro os destaques, depois cada categoria na ordem cadastrada.
function menuSections() {
  const sections = [];
  const featured = state.products
    .filter(p => p.featured && p.available !== false)
    .sort((a, b) => a.featured_order - b.featured_order);

  if (featured.length) sections.push({ title: FEATURED_TITLE, products: featured });

  // Seção sintética (não é uma categoria real do banco): junta quem está com promoção
  // rolando agora, mesma regra do selo "🔥 Oferta". Some sozinha quando não há promoção ativa.
  const onPromo = state.products.filter(p => p.available !== false && promoNow(p));
  if (onPromo.length) sections.push({ title: '🔥 Promoções', products: onPromo });

  // Esgotados continuam aparecendo (com "Esgotado"), mas no fim da categoria.
  const inStockFirst = list => [...list.filter(p => p.available !== false), ...list.filter(p => p.available === false)];

  for (const category of new Set(state.products.map(p => p.category))) {
    sections.push({ title: category, products: inStockFirst(state.products.filter(p => p.category === category)) });
  }

  return sections;
}

// Busca sem diferenciar acentos nem maiúsculas ("agua" acha "Água").
function normalizeText(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Busca por ocasião: "churrasco" traz tudo que costuma ir num churrasco, na ordem da lista.
const SEARCH_IDEAS = {
  churrasco: ['carvao', 'acendedor', 'alcool', 'sal grosso', 'gelo', 'latao', 'cerveja', 'long neck', 'refrigerante', 'coca', 'guarana', 'agua', 'linguica', 'pao de alho', 'farofa', 'copo', 'prato', 'guardanapo', 'papel aluminio'],
  festa: ['gelo', 'cerveja', 'latao', 'long neck', 'refrigerante', 'coca', 'guarana', 'agua', 'energetico', 'vodka', 'copo', 'salgadinho', 'amendoim'],
  aniversario: ['refrigerante', 'coca', 'guarana', 'gelo', 'cerveja', 'copo', 'prato', 'guardanapo', 'salgadinho', 'vela'],
  praia: ['gelo', 'agua', 'cerveja', 'latao', 'refrigerante', 'isotonico', 'energetico', 'salgadinho', 'biscoito', 'protetor', 'agua de coco'],
  piscina: ['gelo', 'agua', 'cerveja', 'latao', 'refrigerante', 'isotonico', 'salgadinho', 'protetor'],
  ressaca: ['agua', 'isotonico', 'gatorade', 'agua de coco', 'energetico', 'sal de fruta', 'engov', 'suco'],
  'cafe da manha': ['pao', 'leite', 'cafe', 'manteiga', 'margarina', 'queijo', 'presunto', 'achocolatado', 'biscoito', 'acucar', 'suco'],
  caipirinha: ['cachaca', 'vodka', 'limao', 'acucar', 'gelo'],
  drink: ['vodka', 'gin', 'cachaca', 'whisky', 'licor', 'tonica', 'energetico', 'limao', 'gelo', 'acucar'],
  lanche: ['salgadinho', 'biscoito', 'refrigerante', 'chocolate', 'amendoim', 'suco'],
  limpeza: ['detergente', 'sabao', 'agua sanitaria', 'desinfetante', 'esponja', 'saco de lixo', 'papel toalha'],
};
SEARCH_IDEAS.drinks = SEARCH_IDEAS.drink;
SEARCH_IDEAS.churras = SEARCH_IDEAS.churrasco;

// Jeitos de falar → como aparece no cardápio.
const SEARCH_SYNONYMS = {
  refri: 'refrigerante', refris: 'refrigerante', breja: 'cerveja', cerva: 'cerveja', gelada: 'cerveja', latinha: 'lata',
  ln: 'long neck', energ: 'energetico', isot: 'isotonico', cig: 'cigarro',
};

function searchIdea(query) {
  const q = normalizeText(query).trim().replace(/^(pra|para|p\/)\s+/, '').replace(/^(um|uma|o|a)\s+/, '');
  if (isBurgerStore()) {
    const ideas = { lanche: ['x-', 'hamburguer', 'burger', 'combo'], jantar: ['x-', 'hamburguer', 'burger', 'combo'], acompanhamento: ['batata', 'frita', 'porcao'], bebida: ['refrigerante', 'coca', 'guarana', 'guaravita', 'suco', 'agua'] };
    const key = Object.keys(ideas).find(k => q === k || q === `${k}s`);
    return key ? { key, words: ideas[key] } : null;
  }
  const key = Object.keys(SEARCH_IDEAS).find(k => q === k || q === `${k}s`);
  return key ? { key, words: SEARCH_IDEAS[key] } : null;
}

// Distância de edição pequena: aceita um erro de digitação ("hineken", "carvao").
function closeEnough(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;

    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }

  return prev[b.length] <= (a.length >= 6 ? 2 : 1);
}

function searchProducts(query) {
  const idea = searchIdea(query);

  // Ocasião: produtos de cada palavra da lista, na ordem da lista, sem repetir.
  if (idea) {
    const seen = new Set();
    const results = [];

    for (const word of idea.words) {
      const re = new RegExp(`\\b${word}`);

      for (const p of state.products) {
        if (!seen.has(p.id) && re.test(normalizeText(`${p.name} ${p.category}`))) {
          seen.add(p.id);
          results.push(p);
        }
      }
    }

    return results;
  }

  const terms = normalizeText(query).split(/\s+/).filter(Boolean).map(t => SEARCH_SYNONYMS[t] || t);
  // Plural: "cervejas" também acha "cerveja".
  const variantsOf = term => [term, term.replace(/(oes|aes)$/, 'ao').replace(/s$/, '')];

  const nameMatches = [];
  const otherMatches = [];

  for (const p of state.products) {
    const name = normalizeText(p.name);
    const text = normalizeText([p.name, p.description, p.category, ...p.variants.map(v => v.name)].join(' '));

    if (terms.every(term => variantsOf(term).some(t => name.includes(t)))) nameMatches.push(p);
    else if (terms.every(term => variantsOf(term).some(t => text.includes(t)))) otherMatches.push(p);
  }

  if (nameMatches.length || otherMatches.length) return [...nameMatches, ...otherMatches];

  // Nada achado: tenta de novo aceitando um erro de digitação por palavra.
  return state.products.filter(p => {
    const words = normalizeText(`${p.name} ${p.category}`).split(/[^a-z0-9]+/).filter(w => w.length > 2);
    return terms.every(term => term.length < 4 || words.some(w => closeEnough(term, w)));
  });
}

/* ---------------- Pedido por voz ---------------- */
// Frase corrida ("um gelo três latão Brahma três latão Heineken") → lista para o cliente conferir.
// Cada número de quantidade começa um item novo; número com medida ("2 litros", "473 ml") é tamanho.
// Nunca fecha o pedido sozinho: sempre passa pela conferência e pelo carrinho.

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
// Pedido por voz desativado por enquanto: true volta a mostrar o 🎤 na busca.
const VOICE_ORDER_ENABLED = false;
const voiceOrderOn = () => VOICE_ORDER_ENABLED && Boolean(SpeechRec);

const VOICE_UNITS = {
  um: 1, uma: 1, hum: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
};
const VOICE_NUMBERS = {
  ...VOICE_UNITS, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15,
  dezesseis: 16, dezeseis: 16, dezessete: 17, dezesete: 17, dezoito: 18, dezenove: 19,
  vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50,
};
const VOICE_TENS = new Set(['vinte', 'trinta', 'quarenta', 'cinquenta']);
// Medidas: número antes delas é tamanho do produto, não quantidade.
const VOICE_SIZE_UNITS = new Set(['l', 'lt', 'lts', 'litro', 'litros', 'ml', 'mililitro', 'mililitros', 'kg', 'kilo', 'kilos', 'quilo', 'quilos', 'g', 'gr', 'grama', 'gramas']);
// Separam itens quando não tem número entre eles ("gelo e coca").
const VOICE_SEPARATORS = new Set([',', ';', 'e', 'mais', 'tambem', 'depois']);
// Pedem o engradado inteiro ("um engradado de Heineken" = 12 unidades, se o produto tiver engradado).
const VOICE_BULK = new Set(['engradado', 'engradados', 'caixa', 'caixas', 'fardo', 'fardos', 'pack', 'packs']);
const VOICE_FILLER = new Set([
  'quero', 'queria', 'gostaria', 'vou', 'querer', 'me', 've', 'manda', 'mandar', 'traz', 'trazer', 'coloca', 'bota', 'poe',
  'por', 'favor', 'pfv', 'pra', 'para', 'mim', 'de', 'da', 'do', 'das', 'dos', 'o', 'a', 'os', 'as', 'ai', 'entao',
  'unidade', 'unidades', 'un', 'saco', 'sacos', 'pacote', 'pacotes', 'maco', 'macos', 'tipo', 'aquela', 'aquele', 'bem', 'gelada', 'geladas', 'gelado',
]);
// Jeitos de falar embalagem e nome → como está no cardápio.
const VOICE_WORDS = {
  latinha: 'lata', latinhas: 'lata', latas: 'lata', latoes: 'latao', latao: 'latao', latas_: 'lata',
  longneck: ['long', 'neck'], longnecks: ['long', 'neck'], nick: 'neck', nec: 'neck', neque: 'neck', necks: 'neck', ln: ['long', 'neck'],
  litrao: 'litrao', litroes: 'litrao', garrafinha: 'garrafa', garrafinhas: 'garrafa', garrafas: 'garrafa',
  cocacola: ['coca', 'cola'], refri: 'refrigerante', refris: 'refrigerante', breja: 'cerveja', cerva: 'cerveja',
  energ: 'energetico', isot: 'isotonico', gelos: 'gelo',
};
// Palavras do nome que não contam como "diferença" entre produtos (medidas, ligações).
const VOICE_NEUTRAL = /^(\d+|ml|l|g|kg|de|com|em|aprox|un|c)$/;
// Tamanho sem número: escolhe a opção/produto pelo peso ou volume de verdade (kg, g, L, ml).
const VOICE_SIZE_WORDS = {
  pequeno: 'small', pequena: 'small', pequenos: 'small', pequenas: 'small', pequenininho: 'small', pequenininha: 'small', pequenino: 'small',
  menor: 'small', menores: 'small', mini: 'small', minis: 'small',
  grande: 'large', grandes: 'large', grandao: 'large', grandona: 'large', maior: 'large', maiores: 'large', familia: 'large',
  medio: 'medium', media: 'medium', medios: 'medium', medias: 'medium',
};

// Plural → singular ("carvões" → "carvão", "latões" → "latão", "licores" → "licor").
function voiceSingular(word) {
  return word
    .replace(/(oes|aes)$/, 'ao')
    .replace(/ais$/, 'al').replace(/eis$/, 'el').replace(/ois$/, 'ol')
    .replace(/ns$/, 'm')
    .replace(/([rz])es$/, '$1')
    .replace(/([^s])s$/, '$1');
}

// Peso/volume escrito no nome ("5,5 kg", "2,5 ou 3 kg", "350 ml", "2 L"), em g/ml. Sem medida: null.
function voiceSizeOf(text) {
  const m = normalizeText(text).match(/(\d+(?:,\d+)?)(?:\s*ou\s*(\d+(?:,\d+)?))?\s*(kg|g|ml|l)\b/);

  if (!m) return null;

  const n = v => Number(String(v).replace(',', '.'));
  const value = m[2] ? (n(m[1]) + n(m[2])) / 2 : n(m[1]);

  return value * (m[3] === 'kg' || m[3] === 'l' ? 1000 : 1);
}

// Da lista (com tamanho), o menor, o maior ou o do meio. Empate no tamanho: o que vem primeiro
// na lista (o mais provável — "coca grande" = Coca-Cola 2 L, não a Zero 2 L).
function pickBySize(list, sizeOf, size) {
  const sizes = [...new Set(list.map(sizeOf).filter(s => s !== null))].sort((a, b) => a - b);

  if (!sizes.length) return null;

  const target = size === 'small' ? sizes[0] : size === 'large' ? sizes[sizes.length - 1] : sizes[Math.floor((sizes.length - 1) / 2)];

  return list.find(x => sizeOf(x) === target);
}

// Forma "de som" da palavra: o reconhecimento de voz escreve "brama", "rainequen", "skoll"...
function voiceSound(word) {
  return voiceSingular(word)
    .replace(/ph/g, 'f').replace(/th/g, 't').replace(/y/g, 'i').replace(/w/g, 'u')
    .replace(/ck/g, 'c').replace(/k/g, 'c').replace(/qu/g, 'c')
    .replace(/(^|[^cln])h/g, '$1')
    .replace(/^r(?=[aeiou])/, '')
    .replace(/ai|ei/g, 'e').replace(/ou/g, 'o')
    .replace(/(.)\1+/g, '$1')
    .replace(/z$/, 's')
    .replace(/s$/, '');
}

function voiceTokens(text) {
  return normalizeText(text)
    .replace(/(\d)\s*x\b/g, '$1')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[,;]/g, ' , ')
    .replace(/[^a-z0-9,]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// Lê um número a partir de tokens[i] ("3", "tres", "vinte e quatro", "meia duzia", "duas duzias").
function readVoiceNumber(tokens, i) {
  const tok = tokens[i];
  let value = null;
  let next = i + 1;

  if (/^\d+$/.test(tok)) value = Number(tok);
  else if (tok === 'meia' && /^duzias?$/.test(tokens[i + 1])) return { value: 6, next: i + 2 };
  else if (/^duzias?$/.test(tok)) return { value: 12, next: i + 1 };
  else if (tok in VOICE_NUMBERS) {
    value = VOICE_NUMBERS[tok];

    if (VOICE_TENS.has(tok) && tokens[i + 1] === 'e' && tokens[i + 2] in VOICE_UNITS) {
      value += VOICE_UNITS[tokens[i + 2]];
      next = i + 3;
    }
  }

  if (value === null) return null;

  if (/^duzias?$/.test(tokens[next])) {
    value *= 12;
    next += 1;
  }

  return { value, next };
}

function voiceWordsOf(tok) {
  const mapped = VOICE_WORDS[tok] || SEARCH_SYNONYMS[tok] || tok;
  return Array.isArray(mapped) ? mapped : String(mapped).split(' ');
}

function parseVoiceOrder(text) {
  const tokens = voiceTokens(text);
  const items = [];
  let cur = null;

  const close = () => {
    if (cur && cur.words.length) items.push(cur);
    cur = null;
  };
  const ensure = () => {
    if (!cur) cur = { qty: 1, words: [], without: [], said: [], bulk: false, size: null };
    return cur;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const num = readVoiceNumber(tokens, i);

    if (num) {
      const said = tokens.slice(i, num.next);
      const afterIsSize = VOICE_SIZE_UNITS.has(tokens[num.next]);

      // "2 litros", "473 ml", "600": tamanho do produto do item atual.
      if (afterIsSize || num.value >= 100) {
        const item = ensure();
        item.words.push(String(num.value));
        item.said.push(...said);
        if (afterIsSize) item.said.push(tokens[num.next]);
        i = afterIsSize ? num.next : num.next - 1;
        continue;
      }

      // Número de quantidade: começa um item novo.
      close();
      cur = { qty: num.value, words: [], without: [], said, bulk: false, size: null };
      i = num.next - 1;
      continue;
    }

    if (VOICE_SEPARATORS.has(tok)) {
      close();
      continue;
    }

    const item = ensure();
    item.said.push(tok);

    // "sem gás", "sem açúcar": o produto não pode ter essa palavra no nome.
    if (tok === 'sem' && tokens[i + 1] && !VOICE_SEPARATORS.has(tokens[i + 1]) && !readVoiceNumber(tokens, i + 1)) {
      item.said.push(tokens[i + 1]);
      item.without.push(...voiceWordsOf(tokens[i + 1]));
      i += 1;
      continue;
    }

    if (VOICE_BULK.has(tok)) {
      item.bulk = true;
      continue;
    }

    // "pequeno", "grande", "médio": escolhe pelo tamanho, não é parte do nome.
    if (VOICE_SIZE_WORDS[tok]) {
      item.size = VOICE_SIZE_WORDS[tok];
      continue;
    }

    if (VOICE_FILLER.has(tok)) continue;

    item.words.push(...voiceWordsOf(tok));
  }

  close();

  return items.map(item => ({
    qty: Math.min(Math.max(item.qty, 1), 99),
    words: item.words.filter(w => w.length >= 2 || /^\d+$/.test(w)),
    without: item.without,
    bulk: item.bulk,
    size: item.size,
    said: item.said.join(' '),
  })).filter(item => item.words.length).flatMap(splitVoiceItem);
}

// O reconhecimento quase nunca escreve vírgula: "gelo água brahma" chega como um item só.
// Se nenhum produto tem todas essas palavras no nome, divide no menor número de pedaços em que
// cada pedaço é um produto ("gelo" + "água" + "brahma" = 1 de cada). "Latão Brahma" continua junto.
// A quantidade falada fica no primeiro pedaço; os outros saem com 1.
function splitVoiceItem(item) {
  const isNum = w => /^\d+$/.test(w);
  const terms = item.words.filter(w => !isNum(w));

  if (terms.length < 2 || item.words.length > 12) return [item];

  const sub = words => ({ ...item, qty: 1, words, said: words.join(' ') });
  const fullScore = words => {
    if (!words.some(w => !isNum(w))) return null;
    const best = voiceCandidates(sub(words)).find(c => c.full);
    return best ? best.score : null;
  };

  if (fullScore(item.words) !== null) return [item];

  // best[i]: melhor divisão das primeiras i palavras (menos pedaços; empate = maior pontuação).
  const n = item.words.length;
  const best = [{ segs: 0, score: 0, cuts: [] }];

  for (let i = 1; i <= n; i++) {
    for (let j = 0; j < i; j++) {
      if (!best[j]) continue;

      const words = item.words.slice(j, i);
      let score = fullScore(words);
      let unknown = false;

      // Palavra solta que não é produto nenhum: vira item à parte (aparece em "Não achei").
      if (score === null && words.length === 1 && !isNum(words[0]) && !voiceCandidates(sub(words)).length) {
        score = -0.5;
        unknown = true;
      }
      if (score === null) continue;

      const cand = { segs: best[j].segs + 1, score: best[j].score + score, cuts: [...best[j].cuts, { j, i, unknown }] };
      const cur = best[i];

      if (!cur || cand.segs < cur.segs || (cand.segs === cur.segs && cand.score > cur.score)) best[i] = cand;
    }
  }

  const done = best[n];

  // Não deu para dividir em produtos conhecidos (ou só sobrou palavra solta): fica como estava.
  if (!done || done.segs < 2 || done.cuts.every(c => c.unknown)) return [item];

  return done.cuts.map((c, k) => ({ ...sub(item.words.slice(c.j, c.i)), qty: k === 0 ? item.qty : 1 }));
}

// Quanto uma palavra dita "bate" com uma palavra do nome do produto.
function voiceHit(term, word) {
  if (word === term || voiceSingular(word) === voiceSingular(term)) return 1;
  if (/^\d+$/.test(term) || /^\d+$/.test(word)) return 0;

  const a = voiceSound(term);
  const b = voiceSound(word);

  if (a.length >= 3 && a === b) return 0.9;
  if (term.length >= 4 && word.startsWith(term)) return 0.8;
  // "Parecido" só com a mesma letra inicial (erro de reconhecimento costuma manter o começo).
  if (a[0] !== b[0]) return 0;
  if (a.length >= 4 && closeEnough(a, b)) return 0.6;
  if (term.length >= 5 && closeEnough(term, word)) return 0.5;
  return 0;
}

// Palavras de cada produto (com peso): nome vale mais que a opção (sabor), que vale mais que a categoria.
const VOICE_CATEGORY_SKIP = new Set(['e', 'de', 'do', 'da', 'pedido', 'minimo', 'r', '20', '00']);
let voiceIndexCache = null;

function voiceIndex() {
  if (voiceIndexCache?.products === state.products) return voiceIndexCache.index;

  const split = text => normalizeText(text).split(/[^a-z0-9]+/).filter(Boolean);
  const index = state.products.filter(p => p.available !== false).map(p => {
    const words = split(p.name);
    const weighted = new Map();
    const add = (w, weight) => { if (w && (weighted.get(w) || 0) < weight) weighted.set(w, weight); };

    words.forEach((w, i) => {
      add(w, 1);
      // Nome colado: "redbull", "cocacola", "longneck".
      if (words[i + 1]) add(w + words[i + 1], 1);
    });
    p.variants.forEach(v => split(v.name).forEach(w => add(w, 0.8)));
    split(p.category).filter(w => !VOICE_CATEGORY_SKIP.has(w)).forEach(w => add(w, 0.7));

    return { p, name: normalizeText(p.name), words, weighted: [...weighted.entries()] };
  });

  voiceIndexCache = { products: state.products, index };
  return index;
}

// Os produtos que combinam com o que foi dito, do mais provável para o menos.
function voiceCandidates(item) {
  // Números ("2" litros, "473") só ajudam a escolher o tamanho; quem decide o produto são as palavras.
  const terms = item.words.filter(w => !/^\d+$/.test(w));
  const sizes = item.words.filter(w => /^\d+$/.test(w));
  const phrase = item.words.join(' ');
  const results = [];

  if (!terms.length) return results;

  for (const { p, name, words, weighted } of voiceIndex()) {
    // "sem gás": fora os que têm gás no nome (a não ser que o nome diga "sem gás").
    if (item.without.some(w => words.some(x => voiceHit(w, x) >= 0.9) && !name.includes(`sem ${w}`))) continue;

    const values = terms.map(t => Math.max(0, ...weighted.map(([w, weight]) => voiceHit(t, w) * weight)));
    const matched = values.filter(Boolean).length;
    const avg = values.reduce((a, b) => a + b, 0) / terms.length;

    // Pelo menos metade das palavras batendo, e não só por "parecido" ("pastel" não vira "Amstel").
    if (!matched || matched / terms.length < 0.5 || avg < 0.6) continue;

    // Empate: o produto com menos palavras "a mais" no nome (o principal). Gelo pedido = gelo de verdade.
    const extras = words.filter(w => !VOICE_NEUTRAL.test(w) && !terms.some(t => voiceHit(t, w))).length;
    // Galão de 20 L só quando o cliente fala "20" ou "galão" ("duas águas" = garrafinha).
    const bigWater = /\b20 l\b/.test(name) && !/\b(20|galao|galoes)\b/.test(phrase) ? 0.3 : 0;
    // Tamanho falado que aparece no nome (ou numa opção) desempata: "coca 2 litros" = Coca-Cola 2 L.
    const sizeBonus = sizes.filter(n => weighted.some(([w]) => w === n)).length * 0.1;
    const withoutBonus = item.without.some(w => name.includes(`sem ${w}`)) ? 0.2 : 0;
    // "Água de coco", "água com gás": "de/com X" que o cliente não falou é outro produto.
    const otherKind = [...name.matchAll(/\b(?:de|com)\s+([a-z]{3,})/g)].some(([, w]) => !terms.some(t => voiceHit(t, w))) ? 0.1 : 0;
    const score = avg - extras * 0.05 - bigWater - otherKind + sizeBonus + withoutBonus + (terms.includes('gelo') && isIce(p) ? 0.5 : 0);
    // Todas as palavras ditas estão no nome (ou numa opção) do produto — não só na categoria.
    const full = terms.every(t => weighted.some(([w, weight]) => weight >= 0.8 && voiceHit(t, w) >= 0.6));

    results.push({ p, score, full });
  }

  return results.sort((a, b) => b.score - a.score);
}

// Produto (e opção) escolhido para um item falado.
function voiceChoice(item, p) {
  let variant = null;

  if (p.variants.length) {
    const open = p.variants.filter(v => v.available !== false);

    if (!open.length) return null;

    // Conta as palavras da opção que batem com o que foi dito ("5,5 kg" ganha de "2,5 kg" para "cinco quilos").
    const scored = open.map(v => ({ v, hits: normalizeText(v.name).split(/[^a-z0-9]+/).filter(w => item.words.some(t => voiceHit(t, w))).length }));
    const top = Math.max(...scored.map(s => s.hits));
    const tied = scored.filter(s => s.hits === top).map(s => s.v);

    // "pequeno"/"grande"/"médio" desempata pelo tamanho; sem isso, prefere a opção "tradicional/original".
    variant = (item.size && pickBySize(tied, v => voiceSizeOf(v.name), item.size))
      || tied.find(v => /^(tradicional|original|normal|comum)\b/.test(normalizeText(v.name)))
      || tied[0];
  }

  // "Um engradado de Heineken" = a quantidade do engradado do produto.
  const bulkQty = (variant || p).bulk_qty;
  const qty = item.bulk && bulkQty ? Math.min(item.qty * bulkQty, 99) : item.qty;

  return { key: cartKey(p.id, variant?.id), name: variant ? `${p.name} - ${variant.name}` : p.name, qty };
}

function matchVoiceProduct(item) {
  const candidates = voiceCandidates(item);

  if (!candidates.length) return null;

  let pick = candidates[0];

  // "coca pequena" / "água grande": entre os produtos que combinam quase igual, o menor ou o maior.
  // (Se o produto tem opções de tamanho, quem escolhe é a opção, em voiceChoice.)
  const sizedVariants = pick.p.variants.some(v => voiceSizeOf(v.name) !== null);

  if (item.size && !sizedVariants) {
    // Só compara com produtos da mesma categoria ("água pequena" não vira Água de Coco).
    const near = candidates.filter(c => c.score >= candidates[0].score - 0.1 && c.p.category === pick.p.category);
    pick = pickBySize(near, c => voiceSizeOf(c.p.name), item.size) || pick;
  }

  const choice = voiceChoice(item, pick.p);

  if (!choice) return null;

  // Outras opções parecidas, para o cliente trocar na conferência.
  choice.alternatives = candidates.filter(c => c !== pick)
    .filter(c => c.score >= candidates[0].score - 0.35)
    .slice(0, 5)
    .map(c => voiceChoice(item, c.p))
    .filter(Boolean);

  return choice;
}

// Quanto um texto reconhecido "faz sentido" com o cardápio (para escolher entre as versões do reconhecimento).
function voiceTextScore(text) {
  const items = parseVoiceOrder(text);
  return items.reduce((sum, item) => sum + (voiceCandidates(item)[0] ? 1 + voiceCandidates(item)[0].score : -0.5), 0);
}

// Ouve até o cliente parar de falar (pausa curta não corta) ou tocar em "Pronto".
// "Falar mais" continua a lista que já foi entendida (previous).
// Pedido por voz no celular: o reconhecimento do Android/iPhone costuma falhar a partir da
// 2ª vez quando se cria um reconhecedor novo a cada toque, quando se "aborta" um que já
// terminou ou quando o modo contínuo fica preso. Por isso: um reconhecedor só para a página
// (recriado só se travar), no celular uma frase por vez (continuous = false; "Falar mais"
// continua a lista), e se o celular recusar começar, recria e tenta de novo ainda no mesmo toque.
const VOICE_MOBILE = /android|iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /mac/i.test(navigator.platform || ''));
// iPhone/iPad (todo navegador do iOS é Safari por dentro): reaproveitar o reconhecedor faz o
// Safari parar de entregar resultados a partir da 2ª frase, e os resultados parciais são instáveis.
// Lá é um reconhecedor NOVO a cada toque, sem parciais, descartado ao terminar.
const VOICE_IOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /mac/i.test(navigator.platform || ''));
let voiceRecognizer = null;
let voiceSession = null; // encerra a sessão anterior, se ainda estiver aberta
let voiceUses = 0; // quantas vezes o 🎤 foi usado nesta página (vai no diagnóstico)

function newVoiceRecognizer() {
  const rec = new SpeechRec();
  rec.lang = 'pt-BR';
  rec.continuous = !VOICE_MOBILE;
  rec.interimResults = !VOICE_IOS;
  rec.maxAlternatives = 3;
  return rec;
}

// iPhone: o reconhecimento de voz do Safari entrega o microfone "mudo" a partir da 2ª vez
// (confirmado pelo diagnóstico: abre o áudio mas nunca detecta fala). Lá o site grava o áudio
// com o microfone comum (getUserMedia, funciona quantas vezes precisar), para sozinho quando a
// pessoa termina de falar e o servidor transcreve (Workers AI / Whisper, POST /api/voice-transcribe).
function startVoiceRecording(button, previous = '') {
  if (voiceSession) voiceSession(true);

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  // Criado ainda dentro do toque (senão o iPhone não libera o áudio).
  const ctx = new AudioCtx();
  ctx.resume?.();
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}

  const t0 = Date.now();
  const diag = [];
  const note = ev => diag.push(`${Date.now() - t0} ${ev}`);
  const chunks = [];
  let stream = null;
  let source = null;
  let proc = null;
  let ended = false;
  let cancelled = false;
  let spoke = false;
  let lastLoud = 0;
  let noise = 0;
  let noiseN = 0;
  let recorded = 0;
  voiceUses += 1;

  state.listening = true;
  button.classList.add('listening');

  const sheet = openSheet(`
    <div class="sheet-head"><h2>🎤 Ouvindo…</h2><button data-close aria-label="Fechar">✕</button></div>
    <p class="muted" style="margin-top:0">${escapeHtml(voiceExample())}</p>
    ${previous ? `<p class="muted" style="font-size:13px">Já anotado: "${escapeHtml(previous)}"</p>` : ''}
    <p class="voice-live" id="voice-live">Pode falar… (quando terminar, espere um instante ou toque em Pronto)</p>
    <div class="voice-actions">
      <button class="btn primary block" id="voice-done">✅ Pronto</button>
    </div>
  `);
  const live = sheet.querySelector('#voice-live');

  const log = extra => {
    try {
      fetch('/api/voice-log', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ua: navigator.userAgent, mode: 'gravacao', use: voiceUses, spoke, cancelled, seconds: Math.round(recorded / (ctx.sampleRate || 48000) * 10) / 10, events: diag, ...extra }),
      }).catch(() => {});
    } catch {}
  };

  const release = () => {
    try { if (proc) proc.onaudioprocess = null; proc?.disconnect(); source?.disconnect(); } catch {}
    try { stream?.getTracks().forEach(t => t.stop()); } catch {}
    try { ctx.close(); } catch {}
    try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch {}
    state.listening = false;
    button.classList.remove('listening');
    document.getElementById('voice-order')?.classList.remove('listening');
    if (voiceSession === finish) voiceSession = null;
  };

  // Termina a gravação. silent = outra sessão está começando; manual = tocou em "Pronto".
  async function finish(silent = false, manual = false) {
    if (ended) return;
    ended = true;
    note(manual ? 'pronto' : 'fim');
    release();

    const rate = ctx.sampleRate || 48000;
    const enough = recorded > rate * 0.6;

    if (silent || cancelled) return log({ result: 'cancelado' });
    if (!(spoke || (manual && enough))) {
      log({ result: 'sem fala' });
      closeSheet();
      toast('Não ouvi nada. Toque no 🎤 e fale os produtos.', true);
      return;
    }

    live.textContent = 'Entendendo o pedido…';
    sheet.querySelector('#voice-done')?.remove();

    try {
      const response = await fetch('/api/voice-transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: encodeWav(chunks, rate) });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) throw new Error(data.error || 'Não consegui entender o áudio.');

      const heard = String(data.text || '').trim();
      log({ result: heard ? 'ok' : 'vazio' });

      if (heard || previous) showVoiceReview([previous, heard].filter(Boolean).join(', '));
      else {
        closeSheet();
        toast('Não entendi. Toque no 🎤 e fale de novo.', true);
      }
    } catch (err) {
      log({ result: `erro: ${err.message}` });
      closeSheet();
      toast(err.message || 'Não consegui entender o áudio. Tente de novo.', true);
    }
  }
  voiceSession = finish;

  sheet.querySelector('#voice-done').addEventListener('click', () => finish(false, true));
  sheet.addEventListener('click', event => {
    if (event.target === sheet || event.target.closest('[data-close]')) {
      cancelled = true;
      finish();
    }
  });

  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then(s => {
      stream = s;
      if (ended) return release();
      note('mic');
      source = ctx.createMediaStreamSource(stream);
      proc = ctx.createScriptProcessor(4096, 1, 1);
      source.connect(proc);
      proc.connect(ctx.destination);

      proc.onaudioprocess = event => {
        if (ended) return;
        const input = event.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(input));
        recorded += input.length;

        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        const now = Date.now();

        // Primeiros ~0,4 s: mede o barulho do ambiente; fala = bem acima dele.
        if (now - t0 < 400) {
          noise += rms;
          noiseN += 1;
          return;
        }
        const floor = noiseN ? noise / noiseN : 0;

        if (rms > Math.max(0.012, floor * 3)) {
          if (!spoke) note('fala');
          spoke = true;
          lastLoud = now;
        }

        // Parou de falar por 1,6 s: termina. Sem falar nada em 10 s, ou 25 s no total: termina.
        if ((spoke && now - lastLoud > 1600) || (!spoke && now - t0 > 10000) || now - t0 > 25000) finish();
      };
    })
    .catch(err => {
      note(`erro-mic:${err.name}`);
      if (ended) return;
      ended = true;
      release();
      log({ result: `sem microfone: ${err.name}` });
      closeSheet();
      toast(err.name === 'NotAllowedError' ? 'Permita o uso do microfone para pedir falando.' : 'Não consegui usar o microfone. Tente de novo.', true);
    });
}

// Áudio gravado → WAV 16 kHz mono 16 bits (formato que o servidor manda para a transcrição).
function encodeWav(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / 16000;
  const outLen = Math.floor(total / ratio);
  const all = new Float32Array(total);
  let pos = 0;
  for (const c of chunks) { all.set(c, pos); pos += c.length; }

  const buffer = new ArrayBuffer(44 + outLen * 2);
  const view = new DataView(buffer);
  const text = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + outLen * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, outLen * 2, true);

  for (let i = 0; i < outLen; i++) {
    // Média do trecho (reduz de 48 kHz para 16 kHz sem chiado).
    const start = Math.floor(i * ratio);
    const end = Math.min(total, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += all[j];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function startVoiceOrder(button, previous = '') {
  if (VOICE_IOS && navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext)) {
    return startVoiceRecording(button, previous);
  }
  if (voiceSession) voiceSession(true);

  let rec = VOICE_IOS ? newVoiceRecognizer() : (voiceRecognizer || (voiceRecognizer = newVoiceRecognizer()));
  const finals = [];
  let interimText = '';
  let silence = null;
  let watchdog = null;
  let cancelled = false;
  let ended = false;
  let lastError = '';
  let retries = 0;
  let gotAudio = false;
  // Diagnóstico da sessão (vai para o servidor ao terminar): ajuda a achar falhas de celular.
  const t0 = Date.now();
  const diag = [];
  const note = ev => diag.push(`${Date.now() - t0} ${ev}`);
  voiceUses += 1;

  state.listening = true;
  button.classList.add('listening');

  const sheet = openSheet(`
    <div class="sheet-head"><h2>🎤 Ouvindo…</h2><button data-close aria-label="Fechar">✕</button></div>
    <p class="muted" style="margin-top:0">${escapeHtml(voiceExample())}</p>
    ${previous ? `<p class="muted" style="font-size:13px">Já anotado: "${escapeHtml(previous)}"</p>` : ''}
    <p class="voice-live" id="voice-live">${VOICE_IOS ? 'Pode falar… (quando terminar, espere um instante ou toque em Pronto)' : '…'}</p>
    <div class="voice-actions">
      <button class="btn primary block" id="voice-done">✅ Pronto</button>
    </div>
  `);

  const live = sheet.querySelector('#voice-live');
  const stop = () => {
    note('stop');
    try { rec.stop(); } catch {}
    // Se o navegador não avisar que terminou, termina assim mesmo (e troca o reconhecedor, que travou).
    clearTimeout(watchdog);
    // No iPhone o resultado só chega depois de parar (sem parciais): espera mais.
    watchdog = setTimeout(() => { note('watchdog'); finish(false, true); }, VOICE_IOS ? 5000 : 2000);
  };
  const armSilence = (ms = 3500) => {
    clearTimeout(silence);
    silence = setTimeout(stop, ms);
  };

  sheet.querySelector('#voice-done').addEventListener('click', stop);
  sheet.addEventListener('click', event => {
    if (event.target === sheet || event.target.closest('[data-close]')) {
      cancelled = true;
      stop();
    }
  });

  const onResult = event => {
    if (ended) return;
    interimText = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];

      if (result.isFinal) {
        // Das versões que o navegador ouviu, fica a que mais combina com o cardápio.
        const versions = Array.from(result, alt => alt.transcript);
        finals[i] = versions.map(t => ({ t, s: voiceTextScore(t) })).sort((a, b) => b.s - a.s)[0].t;
      } else {
        interimText += ` ${result[0].transcript}`;
      }
    }

    live.textContent = `${finals.filter(Boolean).join(' ')} ${interimText}`.trim() || '…';
    armSilence();
  };
  const onError = event => {
    if (ended) return;
    note(`error:${event.error}`);
    lastError = event.error || '';
    // O iPhone às vezes recusa o microfone logo no começo da 2ª vez em diante: recria o
    // reconhecedor e tenta de novo sozinho (até 2 vezes), sem mostrar erro.
    const early = !gotAudio && !finals.length && !interimText && Date.now() - t0 < 4000;
    if (early && retries < 2 && ['aborted', 'audio-capture', 'network', 'service-not-allowed', 'not-allowed'].includes(event.error)) {
      retries += 1;
      const failed = rec;
      failed.onresult = failed.onerror = failed.onend = null;
      failed.onaudiostart = failed.onspeechstart = null;
      try { failed.abort(); } catch {}
      if (voiceRecognizer === failed) voiceRecognizer = null;
      setTimeout(() => {
        if (ended) return;
        note(`retry${retries}`);
        rec = newVoiceRecognizer();
        if (!VOICE_IOS) voiceRecognizer = rec;
        attach(rec);
        try { rec.start(); } catch (err) { note(`throw:${err.name}`); finish(false, true); }
      }, 600);
      return;
    }
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    toast(event.error === 'not-allowed' || event.error === 'service-not-allowed'
      ? 'Permita o uso do microfone para pedir falando.'
      : `Não consegui ouvir (${event.error}). Tente de novo.`, true);
  };
  const attach = r => {
    r.onaudiostart = () => { gotAudio = true; note('audiostart'); };
    r.onspeechstart = () => note('speechstart');
    r.onresult = event => { note('result'); onResult(event); };
    r.onerror = onError;
    r.onend = () => { note('end'); finish(false, false); };
  };

  // Fecha a sessão uma vez só. silent = outra sessão está começando; stuck = o reconhecedor não
  // respondeu (é descartado e o próximo toque cria outro).
  function finish(silent = false, stuck = false) {
    if (ended) return;
    ended = true;
    clearTimeout(silence);
    clearTimeout(watchdog);
    if (voiceSession === finish) voiceSession = null;
    rec.onresult = rec.onerror = rec.onend = null;
    if (stuck || silent) {
      try { rec.abort(); } catch {}
      if (voiceRecognizer === rec) voiceRecognizer = null;
    } else if (VOICE_IOS) {
      // iPhone: o reconhecedor que terminou não é reaproveitado (o próximo toque cria outro).
      if (voiceRecognizer === rec) voiceRecognizer = null;
    }
    state.listening = false;
    button.classList.remove('listening');
    document.getElementById('voice-order')?.classList.remove('listening');

    const heard = `${finals.filter(Boolean).join(' ')} ${interimText}`.trim();

    try {
      fetch('/api/voice-log', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ua: navigator.userAgent, ios: VOICE_IOS, use: voiceUses, retries, heard: Boolean(heard), silent, stuck, cancelled, lastError, events: diag }),
      }).catch(() => {});
    } catch {}

    if (silent || cancelled) return;

    if (heard || previous) showVoiceReview([previous, heard].filter(Boolean).join(', '));
    else {
      closeSheet();
      toast(lastError === 'no-speech' || !lastError ? 'Não ouvi nada. Toque no 🎤 e fale os produtos.' : 'Não consegui ouvir. Toque no 🎤 e tente de novo.', true);
    }
  }
  voiceSession = finish;

  attach(rec);
  armSilence(VOICE_IOS ? 12000 : 3500);

  note('start');
  try {
    rec.start();
  } catch (err) {
    note(`throw:${err.name}`);
    // O reconhecedor ficou preso da vez anterior: cria outro na hora (ainda dentro do toque,
    // senão o celular não libera o microfone).
    try { rec.abort(); } catch {}
    rec.onresult = rec.onerror = rec.onend = null;
    rec = newVoiceRecognizer();
    if (!VOICE_IOS) voiceRecognizer = rec;
    attach(rec);
    try { rec.start(); } catch { finish(false, true); }
  }
}

function showVoiceReview(text) {
  const lines = parseVoiceOrder(text).map(item => ({ ...item, match: matchVoiceProduct(item) }));
  const found = lines.filter(l => l.match);
  const missing = lines.filter(l => !l.match);

  const sheet = openSheet(`
    <div class="sheet-head"><h2>🎤 Entendi assim</h2><button data-close aria-label="Fechar">✕</button></div>
    ${found.length ? `<ul class="voice-list">${found.map((l, i) => `
      <li>
        <div class="voice-item">
          <label><input type="checkbox" data-voice-item="${i}" checked /> <span id="voice-name-${i}">${escapeHtml(l.match.name)}</span></label>
          ${l.match.alternatives.length ? `
            <select class="voice-alt" data-voice-alt="${i}" aria-label="Trocar produto">
              <option value="">trocar por…</option>
              ${l.match.alternatives.map((a, j) => `<option value="${j}">${escapeHtml(a.name)}</option>`).join('')}
            </select>` : ''}
        </div>
        <span class="qty"><button type="button" data-voice-dec="${i}">−</button><span id="voice-qty-${i}">${l.match.qty}</span><button type="button" data-voice-inc="${i}">+</button></span>
      </li>`).join('')}</ul>`
      : '<p class="empty">Não achei nenhum produto nessa frase.</p>'}
    ${missing.length ? `
      <div class="voice-missing">
        <strong>Não achei:</strong>
        ${missing.map(l => `<button type="button" class="btn small" data-voice-search="${escapeHtml(l.words.join(' '))}">🔎 Procurar "${escapeHtml(l.said)}"</button>`).join('')}
      </div>` : ''}
    <div class="voice-actions">
      ${found.length ? '<button class="btn primary block" id="voice-add">Colocar no carrinho e revisar</button>' : ''}
      <button class="btn block" id="voice-more">🎤 Falar mais</button>
    </div>
    <details class="voice-text">
      <summary>Entendi errado? Corrija o texto</summary>
      <textarea id="voice-text" rows="3">${escapeHtml(text)}</textarea>
      <button type="button" class="btn small" id="voice-reparse">↻ Entender de novo</button>
    </details>
  `);

  sheet.addEventListener('click', event => {
    const btn = event.target.closest('button');

    if (!btn) return;

    const i = btn.dataset.voiceInc ?? btn.dataset.voiceDec;

    if (i !== undefined) {
      const match = found[Number(i)].match;
      match.qty = Math.min(99, Math.max(1, match.qty + (btn.dataset.voiceInc !== undefined ? 1 : -1)));
      sheet.querySelector(`#voice-qty-${i}`).textContent = match.qty;
    } else if (btn.dataset.voiceSearch) {
      closeSheet();
      state.search = btn.dataset.voiceSearch;
      renderMenu();
      const input = document.getElementById('search');
      if (input) input.value = state.search;
      document.getElementById('clear-search')?.removeAttribute('hidden');
    }
  });

  // Trocar pelo parecido: mantém a quantidade escolhida.
  sheet.addEventListener('change', event => {
    const i = event.target.dataset.voiceAlt;

    if (i === undefined || event.target.value === '') return;

    const line = found[Number(i)];
    const alt = line.match.alternatives[Number(event.target.value)];
    const current = { ...line.match, alternatives: undefined };

    line.match.alternatives[Number(event.target.value)] = { key: current.key, name: current.name, qty: current.qty };
    Object.assign(line.match, { key: alt.key, name: alt.name });
    sheet.querySelector(`#voice-name-${i}`).textContent = alt.name;
    event.target.innerHTML = `<option value="">trocar por…</option>${line.match.alternatives.map((a, j) => `<option value="${j}">${escapeHtml(a.name)}</option>`).join('')}`;
  });

  sheet.querySelector('#voice-add')?.addEventListener('click', () => {
    sheet.querySelectorAll('[data-voice-item]').forEach(box => {
      if (!box.checked) return;
      const { match } = found[Number(box.dataset.voiceItem)];
      setQty(match.key, (state.cart[match.key] || 0) + match.qty);
    });
    renderMenu();
    openCart(); // sempre abre o carrinho para o cliente conferir antes de finalizar
  });

  sheet.querySelector('#voice-more').addEventListener('click', () => {
    const mic = document.getElementById('voice-order');
    const current = sheet.querySelector('#voice-text').value.trim();
    closeSheet();
    if (mic) startVoiceOrder(mic, current);
  });

  sheet.querySelector('#voice-reparse').addEventListener('click', () => {
    const edited = sheet.querySelector('#voice-text').value.trim();
    if (edited) showVoiceReview(edited);
  });
}

const searchLogged = new Set();
let searchLogTimer = null;

function logEmptySearch(query) {
  clearTimeout(searchLogTimer);
  searchLogTimer = setTimeout(() => {
    const term = normalizeText(query).trim();

    // Só registra se o cliente parou nessa busca e ela continua sem resultado.
    if (term.length < 2 || searchLogged.has(term) || normalizeText(state.search).trim() !== term) return;

    searchLogged.add(term);
    fetch('/api/search-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ term }), keepalive: true }).catch(() => {});
  }, 2500);
}

function menuBodyHtml() {
  if (!state.products.length) {
    return '<p class="empty">O cardápio ainda está sendo montado. Volte daqui a pouco!</p>';
  }

  if (state.search.trim()) {
    const results = searchProducts(state.search);

    const idea = searchIdea(state.search);

    if (!results.length) logEmptySearch(state.search);

    return results.length
      ? `<h2 class="section-title">${idea ? `🔥 Para ${escapeHtml(idea.key)}: ${results.length} produto(s)` : `${results.length} resultado(s) para "${escapeHtml(state.search.trim())}"`}</h2>
         <div class="products">${results.map(productHtml).join('')}</div>`
      : `<p class="empty">Nenhum produto encontrado para "${escapeHtml(state.search.trim())}".</p>`;
  }

  const sections = menuSections();
  const hangover = storeFeatures().smart_suggestions === false ? [] : hangoverProducts();

  // Domingo/feriado de manhã: vitrine "modo ressaca" no topo (produtos reais, os que mais saem nesse horário primeiro).
  if (hangover.length >= 3) sections.unshift({ title: '🥴 Modo ressaca', products: hangover });

  const nav = sections.length > 1
    ? `<nav class="categories">${sections.map(s => `<button data-cat="${escapeHtml(s.title)}">${escapeHtml(s.title)}</button>`).join('')}</nav>`
    : '';

  return nav + sections.map(section => {
    const isCombos = isBurgerStore() && /combo/i.test(section.title);
    // Cada categoria mantém sua própria faixa horizontal de produtos.
    const isScroll = isBurgerStore();
    const sectionTitle = normalizeText(section.title).includes('acai') ? 'Monte seu açaí' : section.title;
    return `
    <section id="cat-${encodeURIComponent(section.title)}" class="${isCombos ? 'menu-section-combos' : ''}">
      <h2 class="section-title">${escapeHtml(sectionTitle)}</h2>
      <div class="products ${isScroll ? 'menu-section-scroll' : ''}">
        ${section.products.map(productHtml).join('')}
      </div>
    </section>`;
  }).join('');
}

// Junta o carrinho ao pedido que ainda não saiu (o servidor confere o status e recalcula os preços).
async function addToActiveOrder(button) {
  const order = state.activeOrder;

  if (!order || !confirm(`Adicionar estes itens ao pedido #${order.public_code}? O total do pedido vai aumentar.`)) return;

  button.disabled = true;

  try {
    const r = await api(`/api/orders/${order.id}/items`, {
      method: 'POST',
      body: JSON.stringify({ items: cartEntries().map(e => ({ product_id: e.product.id, variant_id: e.variant?.id || null, quantity: e.qty, chilled: Boolean(e.chill?.on), no_cheddar: e.noCheddar === true, addons: (e.addons || []).map(a => ({ product_id: a.product.id, quantity: a.qty })) })) }),
    });

    state.cart = {};
    saveJson(CART_KEY, state.cart);
    state.chill = {};
    saveJson(CHILL_KEY, state.chill);
    state.noCheddar = {};
    saveJson(NO_CHEDDAR_KEY, state.noCheddar);
    closeSheet();
    history.pushState(null, '', `?pedido=${order.id}`);
    showOrder(order.id);
    toast(`Itens adicionados ao pedido #${r.code}! Novo total: ${money(r.total_cents)} ✓`);
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
    loadOrderChip();
  }
}

function cartBarHtml() {
  const count = cartCount();

  return count
    ? `<div class="cart-bar"><button class="btn primary" id="open-cart"><span>Ver carrinho (${count})</span><span>${money(cartSubtotal())}</span></button></div>`
    : '';
}

// Mudou só o carrinho: atualiza o botão de cada card e a barra do carrinho, sem redesenhar
// o cardápio (redesenhar recria todas as fotos e faz a tela piscar).
function refreshCartUi() {
  const body = document.getElementById('menu-body');
  const slot = document.getElementById('cart-slot');

  if (!body || !slot) return renderMenu();

  const scratch = document.createElement('div');

  for (const card of body.querySelectorAll('.product[data-pid]')) {
    const product = productById(card.dataset.pid);
    const old = card.querySelector('.bottom');

    if (!product || !old) continue;

    scratch.innerHTML = productHtml(product);
    const fresh = scratch.querySelector('.bottom');

    if (fresh && fresh.innerHTML !== old.innerHTML) old.innerHTML = fresh.innerHTML;
  }

  slot.innerHTML = cartBarHtml();
  prefetchCartSuggestions();
}

// Deixa as fotos do "Complete seu pedido" já baixadas antes de o carrinho abrir (senão elas
// aparecem uma a uma e piscam). São no máximo 6 fotos, as mesmas que o carrinho vai sortear.
const prefetchedPhotos = new Set();

function prefetchCartSuggestions() {
  if (!cartCount()) return;
  const { items = [], ice } = forgottenSuggestions();
  for (const p of [...items, ice].filter(Boolean)) {
    if (!p.image_url || prefetchedPhotos.has(p.image_url)) continue;
    prefetchedPhotos.add(p.image_url);
    const img = new Image();
    img.decoding = 'async';
    img.src = p.image_url;
  }
}

// O cabeçalho e a busca são montados uma vez só (para a busca não perder o foco
// enquanto o cliente digita); depois só a lista de produtos e o carrinho são redesenhados.
function renderMenu() {
  if (!document.getElementById('menu-body')) {
    app.innerHTML = `
      ${headerHtml()}
      ${welcomeHtml()}
      <div id="order-chip-slot">${orderChipHtml()}</div>
      ${storeNoticeHtml()}
      <div id="insights-slot">${insightsHtml()}</div>
      <div id="install-slot">${installBannerHtml()}</div>
      <div id="video-slot"></div>
      ${state.products.length ? `
        <div class="search-bar ${voiceOrderOn() ? 'has-mic' : ''}">
          <input id="search" type="search" placeholder="${storeCopy('🔎 Buscar lanche, combo ou bebida', '🔎 Buscar produto (ex.: heineken, carvão, gelo)')}" autocomplete="off" value="${escapeHtml(state.search)}" />
          <button id="clear-search" aria-label="Limpar busca" ${state.search ? '' : 'hidden'}>✕</button>
          ${voiceOrderOn() ? '<button id="voice-order" class="mic-btn" aria-label="Pedir falando">🎤</button>' : ''}
        </div>` : ''}
      <div id="menu-body"></div>
      ${siteFooterHtml()}
      <div id="cart-slot"></div>
    `;

    loadOrderChip();

    const input = document.getElementById('search');

    input?.addEventListener('input', () => {
      state.search = input.value;
      document.getElementById('clear-search').hidden = !input.value;
      renderMenu();
    });
  }

  // Antes de recriar o DOM do cardápio: mata os ScrollTriggers da vitrine (senão ficam
  // apontando pro nó antigo) e salva a posição de rolagem horizontal (celular) pra restaurar
  // depois — sem isso, todo +/- do carrinho ou poll de promoção "voltaria ao início".
  killShowcases();
  saveShowcaseScroll();

  // Vídeo fica num slot próprio, acima da busca (a busca continua fora do menu-body
  // para não perder o foco do input a cada tecla digitada).
  document.getElementById('video-slot').innerHTML = state.products.length ? pontoxScrollVideoHeroHtml() : '';
  armScrollVideo();
  document.getElementById('menu-body').innerHTML = menuBodyHtml();
  document.getElementById('cart-slot').innerHTML = cartBarHtml();
  prefetchCartSuggestions();
  armProductReveal();
  armProductShowcases();
}

app.addEventListener('click', event => {
  const target = event.target.closest('button, a');

  if (!target) {
    // Clique no card fora dos botões (foto, nome, descrição) abre o detalhe do produto —
    // exceto se esse clique veio logo depois de um arrasto na vitrine horizontal (celular),
    // onde um flick rápido no iOS pode gerar um "click" sintético mesmo tendo rolado.
    const card = event.target.closest('#menu-body .product[data-pid]');
    if (!card) return;
    const track = card.closest('.menu-section-scroll');
    if (track) {
      const dragStart = showcaseDragStart.get(track);
      if (dragStart !== undefined && Math.abs(track.scrollLeft - dragStart) > 6) return;
    }
    openProduct(card.dataset.pid);
    return;
  }

  if (target.dataset.inc && lancheWithAddons(productById(target.dataset.inc.split(':')[0])) && !state.cart[target.dataset.inc]) {
    openProduct(target.dataset.inc.split(':')[0]);
  } else if (target.dataset.inc) {
    const before = state.cart[target.dataset.inc] || 0;
    setQty(target.dataset.inc, before + 1);
    refreshCartUi();
    if (!before) addedFeedback(resolveCartKey(target.dataset.inc)?.name);
  } else if (target.dataset.rate) {
    state.reviewRating = Number(target.dataset.rate);
    document.querySelectorAll('[data-rate]').forEach(b => b.classList.toggle('on', Number(b.dataset.rate) <= state.reviewRating));
    const send = document.querySelector('[data-send-review]');
    if (send) send.disabled = false;
  } else if (target.dataset.sendReview) {
    sendReview(target.dataset.sendReview, target);
  } else if (target.dataset.similar) {
    openSimilar(target.dataset.similar);
  } else if (target.dataset.dec) {
    setQty(target.dataset.dec, (state.cart[target.dataset.dec] || 0) - 1);
    refreshCartUi();
  } else if (target.dataset.choose) {
    openProduct(target.dataset.choose);
  } else if (target.dataset.cat) {
    document.getElementById(`cat-${encodeURIComponent(target.dataset.cat)}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (target.dataset.skipHero !== undefined) {
    // Não pode mirar em #menu-body: o vídeo está no topo dele, então "rolar até lá" seria
    // rolar até onde já se está. Mira na primeira seção de produtos de verdade.
    document.querySelector('#menu-body section[id^="cat-"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (target.dataset.reorder) {
    reorder(target.dataset.reorder, target);
  } else if (target.dataset.bulk) {
    setQty(target.dataset.bulk, (state.cart[target.dataset.bulk] || 0) + Number(target.dataset.bulkQty));
    refreshCartUi();
    addedFeedback(`${target.dataset.bulkQty} un.`);
  } else if (target.dataset.repeat) {
    const [productId, variantId] = target.dataset.repeat.split(':');
    const key = cartKey(productId, variantId || null);
    setQty(key, (state.cart[key] || 0) + 1);
    renderMenu();
    addedFeedback(target.dataset.name);
  } else if (target.id === 'install-app') {
    installApp();
  } else if (target.id === 'install-dismiss') {
    try { localStorage.setItem(INSTALL_DISMISSED_KEY, '1'); } catch {}
    refreshInstallBanner();
  } else if (target.id === 'open-account') {
    openAccount();
  } else if (target.id === 'clear-search') {
    state.search = '';
    const input = document.getElementById('search');
    input.value = '';
    target.hidden = true;
    renderMenu();
    input.focus();
  } else if (target.id === 'open-cart') {
    openCart();
  } else if (target.id === 'voice-order') {
    startVoiceOrder(target);
  } else if (target.dataset.heroDot !== undefined) {
    const track = document.querySelector('.pontox-hero-track');
    const index = Number(target.dataset.heroDot);
    if (track) track.scrollTo({ left: index * track.clientWidth, behavior: 'smooth' });
    document.querySelectorAll('.pontox-hero-dot').forEach((dot, i) => dot.classList.toggle('on', i === index));
  }
});

/* ---------------- Carrinho e checkout ---------------- */

function openSheet(html) {
  // Ao redesenhar a mesma janela, reaproveita as fotos já carregadas (senão elas piscam).
  const oldImages = new Map([...document.querySelectorAll('#sheet img[src]')].map(img => [img.getAttribute('src'), img]));

  closeSheet();

  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.id = 'sheet';
  backdrop.innerHTML = `<div class="sheet">${html}</div>`;

  for (const img of backdrop.querySelectorAll('img[src]')) {
    const old = oldImages.get(img.getAttribute('src'));
    if (old && old.className === img.className) {
      img.replaceWith(old);
      oldImages.delete(img.getAttribute('src'));
    }
  }
  backdrop.addEventListener('click', event => {
    if (event.target === backdrop || event.target.closest('[data-close]')) closeSheet();
  });

  document.body.appendChild(backdrop);
  return backdrop;
}

// Redesenha a janela aberta sem pular para o topo (ex.: tocar em "Adicionar" num adicional lá embaixo).
function keepSheetScroll(render) {
  const top = document.querySelector('#sheet .sheet')?.scrollTop || 0;
  const strips = [...document.querySelectorAll('#sheet .leve-strip')].map(el => el.scrollLeft);
  render();
  const sheet = document.querySelector('#sheet .sheet');
  if (sheet) sheet.scrollTop = top;
  document.querySelectorAll('#sheet .leve-strip').forEach((el, i) => { el.scrollLeft = strips[i] || 0; });
}

function closeSheet() {
  document.getElementById('sheet')?.remove();
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

// Com bairros cadastrados, a taxa depende do bairro escolhido; sem bairro escolhido ainda, fica "escolha o bairro".
function deliveryFeeFor(zoneId) {
  const zones = state.store.delivery_zones || [];

  if (!zones.length) return state.vip ? 0 : state.store.delivery_fee_cents;

  const zone = zones.find(z => z.id === zoneId);

  if (!zone) return null;

  // Cliente VIP não paga entrega (o servidor confere de novo ao fechar o pedido).
  return state.vip ? 0 : zone.fee_cents;
}

/* ---------------- Topo: pedido em andamento, avisos da loja, ajuda ---------------- */

const CHIP_STATUS = {
  received: ['📥', 'Recebido'],
  accepted: ['✅', 'Aceito'],
  preparing: [storeCopy('🍔', '🧊'), 'Em preparação'],
  out_for_delivery: ['🛵', 'Saiu para entrega'],
};

// "🛵 Pedido #86420 • Em preparação — Acompanhar" (só enquanto o pedido está em andamento).
function orderChipHtml() {
  const o = state.activeOrder;

  if (!o) return '';

  const [icon, label] = o.status === 'out_for_delivery' && o.delivery_type === 'pickup' ? ['🏪', 'Pronto para retirada'] : CHIP_STATUS[o.status] || ['📦', ''];

  return `<a class="order-chip" href="?pedido=${escapeHtml(o.id)}">${icon} Pedido #${escapeHtml(o.public_code)} • <strong>${label}</strong><span>Acompanhar →</span></a>`;
}

async function loadOrderChip() {
  const last = loadJson(LAST_ORDER_KEY, null);

  if (!last?.id) return;

  try {
    const { order } = await api(`/api/orders/${encodeURIComponent(last.id)}`);
    state.activeOrder = ['delivered', 'cancelled'].includes(order.status) ? null : order;
  } catch {
    state.activeOrder = null;
  }

  const slot = document.getElementById('order-chip-slot');
  if (slot) slot.innerHTML = orderChipHtml();
}

// Minutos até fechar (horário de São Paulo; aceita fechar depois da meia-noite).
function minutesToClose() {
  const closes = state.store?.closes_at;

  if (!state.store?.is_open || !/^\d{2}:\d{2}$/.test(closes || '')) return null;

  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(new Date(nowMs())).split(':').map(Number);
  const [ch, cm] = closes.split(':').map(Number);

  return (((ch * 60 + cm) - ((h % 24) * 60 + m)) + 24 * 60) % (24 * 60);
}

// Loja fechada (o carrinho continua liberado) ou perto de fechar ("últimos pedidos de hoje").
function storeNoticeHtml() {
  const store = state.store;

  if (!store.is_open) {
    return `<div class="notice closed">🌙 <strong>${storeCopy('Hamburgueria fechada', 'Loja fechada')}</strong>${store.opens_text ? ` — abrimos ${escapeHtml(store.opens_text)}` : ''}. ${store.accept_scheduled
      ? 'Você já pode montar o carrinho e <strong>agendar o pedido para quando abrirmos</strong>.'
      : storeCopy('Escolha seu lanche e finalize o pedido quando abrirmos.', 'Você já pode montar o carrinho e finalizar quando abrirmos.')}</div>`;
  }

  const left = minutesToClose();

  if (left !== null && left <= 60) {
    return `<div class="notice last-call">⏰ <strong>Últimos pedidos de hoje</strong> — fechamos às ${escapeHtml(store.closes_at)}.</div>`;
  }

  return '';
}

// Botão discreto de ajuda pelo WhatsApp (fora do fluxo de compra).
/* ---------------- Rodapé ---------------- */

// Dados do rodapé vêm do cadastro da loja (store.profile, editável no painel > Loja > Geral).
// Estes valores só valem se o servidor ainda não mandar o profile (versão antiga do worker).
const FALLBACK_PROFILE = {
  instagram: '',
  tagline: '',
  address_line1: '',
  address_line2: '',
  maps_query: '',
  alcohol_notice: true,
};
const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// "8h", "22h", "8h30".
function hourText(hhmm) {
  const [h, m] = String(hhmm || '').split(':');
  return `${Number(h)}h${m && m !== '00' ? m : ''}`;
}

// Junta os dias com o mesmo horário: "Todos os dias, das 8h às 22h" ou "Segunda a Sexta: 8h às 22h".
function hoursSummary(hours) {
  if (!Array.isArray(hours) || !hours.length) return [];
  const byDay = [1, 2, 3, 4, 5, 6, 0].map(d => hours.find(h => h.day === d) || { day: d, enabled: false });
  const key = h => (h.enabled ? `${h.open}-${h.close}` : 'fechado');

  if (byDay.every(h => key(h) === key(byDay[0])) && byDay[0].enabled) {
    return [`Todos os dias, das ${hourText(byDay[0].open)} às ${hourText(byDay[0].close)}`];
  }

  const groups = [];
  for (const h of byDay) {
    const last = groups[groups.length - 1];
    if (last && last.key === key(h)) last.days.push(h.day);
    else groups.push({ key: key(h), days: [h.day], h });
  }

  return groups.map(g => {
    const days = g.days.length > 1 ? `${WEEKDAYS[g.days[0]]} a ${WEEKDAYS[g.days[g.days.length - 1]]}` : WEEKDAYS[g.days[0]];
    return g.h.enabled ? `${days}: ${hourText(g.h.open)} às ${hourText(g.h.close)}` : `${days}: fechado`;
  });
}

function siteFooterHtml() {
  const store = state.store || {};
  const phone = String(store.whatsapp || '').replace(/\D/g, '');
  const phoneText = phone.length === 11 ? `(${phone.slice(0, 2)}) ${phone.slice(2, 7)}-${phone.slice(7)}` : phone;
  const hours = hoursSummary(store.hours);
  const zones = (store.delivery_zones || []).slice().sort((a, b) => a.fee_cents - b.fee_cents || a.name.localeCompare(b.name, 'pt-BR'));
  const year = new Date().getFullYear();
  const profile = store.profile || FALLBACK_PROFILE;
  const tagline = profile.tagline || storeCopy('Hambúrgueres · Combos · Bebidas', '');
  const instagram = String(profile.instagram || '').replace(/[^A-Za-z0-9._]/g, '');
  const mapsQuery = profile.maps_query || [store.name, profile.address_line1, profile.address_line2].filter(Boolean).join(', ');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`;

  return `
    <footer class="site-footer">
      <div class="footer-brand">
        <img src="${escapeHtml(document.querySelector('meta[name="store-logo"]')?.content || 'assets/icon-192.png')}" alt="" width="44" height="44" loading="lazy" />
        <div><strong>${escapeHtml(store.name || '')}</strong>${tagline ? `<span>${escapeHtml(tagline)}</span>` : ''}</div>
      </div>

      <div class="footer-links">
        ${instagram ? `
          <a class="footer-link insta" href="https://instagram.com/${instagram}" target="_blank" rel="noopener">
            <span class="ico">📸</span><span><small>Siga no Instagram</small>@${instagram}</span>
          </a>` : ''}
        ${phone.length >= 10 ? `
          <a class="footer-link" href="https://wa.me/55${escapeHtml(phone)}?text=${encodeURIComponent('Olá! Preciso de ajuda com uma dúvida / um pedido no delivery.')}" target="_blank" rel="noopener">
            <span class="ico">💬</span><span><small>Ajuda pelo WhatsApp</small>${escapeHtml(phoneText)}</span>
          </a>` : ''}
      </div>

      ${profile.address_line1 ? `
        <div class="footer-block">
          <h3>📍 Endereço</h3>
          <p>${escapeHtml(profile.address_line1)}${profile.address_line2 ? `<br><span class="muted">${escapeHtml(profile.address_line2)}</span>` : ''}</p>
          <a class="btn small footer-map" href="${mapsUrl}" target="_blank" rel="noopener">🗺️ Como chegar</a>
        </div>` : ''}

      ${hours.length ? `
        <div class="footer-block">
          <h3>🕒 Horário</h3>
          ${hours.map(h => `<p>${escapeHtml(h)}</p>`).join('')}
        </div>` : ''}

      ${zones.length ? `
        <div class="footer-block">
          <h3>🛵 Onde entregamos</h3>
          <p>${zones.map(z => `${escapeHtml(z.name)} <span class="muted">(${z.fee_cents ? money(z.fee_cents) : 'grátis'})</span>`).join(' · ')}</p>
          ${store.delivery_minutes ? `<p class="muted">Entrega em até ~${store.delivery_minutes} min · retirada na loja em ~${store.pickup_minutes || 10} min</p>` : ''}
        </div>` : ''}

      <div class="footer-block">
        <h3>💳 Pagamento</h3>
        <p>Pix, dinheiro, débito ou crédito, na entrega ou na retirada.</p>
      </div>

      ${profile.alcohol_notice !== false ? '<p class="footer-legal">🔞 Venda de bebidas alcoólicas proibida para menores de 18 anos. Se beber, não dirija.</p>' : ''}
      <p class="footer-legal">© ${year} ${escapeHtml(store.name || '')}</p>
      <p class="footer-legal footer-dev">Desenvolvido por <a href="https://sistemaultrion.com.br" target="_blank" rel="noopener noreferrer"><strong>Ultrion</strong></a></p>
    </footer>`;
}

function supportButtonHtml() {
  const phone = String(state.store?.whatsapp || '').replace(/\D/g, '');

  if (phone.length < 10) return '';

  const text = 'Olá! Preciso de ajuda com uma dúvida / um pedido no delivery.';

  return `<a class="support-fab" href="https://wa.me/55${escapeHtml(phone)}?text=${encodeURIComponent(text)}" target="_blank" rel="noopener" aria-label="Ajuda pelo WhatsApp">💬 Ajuda</a>`;
}

// Confirmação visual ao adicionar: aviso + o carrinho dá um "pulinho".
function addedFeedback(name) {
  toast(`Adicionado ao carrinho ✓${name ? ` — ${name}` : ''}`);

  const bar = document.querySelector('.cart-bar .btn');

  if (bar) {
    bar.classList.remove('bump');
    void bar.offsetWidth;
    bar.classList.add('bump');
  }
}

// Esgotado: sugere parecidos disponíveis (mesma categoria, nomes parecidos primeiro).
function openSimilar(productId) {
  const product = productById(productId);

  if (!product) return;

  const words = new Set(normalizeText(product.name).split(/[^a-z0-9]+/).filter(w => w.length > 2));
  const candidates = state.products
    .filter(p => p.id !== product.id && p.available !== false)
    .map(p => {
      const shared = normalizeText(p.name).split(/[^a-z0-9]+/).filter(w => words.has(w)).length;
      return { p, score: shared * 2 + (p.category === product.category ? 1 : 0) };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(x => x.p);

  const sheet = openSheet(`
    <div class="sheet-head"><h2>😕 ${escapeHtml(product.name)} esgotou</h2><button data-close aria-label="Fechar">✕</button></div>
    ${candidates.length ? `<p class="muted" style="margin-top:0">Que tal um destes?</p>
      ${candidates.map(p => `
        <div class="cart-line">
          <span class="name">${escapeHtml(p.name)}<br><span class="price">${productPriceHtml(p)}</span></span>
          ${p.variants.length
            ? `<button class="btn small primary" data-sim-choose="${p.id}">Escolher</button>`
            : `<button class="btn small primary" data-sim-add="${cartKey(p.id)}">Adicionar</button>`}
        </div>`).join('')}` : '<p class="muted">Não achamos um parecido agora. Dá uma olhada na busca! 🔎</p>'}
    <button class="btn block" data-close style="margin-top:12px">Fechar</button>`);

  sheet.addEventListener('click', event => {
    const btn = event.target.closest('button');

    if (btn?.dataset.simAdd) {
      setQty(btn.dataset.simAdd, (state.cart[btn.dataset.simAdd] || 0) + 1);
      closeSheet();
      refreshCartUi();
      addedFeedback(resolveCartKey(btn.dataset.simAdd)?.name);
    } else if (btn?.dataset.simChoose) {
      openVariants(btn.dataset.simChoose);
    }
  });
}

// Topo do cardápio para o cliente deste aparelho: VIP, aniversário e "hora de repor".
function insightsHtml() {
  const i = state.insights;

  if (!i) return '';

  const repeat = (i.repeat || []).filter(r => {
    const p = productById(r.product_id);
    if (!p || !p.available) return false;
    return r.variant_id ? p.variants.some(v => v.id === r.variant_id && v.available) : !p.variants.length;
  });

  return `
    ${i.coupon_cents ? `<div class="card" style="margin-top:8px">🎁 <strong>Você tem ${money(i.coupon_cents)} de desconto</strong> no próximo pedido — já sai automático no total.</div>` : ''}
    ${i.birthday_offer ? `<div class="card" style="margin-top:8px">🎂 <strong>Feliz aniversário!</strong> Seu pedido desta semana tem <strong>${escapeHtml(i.birthday_offer)}</strong> — já sai automático no total.</div>` : ''}
    ${repeat.length ? `
      <div style="margin-top:10px">
        <strong>${storeCopy('🍔 Que tal repetir seu favorito?', '🔁 Hora de repor?')}</strong>
        <div class="repeat-strip" style="margin-top:6px">
          ${repeat.map(r => `
            <div class="card">
              <span>${escapeHtml(r.name)}</span><br>
              <span class="muted" style="font-size:12px">você costuma pedir a cada ~${r.every_days} dias</span><br>
              <button class="btn small primary" style="margin-top:6px" data-repeat="${escapeHtml(r.product_id)}:${escapeHtml(r.variant_id || '')}" data-name="${escapeHtml(r.name)}">+ Adicionar</button>
            </div>`).join('')}
        </div>
      </div>` : ''}`;
}

// Pergunta ao servidor pelos pedidos que este aparelho guardou (prova de que é o próprio cliente).
async function loadInsights() {
  const ids = loadJson(ORDERS_KEY, []).map(o => o.id).filter(Boolean);

  if (!ids.length) return;

  try {
    const data = await api('/api/customer-insights', { method: 'POST', body: JSON.stringify({ order_ids: ids }) });

    if (!data.found) return;

    state.insights = data;
    if (!document.getElementById('checkout-form')) state.vip = Boolean(data.vip);

    const slot = document.getElementById('insights-slot');
    if (slot) slot.innerHTML = insightsHtml();

    const welcome = document.getElementById('welcome');
    if (welcome && (data.highlight || data.vip)) welcome.outerHTML = welcomeHtml();
  } catch {}
}

// "20,50" → 2050 (centavos); vazio ou inválido → null.
function reaisToCents(value) {
  const raw = String(value || '').trim().replace(/\s/g, '');
  if (!raw) return null;
  const normalized = raw.includes(',')
    ? raw.replace(/\./g, '').replace(',', '.')
    : raw;
  const n = Number(normalized);

  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function paymentText(order) {
  if (Array.isArray(order.payment_split)) {
    return order.payment_split.map(p => `${PAYMENT_LABELS[p.method] || p.method} ${money(p.cents)}`).join(' + ');
  }

  return PAYMENT_LABELS[order.payment_method] || '';
}

function totalsHtml(deliveryType, zoneId) {
  const subtotal = cartSubtotal();
  const fee = deliveryType === 'delivery' ? deliveryFeeFor(zoneId) : 0;

  return `
    <div class="totals">
      <div><span>Subtotal</span><span>${money(subtotal)}</span></div>
      ${deliveryType === 'delivery' ? `<div><span>Taxa de entrega</span><span>${fee === null ? 'escolha o bairro' : fee ? money(fee) : state.vip ? 'Grátis ⭐ VIP' : 'Grátis'}</span></div>` : ''}
      <div class="grand"><span>Total</span><span>${money(subtotal + (fee || 0))}</span></div>
    </div>`;
}

function openCart() {
  const entries = cartEntries();

  if (!entries.length) {
    closeSheet();
    refreshCartUi();
    return;
  }

  const sheet = openSheet(`
    <div class="sheet-head"><h2>Seu carrinho</h2><button type="button" class="clear-cart" id="clear-cart">Limpar carrinho</button><button data-close aria-label="Fechar">✕</button></div>
    ${entries.map(({ key, name, price, qty, line, bulk, chill, noCheddar, total, product, variant, addons }) => `
      <div class="cart-line">
        ${lancheWithAddons(product)
          ? `<span class="cart-thumb-wrap">${cartPhotoHtml(product, variant)}<button type="button" class="cart-edit" data-edit-line="${key}" aria-label="Editar adicionais">✏️</button></span>`
          : cartPhotoHtml(product, variant)}
        <span class="name">${escapeHtml(name)}${addons?.length ? `<span class="cart-addons"><span class="cart-addons-title">Turbinado:</span>${addons.map(a => `<span>(${a.qty}) ${escapeHtml(a.product.name)} <b>(+${money(a.product.price_cents * a.qty)})</b></span>`).join('')}</span>` : '<br>'}<span class="muted">${money(price)}${qty > 1 || chill?.on ? ` · ${money(total)}` : ''}${storeFeatures().weight !== false && product?.sold_by_weight ? ' · ⚖️ estimado' : ''}</span>
          ${line.packs ? `<br><span class="bulk-hint">🍻 ${line.packs} engradado${line.packs > 1 ? 's' : ''} · economia de ${money(line.saved)}</span>` : bulk ? `<br><span class="bulk-hint">faltam ${bulk.qty - (qty % bulk.qty)} pro preço de engradado</span>` : ''}
          ${noCheddar !== null ? `<br>${noCheddarToggleHtml(key, noCheddar)}` : ''}
          ${chill ? `<br><button type="button" class="chill-toggle ${chill.on ? 'on' : ''}" data-chill="${key}">${chill.on ? '✅' : '⬜'} 🧊 Engradado gelado (+ ${money(chill.fee)}${chill.packs > 1 ? ` cada · ${chill.packs} engradados` : ''})</button>` : ''}</span>
        <span class="qty">
          <button data-cdec="${key}">−</button><span>${qty}</span><button data-cinc="${key}">+</button>
        </span>
      </div>`).join('')}
    ${categoryMinProblem() ? `<p class="min-rule">🚬 Entrega com ${escapeHtml(categoryMinProblem().label)}: pedido mínimo de ${money(categoryMinProblem().min_cents)} (faltam ${money(categoryMinProblem().min_cents - cartSubtotal())}). Na retirada na loja não tem mínimo.</p>` : ''}
    ${leveJuntoHtml()}
    ${cartHasWeight() ? '<p class="weight-notice">⚖️ Tem produto vendido por kg no carrinho: o total é estimado e pode mudar um pouquinho depois de pesar na loja.</p>' : ''}
    ${totalsHtml('pickup')}
    ${state.store.min_order_cents && cartSubtotal() < state.store.min_order_cents
      ? `<p class="muted">Pedido mínimo: ${money(state.store.min_order_cents)}</p>`
      : ''}
    ${!state.store.is_open && !state.store.accept_scheduled
      ? `<p class="min-rule">🌙 A loja está fechada${state.store.opens_text ? ` — abrimos ${escapeHtml(state.store.opens_text)}` : ''}. Seu carrinho fica salvo: finalize quando abrirmos.</p>`
      : ''}
    ${state.activeOrder && ['received', 'accepted', 'preparing'].includes(state.activeOrder.status) ? `
      <button class="btn block add-to-order" id="add-to-order">➕ Adicionar ao pedido #${escapeHtml(state.activeOrder.public_code)} <span class="muted">(ainda não saiu)</span></button>` : ''}
    <button class="btn primary block" id="go-checkout" ${(state.store.min_order_cents && cartSubtotal() < state.store.min_order_cents) || (!state.store.is_open && !state.store.accept_scheduled) ? 'disabled' : ''}>Continuar</button>
  `);

  sheet.addEventListener('click', event => {
    const btn = event.target.closest('button');

    if (!btn) return;

    if (btn.id === 'clear-cart') {
      if (!confirm('Tirar todos os produtos do carrinho?')) return;
      state.cart = {};
      saveJson(CART_KEY, state.cart);
      state.chill = {};
      saveJson(CHILL_KEY, state.chill);
      state.noCheddar = {};
      saveJson(NO_CHEDDAR_KEY, state.noCheddar);
      closeSheet();
      refreshCartUi();
      toast('Carrinho limpo.');
    } else if (btn.dataset.editLine) {
      editLanche(btn.dataset.editLine);
    } else if (btn.dataset.nocheddar) {
      toggleNoCheddar(btn.dataset.nocheddar);
      keepSheetScroll(openCart);
    } else if (btn.dataset.chill) {
      if (state.chill[btn.dataset.chill]) delete state.chill[btn.dataset.chill];
      else state.chill[btn.dataset.chill] = true;
      saveJson(CHILL_KEY, state.chill);
      openCart();
      refreshCartUi();
    } else if (btn.dataset.cinc) {
      setQty(btn.dataset.cinc, (state.cart[btn.dataset.cinc] || 0) + 1);
      keepSheetScroll(openCart);
      refreshCartUi();
    } else if (btn.dataset.cdec) {
      setQty(btn.dataset.cdec, (state.cart[btn.dataset.cdec] || 0) - 1);
      keepSheetScroll(openCart);
      refreshCartUi();
    } else if (btn.dataset.suggest) {
      const product = productById(btn.dataset.suggest);

      if (!product) return;

      if (product.variants.length) {
        openVariants(product.id);
      } else {
        setQty(cartKey(product.id), (state.cart[cartKey(product.id)] || 0) + 1);
        keepSheetScroll(openCart);
        refreshCartUi();
        addedFeedback(product.name);
      }
    } else if ('iceNo' in btn.dataset) {
      // "Não precisa de gelo": não pergunta de novo nesta visita.
      state.iceDismissed = true;
      openCart();
    } else if (btn.id === 'add-to-order') {
      addToActiveOrder(btn);
    } else if (btn.id === 'go-checkout') {
      openCheckout();
    }
  });
}

/* ---------------- Sugestões inteligentes ("Você esqueceu?") ---------------- */

// O que costuma acompanhar cada tipo de produto. As palavras vêm em ordem de prioridade
// (as primeiras aparecem mais); todos os produtos do cardápio com essa palavra entram no sorteio.
const COMPLEMENT_RULES = [
  { when: /cerveja|latao|long neck|chopp|litrao/, add: ['carvao', 'amendoim', 'salgadinho', 'petisco', 'batata', 'torresmo', 'pao de alho', 'linguica', 'acendedor', 'copo'] },
  { when: /carvao|churrasco/, add: ['acendedor', 'alcool', 'sal grosso', 'espeto', 'pao de alho', 'linguica', 'farofa', 'queijo coalho', 'carne', 'papel aluminio', 'guardanapo', 'prato', 'copo', 'latao'] },
  { when: /vodka|gin|whisky|cachaca|licor|rum|destilado|tequila|conhaque/, add: ['energetico', 'tonica', 'gelo de coco', 'gelo de sabor', 'limao', 'suco', 'agua de coco', 'refrigerante', 'copo', 'acucar'] },
  { when: /energetico|red bull|monster|baly/, add: ['vodka', 'whisky', 'gin', 'gelo de coco', 'gelo de sabor', 'copo'] },
  { when: /refrigerante|coca|guarana|pepsi|fanta|sprite|soda/, add: ['salgadinho', 'biscoito', 'chocolate', 'sorvete', 'copo', 'batata', 'torresmo'] },
  { when: /agua 20|galao/, add: ['casco', 'vasilhame', 'galao vazio', 'bomba'] },
  { when: /salgadinho|amendoim|batata|petisco|doritos|ruffles|cheetos/, add: ['latao', 'cerveja', 'refrigerante', 'long neck', 'guarana', 'coca'] },
  { when: /vinho|espumante/, add: ['queijo', 'chocolate', 'saca rolha', 'taca', 'copo', 'amendoim'] },
  { when: /sorvete|picole|acai/, add: ['cobertura', 'casquinha', 'chocolate', 'biscoito', 'refrigerante'] },
  { when: /cigarro|tabacaria|seda|fumo/, add: ['isqueiro', 'seda', 'piteira', 'bala', 'chiclete', 'halls', 'energetico', 'refrigerante'] },
  { when: /chocolate|doce|bala|bombom/, add: ['refrigerante', 'sorvete', 'biscoito', 'leite'] },
  { when: /biscoito|bolacha|bolinho/, add: ['leite', 'achocolatado', 'refrigerante', 'suco', 'cafe'] },
  { when: /pao|cafe|leite|manteiga|margarina/, add: ['manteiga', 'queijo', 'presunto', 'leite', 'cafe', 'acucar', 'achocolatado', 'requeijao'] },
  { when: /queijo|presunto|frios|mortadela|salame/, add: ['pao', 'manteiga', 'refrigerante', 'vinho', 'biscoito'] },
  { when: /congelado|hamburguer|nuggets|pizza|lasanha/, add: ['batata', 'refrigerante', 'ketchup', 'maionese', 'queijo'] },
  { when: /detergente|sabao|limpeza|desinfetante|agua sanitaria|esponja/, add: ['esponja', 'detergente', 'agua sanitaria', 'desinfetante', 'saco de lixo', 'pano', 'sabao'] },
  { when: /papel higienico|sabonete|creme dental|shampoo|higiene|desodorante/, add: ['papel higienico', 'sabonete', 'creme dental', 'escova', 'shampoo', 'desodorante'] },
  { when: /racao|pet$/, add: ['racao', 'areia'] },
  { when: /copo|prato|guardanapo|descartave/, add: ['guardanapo', 'prato', 'copo', 'talher', 'refrigerante', 'latao'] },
  { when: /suco|cha|isotonico|agua de coco/, add: ['biscoito', 'salgadinho', 'bolinho', 'chocolate'] },
];

// Palavra da regra que NÃO serve para certos produtos ("leite" não é leite condensado nem de coco).
const SUGGEST_EXCEPT = {
  leite: /condensado|de coco|em po|licor|doce de leite|creme de leite/,
  alcool: /vinagre/,
  pao: /de alho|de queijo|de mel/,
  cafe: /cafeteira/,
};

// Bebida que pede gelo.
const DRINK_RE = /cerveja|latao|long neck|chopp|energetico|red bull|refrigerante|refri|coca|guarana|vodka|gin|whisky|cachaca|licor|rum|drink|ice|tonica|beats/;
const isIce = p => /^gelo\b/.test(normalizeText(p.name)) && !/coco|sabor/.test(normalizeText(p.name));

function productText(p) {
  return normalizeText(`${p.name} ${p.category}`);
}

// Ocasião pelo carrinho: carvão (ou carne/linguiça com bebida) = churrasco; muita bebida = festa.
function detectOccasion(entries) {
  if (isBurgerStore()) return null;
  const texts = entries.map(e => productText(e.product));
  const has = re => texts.some(t => re.test(t));

  if (has(/carvao|linguica|picanha|carne|sal grosso/)) return 'churrasco';
  if (entries.filter(e => DRINK_RE.test(productText(e.product))).reduce((s, e) => s + e.qty, 0) >= 12 || has(/copo|guardanapo/)) return 'festa';

  return null;
}

const OCCASION_TITLES = { churrasco: '🔥 Pro seu churrasco', festa: '🎉 Pra sua festa' };

// Primeiro produto disponível (fora do carrinho) cujo nome começa com a palavra-chave.
function findByKeyword(word, exclude) {
  const re = new RegExp(`\\b${word}`);
  return state.products.find(p => p.available !== false && !exclude.has(p.id) && re.test(productText(p))) || null;
}

// Sorteio que muda de carrinho para carrinho (e de visita para visita), mas não fica
// trocando enquanto o cliente só mexe nas quantidades.
const SUGGEST_SEED = Math.floor(Math.random() * 1e9);

function seededRandom(text) {
  let h = SUGGEST_SEED ^ 2166136261;

  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);

  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

// "Você esqueceu?": gelo em destaque (se tem bebida e não tem gelo) e até 6 produtos que combinam
// com o carrinho, sorteados com peso: comprados juntos de verdade > regras por tipo > ocasião >
// mais vendidos. Um produto de cada tipo (não mostra 3 carvões) e nada do que já está no carrinho.
function forgottenSuggestions() {
  if (storeFeatures().smart_suggestions === false) return { items: [], title: '', ice: null };
  const entries = cartEntries();

  if (!entries.length) return { items: [], title: '', ice: null };

  const inCart = new Set(entries.map(e => e.product.id));
  const kindOf = p => normalizeText(p.name).split(/[^a-z0-9]+/)[0];
  const kindsInCart = new Set(entries.map(e => kindOf(e.product)));
  const pool = state.products.filter(p => p.available !== false && !inCart.has(p.id) && !kindsInCart.has(kindOf(p)));
  const scores = new Map(); // id → { p, score, source }
  const give = (p, score, source) => {
    const cur = scores.get(p.id);
    if (!cur) scores.set(p.id, { p, score, source });
    else {
      cur.score += score * 0.5; // combina por mais de um motivo: sobe um pouco
      if (score > cur.best) cur.source = source;
    }
    const entry = scores.get(p.id);
    entry.best = Math.max(entry.best || 0, score);
  };

  // 🧊 Gelo inteligente (some se já tem gelo ou se o cliente disse que não precisa).
  let ice = null;
  const hasDrink = entries.some(e => DRINK_RE.test(productText(e.product)));
  const hasIce = entries.some(e => isIce(e.product));

  if (!isBurgerStore() && hasDrink && !hasIce && !state.iceDismissed) {
    ice = state.products.find(p => p.available !== false && isIce(p) && p.featured) || state.products.find(p => p.available !== false && isIce(p)) || null;
  }

  // O que os clientes realmente compram junto (aprendido dos pedidos).
  for (const e of entries) {
    (state.recs?.pairs?.[e.product.id] || []).forEach((id, i) => {
      const p = pool.find(x => x.id === id);
      if (p) give(p, 3 - i * 0.3, `par:${id}`);
    });
  }

  // Quanto o produto "é" a palavra: nome começando com ela (Acendedor…) vale mais que ela no meio
  // do nome (Vinagre de Álcool) ou só na categoria. Combos, gás e o galão de 20 L só se já tem no carrinho.
  const cartText = entries.map(e => productText(e.product)).join(' ');
  const allowed = p => {
    const name = normalizeText(p.name);
    return (/combo/.test(cartText) || !/combo/.test(productText(p)))
      && (/agua 20|galao/.test(cartText) || !/agua 20/.test(name))
      && (/\bgas p/.test(cartText) || !/^gas p/.test(name));
  };
  const matchWeight = (word, p) => {
    const name = normalizeText(p.name);
    if (SUGGEST_EXCEPT[word]?.test(name)) return 0;
    if (new RegExp(`^${word}`).test(name)) return 1;
    if (new RegExp(`\\b${word}`).test(name)) return 0.5;
    if (new RegExp(`\\b${word}`).test(normalizeText(p.category))) return 0.6;
    return 0;
  };
  const byWord = (word, weight) => pool.forEach(p => {
    const m = allowed(p) ? matchWeight(word, p) : 0;
    if (m) give(p, weight * m, word);
  });

  // Regras por tipo: todos os produtos com a palavra entram no sorteio.
  for (const e of entries) {
    const text = productText(e.product);

    const rules = isBurgerStore() ? [
      { when: /hamburguer|burger|x[- ]|lanche|combo/, add: ['batata', 'frita', 'refrigerante', 'coca', 'guarana', 'guaravita', 'suco'] },
      { when: /batata|frita|porcao/, add: ['hamburguer', 'x-', 'combo', 'refrigerante', 'suco'] },
      { when: /refrigerante|coca|guarana|guaravita|suco/, add: ['hamburguer', 'x-', 'combo', 'batata'] },
    ] : COMPLEMENT_RULES;
    for (const rule of rules) {
      // Palavra inteira: "petiscos" não é "pet".
      if (!new RegExp(`\\b(?:${rule.when.source})`).test(text)) continue;

      rule.add.forEach((word, i) => {
        if (word !== 'gelo') byWord(word, Math.max(2.2 - i * 0.12, 0.8));
      });
    }
  }

  // Ocasião (churrasco, festa): itens da lista daquela ocasião.
  const occasion = detectOccasion(entries);

  if (occasion) {
    SEARCH_IDEAS[occasion].forEach((word, i) => {
      if (word !== 'gelo') byWord(word, Math.max(1.4 - i * 0.05, 0.6));
    });
  }

  // Nada combinou (ex.: produto de limpeza sem regra): os mais vendidos, variando.
  if (!scores.size) pool.filter(p => p.featured).forEach(p => give(p, 1, 'destaque'));

  // Sorteio com peso: cada produto ganha um "ruído" proporcional; o mais pedido leva um empurrãozinho.
  const random = seededRandom([...inCart].sort().join(','));
  const ranked = [...scores.values()]
    .filter(s => !(ice && s.p.id === ice.id))
    .map(s => ({ ...s, rank: s.score * (0.4 + random() * 1.2) + (s.p.featured ? 0.3 : 0) }))
    .sort((a, b) => b.rank - a.rank);

  // Variedade: um por tipo de produto e um por motivo (não mostra 3 carvões nem 3 salgadinhos).
  const picked = [];
  const kinds = new Set();
  const sources = new Set();

  for (const s of ranked) {
    if (picked.length >= 6) break;
    if (kinds.has(kindOf(s.p)) || sources.has(s.source)) continue;
    picked.push(s.p);
    kinds.add(kindOf(s.p));
    sources.add(s.source);
  }

  return { items: picked, title: storeCopy('🍟 Complete seu pedido', OCCASION_TITLES[occasion] || '🤔 Você esqueceu?'), ice };
}

// Pares "comprados juntos" e o que sai em manhã de domingo/feriado (aprendidos dos pedidos reais).
async function loadRecommendations() {
  try {
    state.recs = await api('/api/recommendations');
    prefetchCartSuggestions();

    // A vitrine do modo ressaca depende disso: redesenha se estiver no cardápio.
    if (isRestMorning() && document.getElementById('menu-body') && !state.search.trim()) {
      document.getElementById('menu-body').innerHTML = menuBodyHtml();
    }
  } catch {}
}

function suggestionButtonHtml(p) {
  return `
    <button type="button" class="leve-item" data-suggest="${p.id}">
      ${p.image_url ? `<img src="${escapeHtml(p.image_url)}" alt="" decoding="async" />` : '<span class="no-photo">🛒</span>'}
      <span class="leve-name">${escapeHtml(p.name)}</span>
      <span class="leve-price">${p.variants.length ? 'a partir de ' : ''}${money(p.variants.length ? Math.min(...p.variants.map(v => v.price_cents)) : (promoNow(p)?.price_cents ?? p.price_cents))}</span>
      <span class="leve-add">+ Adicionar</span>
    </button>`;
}

// Enquanto o carrinho continua aberto, as sugestões não são sorteadas de novo a cada toque
// (senão a lista inteira troca e as fotos piscam): só sai o que acabou de entrar no carrinho.
let cartSuggestCache = null;

function leveJuntoHtml() {
  const reopening = Boolean(document.querySelector('#sheet #clear-cart'));

  if (!reopening || !cartSuggestCache) cartSuggestCache = forgottenSuggestions();

  const inCart = new Set(cartEntries().map(e => e.product.id));
  const items = cartSuggestCache.items.filter(p => !inCart.has(p.id) && p.available !== false);
  const ice = cartSuggestCache.ice && !inCart.has(cartSuggestCache.ice.id) && !state.iceDismissed ? cartSuggestCache.ice : null;
  const { title } = cartSuggestCache;

  if (!items.length && !ice) return '';

  return `
    ${ice ? `
      <div class="ice-hint">
        <span>🧊 <strong>Vai precisar de gelo?</strong> <span class="muted">${escapeHtml(ice.name)} · ${money(ice.price_cents)}</span></span>
        <button type="button" class="btn small primary" data-suggest="${ice.id}">+ Gelo</button>
        <button type="button" class="install-close" data-ice-no aria-label="Não precisa">✕</button>
      </div>` : ''}
    ${items.length ? `
      <div class="leve-junto">
        <strong>${title}</strong>
        <div class="leve-strip">${items.map(suggestionButtonHtml).join('')}</div>
      </div>` : ''}`;
}

/* ---------------- Conta do cliente (salva neste aparelho) ---------------- */

// Guardada no próprio celular do cliente: nome, WhatsApp, endereços, última forma de
// pagamento e os últimos pedidos. Não precisa de senha e não sai do aparelho.

function loadAccount() {
  const raw = loadJson(CUSTOMER_KEY, null);

  if (!raw) return null;

  // Formato antigo (um endereço só): converte para a lista de endereços.
  if (!Array.isArray(raw.addresses)) {
    raw.addresses = raw.address
      ? [{ id: 'a1', address: raw.address, delivery_zone_id: raw.delivery_zone_id || null }]
      : [];
    raw.last_address_id = raw.addresses[0]?.id || null;
    delete raw.address;
    delete raw.delivery_zone_id;
  }

  return raw.customer_name || raw.customer_phone ? raw : null;
}

function saveAccount(account) {
  saveJson(CUSTOMER_KEY, account);
}

// Restaura o login (nome + WhatsApp) pelo cookie de sessão, mesmo que o localStorage tenha sido limpo.
async function restoreCustomerSession() {
  try {
    const result = await api('/api/customer/session');
    if (result.logged_in && !loadAccount()) {
      saveAccount({ customer_name: result.name, customer_phone: result.phone, addresses: [] });
      renderMenu();
    }
  } catch {}
}

function forgetAccount() {
  try {
    localStorage.removeItem(CUSTOMER_KEY);
    localStorage.removeItem(ORDERS_KEY);
    localStorage.removeItem(LAST_ORDER_KEY);
  } catch {}
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function zoneName(zoneId) {
  return state.store.delivery_zones?.find(z => z.id === zoneId)?.name || '';
}

function addressLabel(a) {
  const zone = zoneName(a.delivery_zone_id);
  return `${a.address}${zone ? ` — ${zone}` : ''}`;
}

// Guarda o endereço usado no pedido (sem repetir) e deixa ele como o último usado.
function rememberAddress(account, address, zoneId, fromProfile = false, street = '') {
  const text = String(address || '').trim();

  if (!text) return;

  const same = account.addresses.find(a => (fromProfile && a.profile) || a.address.trim().toLowerCase() === text.toLowerCase());

  if (same) {
    same.delivery_zone_id = zoneId || same.delivery_zone_id || null;
    same.street = street || same.street || '';
    account.last_address_id = same.id;
    return;
  }

  const id = fromProfile ? 'profile' : `a${Date.now()}`;
  account.addresses.unshift({ id, address: text, delivery_zone_id: zoneId || null, street: street || '', ...(fromProfile ? { profile: true } : {}) });
  account.addresses = account.addresses.slice(0, 6);
  account.last_address_id = id;
}

function rememberOrder(result, total) {
  const orders = loadJson(ORDERS_KEY, []);
  orders.unshift({ id: result.id, number: result.code, total_cents: total, created_at: new Date().toISOString() });
  saveJson(ORDERS_KEY, orders.slice(0, 10));
}

// "Boa noite, Maria! 🍻 ..." — muda com a hora e escolhe uma frase por visita.
const WELCOME_PHRASES = [
  'Que bom te ver de novo por aqui! 🍻',
  'O que vai ser hoje? Tá tudo trincando de gelado 🧊',
  'Bora de uma gelada? A gente leva rapidinho 🛵',
  'Seu pedido de sempre está a um toque de distância 😉',
  'Chegou quem faltava! O cardápio é todo seu 🛒',
];

function welcomeHtml() {
  const account = loadAccount();
  const name = firstName(account?.customer_name);

  if (!name) return '';

  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).format(new Date())) % 24;
  const greeting = hour >= 5 && hour < 12 ? 'Bom dia' : hour >= 12 && hour < 18 ? 'Boa tarde' : 'Boa noite';
  const icon = hour >= 5 && hour < 12 ? '☀️' : hour >= 12 && hour < 18 ? '🌤️' : '🌙';

  const phrases = isBurgerStore() ? [
    'Bateu a fome? Escolha seu hambúrguer favorito. 🍔',
    'Hoje combina com lanche e refri! 🥤',
    'Seu lanche de sempre está a um toque de distância. 😉',
    'Que tal experimentar um combo hoje? 🍔',
    'Bom te ver de novo! O que vai pedir hoje? ❤️',
  ] : WELCOME_PHRASES;
  welcomeHtml.phrase = welcomeHtml.phrase || phrases[Math.floor(Math.random() * phrases.length)];

  // Cliente em destaque: nome em dourado.
  const shownName = state.insights?.highlight ? `<span class="name-star">👑 ${escapeHtml(name)}</span>` : escapeHtml(name);

  const vip = state.insights?.vip ? ' <span class="badge vip">⭐ VIP · entrega grátis</span>' : '';

  return `<div class="welcome" id="welcome">${icon} <strong>${greeting}, ${shownName}!</strong>${vip} <span class="welcome-phrase">${welcomeHtml.phrase}</span></div>`;
}

function accountButtonHtml() {
  const account = loadAccount();

  return `<button class="account-btn" id="open-account" aria-label="Minha conta">👤${account ? ` <span>${escapeHtml(firstName(account.customer_name))}</span>` : ''}</button>`;
}

// Aniversário já cadastrado (neste aparelho ou reconhecido pela loja): não pede de novo.
function birthdaySaved(account) {
  return Boolean(account?.birthday_saved || state.insights?.has_birthday);
}

function birthdayDoneHtml(account) {
  const [month, day] = String(account?.birthday || '').split('-');
  const date = day && month ? ` (${day}/${month})` : '';

  return `<p class="muted" style="margin:0">✅ Aniversário cadastrado${date}. No seu dia, o presente sai automático no pedido. 🎁</p>`;
}

function openAccount() {
  const account = loadAccount();
  const orders = loadJson(ORDERS_KEY, []);

  if (!account) {
    const sheet = openSheet(`
      <div class="sheet-head"><h2>👤 Minha conta</h2><button data-close aria-label="Fechar">✕</button></div>
      <div class="card" id="login-box">
        <p class="vip-note">🎉 Entre com seu WhatsApp e garanta: 🎂 presente de aniversário, reconhecimento como cliente fiel e endereço salvo pra pedidos mais rápidos.</p>
        <p class="muted" style="font-size:12px">Entrar é opcional — você pode pedir sem fazer login.</p>
        <div class="grid-2">
          <div class="field"><label for="login-name">Seu nome</label><input id="login-name" maxlength="80" autocomplete="name" placeholder="Seu nome" /></div>
          <div class="field"><label for="login-phone">WhatsApp (com DDD)</label><input id="login-phone" inputmode="tel" maxlength="20" autocomplete="tel" placeholder="(24) 99999-9999" /></div>
        </div>
        <button class="btn small" type="button" id="login-send">Receber código no WhatsApp</button>
        <div id="login-code-fields" hidden>
          <label for="login-code">Código recebido (válido por 5 minutos)</label>
          <input id="login-code" inputmode="numeric" autocomplete="one-time-code" maxlength="4" placeholder="0000" />
          <button class="btn small" type="button" id="login-verify">Confirmar código</button>
        </div>
        <p id="login-message" role="status" aria-live="polite"></p>
      </div>
      <p>Você ainda não fez nenhum pedido neste aparelho.</p>
      <p class="muted">No seu primeiro pedido, seu nome, WhatsApp e endereço ficam salvos aqui. Nos próximos, é só escolher e enviar. 😉</p>
      <button class="btn primary block" data-close>Ver cardápio</button>`);

    let loginChallenge = null;
    let loginCodePhone = null;
    const loginMessage = sheet.querySelector('#login-message');
    const loginSend = sheet.querySelector('#login-send');
    const loginVerify = sheet.querySelector('#login-verify');

    loginSend.addEventListener('click', async () => {
      const name = sheet.querySelector('#login-name').value.trim();
      const phone = sheet.querySelector('#login-phone').value.replace(/\D/g, '');
      if (!name) { loginMessage.textContent = 'Digite seu nome.'; return; }
      if (phone.length < 10) { loginMessage.textContent = 'Digite o WhatsApp com DDD.'; return; }
      loginSend.disabled = true;
      loginMessage.textContent = 'Enviando código…';
      try {
        const result = await api('/api/customer/send-code', { method: 'POST', body: JSON.stringify({ name, phone }) });
        loginChallenge = result.challenge;
        loginCodePhone = phone;
        sheet.querySelector('#login-code-fields').hidden = false;
        sheet.querySelector('#login-code').value = '';
        sheet.querySelector('#login-code').focus();
        loginMessage.textContent = 'Código enviado. Confira seu WhatsApp.';
      } catch (err) { loginMessage.textContent = err.message; }
      finally { loginSend.disabled = false; }
    });

    loginVerify.addEventListener('click', async () => {
      const name = sheet.querySelector('#login-name').value.trim();
      const phone = sheet.querySelector('#login-phone').value.replace(/\D/g, '');
      const code = sheet.querySelector('#login-code').value.trim();
      if (!/^\d{4}$/.test(code)) { loginMessage.textContent = 'Digite os 4 dígitos recebidos.'; return; }
      if (!loginChallenge || phone !== loginCodePhone) { loginMessage.textContent = 'Solicite um código para este número.'; return; }
      loginVerify.disabled = true;
      try {
        await api('/api/customer/verify-code', { method: 'POST', body: JSON.stringify({ phone, code, challenge: loginChallenge }) });
        loginChallenge = null;
        saveAccount({ customer_name: name, customer_phone: phone, addresses: [] });
        closeSheet();
        renderMenu();
        openAccount();
        toast('Login feito! Seus dados já ficam salvos para o próximo pedido.');
      } catch (err) { loginMessage.textContent = err.message; }
      finally { loginVerify.disabled = false; }
    });
    return;
  }

  const sheet = openSheet(`
    <div class="sheet-head"><h2>👤 Olá, ${escapeHtml(firstName(account.customer_name))}!</h2><button data-close aria-label="Fechar">✕</button></div>
    <form id="account-form">
      <div class="field"><label>Seu nome</label><input name="customer_name" maxlength="80" autocomplete="name" value="${escapeHtml(account.customer_name || '')}" /></div>
      <div class="field"><label>WhatsApp (com DDD)</label><input name="customer_phone" inputmode="tel" maxlength="20" autocomplete="tel" value="${escapeHtml(account.customer_phone || '')}" /></div>
      <button class="btn primary block" type="submit">Salvar</button>
    </form>
    <h3 class="section-title">📍 Endereços salvos</h3>
    ${account.addresses.length
      ? account.addresses.map(a => `
        <div class="cart-line">
          <span class="name">${escapeHtml(addressLabel(a))}</span>
          <button class="btn small danger" data-remove-address="${a.id}" aria-label="Remover endereço">🗑</button>
        </div>`).join('')
      : '<p class="muted">Nenhum endereço salvo. Ele é guardado no seu próximo pedido com entrega.</p>'}
    ${orders.length || account.customer_phone ? `
      <h3 class="section-title">🎂 Seu aniversário</h3>
      <div id="bday-box">${birthdaySaved(account) ? birthdayDoneHtml(account) : `
        <form id="bday-form" class="row" style="align-items:center">
          <select name="day" class="btn small"><option value="">Dia</option>${Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).map(d => `<option>${d}</option>`).join('')}</select>
          <select name="month" class="btn small"><option value="">Mês</option>${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'].map((m, i) => `<option value="${String(i + 1).padStart(2, '0')}">${m}</option>`).join('')}</select>
          <button class="btn small primary" type="submit">Salvar</button>
        </form>
        <p class="muted" style="font-size:12px;margin-top:4px">Cadastre e ganhe um presente no seu dia. 🎁</p>`}</div>` : ''}
    ${orders.length ? `
      <h3 class="section-title">🧾 Seus últimos pedidos</h3>
      ${orders.map(o => `
        <div class="cart-line">
          <span class="name">Pedido #${escapeHtml(o.number)}<br><span class="muted">${new Date(o.created_at).toLocaleDateString('pt-BR')} · ${money(o.total_cents)}</span></span>
          <span class="row" style="gap:6px;justify-content:flex-end">
            <button class="btn small primary" data-reorder="${escapeHtml(o.id)}">🔁 Pedir de novo</button>
            <a class="btn small" href="?pedido=${escapeHtml(o.id)}" style="text-decoration:none;color:inherit">Acompanhar</a>
          </span>
        </div>`).join('')}` : ''}
    <button class="btn danger block" id="forget-account" style="margin-top:18px">Sair (apagar meus dados deste aparelho)</button>`);

  sheet.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;

    // Aniversário pelo perfil (a prova de que é o cliente são os pedidos guardados no aparelho).
    if (form.id === 'bday-form') {
      if (!form.day.value || !form.month.value) return toast('Escolha o dia e o mês.', true);

      const birthday = `${form.month.value}-${form.day.value}`;
      const current = loadAccount();

      try {
        // Pedidos do aparelho (prova) + WhatsApp e nome da conta (quando os pedidos não bastam).
        await api('/api/customer-birthday', {
          method: 'POST',
          body: JSON.stringify({ order_ids: orders.map(o => o.id), phone: current.customer_phone, name: current.customer_name, birthday }),
        });
        current.birthday_saved = true;
        current.birthday = birthday;
        saveAccount(current);
        if (state.insights) state.insights.has_birthday = true;
        // Já cadastrado: some o pedido de aniversário.
        sheet.querySelector('#bday-box').innerHTML = birthdayDoneHtml(current);
        toast('Aniversário salvo! 🎂');
      } catch (err) {
        toast(err.message, true);
      }

      return;
    }

    const current = loadAccount();
    current.customer_name = form.customer_name.value.trim();
    current.customer_phone = form.customer_phone.value.trim();
    saveAccount(current);
    refreshAccountButton();
    toast('Dados salvos!');
    closeSheet();
  });

  sheet.addEventListener('click', event => {
    const btn = event.target.closest('button');

    if (!btn) return;

    if (btn.dataset.reorder) {
      reorder(btn.dataset.reorder, btn);
      return;
    }

    if (btn.dataset.removeAddress) {
      const current = loadAccount();
      current.addresses = current.addresses.filter(a => a.id !== btn.dataset.removeAddress);
      if (current.last_address_id === btn.dataset.removeAddress) current.last_address_id = current.addresses[0]?.id || null;
      saveAccount(current);
      openAccount();
    } else if (btn.id === 'forget-account') {
      forgetAccount();
      refreshAccountButton();
      closeSheet();
      toast('Seus dados foram apagados deste aparelho.');
      app.innerHTML = '';
      renderMenu();
    }
  });
}

function refreshAccountButton() {
  const old = document.getElementById('open-account');
  if (old) old.outerHTML = accountButtonHtml();
}

/* ---------------- Checkout ---------------- */

// Reconhece o cliente pelo WhatsApp (cadastro do sistema, inclusive quem veio do Olá Click).
// O servidor devolve só o primeiro nome e o endereço com os números escondidos.
async function lookupCustomer(phone) {
  const digits = String(phone || '').replace(/\D/g, '');

  if (digits.length < 10) return null;

  try {
    const data = await api('/api/customer-lookup', { method: 'POST', body: JSON.stringify({ phone: digits }) });
    return data.found ? data : null;
  } catch {
    return null;
  }
}

function openCheckout() {
  state.vip = false;
  const account = loadAccount();
  const zones = state.store.delivery_zones || [];
  let addresses = [...(account?.addresses || [])];
  let profile = null; // cadastro achado pelo WhatsApp
  const deliveryType = account?.delivery_type || 'delivery';
  const payment = PAYMENT_CHOICES.includes(account?.payment_method) ? account.payment_method : 'pix';
  const radio = (name, value, label, checked) => `<label><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''} /> ${label}</label>`;

  // Cliente recorrente (nome, WhatsApp, endereço e pagamento salvos): só revisa e confirma.
  const savedAddress = addresses.find(a => a.id === account?.last_address_id) || addresses[0];
  const quick = Boolean(account?.customer_phone && account?.payment_method && PAYMENT_CHOICES.includes(account.payment_method)
    && (deliveryType === 'pickup' || (savedAddress && (!zones.length || savedAddress.delivery_zone_id)
      && (!(zones.find(z => z.id === savedAddress.delivery_zone_id)?.streets || []).length || savedAddress.street))));

  const sheet = openSheet(`
    <div class="sheet-head"><h2>${quick ? '⚡ Confirmar pedido' : 'Finalizar pedido'}</h2><button data-close aria-label="Fechar">✕</button></div>
    <form id="checkout-form" class="${quick ? 'quick' : ''}">
      ${quick ? `
        <div class="quick-box">
          <div>📍 ${deliveryType === 'pickup' ? '<strong>Retirar na loja</strong>' : `<strong>Entrega:</strong> ${escapeHtml(addressLabel(savedAddress))}`}</div>
          <div>💳 <strong>${escapeHtml(PAYMENT_LABELS[account.payment_method])}</strong> na ${deliveryType === 'pickup' ? 'retirada' : 'entrega'}</div>
          <button type="button" class="btn small" id="quick-edit">Alterar endereço ou pagamento</button>
        </div>` : ''}
      ${account ? `
        <div class="saved-customer" id="saved-customer">
          <span>👋 <strong>${escapeHtml(account.customer_name)}</strong><br><span class="muted">${escapeHtml(account.customer_phone)}</span></span>
          <button type="button" class="btn small" id="edit-customer">Editar</button>
        </div>` : ''}
      <div id="customer-fields" ${account ? 'hidden' : ''}>
        <div class="field"><label>Seu WhatsApp (com DDD)</label><input name="customer_phone" required inputmode="tel" maxlength="20" autocomplete="tel" placeholder="(24) 99999-9999" value="${escapeHtml(account?.customer_phone || '')}" /></div>
        <div class="lookup-msg" id="lookup-msg" hidden></div>
        <div class="field"><label>Seu nome</label><input name="customer_name" required maxlength="80" autocomplete="name" value="${escapeHtml(account?.customer_name || '')}" /></div>
      </div>

      <div class="field quick-hide"><label>Como quer receber?</label>
        <div class="choices">
          ${radio('delivery_type', 'delivery', 'Entrega', deliveryType === 'delivery')}
          ${radio('delivery_type', 'pickup', 'Retirar na loja', deliveryType === 'pickup')}
        </div>
      </div>

      <div id="delivery-fields" class="quick-hide">
        <div class="field" id="address-choices" hidden><label>Entregar em</label><div class="address-options" id="address-options"></div></div>
        <div id="new-address">
          ${zones.length ? `
            <div class="field" id="zone-select"><label>Bairro</label>
              <select name="delivery_zone_id">
                <option value="">Escolha o bairro…</option>
                ${zones.map(z => `<option value="${z.id}">${escapeHtml(z.name)} — ${z.fee_cents ? money(z.fee_cents) : 'entrega grátis'}</option>`).join('')}
              </select>
            </div>` : ''}
          <div class="field" id="address-text"><label>Endereço completo</label><textarea name="address" rows="2" maxlength="300" autocomplete="street-address" placeholder="Rua, número, complemento, ponto de referência"></textarea></div>
        </div>
        <div class="field" id="street-field" hidden><label id="street-label">Qual é a sua quadra?</label><select name="delivery_street"></select></div>
      </div>

      <div class="field quick-hide"><label>Pagamento (na entrega/retirada)</label>
        <div class="choices">
          ${radio('payment_method', 'pix', 'Pix', payment === 'pix')}
          ${radio('payment_method', 'debito', 'Cartão de débito', payment === 'debito')}
          ${radio('payment_method', 'credito', 'Cartão de crédito', payment === 'credito')}
          ${radio('payment_method', 'dinheiro', 'Dinheiro', payment === 'dinheiro')}
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:10px;font-size:14px"><input type="checkbox" name="split" /> Dividir em duas formas (ex.: parte no Pix, parte no dinheiro)</label>
      </div>

      <div id="split-fields" hidden>
        <div class="field"><label id="split-first-label">Quanto vai pagar no Pix?</label><input name="split_first" inputmode="decimal" placeholder="Ex.: 20" /></div>
        <div class="field"><label>O restante em</label><div class="choices" id="split-second"></div></div>
        <p class="muted" id="split-rest" style="margin-top:-6px;font-size:14px"></p>
      </div>

      <div class="field" id="change-field" hidden><label id="change-label">Troco para quanto? (deixe vazio se não precisar)</label><input name="change_for" inputmode="decimal" placeholder="Ex.: 100" /></div>

      <div class="field"><label>Observação (opcional)</label><textarea name="notes" rows="2" maxlength="500" placeholder="${storeCopy('Ex.: sem cebola no lanche. Adicionais devem ser selecionados no cardápio.', '')}"></textarea></div>

      ${state.insights?.found || birthdaySaved(account) || loadJson(ORDERS_KEY, []).length ? '' : `
        <div class="field" id="bday-field"><label>🎂 Seu aniversário (opcional — ganhe um presente no seu dia)</label>
          <div class="row">
            <select name="bday_day"><option value="">Dia</option>${Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')).map(d => `<option>${d}</option>`).join('')}</select>
            <select name="bday_month"><option value="">Mês</option>${['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'].map((m, i) => `<option value="${String(i + 1).padStart(2, '0')}">${m}</option>`).join('')}</select>
          </div>
        </div>`}
      ${state.insights?.opted_in || account?.opted_in ? '' : '<label style="display:flex;gap:8px;align-items:center;margin:0 0 12px;font-size:14px"><input type="checkbox" name="opt_in" /> Quero receber lembretes e novidades da loja pelo WhatsApp</label>'}

      <div id="checkout-totals"></div>
      <div class="card" id="vip-verification" hidden>
        <strong>⭐ Confirme seu WhatsApp para usar os benefícios VIP</strong>
        <p class="muted">Enviamos um código de 4 dígitos. Você também pode enviar o pedido normalmente, sem os benefícios VIP.</p>
        <button class="btn small" type="button" id="vip-send">Receber código no WhatsApp</button>
        <div id="vip-code-fields" hidden>
          <label for="vip-code">Código recebido (válido por 5 minutos)</label>
          <input id="vip-code" inputmode="numeric" autocomplete="one-time-code" maxlength="4" placeholder="0000" />
          <button class="btn small" type="button" id="vip-verify">Confirmar código</button>
        </div>
        <p id="vip-message" role="status" aria-live="polite"></p>
      </div>
      ${!state.store.is_open && state.store.accept_scheduled ? `
        <div class="scheduled-box">
          <strong>🌙 A loja está fechada agora.</strong><br>
          Seu pedido vai ficar <strong>aguardando a abertura</strong>${state.store.opens_text ? ` (abrimos <strong>${escapeHtml(state.store.opens_text)}</strong>)` : ''} e <strong>não será entregue agora</strong>.
          <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" name="scheduled_ok" required /> Entendi, pode deixar agendado para quando abrir</label>
        </div>` : ''}
      ${cartHasWeight() ? '<p class="weight-notice">⚖️ Seu pedido tem produto vendido por kg: o total é estimado e pode mudar um pouquinho depois de pesar na loja.</p>' : ''}
      <button class="btn primary block" type="submit">${!state.store.is_open && state.store.accept_scheduled ? 'Agendar pedido para quando abrir' : 'Enviar pedido'}</button>
      ${account ? '' : '<p class="muted" style="font-size:12px;text-align:center;margin:8px 0 0">Seus dados ficam salvos neste aparelho para os próximos pedidos.</p>'}
    </form>
  `);

  const form = sheet.querySelector('#checkout-form');
  let vipChallenge = null;
  let vipCodePhone = null;
  const vipBox = sheet.querySelector('#vip-verification');
  const vipMessage = sheet.querySelector('#vip-message');
  const vipSend = sheet.querySelector('#vip-send');
  const vipVerify = sheet.querySelector('#vip-verify');

  vipSend.addEventListener('click', async () => {
    const phone = form.customer_phone.value.replace(/\D/g, '');
    vipSend.disabled = true;
    vipMessage.textContent = 'Enviando código…';
    try {
      const result = await api('/api/vip/send-code', { method: 'POST', body: JSON.stringify({ phone }) });
      if (form.customer_phone.value.replace(/\D/g, '') !== phone) return;
      vipChallenge = result.challenge;
      vipCodePhone = phone;
      sheet.querySelector('#vip-code-fields').hidden = false;
      sheet.querySelector('#vip-code').value = '';
      sheet.querySelector('#vip-code').focus();
      vipMessage.textContent = 'Código enviado. Confira seu WhatsApp.';
    } catch (err) { vipMessage.textContent = err.message; }
    finally { vipSend.disabled = false; }
  });

  vipVerify.addEventListener('click', async () => {
    const phone = form.customer_phone.value.replace(/\D/g, '');
    const code = sheet.querySelector('#vip-code').value.trim();
    if (!/^\d{4}$/.test(code)) { vipMessage.textContent = 'Digite os 4 dígitos recebidos.'; return; }
    if (!vipChallenge || phone !== vipCodePhone) { vipMessage.textContent = 'Solicite um código para este número.'; return; }
    vipVerify.disabled = true;
    try {
      await api('/api/vip/verify-code', { method: 'POST', body: JSON.stringify({ phone, code, challenge: vipChallenge }) });
      if (form.customer_phone.value.replace(/\D/g, '') !== phone) return;
      vipChallenge = null;
      lastLooked = '';
      await refreshCustomer();
      toast('WhatsApp confirmado. Benefícios VIP liberados!');
    } catch (err) { vipMessage.textContent = err.message; }
    finally { vipVerify.disabled = false; }
  });

  // Lista de endereços: os salvos neste aparelho + o do cadastro (se achado pelo WhatsApp) + "novo".
  function renderAddressOptions(selectedId) {
    const options = [...addresses];

    if (profile?.address && !options.some(a => a.profile)) {
      options.unshift({ id: 'profile', address: profile.address.masked, delivery_zone_id: profile.address.zone_id, profile: true });
    }

    const box = sheet.querySelector('#address-choices');
    box.hidden = !options.length;

    const current = selectedId || form.address_id?.value || account?.last_address_id || options[0]?.id || 'new';

    sheet.querySelector('#address-options').innerHTML = options.map(a => `
      <label class="address-option"><input type="radio" name="address_id" value="${a.id}" ${a.id === current ? 'checked' : ''} />
        <span>🏠 ${escapeHtml(a.address)}${zoneName(a.delivery_zone_id) ? `<br><span class="muted">${escapeHtml(zoneName(a.delivery_zone_id))}</span>` : ''}${a.profile ? '<br><span class="muted">endereço do seu cadastro</span>' : ''}</span>
      </label>`).join('') + (options.length
      ? `<label class="address-option"><input type="radio" name="address_id" value="new" ${current === 'new' || !options.some(a => a.id === current) ? 'checked' : ''} /> <span>➕ Novo endereço</span></label>`
      : '');

    sync();
  }

  function allOptions() {
    const list = [...addresses];
    if (profile?.address && !list.some(a => a.profile)) list.unshift({ id: 'profile', address: profile.address.masked, delivery_zone_id: profile.address.zone_id, profile: true });
    return list;
  }

  // Endereço escolhido: salvo (neste aparelho ou no cadastro) ou o novo digitado agora.
  function chosenAddress() {
    const id = form.address_id?.value;
    const saved = id && id !== 'new' ? allOptions().find(a => a.id === id) : null;

    if (!saved) return { address: form.address.value, delivery_zone_id: form.delivery_zone_id?.value || null, profile: false, isNew: true, street: '' };

    return {
      address: saved.address,
      delivery_zone_id: saved.delivery_zone_id || form.delivery_zone_id?.value || null,
      street: saved.street || '',
      profile: Boolean(saved.profile),
      needsZone: !saved.delivery_zone_id,
      isNew: false,
    };
  }

  function sync() {
    const isDelivery = form.delivery_type.value === 'delivery';
    const place = chosenAddress();
    const showZone = isDelivery && zones.length && (place.isNew || place.needsZone);

    sheet.querySelector('#delivery-fields').hidden = !isDelivery;
    sheet.querySelector('#new-address').hidden = !(place.isNew || place.needsZone);
    sheet.querySelector('#address-text').hidden = !place.isNew;
    if (sheet.querySelector('#zone-select')) sheet.querySelector('#zone-select').hidden = !showZone;
    form.address.required = isDelivery && place.isNew;
    if (form.delivery_zone_id) form.delivery_zone_id.required = Boolean(showZone);
    syncStreet(isDelivery, place);
    syncSplit();
    sheet.querySelector('#checkout-totals').innerHTML = totalsHtml(form.delivery_type.value, place.delivery_zone_id);
  }

  // Quadra (ou rua): lista do bairro escolhido, só onde existe (hoje, Garatucaia). Ajuda a juntar entregas.
  function syncStreet(isDelivery, place) {
    const field = sheet.querySelector('#street-field');
    const zone = zones.find(z => z.id === place.delivery_zone_id);
    const streets = zone?.streets || [];
    const show = isDelivery && streets.length > 0;

    field.hidden = !show;
    form.delivery_street.required = show;

    if (!show) return;

    // Só remonta a lista quando muda o bairro ou o endereço escolhido (senão perde a escolha).
    const key = `${zone.id}|${form.address_id?.value || 'new'}`;

    if (field.dataset.key === key) return;

    field.dataset.key = key;
    const selected = streets.includes(place.street) ? place.street : '';

    // Garatucaia é condomínio: casa = quadra + lote.
    const word = streets.every(s => /^quadra\b/i.test(s)) ? 'quadra' : 'rua';
    sheet.querySelector('#street-label').textContent = `Qual é a sua ${word}?`;

    form.delivery_street.innerHTML = `<option value="">Escolha a ${word}…</option>`
      + streets.map(s => `<option ${s === selected ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')
      + `<option value="-">${word === 'quadra' ? 'Não sei a quadra' : 'Minha rua não está na lista'}</option>`;
  }

  // Total que o cliente vê agora (subtotal + taxa do bairro escolhido).
  function currentTotal() {
    const fee = form.delivery_type.value === 'delivery' ? deliveryFeeFor(chosenAddress().delivery_zone_id) : 0;
    return cartSubtotal() + (fee || 0);
  }

  // Pagamento dividido: 1ª forma = a escolhida acima; o restante vai para a 2ª.
  function syncSplit() {
    const first = form.payment_method.value;
    const splitting = form.split.checked;
    const box = sheet.querySelector('#split-second');
    const previous = form.split_second?.value;
    const others = PAYMENT_CHOICES.filter(m => m !== first);
    const second = others.includes(previous) ? previous : (others.includes('dinheiro') ? 'dinheiro' : others[0]);

    sheet.querySelector('#split-fields').hidden = !splitting;
    sheet.querySelector('#split-first-label').textContent = `Quanto vai pagar no ${PAYMENT_LABELS[first]}?`;
    box.innerHTML = others.map(m => radio('split_second', m, PAYMENT_LABELS[m], m === second)).join('');
    form.split_first.required = splitting;
    updateSplitRest();

    const cashInvolved = splitting ? [first, second].includes('dinheiro') : first === 'dinheiro';
    sheet.querySelector('#change-field').hidden = !cashInvolved;
    sheet.querySelector('#change-label').textContent = splitting
      ? 'Troco para quanto? (da parte em dinheiro — deixe vazio se não precisar)'
      : 'Troco para quanto? (deixe vazio se não precisar)';
  }

  function updateSplitRest() {
    const rest = sheet.querySelector('#split-rest');

    if (!form.split.checked) return;

    const firstCents = reaisToCents(form.split_first.value);
    const total = currentTotal();

    rest.textContent = firstCents === null || firstCents <= 0 || firstCents >= total
      ? `Total do pedido: ${money(total)}`
      : `Restante: ${money(total - firstCents)} no ${PAYMENT_LABELS[form.split_second.value]}`;
  }

  renderAddressOptions();
  form.addEventListener('change', sync);

  // Bairro automático pelo endereço digitado (até o cliente escolher o bairro na mão).
  let zoneAuto = true;
  const zoneHint = document.createElement('p');
  zoneHint.className = 'muted';
  zoneHint.style.cssText = 'font-size:13px;margin:4px 0 0';
  zoneHint.hidden = true;
  sheet.querySelector('#zone-select')?.appendChild(zoneHint);
  form.delivery_zone_id?.addEventListener('change', event => {
    if (!event.isTrusted) return;
    zoneAuto = false;
    zoneHint.hidden = true;
  });
  form.address.addEventListener('input', () => {
    if (!form.delivery_zone_id || !zoneAuto) return;
    const zone = detectZoneFromAddress(form.address.value, zones);
    if (!zone || form.delivery_zone_id.value === zone.id) return;
    form.delivery_zone_id.value = zone.id;
    zoneHint.textContent = `📍 Bairro identificado pelo endereço: ${zone.name}. Se não for, escolha outro acima.`;
    zoneHint.hidden = false;
    sync();
  });
  form.split_first.addEventListener('input', updateSplitRest);

  // Carrinho abandonado: com o WhatsApp preenchido, a loja fica sabendo do carrinho
  // (se o pedido for fechado, ele some da lista de abandonados).
  let draftTimer;
  const saveDraft = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const phone = form.customer_phone.value.replace(/\D/g, '');

      if (phone.length < 10) return;

      api('/api/cart-draft', {
        method: 'POST',
        body: JSON.stringify({
          phone,
          name: form.customer_name.value,
          subtotal_cents: cartSubtotal(),
          marketing_opt_in: form.opt_in?.checked === true,
          items: cartEntries().map(e => ({ product_id: e.product.id, variant_id: e.variant?.id || null, quantity: e.qty, name: e.name })),
        }),
      }).catch(() => {});
    }, 1500);
  };

  form.customer_phone.addEventListener('input', saveDraft);
  form.customer_name.addEventListener('change', saveDraft);
  form.opt_in?.addEventListener('change', saveDraft);
  saveDraft();

  const openQuickFields = () => {
    form.classList.remove('quick');
    sheet.querySelector('.quick-box')?.remove();
  };

  sheet.querySelector('#quick-edit')?.addEventListener('click', openQuickFields);
  // Se faltar algo nos dados salvos, mostra os campos em vez de travar num campo escondido.
  form.addEventListener('invalid', openQuickFields, true);

  sheet.querySelector('#edit-customer')?.addEventListener('click', () => {
    sheet.querySelector('#saved-customer').hidden = true;
    sheet.querySelector('#customer-fields').hidden = false;
    form.customer_phone.focus();
  });

  // Reconhecimento: quando o WhatsApp fica completo, procura o cadastro.
  let lookupTimer;
  let lastLooked = '';

  async function refreshCustomer() {
      const digits = form.customer_phone.value.replace(/\D/g, '');

      if (digits.length < 10 || digits === lastLooked) return;

      lastLooked = digits;
      const found = await lookupCustomer(digits);
      const msg = sheet.querySelector('#lookup-msg');

      if (form.customer_phone.value.replace(/\D/g, '') !== digits) return;
      if (!found) {
        msg.hidden = true;
        state.vip = false;
        vipBox.hidden = true;
        sync();
        return;
      }

      profile = found;
      state.vip = Boolean(found.vip && !found.verification_required);
      vipBox.hidden = !found.verification_required;
      msg.hidden = false;
      msg.innerHTML = (found.first_name
        ? `👋 Oi, <strong>${escapeHtml(found.first_name)}</strong>! Achamos seu cadastro 😉`
        : '👋 Achamos seu cadastro 😉')
        + (found.vip && !found.verification_required ? '<br>⭐ Você é cliente VIP: <strong>entrega grátis!</strong>' : '')
        + (found.verification_required ? '<br>🔐 Confirme seu WhatsApp para liberar o benefício VIP.' : '');

      if (found.first_name && !form.customer_name.value.trim()) form.customer_name.value = found.first_name;

      // Cliente que já pediu antes: aniversário só no primeiro pedido (depois, pelo perfil).
      const bday = sheet.querySelector('#bday-field');
      if (bday) {
        bday.remove();
      }

      if (!found.verification_required) maybeAskSaveData(found, digits, form.customer_name);

      renderAddressOptions(found.address ? 'profile' : undefined);
  }
  form.customer_phone.addEventListener('input', () => {
    clearTimeout(lookupTimer);
    lastLooked = '';
    profile = null;
    state.vip = false;
    vipChallenge = null;
    vipCodePhone = null;
    vipBox.hidden = true;
    sheet.querySelector('#vip-code-fields').hidden = true;
    vipMessage.textContent = '';
    renderAddressOptions();
    lookupTimer = setTimeout(refreshCustomer, 400);
  });
  refreshCustomer();

  form.addEventListener('submit', async event => {
    event.preventDefault();

    const submit = form.querySelector('[type=submit]');
    // Revalida inclusive em checkout rápido: cookie pode ter expirado ou o VIP ter sido removido.
    submit.disabled = true;
    try {
      const latest = await api('/api/customer-lookup', { method: 'POST', body: JSON.stringify({ phone: form.customer_phone.value }) });
      if (state.vip && !latest.vip) {
        state.vip = false;
        profile = latest;
        vipBox.hidden = !latest.verification_required;
        renderAddressOptions();
        toast('Confira o total atualizado ou confirme seu WhatsApp para usar os benefícios VIP.', true);
        return;
      }
      state.vip = Boolean(latest.vip && !latest.verification_required);
      sync();
    } catch (err) { toast(err.message, true); return; }
    finally { submit.disabled = false; }
    const changeRaw = form.change_for.value.trim().replace(/\./g, '').replace(',', '.');
    const isDelivery = form.delivery_type.value === 'delivery';
    const place = chosenAddress();

    if (isDelivery && zones.length && !place.delivery_zone_id) {
      toast('Escolha o bairro da entrega.', true);
      return;
    }

    const minRule = isDelivery ? categoryMinProblem() : null;

    if (minRule) {
      toast(`Para entrega com ${minRule.label}, o pedido mínimo é ${money(minRule.min_cents)}. Adicione mais itens ou escolha retirar na loja.`, true);
      return;
    }

    let paymentSplit = null;

    if (form.split.checked) {
      const firstCents = reaisToCents(form.split_first.value);
      const total = currentTotal();

      if (firstCents === null || firstCents <= 0 || firstCents >= total) {
        toast(`No pagamento dividido, informe um valor maior que zero e menor que o total (${money(total)}).`, true);
        return;
      }

      paymentSplit = { first_method: form.payment_method.value, first_cents: firstCents, second_method: form.split_second.value };
    }

    const cashInvolved = paymentSplit ? [paymentSplit.first_method, paymentSplit.second_method].includes('dinheiro') : form.payment_method.value === 'dinheiro';

    const payload = {
      customer_name: form.customer_name.value,
      require_vip: state.vip,
      customer_phone: form.customer_phone.value,
      delivery_type: form.delivery_type.value,
      address: isDelivery && !place.profile ? place.address : '',
      use_saved_address: isDelivery && place.profile,
      delivery_zone_id: isDelivery ? place.delivery_zone_id : null,
      delivery_street: isDelivery && form.delivery_street.value !== '-' ? form.delivery_street.value : '',
      payment_method: form.payment_method.value,
      payment_split: paymentSplit,
      scheduled_ok: form.scheduled_ok?.checked === true,
      birthday: form.bday_day?.value && form.bday_month?.value ? `${form.bday_month.value}-${form.bday_day.value}` : null,
      marketing_opt_in: form.opt_in?.checked === true,
      change_for_cents: cashInvolved && changeRaw ? Math.round(Number(changeRaw) * 100) : null,
      notes: form.notes.value,
      items: cartEntries().map(e => ({ product_id: e.product.id, variant_id: e.variant?.id || null, quantity: e.qty, chilled: Boolean(e.chill?.on), no_cheddar: e.noCheddar === true, addons: (e.addons || []).map(a => ({ product_id: a.product.id, quantity: a.qty })) })),
    };

    if (payload.change_for_cents !== null && !Number.isFinite(payload.change_for_cents)) {
      toast('Valor do troco inválido.', true);
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Enviando…';

    try {
      const result = await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });

      const updated = loadAccount() || { addresses: [] };
      updated.customer_name = payload.customer_name.trim();
      updated.customer_phone = payload.customer_phone.trim();
      updated.delivery_type = payload.delivery_type;
      updated.payment_method = payload.payment_method;
      if (payload.birthday) {
        updated.birthday_saved = true;
        updated.birthday = payload.birthday;
      }
      if (payload.marketing_opt_in) updated.opted_in = true;
      if (isDelivery) rememberAddress(updated, place.address, payload.delivery_zone_id, place.profile, payload.delivery_street);
      saveAccount(updated);

      rememberOrder(result, result.total_cents);
      saveJson(LAST_ORDER_KEY, { id: result.id, number: result.code });
      state.cart = {};
      saveJson(CART_KEY, state.cart);
      state.chill = {};
      saveJson(CHILL_KEY, state.chill);
      state.noCheddar = {};
      saveJson(NO_CHEDDAR_KEY, state.noCheddar);
      closeSheet();
      history.pushState(null, '', `?pedido=${result.id}`);
      showOrder(result.id, true);
    } catch (err) {
      toast(err.message, true);
      submit.disabled = false;
      submit.textContent = 'Enviar pedido';
    }
  });
}

/* ---------------- Pedir de novo ---------------- */

// Coloca no carrinho os mesmos itens de um pedido antigo (com os preços de hoje).
async function reorder(orderId, button) {
  if (button) button.disabled = true;

  try {
    const { order } = await api(`/api/orders/${encodeURIComponent(orderId)}`);
    const missing = [];
    let added = 0;

    for (const item of order.order_items) {
      const product = productById(item.product_id);
      const variantOk = !item.variant_id || product?.variants.some(v => v.id === item.variant_id);

      if (!product || !variantOk || (product.variants.length && !item.variant_id)) {
        missing.push(item.product_name);
        continue;
      }

      const key = cartKey(product.id, item.variant_id);
      setQty(key, (state.cart[key] || 0) + item.quantity);
      added++;
    }

    if (!added) {
      toast('Os produtos desse pedido não estão disponíveis agora. 😕', true);
      if (button) button.disabled = false;
      return;
    }

    if (missing.length) {
      sessionStorage.setItem(storeKey('reorder-missing'), missing.join(', '));
    }

    // Volta para o cardápio já com o carrinho aberto.
    location.href = '/?carrinho=1';
  } catch (err) {
    toast(err.message, true);
    if (button) button.disabled = false;
  }
}

/* ---------------- Instalar como aplicativo ---------------- */

const INSTALL_DISMISSED_KEY = storeKey('install-dismissed');
let installPrompt = null;

/* ---------------- Pop-ups: salvar dados, aviso do pedido e promoções ---------------- */

// Pop-up por cima de tudo (inclusive do checkout). Some sozinho ao escolher.
function showPopup({ id, icon, title, text, yes, no }) {
  return new Promise(resolve => {
    if (document.getElementById(id)) return resolve(false);

    const box = document.createElement('div');
    box.className = 'sheet-backdrop popup';
    box.id = id;
    box.innerHTML = `
      <div class="sheet" style="text-align:center">
        <div style="font-size:44px;line-height:1">${icon}</div>
        <h2 style="margin:10px 0 6px">${title}</h2>
        <p class="muted" style="margin:0 0 16px">${text}</p>
        <button class="btn primary block" data-popup="yes">${yes}</button>
        <button class="btn block" data-popup="no" style="margin-top:8px">${no}</button>
      </div>`;

    box.addEventListener('click', event => {
      const choice = event.target.closest('[data-popup]')?.dataset.popup;

      if (!choice && event.target !== box) return;

      box.remove();
      resolve(choice === 'yes');
    });

    document.body.appendChild(box);
  });
}

// "Não agora": não pergunta de novo por alguns dias.
const snoozed = key => {
  try { return Number(localStorage.getItem(key) || 0) > Date.now(); } catch { return false; }
};
const snooze = (key, days) => {
  try { localStorage.setItem(key, String(Date.now() + days * 86400000)); } catch {}
};

function pushAvailable() {
  return Boolean(state.pushKey) && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
    && Notification.permission !== 'denied' && !(isIos() && !isStandalone());
}

// Pede a permissão (precisa ser dentro do toque no botão) e devolve a inscrição deste aparelho.
async function pushSubscription() {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Você não permitiu as notificações.');

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();

  if (existing) return existing;

  const padded = (state.pushKey + '='.repeat((4 - (state.pushKey.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');

  return registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(padded), c => c.charCodeAt(0)) });
}

// 1) Cliente reconhecido pelo WhatsApp e ainda sem dados salvos no aparelho.
async function maybeAskSaveData(found, phone, nameInput) {
  if (loadAccount() || snoozed(storeKey('save-snooze'))) return;

  const ok = await showPopup({
    id: 'popup-save',
    icon: '💾',
    title: `${found.first_name ? `${escapeHtml(found.first_name)}, s` : 'S'}alvar seus dados?`,
    text: 'Da próxima vez, seu nome, WhatsApp e endereço já vêm preenchidos. Fica guardado só neste aparelho.',
    yes: 'Salvar meus dados',
    no: 'Agora não',
  });

  if (!ok) return snooze(storeKey('save-snooze'), 30);

  const account = { customer_name: nameInput.value.trim() || found.first_name || '', customer_phone: phone, addresses: [] };

  if (found.address) rememberAddress(account, found.address.masked, found.address.zone_id, true);

  saveAccount(account);
  toast('Dados salvos neste aparelho! 👍');
}

// 2) Pedido feito: avisar no celular quando for aceito, sair para entrega e chegar.
async function maybeAskOrderPush(orderId) {
  if (!pushAvailable() || snoozed(storeKey('order-push-snooze'))) return;

  const ok = await showPopup({
    id: 'popup-order-push',
    icon: '🔔',
    title: 'Quer ser avisado do seu pedido?',
    text: 'A gente te avisa aqui no celular quando o pedido for aceito, sair para entrega e chegar — mesmo com o site fechado.',
    yes: '🔔 Ativar notificações',
    no: 'Não precisa',
  });

  if (!ok) return snooze(storeKey('order-push-snooze'), 7);

  try {
    const subscription = await pushSubscription();
    await api('/api/customer-push', { method: 'POST', body: JSON.stringify({ order_id: orderId, subscription: subscription.toJSON() }) });
    toast('Pronto! Você vai ser avisado do seu pedido. 🔔');
  } catch (err) {
    toast(err.message, true);
  }
}

// 3) Promoções: aparece uma vez no cardápio (e de novo só depois de 7 dias, se recusar).
async function maybeAskPromos() {
  let enabled = false;
  try { enabled = localStorage.getItem(storeKey('promos-on')) === '1'; } catch {}

  if (enabled || !pushAvailable() || snoozed(storeKey('promos-snooze')) || document.getElementById('sheet') || document.querySelector('.popup')) return;

  const ok = await showPopup({
    id: 'popup-promos',
    icon: '🔥',
    title: 'Fique por dentro das promoções!',
    text: storeCopy('Receba as promoções de lanches, combos e novidades da Ponto X no seu celular.', `Ative as notificações e seja o primeiro a saber das ofertas e novidades da ${state.store?.name || 'loja'}.`),
    yes: '🔔 Quero receber as promoções',
    no: 'Agora não',
  });

  if (!ok) return snooze(storeKey('promos-snooze'), 7);

  try {
    const subscription = await pushSubscription();
    await api('/api/promo-push', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) });
    try { localStorage.setItem(storeKey('promos-on'), '1'); } catch {}
    toast('Pronto! Você vai receber as promoções. 🔥');
  } catch (err) {
    toast(err.message, true);
  }
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  refreshInstallBanner();
});

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  refreshInstallBanner();
  toast(`App instalado! 🎉 Agora é só abrir pelo ícone da ${state.store?.name || 'loja'}.`);
});

function installBannerHtml() {
  let dismissed = false;
  try { dismissed = Boolean(localStorage.getItem(INSTALL_DISMISSED_KEY)); } catch {}

  if (isStandalone() || dismissed || !(installPrompt || isIos())) return '';

  return `
    <div class="install-banner compact">
      <span>📲 <strong>Instale o app</strong> <span class="muted">e peça em 2 toques</span></span>
      <button class="btn small primary" id="install-app">Instalar</button>
      <button class="install-close" id="install-dismiss" aria-label="Agora não">✕</button>
    </div>`;
}

function refreshInstallBanner() {
  const slot = document.getElementById('install-slot');
  if (slot) slot.innerHTML = installBannerHtml();
}

async function installApp() {
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    refreshInstallBanner();
    return;
  }

  openSheet(`
    <div class="sheet-head"><h2>📲 Instalar no iPhone</h2><button data-close aria-label="Fechar">✕</button></div>
    <ol class="install-steps">
      <li>Toque no botão <strong>Compartilhar</strong> <span class="ios-share">⬆️</span> na barra do Safari.</li>
      <li>Role e toque em <strong>"Adicionar à Tela de Início"</strong>.</li>
      <li>Toque em <strong>Adicionar</strong>. Pronto! O ícone da ${escapeHtml(state.store?.name || 'loja')} aparece na sua tela. ${storeCopy('🍔', '🍻')}</li>
    </ol>
    <button class="btn primary block" data-close>Entendi</button>`);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/* ---------------- Acompanhar pedido ---------------- */

let pollTimer;
let lastSeenStatus = null;

const STATUS_TOASTS = {
  accepted: '✅ Seu pedido foi aceito!',
  preparing: storeCopy('🍔 Seu pedido está sendo preparado na cozinha!', '🧊 Seu pedido está sendo separado!'),
  out_for_delivery: '🛵 Seu pedido saiu para entrega!',
};

// Previsão (prazo da loja contado da hora do pedido) e, se passar dela, um aviso tranquilo.
function orderEtaHtml(order) {
  if (['delivered', 'cancelled'].includes(order.status)) return '';

  const pickup = order.delivery_type === 'pickup';
  const minutes = (pickup ? state.store?.pickup_minutes : state.store?.delivery_minutes) || (pickup ? 20 : 45);
  const deadline = new Date(order.created_at).getTime() + minutes * 60000;
  const time = new Date(deadline).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

  if (Date.now() <= deadline) {
    return `<p style="margin:12px 0 0">⏰ Previsão: <strong>${pickup ? 'pronto para retirar' : 'chega'} até as ${time}</strong></p>`;
  }

  return `<div class="late-note">⏳ Seu pedido está levando um pouquinho mais que o previsto, mas já estamos cuidando dele. Obrigado pela paciência! 💛</div>`;
}

async function showOrder(orderId, justPlaced = false) {
  clearTimeout(pollTimer);

  try {
    const { order } = await api(`/api/orders/${encodeURIComponent(orderId)}`);

    // Mudou de etapa enquanto a página estava aberta: avisa na hora.
    if (lastSeenStatus && lastSeenStatus !== order.status && STATUS_TOASTS[order.status]) {
      toast(order.status === 'out_for_delivery' && order.delivery_type === 'pickup' ? '🏪 Seu pedido está pronto para retirada!' : STATUS_TOASTS[order.status]);
      navigator.vibrate?.(200);
    }

    lastSeenStatus = order.status;
    const steps = order.delivery_type === 'pickup'
      ? STATUS_STEPS.map(([k, label]) => [k, k === 'out_for_delivery' ? 'Pronto para retirada' : k === 'delivered' ? 'Retirado' : label])
      : STATUS_STEPS;
    const currentIndex = steps.findIndex(([key]) => key === order.status);
    const whatsapp = state.store?.whatsapp;

    app.innerHTML = `
      ${headerHtml()}
      ${justPlaced ? '<div class="card"><strong>Pedido enviado! 🎉</strong><br><span class="muted">Deixe esta página aberta pra acompanhar. Ela atualiza sozinha.</span></div>' : ''}
      <div class="card">
        <h2 style="margin:0">Pedido #${escapeHtml(order.public_code)}</h2>
        ${order.status === 'cancelled'
          ? '<p class="status-cancelled"><strong>Pedido cancelado.</strong> Em caso de dúvida, fale com a loja.</p>'
          : `<ul class="tracker">${steps.map(([key, label], i) => `<li class="${i < currentIndex ? 'done' : ''} ${i === currentIndex ? 'done current' : ''}">${label}</li>`).join('')}</ul>`}
        ${orderEtaHtml(order)}
        <ul class="order-items">
          ${order.order_items.map(item => `<li><span>${item.quantity}× ${escapeHtml(item.product_name)}${item.by_weight ? `<br><small class="muted">⚖️ ${item.weighed_at ? `pesado na loja${item.estimated_cents != null && item.estimated_cents !== item.subtotal_cents ? ` (estimado era ${money(item.estimated_cents)})` : ''}` : 'por kg · valor estimado até pesar'}</small>` : ''}</span><span>${money(item.subtotal_cents)}</span></li>`).join('')}
        </ul>
        ${order.order_items.some(i => i.by_weight && !i.weighed_at) && !['delivered', 'cancelled'].includes(order.status) ? '<p class="weight-notice">⚖️ O total ainda é estimado: a loja vai pesar os produtos vendidos por kg e o valor pode mudar um pouquinho.</p>' : ''}
        <div class="totals">
          ${order.delivery_fee_cents ? `<div><span>Taxa de entrega</span><span>${money(order.delivery_fee_cents)}</span></div>` : ''}
          ${order.fee_waived === 'vip' ? '<div><span>Entrega</span><span>Grátis ⭐ VIP</span></div>' : ''}
          ${order.discount_cents ? `<div><span>${order.discount_reason === 'aniversario' ? '🎂 Presente de aniversário' : order.discount_reason === 'cupom' ? '🎁 Cupom' : 'Desconto'}</span><span>− ${money(order.discount_cents)}</span></div>` : ''}
          <div class="grand"><span>Total</span><span>${money(order.total_cents)}</span></div>
          <div class="muted"><span>Pagamento na ${order.delivery_type === 'pickup' ? 'retirada' : 'entrega'}</span><span>${escapeHtml(paymentText(order))}</span></div>
        </div>
      </div>
      ${whatsapp ? `<a class="btn block" style="display:block;text-align:center;text-decoration:none;color:inherit;margin-bottom:12px" target="_blank" rel="noopener" href="https://wa.me/55${escapeHtml(whatsapp)}?text=${encodeURIComponent(`Olá! Sobre o meu pedido #${order.public_code}`)}">💬 Falar com a loja no WhatsApp</a>` : ''}
      ${order.status === 'delivered' ? reviewHtml(order) : ''}
      ${['delivered', 'cancelled'].includes(order.status) ? `<button class="btn primary block" data-reorder="${escapeHtml(order.id)}" style="margin-bottom:12px">🔁 Pedir de novo (mesmos itens)</button>` : ''}
      <a class="btn ${['delivered', 'cancelled'].includes(order.status) ? '' : 'primary'} block" style="display:block;text-align:center;text-decoration:none;color:inherit" href="/">Fazer outro pedido</a>
    `;

    if (!['delivered', 'cancelled'].includes(order.status)) {
      pollTimer = setTimeout(() => showOrder(orderId), 20000);
    }

    // Acabou de pedir: oferece o aviso no celular do andamento do pedido.
    if (justPlaced) setTimeout(() => maybeAskOrderPush(orderId), 1200);
  } catch (err) {
    app.innerHTML = `${headerHtml()}<p class="empty">${escapeHtml(err.message)}<br><br><a href="/">Voltar ao cardápio</a></p>`;
  }
}

/* ---------------- Avaliação do pedido ---------------- */

function reviewHtml(order) {
  const done = Array.isArray(order.order_reviews) ? order.order_reviews.length : Boolean(order.order_reviews);

  if (done || state.reviewSent === order.id) {
    return '<div class="card review-box"><strong>💛 Obrigado pela avaliação!</strong></div>';
  }

  const rating = state.reviewRating || 0;

  return `
    <div class="card review-box" id="review-box">
      <strong>Como foi seu pedido?</strong>
      <div class="stars">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-rate="${n}" class="${n <= rating ? 'on' : ''}" aria-label="${n} estrela(s)">★</button>`).join('')}</div>
      <textarea id="review-comment" rows="2" maxlength="500" placeholder="Quer contar algo? (opcional)"></textarea>
      <button type="button" class="btn primary block" data-send-review="${escapeHtml(order.id)}" ${rating ? '' : 'disabled'}>Enviar avaliação</button>
    </div>`;
}

async function sendReview(orderId, button) {
  button.disabled = true;

  try {
    await api(`/api/orders/${orderId}/review`, {
      method: 'POST',
      body: JSON.stringify({ rating: state.reviewRating, comment: document.getElementById('review-comment')?.value || '' }),
    });
    state.reviewSent = orderId;
    document.getElementById('review-box').outerHTML = '<div class="card review-box"><strong>💛 Obrigado pela avaliação!</strong></div>';
  } catch (err) {
    toast(err.message, true);
    button.disabled = false;
  }
}

/* ---------------- Início ---------------- */

async function start() {
  try {
    const data = await api('/api/menu');
    state.store = data.store;
    setMenuProducts(data.products);
    state.today = data.today || null;
    state.timeOffset = data.server_time ? new Date(data.server_time).getTime() - Date.now() : 0;
    state.pushKey = data.push_public_key || null;
    loadedVersion = loadedVersion || data.app_version;
    cleanCart();
  } catch (err) {
    app.innerHTML = `<p class="empty">${escapeHtml(err.message)}<br><br><button class="btn" onclick="location.reload()">Tentar de novo</button></p>`;
    return;
  }

  const orderId = new URLSearchParams(location.search).get('pedido');

  loadInsights();
  loadRecommendations();
  if (!loadAccount()) restoreCustomerSession();

  if (orderId) {
    showOrder(orderId);
  } else {
    renderMenu();
    // Pop-up "fique por dentro das promoções" (alguns segundos depois de abrir o cardápio).
    setTimeout(maybeAskPromos, 6000);

    if (new URLSearchParams(location.search).get('carrinho')) {
      history.replaceState(null, '', '/');
      if (cartCount()) openCart();

      const missing = sessionStorage.getItem(storeKey('reorder-missing'));
      if (missing) {
        sessionStorage.removeItem(storeKey('reorder-missing'));
        toast(`Não disponível agora: ${missing}`, true);
      } else if (cartCount()) {
        toast('Itens do pedido anterior no carrinho 🛒');
      }
    }
  }
}

/* ---------------- Atualização automática ---------------- */

// Versão do site que esta página carregou. Quando publicamos uma versão nova,
// a página se recarrega sozinha (o carrinho fica guardado); enquanto o cliente
// está com o carrinho/checkout aberto, só os dados (preços, horário, bairros) são atualizados.
let loadedVersion = null;
let lastCheck = Date.now();

async function checkForUpdate() {
  lastCheck = Date.now();

  try {
    const data = await api('/api/menu');
    const busy = document.getElementById('sheet') || document.activeElement?.id === 'search';

    if (loadedVersion && data.app_version && data.app_version !== loadedVersion && !busy) {
      location.reload();
      return;
    }

    state.store = data.store;
    setMenuProducts(data.products);
    state.today = data.today || state.today;
    if (data.server_time) state.timeOffset = new Date(data.server_time).getTime() - Date.now();
    cleanCart();

    // No cardápio (e sem ninguém digitando), redesenha para mostrar horário e preços atuais.
    if (!busy && document.getElementById('menu-body')) {
      app.innerHTML = '';
      renderMenu();
    }
  } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastCheck > 30000) checkForUpdate();
});

setInterval(() => {
  if (document.visibilityState === 'visible') checkForUpdate();
}, 3 * 60 * 1000);

window.addEventListener('popstate', () => {
  clearTimeout(pollTimer);
  start();
});

start();
