// Service worker do app do garçom: guarda os arquivos do app para ele abrir na hora, mesmo sem
// sinal. As chamadas ao PC (/api) nunca passam pelo cache.
// Ao mudar qualquer arquivo do app, troque a VERSAO: o navegador baixa a nova e apaga a antiga.
const VERSAO = "garcom-2026-10-30.1";
const ARQUIVOS = [
  "./", "index.html", "app.css", "app.js", "rede.js", "cripto.js", "banco.js", "manifest.webmanifest",
  "icone-192.png", "icone-512.png", "icone-apple.png", "fontes/bricolage-500.woff2", "fontes/bricolage-700.woff2",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSAO).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((nomes) => Promise.all(nomes.filter((n) => n.startsWith("garcom-") && n !== VERSAO).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;
  if (e.request.mode === "navigate") {
    // Abre do cache na hora; se houver rede, a próxima abertura já pega a versão nova (VERSAO).
    e.respondWith(caches.match("index.html").then((r) => r ?? fetch(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r ?? fetch(e.request)));
});
