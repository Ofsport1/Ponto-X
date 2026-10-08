// Acesso ao Supabase (REST) com a chave de servidor. Só roda no servidor da Oracle.

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Faltam SUPABASE_URL e SUPABASE_SECRET_KEY no arquivo .env');
  process.exit(1);
}

export async function db(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  const text = await response.text();

  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text.slice(0, 300)}`);

  return text ? JSON.parse(text) : null;
}
