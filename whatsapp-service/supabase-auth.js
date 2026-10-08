// Sessões do WhatsApp isoladas por loja na tabela wa_auth.
// A migration de schema ainda não foi aplicada: os IDs são namespaced por store_id
// para impedir que uma sessão legada/global seja reutilizada por outra loja.

import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import { db } from './supabase.js';

const encode = value => JSON.stringify(value, BufferJSON.replacer);
const decode = text => JSON.parse(text, BufferJSON.reviver);
const storageId = (storeId, id) => `store:${String(storeId)}:${id}`;

function requireStoreId(storeId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(storeId || ''))) throw new Error('store_id inválido.');
  return String(storeId);
}

async function readKeys(storeId, ids) {
  const scoped = requireStoreId(storeId);
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).map(id => storageId(scoped, id));
    const list = chunk.map(id => `"${id.replace(/"/g, '\\"')}"`).join(',');
    const rows = await db(`wa_auth?select=id,data&id=in.(${encodeURIComponent(list)})`);
    for (const row of rows) {
      const prefix = `store:${scoped}:`;
      if (typeof row.id === 'string' && row.id.startsWith(prefix)) {
        out.set(row.id.slice(prefix.length), row.data);
      }
    }
  }
  return out;
}

async function writeKeys(storeId, entries) {
  const scoped = requireStoreId(storeId);
  const now = new Date().toISOString();
  for (let i = 0; i < entries.length; i += 100) {
    await db('wa_auth?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(entries.slice(i, i + 100).map(([id, data]) => ({ id: storageId(scoped, id), data, updated_at: now }))),
    });
  }
}

async function deleteKeys(storeId, ids) {
  const scoped = requireStoreId(storeId);
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).map(id => storageId(scoped, id));
    const list = chunk.map(id => `"${id.replace(/"/g, '\\"')}"`).join(',');
    await db(`wa_auth?id=in.(${encodeURIComponent(list)})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  }
}

export async function useSupabaseAuthState(storeId) {
  const scoped = requireStoreId(storeId);
  const [credsRow] = await db(`wa_auth?select=data&id=eq.${encodeURIComponent(storageId(scoped, 'creds'))}`);
  const creds = credsRow ? decode(credsRow.data) : initAuthCreds();
  const state = {
    creds,
    keys: {
      async get(type, ids) {
        const found = await readKeys(scoped, ids.map(id => `${type}:${id}`));
        const data = {};
        for (const id of ids) {
          const raw = found.get(`${type}:${id}`);
          if (!raw) continue;
          let value = decode(raw);
          if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
          data[id] = value;
        }
        return data;
      },
      async set(data) {
        const upserts = [];
        const removals = [];
        for (const type of Object.keys(data)) {
          for (const id of Object.keys(data[type])) {
            const value = data[type][id];
            if (value) upserts.push([`${type}:${id}`, encode(value)]);
            else removals.push(`${type}:${id}`);
          }
        }
        if (upserts.length) await writeKeys(scoped, upserts);
        if (removals.length) await deleteKeys(scoped, removals);
      },
    },
  };
  return { state, saveCreds: () => writeKeys(scoped, [['creds', encode(state.creds)]]) };
}

export async function hasSupabaseAuthState(storeId) {
  const scoped = requireStoreId(storeId);
  const [row] = await db(`wa_auth?select=data&id=eq.${encodeURIComponent(storageId(scoped, 'creds'))}`);
  if (!row) return false;
  return Boolean(decode(row.data).me?.id);
}

export async function clearSupabaseAuthState(storeId) {
  const scoped = requireStoreId(storeId);
  await db(`wa_auth?id=like.${encodeURIComponent(`store:${scoped}:%`)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}
