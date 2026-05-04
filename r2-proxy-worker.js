// ============================================================
//  SiPegawai — Cloudflare Worker (r2-proxy via S3 API)
//  Bisa akses R2 bucket di akun Cloudflare BERBEDA
//
//  Environment variables di Worker Settings:
//  R2_ACCOUNT_ID  = Account ID pemilik bucket R2
//  R2_ACCESS_KEY  = R2 Access Key ID
//  R2_SECRET_KEY  = R2 Secret Access Key  (pakai wrangler secret)
//  R2_BUCKET      = Nama bucket
//  SUPABASE_URL   = https://xxxx.supabase.co
//  SUPABASE_KEY   = anon key  (pakai wrangler secret)
//  ALLOWED_ORIGIN = https://sipegawai.saparualapas.workers.dev
// ============================================================

const STORAGE_LIMIT = 8 * 1024 * 1024 * 1024; // 8 GB

export default {
  async fetch(request, env) {
    const allowed = env.ALLOWED_ORIGIN || 'https://sipegawai.saparualapas.workers.dev';
    const cors = {
      'Access-Control-Allow-Origin':  allowed,
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Content-Length',
      'Access-Control-Max-Age':       '86400',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url  = new URL(request.url);
    const path = url.pathname;

    // ── Auth: validasi JWT Supabase ───────────────────────
    const token = (request.headers.get('Authorization') || '').replace('Bearer ', '').trim();
    if (!token) return jres({ error: 'Unauthorized: token tidak ada' }, 401, cors);

    const uRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` }
    });
    if (!uRes.ok) return jres({ error: 'Unauthorized: token tidak valid' }, 401, cors);
    const user = await uRes.json();
    const uid  = user?.id;
    if (!uid) return jres({ error: 'Unauthorized' }, 401, cors);

    // Cek role dari profiles
    const pRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=role`,
      { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` } }
    );
    const pData = pRes.ok ? await pRes.json() : [];
    const admin = pData?.[0]?.role === 'admin';

    // ── PUT /upload/:r2key ────────────────────────────────
    if (request.method === 'PUT' && path.startsWith('/upload/')) {
      const key = decodeURIComponent(path.slice(8)); // hapus /upload/
      if (!key.startsWith(uid + '/') && !admin)
        return jres({ error: 'Forbidden: hanya bisa upload ke folder sendiri' }, 403, cors);

      const fileSize = parseInt(request.headers.get('Content-Length') || '0');
      const stor = await cekStorage(env, token, fileSize);
      if (!stor.ok) return jres({ error: stor.msg, usedBytes: stor.used, limitBytes: STORAGE_LIMIT }, 413, cors);

      const ct   = request.headers.get('Content-Type') || 'application/octet-stream';
      const body = await request.arrayBuffer();
      const s3u  = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
      const hdrs = await signS3('PUT', s3u, body, ct, env);

      const r = await fetch(s3u, { method: 'PUT', headers: hdrs, body });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return jres({ error: `R2 upload gagal (${r.status}): ${t.slice(0,300)}` }, 502, cors);
      }
      return jres({ ok: true, r2Key: key, size: body.byteLength }, 200, cors);
    }

    // ── GET /file/:r2key ─────────────────────────────────
    if (request.method === 'GET' && path.startsWith('/file/')) {
      const key = decodeURIComponent(path.slice(6));
      if (!key.startsWith(uid + '/') && !admin)
        return jres({ error: 'Forbidden' }, 403, cors);

      const s3u  = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
      const hdrs = await signS3('GET', s3u, '', '', env);
      const r    = await fetch(s3u, { method: 'GET', headers: hdrs });
      if (!r.ok) return jres({ error: 'File tidak ditemukan' }, 404, cors);

      const rh = new Headers(cors);
      rh.set('Content-Type', r.headers.get('Content-Type') || 'application/octet-stream');
      const cl = r.headers.get('Content-Length');
      if (cl) rh.set('Content-Length', cl);
      rh.set('Cache-Control', 'private, max-age=3600');
      rh.set('Content-Disposition', `inline; filename="${key.split('/').pop()}"`);
      return new Response(r.body, { status: 200, headers: rh });
    }

    // ── DELETE /file/:r2key ──────────────────────────────
    if (request.method === 'DELETE' && path.startsWith('/file/')) {
      const key = decodeURIComponent(path.slice(6));
      if (!key.startsWith(uid + '/') && !admin)
        return jres({ error: 'Forbidden' }, 403, cors);

      const s3u  = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
      const hdrs = await signS3('DELETE', s3u, '', '', env);
      const r    = await fetch(s3u, { method: 'DELETE', headers: hdrs });
      if (!r.ok && r.status !== 204) {
        const t = await r.text().catch(() => '');
        return jres({ error: `Hapus gagal (${r.status}): ${t.slice(0,200)}` }, 502, cors);
      }
      return jres({ ok: true }, 200, cors);
    }

    // ── GET /storage (admin only) ────────────────────────
    if (request.method === 'GET' && path === '/storage') {
      if (!admin) return jres({ error: 'Hanya admin' }, 403, cors);
      const info = await cekStorage(env, token, 0);
      return jres({
        used: info.used, limit: STORAGE_LIMIT,
        available: STORAGE_LIMIT - info.used,
        percent: +((info.used / STORAGE_LIMIT) * 100).toFixed(2),
      }, 200, cors);
    }

    return jres({ error: 'Route tidak ditemukan' }, 404, cors);
  }
};

// ── Hitung storage dari Supabase DB (paginasi) ───────────────
async function cekStorage(env, token, incoming) {
  let total = 0, from = 0, done = false;
  while (!done) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/dokumen?select=ukuran_file`, {
      headers: {
        apikey: env.SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        Range: `${from}-${from + 999}`,
        'Range-Unit': 'items',
      }
    });
    if (!r.ok) break;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) { done = true; break; }
    rows.forEach(d => { total += d.ukuran_file || 0; });
    if (rows.length < 1000) done = true; else from += 1000;
  }
  if (total + incoming > STORAGE_LIMIT) {
    const sisa = STORAGE_LIMIT - total;
    return { ok: false, used: total,
      msg: sisa <= 0
        ? `Penyimpanan penuh (${fmt(total)} / 8 GB). Tidak bisa upload.`
        : `Sisa ruang ${fmt(sisa)} tidak cukup untuk file ${fmt(incoming)}.`
    };
  }
  return { ok: true, used: total };
}

// ── AWS Signature V4 ─────────────────────────────────────────
async function signS3(method, url, body, ct, env) {
  const u    = new URL(url);
  const now  = new Date();
  const ds   = now.toISOString().slice(0,10).replace(/-/g,'');
  const dts  = now.toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z';

  const bodyBuf  = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  const bodyHash = await sha256hex(bodyBuf);

  const hdrs = {
    host: u.host,
    'x-amz-date': dts,
    'x-amz-content-sha256': bodyHash,
    ...(ct ? { 'content-type': ct } : {}),
  };

  const sortedK  = Object.keys(hdrs).sort();
  const canHdrs  = sortedK.map(k => `${k}:${hdrs[k]}`).join('\n') + '\n';
  const signedH  = sortedK.join(';');
  const canReq   = [method, u.pathname, '', canHdrs, signedH, bodyHash].join('\n');
  const scope    = `${ds}/auto/s3/aws4_request`;
  const sts      = `AWS4-HMAC-SHA256\n${dts}\n${scope}\n${await sha256hex(canReq)}`;

  let sk = await hmac(`AWS4${env.R2_SECRET_KEY}`, ds);
  sk = await hmac(sk, 'auto');
  sk = await hmac(sk, 's3');
  sk = await hmac(sk, 'aws4_request');
  const sig = hex(await hmac(sk, sts));

  return {
    ...hdrs,
    Authorization: `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY}/${scope}, SignedHeaders=${signedH}, Signature=${sig}`,
  };
}

async function sha256hex(d) {
  const b = typeof d === 'string' ? new TextEncoder().encode(d) : d;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', b)));
}
async function hmac(key, data) {
  const k  = key instanceof Uint8Array ? key : new TextEncoder().encode(key);
  const ck = await crypto.subtle.importKey('raw', k, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(data)));
}
function hex(arr) { return Array.from(arr).map(b=>b.toString(16).padStart(2,'0')).join(''); }
function fmt(b) {
  if (b<1024) return b+' B';
  if (b<1048576) return (b/1024).toFixed(1)+' KB';
  if (b<1073741824) return (b/1048576).toFixed(1)+' MB';
  return (b/1073741824).toFixed(2)+' GB';
}
function jres(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...headers }
  });
}
