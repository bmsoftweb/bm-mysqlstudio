// Service worker do MySQL Studio (PWA instalável). Não guarda nada em cache: o app depende do banco ao vivo e
// sempre carrega a versão nova. Mesmo modelo do crmWeb.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
