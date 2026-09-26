#!/usr/bin/env node
// DesiDubAnime v2.0.0 — Stremio addon for desidubanime.me
// Hindi/Tamil/Telugu/Bengali DUBBED anime. NETHUB-style stream finding:
// caches + parallel variant search + honest empties + bg re-resolve +
// 11.5s wall + binge prewarm. Abyss player: /info API -> local AES-CTR
// fallback -> browser fallback. Pool fallback for blocked API hops.
// Playback is ALWAYS direct CDN.

'use strict';

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fetch as undiciFetch, Agent } from 'undici';
import { poolStart, poolStats, apiFetch } from './mb-lib/pool.js';

const VERSION = '2.3.0';
const BASE = 'https://www.desidubanime.me';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const IMDB_SUGGEST = 'https://v2.sg.media-imdb.com/suggestion';
const PUBLIC_BASE = process.env.PUBLIC_BASE || 'https://5a16d5684c14-desidubanime-stremio.baby-beamup.club';
const PORT = parseInt(process.env.PORT, 10) || 7000;
const DEBUG = !!process.env.NMDEBUG;
const WALL_MS = 11500;
const DBG = (...a) => { if (DEBUG) console.error('[dd]', ...a); };

let LOGO_BUF = null;
try { LOGO_BUF = fs.readFileSync(new URL('./logo.png', import.meta.url)); } catch { LOGO_BUF = null; }

// ─── cache (TTL + cap, oldest-evicted) ───────────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { cache.delete(key); return null; }
  return e.val;
}
function cachePut(key, val, ttlMs) {
  if (!cache.has(key) && cache.size >= 500) {
    let n = 60;
    for (const k of cache.keys()) { cache.delete(k); if (--n <= 0) break; }
  }
  cache.set(key, { val, exp: Date.now() + ttlMs });
}
const BG = new Set();

// ─── HTTP helpers (direct -> pool fallback; policy: API hops may ride pool,
//     media bytes NEVER do — streams go straight to the user's player) ──────
const AGENT = new Agent({ connect: { timeout: 9000 } });
async function fetchText(url, { timeout = 12000, referer = BASE, pool = false } = {}) {
  const headers = { 'User-Agent': UA, Accept: 'text/html,*/*', Referer: referer };
  const tryOnce = async d => {
    const r = await undiciFetch(url, { headers, dispatcher: AGENT, signal: AbortSignal.timeout(d), redirect: 'follow' });
    if (!r.ok) return null;
    return await r.text();
  };
  let t = await tryOnce(timeout).catch(() => null);
  if (t === null && pool) {
    try {
      const r = await apiFetch(url, { headers, signal: AbortSignal.timeout(timeout) });
      if (r && r.ok) t = await r.text();
    } catch { /* pool cold */ }
  }
  return t;
}
async function fetchJSON(url, { timeout = 10000, referer = BASE, headers = {} } = {}) {
  try {
    const r = await undiciFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', Referer: referer, ...headers }, dispatcher: AGENT, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── meta (Cinemeta + IMDb suggest, cached, parallel) ───────────────────────
const metaCache = new Map();
async function cinemeta(type, id) {
  const ck = `cm:${type}:${id}`;
  const e = metaCache.get(ck);
  if (e && Date.now() - e.at < 12 * 3600e3) return e.m;
  const d = await fetchJSON(`${CINEMETA}/meta/${type}/${id}.json`, { timeout: 9000 }).catch(() => null);
  const m = d?.meta?.name ? { name: d.meta.name, year: String(d.meta.releaseInfo || '').match(/^(\d{4})/)?.[1] || '', aliases: [d.meta.name, ...(d.meta.aliases || [])] } : null;
  metaCache.set(ck, { at: Date.now(), m });
  return m;
}
async function imdbSuggest(id) {
  const ck = `im:${id}`;
  const e = metaCache.get(ck);
  if (e && Date.now() - e.at < 12 * 3600e3) return e.m;
  let m = null;
  try {
    const r = await undiciFetch(`${IMDB_SUGGEST}/${id[0]}/${encodeURIComponent(id)}.json`, { headers: { 'User-Agent': UA }, dispatcher: AGENT, signal: AbortSignal.timeout(6000) });
    if (r.ok) {
      const d = await r.json();
      const hit = (d.d || []).find(x => x.id === id && x.l);
      if (hit) m = { name: hit.l, year: String(hit.y || ''), aliases: [hit.l] };
    }
  } catch { /* noop */ }
  metaCache.set(ck, { at: Date.now(), m });
  return m;
}

// ─── DesiDubAnime search (site search HTML) ─────────────────────────────────
const nz = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
async function searchAnime(query) {
  const ck = `s:${query.toLowerCase()}`;
  const e = cache.get(ck);
  if (e && Date.now() - e.at < (e.good ? 6 * 3600e3 : 120e3)) return e.r;
  let results = [];
  // parallel: (a) WP JSON structured search  (b) Kiranime REST snippet search
  const [wpRaw, kiraRaw] = await Promise.all([
    fetchText(`${BASE}/wp-json/wp/v2/search?search=${encodeURIComponent(query)}&subtype=anime&per_page=20`, { timeout: 12000 }),
    fetchText(`${BASE}/wp-json/kiranime/v1/anime/search?query=${encodeURIComponent(query)}`, { timeout: 12000 }),
  ]);
  const seen = new Set();
  if (wpRaw && wpRaw.trimStart().startsWith('[')) {
    try {
      for (const it of JSON.parse(wpRaw)) {
        const sm = String(it.url || '').match(/\/anime\/([^/"]+)/);
        if (sm && it.title && !seen.has(sm[1])) { seen.add(sm[1]); results.push({ slug: sm[1], title: String(it.title).trim() }); }
      }
    } catch { /* noop */ }
  }
  if (kiraRaw) {
    let snap = kiraRaw;
    if (snap.trimStart().startsWith('{')) { try { snap = JSON.parse(snap).result || ''; } catch { /* keep raw */ } }
    for (const m of snap.matchAll(/href="https:\/\/www\.desidubanime\.me\/anime\/([^"/]+)\/?"/g)) {
      const slug = m[1];
      if (!slug || seen.has(slug)) continue;
      const tail = snap.slice(m.index, m.index + 900);
      const t = (tail.match(/<span[^>]*>([^<]{2,120})<\/span>/) || tail.match(/alt=['"]([^'"]+)['"]/) || [])[1];
      seen.add(slug);
      results.push({ slug, title: (t || slug.replace(/-/g, ' ')).trim() });
    }
  }
  // fallback: WordPress HTML search
  if (!results.length) {
    const html = await fetchText(`${BASE}/?s=${encodeURIComponent(query)}`, { timeout: 13000 });
    if (html) {
      for (const m of html.matchAll(/href="https:\/\/www\.desidubanime\.me\/anime\/([^"/]+)\/?"/gi)) {
        const slug = m[1];
        if (slug && !seen.has(slug)) { seen.add(slug); results.push({ slug, title: slug.replace(/-/g, ' ') }); }
      }
    }
  }
  const good = results.length > 0;
  cachePut(ck, { r: results, good, at: Date.now() }, good ? 6 * 3600e3 : 120e3);
  DBG('search', query, '->', results.length);
  return results;
}
function matchScore(title, want) {
  const t = nz(title), w = nz(want);
  if (!t) return 0;
  if (t === w) return 3;
  if (t.startsWith(w) || w.startsWith(t)) return 2;
  if (t.includes(w) || w.includes(t)) return 1;
  return 0;
}
// serialize searches with small spacing — the site WAF throttles bursts
let searchChain = Promise.resolve();
function spacedSearch(query) {
  const p = searchChain.catch(() => {}).then(() => searchAnime(query));
  searchChain = p.catch(() => {});
  return p;
}
async function findAnime(aliases) {
  const primary = String(aliases[0] || '').trim();
  if (!primary) return { item: null, best: null, score: 0 };
  const names = [primary, ...aliases.slice(1).filter(al => {
    // only keep aliases reasonably similar to the primary name (drop junk)
    const p = nz(primary), az = nz(al);
    return az.length > 3 && (p.includes(az) || az.includes(p));
  })].slice(0, 3);
  let best = null, bs = -1;
  await Promise.all(names.map(async (n, i) => {
    let rows = [];
    if (i === 0) {
      rows = await spacedSearch(n).catch(() => []);
      if (!rows.length) { await new Promise(r => setTimeout(r, 2000)); rows = await spacedSearch(n).catch(() => []); }
    } else rows = await spacedSearch(n).catch(() => []);
    for (const r of rows) {
      const sc = matchScore(r.title, names[0]);
      if (sc > bs) { bs = sc; best = r; }
    }
  }));
  return { item: bs >= 1 ? best : null, best, score: bs, rows: best ? 1 : 0 };
}

// ─── anime page: real watch slugs per episode ───────────────────────────────
async function animeEpisodes(slug) {
  const ck = `eps:${slug}`;
  const e = cache.get(ck);
  if (e && Date.now() - e.at < (e.v.watch.size ? 3600e3 : 3 * 60e3)) return e.v;
  const html = await fetchText(`${BASE}/anime/${slug}/`, { timeout: 13000 });
  const v = { watch: new Map(), total: 0 };   // ep -> watch url
  if (html) {
    const re = /href="https:\/\/www\.desidubanime\.me\/watch\/([^"]+?)-episode-(\d+)\/"/g;
    let m;
    while ((m = re.exec(html))) v.watch.set(Number(m[2]), m[1]);
    v.total = v.watch.size;
  }
  cachePut(ck, { v, at: Date.now() }, 3600e3);
  DBG('episodes', slug, '->', v.total);
  return v;
}

// ─── watch page: embed servers ───────────────────────────────────────────────
async function watchEmbeds(watchSlug, ep) {
  const ck = `w:${watchSlug}:${ep}`;
  const e = cache.get(ck);
  if (e && Date.now() - e.at < 30 * 60e3) return e.v;
  const html = await fetchText(`${BASE}/watch/${watchSlug}-episode-${ep}/`, { timeout: 13000 });
  const embeds = [];
  if (html) {
    const re = /data-embed-id="([^"]+)"/g;
    let m;
    while ((m = re.exec(html))) {
      const [srvB, urlB] = m[1].split(':');
      try {
        const server = Buffer.from(srvB, 'base64').toString('utf8').trim();
        const url = Buffer.from(urlB, 'base64').toString('utf8').trim();
        if (/^https?:\/\//.test(url)) {
          const lang = /(dub|Dub)$/i.test(server) ? 'DUB' : /(sub|Sub)$/i.test(server) ? 'SUB' : 'DUB';
          embeds.push({ server: server.replace(/(dub|sub)$/i, '').trim() || server, url, lang });
        }
      } catch { /* skip */ }
    }
  }
  cachePut(ck, { v: embeds, at: Date.now() }, 30 * 60e3);
  DBG('embeds', watchSlug, ep, '->', embeds.map(x => x.server).join(','));
  return embeds;
}

// ─── HLS re-manifest: expose video variants as explicit quality tracks ──────
async function handleRemanifest(url, res) {
  try {
    const txt = await fetchText(url, { timeout: 10000, referer: BASE });
    if (!txt || !txt.includes('#EXTM3U')) return send(res, 200, txt || '', 'application/vnd.apple.mpegurl');
    if ((txt.match(/#EXT-X-STREAM-INF/g) || []).length <= 1) {
      // single variant → passthrough untouched (multi-audio mapping stays intact)
      return send(res, 200, txt, 'application/vnd.apple.mpegurl');
    }
    const base = new URL(url);
    const lines = txt.split('\n');
    const out = ['#EXTM3U'];
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (L.startsWith('#EXT-X-STREAM-INF')) {
        const attrs = L.replace(/^#EXT-X-STREAM-INF:/, '');
        const uri = (lines[i + 1] || '').trim();
        if (!uri) continue;
        i++;
        const resM = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
        const qual = resM ? `${resM[2]}p` : 'stream';
        out.push(`#EXT-X-STREAM-INF:${attrs},NAME="${qual}"`);
        out.push(new URL(uri, base).href);
      } else if (i > 0) out.push(L);
    }
    return send(res, 200, out.join('\n') + '\n', 'application/vnd.apple.mpegurl');
  } catch {
    return send(res, 200, '', 'application/vnd.apple.mpegurl');
  }
}

// ─── Abyss player ─────────────────────────────────────────────────────────────
// Page datas blob decrypt: AES-256-CTR, key=ascii(md5hex(user_id:slug:md5_id)),
// counter=key[0:16] → JSON {mp4:{sources[{label,size,codec,sub,path,url}],domains,fristDatas}}
const abyssAgent = new Agent({ connect: { timeout: 9000 } });
const { execFile } = await import('node:child_process');
const execFileP = (file, args, timeout) => new Promise(res => {
  execFile(file, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout) => res(err ? null : stdout));
});
async function abyssPage(url) {
  // undici often gets 403 (TLS fingerprint); curl passes — try both
  try {
    const r = await undiciFetch(url, { headers: { 'User-Agent': UA, Referer: BASE }, dispatcher: abyssAgent, signal: AbortSignal.timeout(14000) });
    if (r.ok) {
      const t = await r.text();
      if (t.includes('const datas')) return t;
    }
  } catch { /* fall through */ }
  return await execFileP('curl', ['-s', '-L', '--max-time', '18', '-A', UA, '-e', BASE, url], 22000);
}
function aesCtrHexKey(hexStr) {
  const key = Buffer.from(hexStr, 'utf8');               // 32 ascii bytes → AES-256
  const counter = Buffer.from(hexStr.slice(0, 16), 'utf8');
  return data => {
    const c = crypto.createCipheriv('aes-256-ctr', key, counter);
    return Buffer.concat([c.update(data), c.final()]);
  };
}
async function abyssMeta(url) {
  const m = url.match(/([a-zA-Z0-9_-]{7,24})(?:[?#].*)?$/);
  const slug = m ? m[1] : null;
  if (!slug) return null;
  const ck = `ab:${slug}`;
  const e = cache.get(ck);
  if (e && Date.now() - e.at < 3 * 3600e3) return e.v;
  let meta = null;
  const html = await abyssPage(url);
  const dm = html && html.match(/const datas = "([^"]+)"/);
  if (dm) {
    try {
      const blob = JSON.parse(Buffer.from(dm[1], 'base64').toString('latin1'));
      const hex = crypto.createHash('md5').update(`${blob.user_id}:${blob.slug}:${blob.md5_id}`).digest('hex');
      const dec = aesCtrHexKey(hex);
      const pt = dec(Buffer.from(blob.media, 'latin1'));
      const j = JSON.parse(pt.toString('utf8'));
      if (j && j.mp4 && Array.isArray(j.mp4.sources)) meta = { slug: blob.slug, md5_id: blob.md5_id, ...j };
    } catch { /* stale */ }
  }
  cachePut(ck, { v: meta, at: Date.now() }, meta ? 10 * 60e3 : 300e3);
  DBG('abyssMeta', slug, meta ? meta.mp4.sources.map(s => s.label).join('/') : 'none');
  return meta;
}

// ─── Abyss /sora/ direct stream (donghua-proven protocol) ────────────────────
// token = b64(b64(AES-256-CTR("/mp4/{md5}/{res}/{size}/{size}/0",
//         key=utf8(md5hex(size-digits-as-bytes)), ctr=key[:16])))
// origin decrypts server-side; Referer abyssplayer.com is required.
const ABYSS_REFERER = 'https://abyssplayer.com/';
const ABYSS_RANGE_MAX = 524288000;
const CODEC_RANK = { h264: 0, avc: 0, hevc: 1, h265: 1, av1: 2 };
function abyssToken(md5Id, resId, size, frag, index) {
  const path = `/mp4/${md5Id}/${resId}/${size}/${frag}/${index}`;
  const secret = Buffer.from(String(size).split('').map(ch => (ch >= '0' && ch <= '9') ? Number(ch) : ch.charCodeAt(0)));
  const hex = crypto.createHash('md5').update(secret).digest('hex');
  const key = Buffer.from(hex, 'utf8');
  const c = crypto.createCipheriv('aes-256-ctr', key, key.subarray(0, 16));
  const ct = Buffer.concat([c.update(path, 'utf8'), c.final()]);
  const once = ct.toString('base64').replace(/=+$/, '');
  return Buffer.from(once, 'ascii').toString('base64').replace(/=+$/, '');
}
const resPx = label => {
  const m = String(label || '').match(/(\d{3,4})\s*p/);
  return m ? Number(m[1]) : ({ '4k': 2160, '8k': 4320, origin: 9999 })[String(label || '').toLowerCase()] || 0;
};
async function abyssProbe(url, seekable) {
  // sssrr origins TLS-gate undici sometimes — curl first (binary-safe head check)
  try {
    const cmd = `curl -s -L -m 12 -A ${JSON.stringify(UA)} -H ${JSON.stringify('Referer: ' + ABYSS_REFERER)} ${seekable ? '-H "Range: bytes=0-63" ' : ''}${JSON.stringify(url)} | head -c 64`;
    const head = await new Promise(res => {
      execFile('sh', ['-c', cmd], { timeout: 16000, encoding: 'buffer', maxBuffer: 1 << 16 }, (err, stdout) => res(stdout || Buffer.alloc(0)));
    });
    if (head.length > 8) return head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
  } catch { /* fall through */ }
  try {
    const headers = { 'User-Agent': UA, Referer: ABYSS_REFERER };
    if (seekable) headers.Range = 'bytes=0-63';
    const r = await undiciFetch(url, { headers, dispatcher: abyssAgent, signal: AbortSignal.timeout(12000), redirect: 'follow' });
    let head = Buffer.alloc(0);
    if (r.status === 200 || r.status === 206) {
      const reader = r.body.getReader();
      const { value } = await reader.read();
      if (value) head = Buffer.from(value.slice(0, 64));
      try { await reader.cancel(); } catch { /* noop */ }
    } else { try { await r.body?.cancel(); } catch { /* noop */ } }
    return head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70;
  } catch { return false; }
}
async function abyssStreamCards(url, chosenTitle, episode, lang) {
  const cards = [];
  const meta = await abyssMeta(url);
  if (!meta?.mp4?.sources?.length) {
    cards.push({
      name: `[DesiDub] Abyss ${lang} · App`,
      title: `${chosenTitle} — E${episode}\nAbyss · ${lang} · opens in app player`,
      externalUrl: `https://abysscdn.com/?v=${(url.match(/([a-zA-Z0-9_-]{7,24})(?:[?#].*)?$/) || [])[1] || ''}`,
      behaviorHints: { notWebReady: true },
    });
    return cards;
  }
  const domains = (meta.mp4.domains || []).filter(d => d && d.includes('.'));
  if (!domains.length) return cards;
  const root = domains[0].split('.').slice(1).join('.');
  // best per label: h264 wins over av1, bigger size wins
  const best = {};
  for (const s of meta.mp4.sources || []) {
    if (!s || !s.status || !s.label || !s.sub || !s.size || !s.res_id) continue;
    const cand = { label: s.label, codec: (s.codec || '').toLowerCase(), size: Number(s.size), res_id: Number(s.res_id), sub: s.sub, base: `https://${s.sub}.${root}` };
    const cur = best[s.label];
    if (!cur || ((CODEC_RANK[cand.codec] ?? 9) - (CODEC_RANK[cur.codec] ?? 9) || cand.size - cur.size) > 0) best[s.label] = cand;
  }
  const list = Object.values(best).sort((a, b) => resPx(b.label) - resPx(a.label)).slice(0, 3);
  await Promise.all(list.map(async src => {
    const tok = abyssToken(meta.md5_id, src.res_id, src.size, src.size, 0);
    const u = `${src.base}/sora/${src.size}/${tok}`;
    const seekable = src.size <= ABYSS_RANGE_MAX;
    const ok = await abyssProbe(u, seekable);
    DBG('abyssSora', src.label, ok ? 'ftyp-ok' : 'probe-fail');
    if (!ok) return; // no phantom cards — dead tokens don't play
    const av1 = src.codec === 'av1';
    cards.push({
      name: `[DesiDub] Abyss ${src.label}${av1 ? ' AV1' : ''} ${lang}`,
      title: `${chosenTitle} — E${episode}\nAbyss ${src.label} · ${src.codec || ''} · ${(src.size / 1048576).toFixed(0)}MB${seekable ? '' : ' · large file: plays from start'}\nDirect MP4 · fresh link`,
      url: u,
      behaviorHints: { notWebReady: false, proxyHeaders: { Referer: ABYSS_REFERER } },
      _ok: true,
      _q: resPx(src.label) - (av1 ? 1000 : 0), // h264 beats av1: playability first
      _abyss: true,
    });
  }));
  if (!cards.some(c => c._abyss)) {
    cards.push({
      name: `[DesiDub] Abyss ${lang} · App`,
      title: `${chosenTitle} — E${episode}\nAbyss · ${lang} · opens in app player`,
      externalUrl: `https://abysscdn.com/?v=${meta?.slug || (url.match(/([a-zA-Z0-9_-]{7,24})(?:[?#].*)?$/) || [])[1] || ''}`,
      behaviorHints: { notWebReady: true },
    });
  }
  return cards;
}
async function abyssInfo(url) {
  const m = url.match(/([a-zA-Z0-9_-]{7,24})(?:[?#].*)?$/);
  const slug = m ? m[1] : null;
  if (!slug) return null;
  const ck = `ab:${slug}`;
  const e = cache.get(ck);
  if (e && Date.now() - e.at < 6 * 3600e3) return e.v;
  // 1) the player's own /info API (server-side decrypted)
  const origin = new URL(url).origin;
  let out = null;
  try {
    const r = await undiciFetch(`${origin}/info/${slug}`, {
      headers: {
        'User-Agent': UA, Accept: 'application/json',
        'x-client-screen': '1920x1080',
        'x-referer': `${BASE}/`,
        Referer: url,
      },
      dispatcher: abyssAgent, signal: AbortSignal.timeout(12000),
    });
    if (r.ok) {
      const j = await r.json();
      const media = j && typeof j === 'object' ? (j.media || j.result?.media || (j.result && typeof j.result === 'object' ? j.result : null)) : null;
      if (media && typeof media === 'object') out = mediaSources(media);
    }
  } catch { /* noop */ }
  // 2) local decrypt of the page datas blob (AES-CTR, md5-hex key) — works on
  //    abyss deployments where the blob carries the real payload
  if (!out) {
    const html = await fetchText(url, { timeout: 13000, referer: BASE });
    const dm = html && html.match(/const datas = "([^"]+)"/);
    if (dm) {
      try {
        const blob = JSON.parse(Buffer.from(dm[1], 'base64').toString('utf8'));
        const keyStr = `${blob.user_id}:${blob.slug}:${blob.md5_id}`;
        const md5hex = crypto.createHash('md5').update(keyStr).digest('hex');
        const kb = new TextEncoder().encode(md5hex);
        const key = await crypto.webcrypto.subtle.importKey('raw', kb, { name: 'AES-CTR', length: 128 }, false, ['decrypt']);
        const enc = new Uint8Array(blob.media.length);
        for (let i = 0; i < blob.media.length; i++) enc[i] = blob.media.charCodeAt(i);
        const pt = await crypto.webcrypto.subtle.decrypt({ name: 'AES-CTR', counter: new Uint8Array(kb.slice(0, 16)), length: 128 }, key, enc);
        const media = JSON.parse(new TextDecoder().decode(pt));
        out = mediaSources(media);
      } catch { /* stale blob */ }
    }
  }
  cachePut(ck, { v: out, at: Date.now() }, out ? 6 * 3600e3 : 300e3);
  DBG('abyss', slug, '->', out ? 'sources' : 'none');
  return out;
}
function mediaSources(media) {
  const out = [];
  const push = f => { if (f && /^https?:\/\//.test(String(f))) out.push(String(f)); };
  if (Array.isArray(media)) {
    for (const it of media) { push(it.file); push(it.source); for (const s of it.source || []) push(s.file); }
  } else {
    push(media.file); push(media.source); push(media.hls);
    for (const s of media.source || []) push(s.file);
    for (const k of ['hls', 'mp4']) if (media[k] && typeof media[k] === 'object') for (const s of [].concat(media[k])) push(s.file || s);
  }
  return [...new Set(out)];
}

// ─── Mirror (filesforever) ───────────────────────────────────────────────────
async function mirrorSources(url) {
  const ck = `mir:${url}`;
  const e = cache.get(ck);
  if (e && Date.now() - e.at < 3 * 3600e3) return e.v;
  let out = null;
  const html = await fetchText(url, { timeout: 12000, referer: BASE });
  const sid = (url.match(/\/embed\/([a-z0-9]+)/i) || [])[1];
  if (html && sid) {
    const vt = (html.match(/name="view_token" value="([a-f0-9]+)"/) || [])[1] || '';
    try {
      const r = await undiciFetch('https://filesforever.link/embedhelper2.php', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest', Referer: url, Origin: 'https://filesforever.link' },
        body: new URLSearchParams({ sid, UserFavSite: '', currentDomain: '', ...(vt ? { view_token: vt } : {}) }).toString(),
        dispatcher: abyssAgent, signal: AbortSignal.timeout(12000),
      });
      const txt = await r.text();
      if (r.ok && txt.trim().startsWith('{')) {
        const j = JSON.parse(txt);
        const found = [];
        const walk = o => {
          if (!o || typeof o !== 'object') return;
          if (typeof o.file === 'string' && /^https?:\/\//.test(o.file)) found.push(o.file);
          if (typeof o.url === 'string' && /^https?:\/\//.test(o.url)) found.push(o.url);
          for (const k of Object.keys(o)) walk(o[k]);
        };
        walk(j);
        if (found.length) out = [...new Set(found)];
      }
    } catch { /* noop */ }
  }
  cachePut(ck, { v: out, at: Date.now() }, out ? 3 * 3600e3 : 300e3);
  DBG('mirror', sid, '->', out ? out.length : 'none');
  return out;
}

// ─── VMoly (page regex) ──────────────────────────────────────────────────────
async function vmolySources(url) {
  const ck = `vm:${url}`;
  const e = cache.get(ck);
  if (e && Date.now() - e.at < 3 * 3600e3) return e.v;
  const html = await fetchText(url, { timeout: 12000, referer: BASE });
  let out = null;
  if (html) {
    const found = [];
    for (const m of html.matchAll(/(?:file|source|sources)\s*[:=]\s*["']?(https?:\/\/[^"'\s,]+?\.(?:m3u8|mp4)[^"'\s,]*)/gi)) found.push(m[1]);
    out = found.length ? [...new Set(found)] : null;
  }
  cachePut(ck, { v: out, at: Date.now() }, out ? 3 * 3600e3 : 300e3);
  DBG('vmoly', '->', out ? out.length : 'none');
  return out;
}

// ─── verify a stream URL is really playable (range probe, direct) ───────────
async function playable(u) {
  try {
    const r = await undiciFetch(u, { method: 'GET', headers: { 'User-Agent': UA, Range: 'bytes=0-1024', Referer: BASE }, dispatcher: abyssAgent, signal: AbortSignal.timeout(9000) });
    if (r.status === 200 || r.status === 206) {
      try { await r.body?.cancel(); } catch { /* noop */ }
      return true;
    }
    try { await r.body?.cancel(); } catch { /* noop */ }
    return false;
  } catch { return false; }
}

// ─── resolve one episode ─────────────────────────────────────────────────────
function streamTtl(streams) {
  return streams.some(x => x._abyss) ? 3 * 60e3 : 90 * 60e3;
}
async function resolveEpisode(aliases, episode) {
  const { item, best, score } = await findAnime(aliases);
  if (!best) return { streams: [], note: 'not found on DesiDubAnime' };
  const chosen = item || best;
  const eps = await animeEpisodes(chosen.slug);
  let watchSlug = eps.watch.get(episode);
  if (!watchSlug && eps.watch.size) {
    // fall back to any listed slug base with the requested ep appended
    watchSlug = [...eps.watch.values()][0].replace(/-episode-\d+$/, '');
  }
  if (!watchSlug) return { streams: [], note: 'no episodes listed' };
  const embeds = await watchEmbeds(watchSlug, episode);
  if (!embeds.length) return { streams: [], note: 'no embeds' };

  const jobs = [];
  const streams = [];
  for (const em of embeds) {
    const srv = em.server.toLowerCase();
    if (srv.includes('abyss')) {
      jobs.push(abyssStreamCards(em.url, chosen.title, episode, em.lang).then(cs => {
        streams.push(...cs);
      }));
    } else if (srv.includes('mirror') || srv.includes('filesforever')) {
      jobs.push(mirrorSources(em.url).then(async srcs => {
        if (srcs?.length) {
          const checks = await Promise.all(srcs.slice(0, 3).map(u => playable(u).then(ok => ({ u, ok }))));
          for (const { u, ok } of checks) {
            streams.push({
              name: `[DesiDub] Mirror ${em.lang}`,
              title: `${chosen.title} — E${episode}\nMirror · ${em.lang} · direct`,
              url: u,
              behaviorHints: { notWebReady: false },
              _ok: ok,
            });
          }
        } else {
          streams.push({
            name: `[DesiDub] Mirror ${em.lang} · Browser`,
            title: `${chosen.title} — E${episode}\nMirror · ${em.lang} · opens in browser`,
            externalUrl: em.url,
            behaviorHints: { notWebReady: true },
          });
        }
      }));
    } else if (srv.includes('vmoly')) {
      jobs.push(vmolySources(em.url).then(srcs => {
        if (srcs?.length) {
          for (const u of srcs.slice(0, 3)) {
            // re-manifest through us → explicit quality switching when the
            // source has multiple video variants; multi-audio preserved
            const wrapped = `${PUBLIC_BASE}/hz/${Buffer.from(u).toString('base64url')}.m3u8`;
            streams.push({
              name: `[DesiDub] VMoly ${em.lang}`,
              title: `${chosen.title} — E${episode}\nVMoly · ${em.lang} · HLS multi-audio (hi/ta/te/en)\nAudio + quality switch in player`,
              url: wrapped,
              behaviorHints: { notWebReady: false },
              _ok: true,
            });
          }
        } else {
          streams.push({
            name: `[DesiDub] VMoly ${em.lang} · Browser`,
            title: `${chosen.title} — E${episode}\nVMoly · ${em.lang} · opens in browser`,
            externalUrl: em.url,
            behaviorHints: { notWebReady: true },
          });
        }
      }));
    } else {
      // p2p / unknown hash-player — honest browser card
      streams.push({
        name: `[DesiDub] ${em.server} ${em.lang} · Browser`,
        title: `${chosen.title} — E${episode}\n${em.server} · ${em.lang} · opens in browser`,
        externalUrl: em.url,
        behaviorHints: { notWebReady: true },
      });
    }
  }
  await Promise.all(jobs);
  // dedupe identical urls (same file via two Abyss embeds)
  const seenU = new Set();
  for (let i = streams.length - 1; i >= 0; i--) {
    const k = streams[i].url || streams[i].externalUrl;
    if (seenU.has(k)) streams.splice(i, 1);
    else seenU.add(k);
  }
  // direct-play first, browser cards last; then by quality heuristics
  streams.sort((a, b) => (b._ok ? 1 : 0) - (a._ok ? 1 : 0) || (b._q || 0) - (a._q || 0));
  return { streams, note: streams.length ? null : 'no playable sources' };
}

// ─── manifest ────────────────────────────────────────────────────────────────
const manifest = {
  id: 'community.desidubanime',
  version: VERSION,
  name: 'DesiDubAnime',
  logo: `${PUBLIC_BASE}/logo.png`,
  description: 'Hindi, Tamil, Telugu & Bengali dubbed anime from DesiDubAnime.me. Multi-server (Abyss resolved, Mirror, VMoly) — direct streams, zero server bandwidth.',
  resources: ['stream'],
  types: ['series', 'movie'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ─── http server ─────────────────────────────────────────────────────────────
function send(res, status, body, ctype) {
  const s = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': ctype || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(s);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname === '/manifest.json') return send(res, 200, manifest);
    if (u.pathname === '/health') return send(res, 200, { ok: true, version: VERSION, pool: poolStats().healthy, cache: cache.size });
    if (u.pathname === '/logo.png') {
      if (!LOGO_BUF) return send(res, 404, { error: 'no logo' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      return res.end(LOGO_BUF);
    }
    if (u.pathname === '/') {
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DesiDubAnime</title></head><body style="font-family:system-ui;background:#0b0e14;color:#e8eaf0;max-width:640px;margin:40px auto;padding:0 18px"><h1 style="font-size:28px">Desi<span style="color:#ff6b35">Dub</span>Anime <span style="color:#8d96a5;font-size:14px">v${VERSION}</span></h1><p style="color:#9aa3b2;line-height:1.6">Hindi/Tamil/Telugu/Bengali dubbed anime. Multi-server with Abyss resolved (AES-CTR + /info), Mirror &amp; VMoly. Streams play direct from CDN.</p><a href="stremio://${u.host}/manifest.json" style="display:inline-block;margin-top:16px;padding:14px 34px;border-radius:12px;background:linear-gradient(90deg,#e65100,#ff6b35);color:#fff;font-weight:700;text-decoration:none">Install in Stremio</a></body></html>`, 'text/html; charset=utf-8');
    }
    const hz = u.pathname.match(/^\/hz\/([A-Za-z0-9_-]+?)(?:\.m3u8)?$/);
    if (hz) {
      try { return await handleRemanifest(Buffer.from(hz[1], 'base64url').toString('utf8'), res); }
      catch { return send(res, 200, '', 'application/vnd.apple.mpegurl'); }
    }
    const sm = u.pathname.match(/^\/stream\/(movie|series)\/([^/]+?)(?:\/(\d+)\/(\d+))?(?:\.json)?$/);
    if (sm) {
      const imdb = decodeURIComponent(sm[2]).split(':')[0];
      const season = Number(sm[3]) || 1;
      const episode = Number(sm[4]) || 1;
      const ck = `${sm[1]}:${imdb}:${season}:${episode}`;
      const cached = cacheGet(ck);
      if (cached) return send(res, 200, { streams: cached });
      if (cached && cached.length === 0) {
        // cached empty: bg re-resolve, answer honestly now
        if (!BG.has(ck)) {
          BG.add(ck);
          setTimeout(() => {
            (async () => {
              const meta = (await cinemeta(sm[1], imdb)) || (await imdbSuggest(imdb));
              if (!meta?.name) return [];
              const r = await resolveEpisode(meta.aliases, episode);
              if (r.streams.length) cachePut(ck, r.streams, streamTtl(r.streams));
              return r.streams;
            })().catch(() => {}).finally(() => BG.delete(ck));
          }, 400).unref?.();
        }
        return send(res, 200, { streams: [] });
      }
      const meta = (await cinemeta(sm[1], imdb)) || (await imdbSuggest(imdb));
      if (!meta?.name) return send(res, 200, { streams: [], message: 'no meta' });
      const p = (async () => {
        const r = await resolveEpisode(meta.aliases, episode);
        DBG('resolved', meta.name, 'E' + episode, '->', r.streams.length, r.note || '');
        if (r.streams.length) cachePut(ck, r.streams, streamTtl(r.streams));
        else cachePut(ck, r.streams, 60e3);
        // binge prewarm: next 2 episodes quietly
        if (r.streams.length && sm[1] === 'series') {
          setTimeout(() => {
            for (let e = episode + 1; e <= episode + 2; e++) {
              resolveEpisode(meta.aliases, e).then(x => { if (x.streams.length) cachePut(`${sm[1]}:${imdb}:${season}:${e}`, x.streams, streamTtl(x.streams)); }).catch(() => {});
            }
          }, 1500).unref?.();
        }
        return r.streams;
      })();
      let streams = await Promise.race([p, new Promise(r => setTimeout(() => r(null), WALL_MS))]);
      if (streams === null) {
        p.catch(() => {});
        return send(res, 200, { streams: [], message: 'resolving — tap streams again in a moment' });
      }
      return send(res, 200, { streams });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    return send(res, 200, { streams: [] });
  }
});

poolStart();
setImmediate(() => { cinemeta('series', 'tt9335498').catch(() => {}); });
server.listen(PORT, '0.0.0.0', () => console.log(`DesiDubAnime v${VERSION} on :${PORT}`));
