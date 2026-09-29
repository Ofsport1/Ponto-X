// Service worker do delivery: recebe os avisos de pedido novo (painel) e permite
// instalar o cardápio e o painel como aplicativo. Não guarda cache: tudo vem sempre
// atualizado da internet.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// Necessário para o navegador oferecer "instalar app"; só repassa para a rede.
self.addEventListener('fetch', () => {});

self.addEventListener('push', event => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch {}

  event.waitUntil(
    self.registration.showNotification(data.title || 'Novo aviso', {
      body: data.body || '',
      icon: 'assets/icon-192.png',
      badge: 'assets/icon-192.png',
      tag: data.tag,
      renotify: true,
      requireInteraction: true,
      vibrate: [300, 150, 300, 150, 300],
      data: { url: data.url || '/admin.html' },
    })
  );
});

// Toque no aviso: aviso da equipe abre (ou traz para frente) o painel; aviso de cliente abre
// a página do pedido (ou o cardápio, nas promoções).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/admin.html', self.location.origin).href;
  const forPanel = url.includes('/admin');

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const open = forPanel ? list.find(c => c.url.includes('/admin')) : list.find(c => c.url === url);

      if (open) return open.focus();

      return self.clients.openWindow(url);
    })
  );
});
