'use strict';

const CACHE_NAME = 'sipegawai-v2';
const CDN_HOSTS  = ['cdnjs.cloudflare.com','fonts.googleapis.com','fonts.gstatic.com','cdn.jsdelivr.net'];

// Asset CDN yang di-cache saat install (statis, jarang berubah)
const PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/bootstrap/5.3.2/css/bootstrap.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css',
];

// ── Halaman offline (ditampilkan saat tidak ada koneksi) ──────────────────────
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>SiPegawai — Offline</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#0a2342;min-height:100vh;display:flex;align-items:center;
         justify-content:center;padding:1.5rem}
    .card{background:#fff;border-radius:20px;padding:2.5rem 2rem;max-width:380px;
          width:100%;text-align:center;box-shadow:0 25px 60px rgba(0,0,0,.3)}
    .icon{font-size:3.5rem;margin-bottom:1.25rem;display:block}
    .title{font-size:1.4rem;font-weight:800;color:#0a2342;margin-bottom:.6rem}
    .desc{font-size:.875rem;color:#6b7280;line-height:1.65;margin-bottom:1.5rem}
    .btn{display:inline-flex;align-items:center;gap:.5rem;background:#0a2342;
         color:#fff;border:none;border-radius:12px;padding:.85rem 1.75rem;
         font-size:.9rem;font-weight:700;cursor:pointer;transition:opacity .2s}
    .btn:hover{opacity:.85}
    .tip{background:#f0fdf4;border:1px solid #86efac;border-radius:8px;
         padding:.75rem 1rem;font-size:.77rem;color:#166534;margin-top:1rem;
         text-align:left;line-height:1.6}
  </style>
</head>
<body>
  <div class="card">
    <span class="icon">📡</span>
    <div class="title">Tidak Ada Koneksi</div>
    <div class="desc">
      SiPegawai memerlukan internet untuk mengakses data kepegawaian.
      Pastikan perangkat terhubung ke jaringan WiFi atau data seluler, lalu coba lagi.
    </div>
    <button class="btn" onclick="window.location.reload()">↻ Coba Lagi</button>
    <div class="tip">
      <strong>💡 Tips:</strong> Pastikan WiFi Lapas aktif dan perangkat berada
      dalam jangkauan sinyal yang cukup.
    </div>
  </div>
</body>
</html>`;

// ── Install: cache asset CDN statis ──────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: hapus cache lama ───────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: strategi per tipe request ─────────────────────────────────────────
self.addEventListener('fetch', e => {
  // Hanya handle GET
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // Abaikan: Supabase realtime WebSocket
  if (url.pathname.includes('/realtime/')) return;

  // Abaikan: request ke API sensitif (Supabase, R2 Worker, Google APIs)
  // Data ini tidak boleh di-cache karena sensitif & harus selalu fresh
  const isAPI = url.hostname.includes('supabase.co')
             || url.hostname.includes('workers.dev')
             || url.hostname.includes('googleapis.com');
  if (isAPI) return;

  // CDN assets → Cache First (stabil, jarang berubah)
  const isCDN = CDN_HOSTS.some(d => url.hostname.includes(d));
  if (isCDN) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          }
          return res;
        }).catch(() => cached || new Response('', { status: 503 }));
      })
    );
    return;
  }

  // Halaman utama (sipegawai.pages.dev) → Network First, fallback offline page
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        })
      )
    );
  }
});
