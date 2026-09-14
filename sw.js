const CACHE_NAME = 'monitoramento-prf-v26';
const TILE_CACHE = 'monitoramento-prf-tiles-v1';
const SHELL_FILES = ['/', '/manifest.json', '/icon.svg', '/app.js?v=30', '/db.js?v=30', '/supabase-client.js?v=30', '/especies.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  // Sem skipWaiting(): o SW novo fica esperando (comportamento padrão) até todas as abas do app
  // fecharem, em vez de assumir na hora. Assumir imediatamente trocaria a versão do app debaixo de
  // quem está no meio de um lançamento de ponto em campo — justamente o "hot update" que não queremos.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME && n !== TILE_CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Chamadas ao Supabase: sempre buscar na rede — nunca servir dado desatualizado do cache
  if (url.hostname.endsWith('.supabase.co')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Tiles do mapa (OpenStreetMap): cache primeiro — depois de ver uma área com sinal uma vez,
  // ela continua disponível offline em campo (o objetivo do KML + mapa é justamente esse).
  if (url.hostname.endsWith('.tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            cache.put(event.request, response.clone());
            return response;
          }).catch(() => cached);
        })
      )
    );
    return;
  }

  // Shell do app: rede primeiro, cache como reserva offline
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
