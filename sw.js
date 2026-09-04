/* ============================================================================
   ASL Consultoria.IA — service worker

   Estratégia: NETWORK-FIRST. Sempre tenta a rede primeiro, para você nunca
   ficar preso numa versão antiga do sistema depois de um deploy na Vercel.
   O cache só entra em cena quando o celular está sem internet.

   Ao publicar uma mudança, troque o número do CACHE abaixo (v3 → v4).
   Isso apaga o cache antigo de todo mundo no próximo acesso.
   ============================================================================ */

const CACHE = "asl-v4";

const SHELL = [
  "/",
  "/index.html",
  "/app.html",
  "/app.js",
  "/opera-db.js",
  "/config.js",
  "/vendor/supabase.js",
  "/bg-gate.jpg",
  "/logo-mark.png",
  "/logo-mark-light.png",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;

  // Só cuidamos de navegação e dos arquivos do próprio site.
  // Chamadas ao Supabase passam direto, sem cache nenhum.
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        // offline dentro do sistema volta para o app, não para a landing
        caches.match(req).then((hit) => hit || caches.match("/app.html"))
      )
  );
});
