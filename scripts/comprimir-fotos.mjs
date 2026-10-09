// Comprime as fotos do bucket product-photos (reduz o Cached Egress do Supabase).
//
//   node scripts/comprimir-fotos.mjs            -> simulação: só mede a economia, não altera nada
//   node scripts/comprimir-fotos.mjs --aplicar  -> envia a foto leve, troca image_url e apaga a antiga
//
// A simulação não precisa de chave (lê o /api/menu público). O modo --aplicar precisa das variáveis
// de ambiente SUPABASE_URL e SUPABASE_SECRET_KEY (a chave NUNCA é gravada em arquivo nem no Git).
import { createRequire } from 'node:module';

const require = createRequire(new URL('../whatsapp-service/package.json', import.meta.url));
const sharp = require('sharp');

const APPLY = process.argv.includes('--aplicar');
const SITE = process.env.SITE_URL || 'https://pontox.sistemaultrion.com.br';
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://qknjjsdblasejgpbowjs.supabase.co').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY;
const BUCKET = 'product-photos';
const PUBLIC_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;
const MAX_SIDE = 800;
const QUALITY = 78;
const SKIP_UNDER = 70 * 1024; // já é leve: não mexe

if (APPLY && !KEY) {
  console.error('Defina SUPABASE_SECRET_KEY no terminal antes de usar --aplicar.');
  process.exit(1);
}

const headers = KEY ? { apikey: KEY, Authorization: `Bearer ${KEY}` } : {};
const fmt = n => `${(n / 1024).toFixed(0)} KB`;

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers, 'Content-Type': 'application/json', ...init.headers } });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// Lista { kind, id, productId, url } de produtos e variações com foto no bucket.
async function listPhotos() {
  const out = [];
  if (APPLY) {
    const products = await rest('products?select=id,image_url&image_url=not.is.null');
    const variants = await rest('product_variants?select=id,product_id,image_url&image_url=not.is.null');
    for (const p of products) out.push({ kind: 'product', id: p.id, productId: p.id, url: p.image_url });
    for (const v of variants) out.push({ kind: 'variant', id: v.id, productId: v.product_id, url: v.image_url });
  } else {
    const { products } = await (await fetch(`${SITE}/api/menu`)).json();
    for (const p of products) {
      out.push({ kind: 'product', id: p.id, productId: p.id, url: p.image_url });
      for (const v of p.variants || []) out.push({ kind: 'variant', id: v.id, productId: p.id, url: v.image_url });
    }
  }
  return out.filter(x => x.url);
}

// A simulação lê o menu publicado; se o site já devolve /api/img/..., volta para a URL do bucket.
const toBucketUrl = url => (url.startsWith('/api/img/') ? PUBLIC_PREFIX + url.slice('/api/img/'.length) : url);

let before = 0;
let after = 0;
let done = 0;
let skipped = 0;
let failed = 0;
const seen = new Set();

for (const item of await listPhotos()) {
  const url = toBucketUrl(item.url);
  if (!url.startsWith(PUBLIC_PREFIX) || seen.has(url)) continue;
  seen.add(url);
  const oldPath = url.slice(PUBLIC_PREFIX.length);

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const original = Buffer.from(await res.arrayBuffer());

    if (original.length <= SKIP_UNDER) { skipped++; before += original.length; after += original.length; continue; }

    const webp = await sharp(original).rotate().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: QUALITY }).toBuffer();

    if (webp.length >= original.length) { skipped++; before += original.length; after += original.length; continue; }

    before += original.length;
    after += webp.length;
    console.log(`${oldPath}  ${fmt(original.length)} -> ${fmt(webp.length)}`);

    if (!APPLY) { done++; continue; }

    const newPath = item.kind === 'variant' ? `${item.productId}/v-${item.id}-${Date.now()}.webp` : `${item.productId}/${Date.now()}.webp`;
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${newPath}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'image/webp', 'Cache-Control': 'max-age=31536000' },
      body: webp,
    });
    if (!up.ok) throw new Error(`upload ${up.status} ${await up.text()}`);

    const table = item.kind === 'variant' ? 'product_variants' : 'products';
    await rest(`${table}?id=eq.${item.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ image_url: PUBLIC_PREFIX + newPath }) });

    // Só apaga a antiga depois de a nova estar enviada e gravada no banco.
    // (Se a mesma foto servia a mais de um registro, os demais ficam com a URL antiga; é tratado na próxima execução.)
    const stillUsed = await rest(`products?select=id&image_url=eq.${encodeURIComponent(url)}&limit=1`);
    const stillUsedV = await rest(`product_variants?select=id&image_url=eq.${encodeURIComponent(url)}&limit=1`);
    if (!stillUsed.length && !stillUsedV.length) {
      await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${oldPath}`, { method: 'DELETE', headers });
    }
    done++;
  } catch (err) {
    failed++;
    console.error(`FALHOU ${oldPath}: ${err.message}`);
  }
}

console.log(`\n${APPLY ? 'Aplicado' : 'Simulação'}: ${done} fotos comprimidas, ${skipped} já leves/ignoradas, ${failed} falhas.`);
console.log(`Total: ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(1)} MB`);
