'use strict';
// App "Ponto X - Delivery": abre só o painel (/admin) da Ponto X, em janela maximizada, com impressão direta
// na impressora padrão do Windows. Não há PDV nem Servidor nesta loja.
const TELAS = {
  delivery: { path: '/admin', title: 'Ponto X - Delivery', kiosk: false, silentPrint: true },
};

const DEFAULT_BASE = 'https://pontox.sistemaultrion.com.br';

// Endereço base da loja: PONTOX_BASE (variável) > "base" da configuração > padrão.
function resolveTela(_argv, config = {}, env = {}) {
  const def = TELAS.delivery;
  const base = safeOrigin(env.PONTOX_BASE || config.base) || DEFAULT_BASE;
  const url = `${base}${def.path}`;

  return {
    tela: 'delivery',
    url,
    origin: new URL(url).origin,
    title: def.title,
    kiosk: def.kiosk,
    silentPrint: def.silentPrint,
  };
}

function safeOrigin(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

module.exports = { TELAS, DEFAULT_BASE, resolveTela };
