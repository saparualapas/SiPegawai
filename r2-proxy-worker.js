// ============================================================
//  SiPegawai — Cloudflare Worker (r2-proxy via S3 API) — FIXED
//
//  Environment variables (Worker Settings → Variables):
//  R2_ACCOUNT_ID  = Account ID pemilik bucket R2  [Plaintext]
//  R2_ACCESS_KEY  = R2 Access Key ID              [Plaintext]
//  R2_SECRET_KEY  = R2 Secret Access Key          [Secret]
//  R2_BUCKET      = Nama bucket                   [Plaintext]
//  SUPABASE_URL   = https://xxxx.supabase.co      [Plaintext]
//  SUPABASE_KEY   = anon key                      [Secret]
//  ALLOWED_ORIGIN = https://sipegawai.pages.dev   [Plaintext]
// ============================================================

const STORAGE_LIMIT = 8 * 1024 * 1024 * 1024; // 8 GB

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGIN || '').trim().replace(/\/$/, '');
    const origin  = (request.headers.get('Origin') || '').trim().replace(/\/$/, '');
    const corsOrigin = (allowed === origin || !allowed) ? origin : allowed;

    const cors = {
      'Access-Control-Allow-Origin':  corsOrigin || '*',
      'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Size',
      'Access-Control-Max-Age':       '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url  = new URL(request.url);
    const path = url.pathname;

    // Auth
    const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return jres({ error: 'Unauthorized: token tidak ada' }, 401, cors);

    const uRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` },
    });
    if (!uRes.ok) return jres({ error: 'Unauthorized: token tidak valid' }, 401, cors);
    const user = await uRes.json();
    const uid  = user?.id;
    if (!uid) return jres({ error: 'Unauthorized' }, 401, cors);

    const pRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${uid}&select=role`,
      { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}` } }
    );
    const pData = pRes.ok ? await pRes.json() : [];
    const admin = pData?.[0]?.role === 'admin';

    // PUT /upload/:key
    if (request.method === 'PUT' && path.startsWith('/upload/')) {
      const key = decodeURIComponent(path.slice(8));

      if (!admin && !key.startsWith(uid + '/'))
        return jres({ error: 'Forbidden' }, 403, cors);

      let bodyBuffer;
      try { bodyBuffer = await request.arrayBuffer(); }
      catch (e) { return jres({ error: 'Gagal baca body: ' + e.message }, 400, cors); }

      if (!bodyBuffer || bodyBuffer.byteLength === 0)
        return jres({ error: 'File kosong' }, 400, cors);

      const stor = await cekStorage(env, token, bodyBuffer.byteLength);
      if (!stor.ok) return jres({ error: stor.msg, usedBytes: stor.used, limitBytes: STORAGE_LIMIT }, 413, cors);

      const ct     = request.headers.get('Content-Type') || 'application/octet-stream';
      const s3url  = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
      const hdrs   = await signS3('PUT', s3url, bodyBuffer, ct, env);
      const r2Res  = await fetch(s3url, { method: 'PUT', headers: hdrs, body: bodyBuffer });

      if (!r2Res.ok) {
        const t = await r2Res.text().catch(() => '');
        return jres({ error: `R2 upload gagal (${r2Res.status}): ${t.slice(0,300)}` }, 502, cors);
      }
      return jres({ ok: true, r2Key: key, size: bodyBuffer.byteLength }, 200, cors);
    }

    // GET /file/:key
    if (request.method === 'GET' && path.startsWith('/file/')) {
      const key = decodeURIComponent(path.slice(6));
      if (!admin && !key.startsWith(uid + '/')) return jres({ error: 'Forbidden' }, 403, cors);

      const s3url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
      const hdrs  = await signS3('GET', s3url, null, '', env);
      const r2Res = await fetch(s3url, { method: 'GET', headers: hdrs });

      if (!r2Res.ok) return jres({ error: 'File tidak ditemukan' }, 404, cors);

      const rh = new Headers(cors);
      rh.set('Content-Type', r2Res.headers.get('Content-Type') || 'application/octet-stream');
      const cl = r2Res.headers.get('Content-Length');
      if (cl) rh.set('Content-Length', cl);
      rh.set('Cache-Control', 'private, max-age=3600');
      const rawName = key.split('/').pop() || 'file';
      const namePart = rawName.replace(/^\d+_/, '');
      rh.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(namePart)}`);
      return new Response(r2Res.body, { status: 200, headers: rh });
    }

    // DELETE /file/:key
    if (request.method === 'DELETE' && path.startsWith('/file/')) {
      const key = decodeURIComponent(path.slice(6));
      if (!admin && !key.startsWith(uid + '/')) return jres({ error: 'Forbidden' }, 403, cors);

      const s3url = `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${env.R2_BUCKET}/${key}`;
      const hdrs  = await signS3('DELETE', s3url, null, '', env);
      const r2Res = await fetch(s3url, { method: 'DELETE', headers: hdrs });

      if (!r2Res.ok && r2Res.status !== 204 && r2Res.status !== 404) {
        const t = await r2Res.text().catch(() => '');
        return jres({ error: `Hapus gagal (${r2Res.status}): ${t.slice(0,200)}` }, 502, cors);
      }
      return jres({ ok: true }, 200, cors);
    }

    // GET /storage (admin)
    if (request.method === 'GET' && path === '/storage') {
      if (!admin) return jres({ error: 'Hanya admin' }, 403, cors);
      const info = await cekStorage(env, token, 0);
      return jres({
        used: info.used, limit: STORAGE_LIMIT,
        available: STORAGE_LIMIT - info.used,
        percent: +((info.used / STORAGE_LIMIT) * 100).toFixed(2),
        usedFormatted: fmt(info.used), limitFormatted: fmt(STORAGE_LIMIT),
      }, 200, cors);
    }

    // GET /health
    if (path === '/health') return jres({ ok: true, ts: new Date().toISOString() }, 200, cors);

    return jres({ error: 'Route tidak ditemukan: ' + path }, 404, cors);
  },
};

async function cekStorage(env, token, incoming) {
  let total = 0, from = 0;
  while (true) {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1/dokumen?select=ukuran_file`, {
      headers: {
        apikey: env.SUPABASE_KEY, Authorization: `Bearer ${token}`,
        Range: `${from}-${from + 999}`, 'Range-Unit': 'items',
      },
    });
    if (!r.ok) break;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    rows.forEach(d => { total += d.ukuran_file || 0; });
    if (rows.length < 1000) break;
    from += 1000;
  }
  if (total + incoming > STORAGE_LIMIT) {
    const sisa = STORAGE_LIMIT - total;
    return { ok: false, used: total,
      msg: sisa <= 0
        ? `Penyimpanan penuh (${fmt(total)} / ${fmt(STORAGE_LIMIT)}).`
        : `Sisa ${fmt(sisa)} tidak cukup untuk ${fmt(incoming)}.` };
  }
  return { ok: true, used: total };
}

async function signS3(method, urlStr, body, contentType, env) {
  const u   = new URL(urlStr);
  const now = new Date();
  const ds  = now.toISOString().slice(0,10).replace(/-/g,'');
  const dts = now.toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z';

  // Hash body — empty hash untuk GET/DELETE
  const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  let bodyHash;
  if (!body || body.byteLength === 0 || body === '') {
    bodyHash = EMPTY_HASH;
  } else {
    bodyHash = await sha256hex(body instanceof ArrayBuffer ? body : new TextEncoder().encode(body));
  }

  // Build canonical headers — harus alphabetis, lowercase key
  const hmap = {
    'host':                  u.host,
    'x-amz-content-sha256': bodyHash,
    'x-amz-date':           dts,
  };
  // Tambahkan content-type hanya untuk PUT
  if (contentType && method === 'PUT') hmap['content-type'] = contentType;

  const sortedKeys    = Object.keys(hmap).sort();
  const canonHeaders  = sortedKeys.map(k => `${k}:${hmap[k]}`).join('\n') + '\n';
  const signedHeaders = sortedKeys.join(';');

  const canonReq = [method, u.pathname, '', canonHeaders, signedHeaders, bodyHash].join('\n');
  const scope    = `${ds}/auto/s3/aws4_request`;
  const sts      = ['AWS4-HMAC-SHA256', dts, scope, await sha256hex(canonReq)].join('\n');

  let sk = await hmacB(`AWS4${env.R2_SECRET_KEY}`, ds);
  sk = await hmacB(sk, 'auto');
  sk = await hmacB(sk, 's3');
  sk = await hmacB(sk, 'aws4_request');
  const sig = hex(await hmacB(sk, sts));

  return {
    ...hmap,
    Authorization: `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  };
}

async function sha256hex(data) {
  const b = data instanceof ArrayBuffer ? data
    : typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', b)));
}
async function hmacB(key, data) {
  const kb = key instanceof Uint8Array ? key : new TextEncoder().encode(key);
  const ck = await crypto.subtle.importKey('raw', kb, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const db = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign('HMAC', ck, db));
}
function hex(arr) { return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join(''); }
function fmt(b) {
  if (b < 1024)       return b + ' B';
  if (b < 1048576)    return (b/1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b/1048576).toFixed(2) + ' MB';
  return (b/1073741824).toFixed(2) + ' GB';
}
function jres(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}
