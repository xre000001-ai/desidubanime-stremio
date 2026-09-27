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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fetch as undiciFetch, Agent } from 'undici';
import { poolStart, poolStats, apiFetch } from './mb-lib/pool.js';

const VERSION = '1.1.0';
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
const ROMANS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
function matchScore(title, want, season) {
  const t = nz(title);
  if (!t) return 0;
  // prefix-walk: "Mushoku Tensei: Jobless Reincarnation" must match site rows
  // like "Mushoku Tensei II: Isekai Ittara Honki Dasu" via the shared head
  const words = String(want).trim().split(/\s+/);
  let sc = 0, base = '';
  for (let k = words.length; k >= 2; k--) {
    base = nz(words.slice(0, k).join(' '));
    if (base.length < 5) continue;
    if (t === base) { sc = 5 - (words.length - k); break; }
    if (t.startsWith(base)) { sc = 4 - (words.length - k); break; }
    if (base.startsWith(t) && t.length > 6) { sc = 3; break; }
    if (t.includes(base)) { sc = 2; break; }
  }
  if (!sc) return 0;
  // season discrimination on the raw title with the base blanked out
  const sn = Number(season) || 1;
  const raw = String(title).toLowerCase();
  const rawBase = String(base ? words.slice(0, base.split('').length ? undefined : undefined) : '').length ? '' : '';
  const blanked = raw.replace(nzToText(base), '§');
  const rom = ROMANS[sn] || String(sn);
  const thisRoman = new RegExp(`${rom}(?![a-z])`, 'i').test(blanked);
  const thisDigit = new RegExp(`(?:^|[^0-9a-z])(?:s\\s*)?0?${sn}(?![0-9])`, 'i').test(blanked);
  const anyMark = /(?:^|[^0-9a-z])(?:season\s*|s\s*)?(ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|[2-9])(?![a-z0-9])/i.test(blanked);
  if (sn === 1) sc += anyMark ? -3 : 0;
  else if (thisRoman || thisDigit) sc += 3;
  else if (anyMark) sc -= 3;
  else sc -= 1;
  return Math.max(sc, 0);
}
function nzToText(nzzed) {
  // fuzzy lowercase needle; NO greedy separator after the last char (it must
  // not swallow the boundary space or season marks glue onto the sentinel)
  const cs = [...nzzed];
  const pat = cs.map((c, i) => (i < cs.length - 1 ? c + '[^a-z0-9]*' : c)).join('');
  return new RegExp(pat, 'i');
}
// serialize searches with small spacing — the site WAF throttles bursts
let searchChain = Promise.resolve();
function spacedSearch(query) {
  const p = searchChain.catch(() => {}).then(() => searchAnime(query));
  searchChain = p.catch(() => {});
  return p;
}
async function findAnime(aliases, season) {
  const primary = String(aliases[0] || '').trim();
  if (!primary) return { item: null, best: null, score: 0 };
  const colonStrip = primary.replace(/\s*[:\u2013\u2014-]\s.*$/, '').trim();
  const names = [...new Set([
    primary, ...(colonStrip.length > 3 ? [colonStrip] : []),
    ...aliases.slice(1).filter(al => {
      const p = nz(primary), az = nz(al);
      return az.length > 3 && (p.includes(az) || az.includes(p));
    }),
  ])].slice(0, 3);
  let best = null, bs = -1;
  await Promise.all(names.map(async (n, i) => {
    let rows = [];
    if (i === 0) {
      rows = await spacedSearch(n).catch(() => []);
      if (!rows.length) { await new Promise(r => setTimeout(r, 2000)); rows = await spacedSearch(n).catch(() => []); }
    } else rows = await spacedSearch(n).catch(() => []);
    for (const r of rows) {
      const sc = matchScore(r.title, primary, season);
      if (sc > bs) { bs = sc; best = r; }
    }
  }));
  return { item: bs >= 1 ? best : null, best, score: bs, rows: best ? 1 : 0 };
}

// ─── anime page: real watch slugs per episode ───────────────────────────────
async function animeEpisodes(slug) {
  const ck = `eps:${slug}`;
  const e = cache.get(ck);
  if (e && e.v && Date.now() - e.at < (e.v.watch?.size ? 6 * 3600e3 : 3 * 60e3)) return e.v;
  const html = await fetchText(`${BASE}/anime/${slug}/`, { timeout: 13000 });
  const v = { watch: new Map(), total: 0 };   // ep number -> FULL watch url
  // FULL episode list lives behind Kiranime's AJAX (the page HTML only links
  // the latest tail). postID is embedded in the page.
  const pid = (html && html.match(/postID["':=]+\s*(\d+)/) || [])[1];
  let complete = false;
  if (pid) {
    let page = 1, maxp = 1;
    do {
      if (page > 1) await new Promise(r => setTimeout(r, 450)); // admin-ajax throttles bursts
      const raw = await fetchText(`${BASE}/wp-admin/admin-ajax.php?action=get_episodes&anime_id=${pid}&page=${page}&order=asc`, { timeout: 12000 }).catch(() => null);
      if (!raw || !raw.trimStart().startsWith('{')) break;
      let data = null;
      try { data = JSON.parse(raw).data; } catch { break; }
      for (const ep of (data?.episodes || [])) {
        const n = parseInt(ep.meta_number, 10);
        if (Number.isFinite(n) && n >= 0 && ep.url) v.watch.set(n, ep.url);
      }
      maxp = Number(data?.max_episodes_page) || 1;
      complete = page >= maxp;
      page++;
    } while (page <= Math.min(maxp, 8));
  }
  // fallback: watch links present in the page HTML (latest tail)
  if (!v.watch.size && html) {
    const re = /href="https:\/\/www\.desidubanime\.me\/watch\/([^"]+?)-episode-(\d+)\/"/g;
    let m;
    while ((m = re.exec(html))) v.watch.set(Number(m[2]), `${BASE}/watch/${m[1]}-episode-${m[2]}/`);
  }
  v.total = v.watch.size;
  // full list cached long; a partial list (throttled pages) re-fetches soon
  cachePut(ck, { v, at: Date.now() }, complete ? 6 * 3600e3 : 10 * 60e3);
  DBG('episodes', slug, '->', v.total, v.watch.size ? `range ${Math.min(...v.watch.keys())}-${Math.max(...v.watch.keys())}` : '', complete ? 'full' : 'partial');
  return v;
}

// ─── watch page: embed servers ───────────────────────────────────────────────
async function watchEmbeds(watchUrl, ep) {
  const ck = `w:${watchUrl}`;
  const e = cache.get(ck);
  if (e && Date.now() - e.at < 30 * 60e3) return e.v;
  let html = await fetchText(watchUrl, { timeout: 13000 });
  if (!html) { await new Promise(r => setTimeout(r, 1200)); html = await fetchText(watchUrl, { timeout: 13000 }).catch(() => ''); }
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
  // an empty result may be a transient CF challenge — retry once, cache briefly
  if (!embeds.length && html) {
    await new Promise(r => setTimeout(r, 1200));
    const html2 = await fetchText(watchUrl, { timeout: 13000 }).catch(() => '');
    if (html2) {
      const re2 = /data-embed-id="([^"]+)"/g;
      let m2;
      while ((m2 = re2.exec(html2))) {
        const [srvB, urlB] = m2[1].split(':');
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
  }
  cachePut(ck, { v: embeds, at: Date.now() }, embeds.length ? 30 * 60e3 : 60e3);
  DBG('embeds', String(watchUrl).slice(-42), '->', embeds.map(x => x.server).join(','));
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



// ─── VMoly /vm/ relay: server-bound signature for every byte, UA injected ────
const VM_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const vmB64 = u => Buffer.from(u).toString('base64url');
function vmRewrite(txt, baseUrl) {
  return txt.split('\n').map(L => {
    const line = L.trim();
    if (!line) return L;
    if (line.startsWith('#')) return L.replace(/URI="([^"]+)"/g, (m, u0) => {
      try { return `URI="/vm/${vmB64(new URL(u0, baseUrl).href)}.m3u8"`; } catch { return m; }
    });
    try {
      const abs = new URL(line, baseUrl).href;
      return `/vm/${vmB64(abs)}${abs.includes('.m3u8') ? '.m3u8' : '.ts'}`;
    } catch { return L; }
  }).join('\n');
}
async function handleVmProxy(res, target, asM3u8) {
  const isM3u8 = asM3u8 || target.includes('.m3u8');
  try {
    const r = await undiciFetch(target, { headers: { 'User-Agent': VM_UA }, signal: AbortSignal.timeout(15000) });
    if (isM3u8) {
      const txt = await r.text();
      if (r.status !== 200 || !txt.includes('#EXTM3U')) { res.writeHead(502, { 'access-control-allow-origin': '*' }); return res.end(''); }
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(vmRewrite(txt, target));
    }
    res.writeHead(r.status, {
      'content-type': 'video/mp2t',
      ...(r.headers.get('content-length') ? { 'content-length': r.headers.get('content-length') } : {}),
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502, { 'access-control-allow-origin': '*' });
    res.end();
  }
}

// ─── Abyss crypto (donghua-proven) ───────────────────────────────────────────
const ABYSS_REFERER = 'https://abyssplayer.com/';
const ABYSS_RANGE_MAX = 524288000;
const CODEC_RANK = { h264: 0, avc: 0, hevc: 1, h265: 1, av1: 2 };
const resPx = label => {
  const mm = String(label || '').match(/(\d{3,4})\s*p/);
  return mm ? Number(mm[1]) : ({ '4k': 2160, '8k': 4320, origin: 9999 })[String(label || '').toLowerCase()] || 0;
};
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
// ─── Abyss /ar/ byte-proxy: fresh token at click-time, server-side Referer ───
async function handleAbyssProxy(req, res, m) {
  const [, md5, resId, sizeS, host] = m;
  const size = Number(sizeS);
  const CHUNK = 4194304; // origin accepts arbitrary frag sizes: fragment i = bytes [i*CHUNK, (i+1)*CHUNK)
  const range = req.headers.range;
  let A = 0, B;
  if (range) {
    const rm = String(range).match(/bytes=(\d+)-(\d*)/);
    if (rm) { A = Number(rm[1]); if (rm[2]) B = Number(rm[2]); }
  }
  if (A >= size) { res.writeHead(416, { 'content-range': `bytes */${size}`, 'access-control-allow-origin': '*' }); return res.end(); }
  // NO Range visible (reverse proxy strips it): full-file stream from byte 0 —
  // sequential playback always works; players disable seek (honest degradation).
  if (!range && req.method === 'GET') {
    const tok0 = abyssToken(md5, resId, size, size, 0);
    const up0 = `https://${host}/sora/${size}/${tok0}`;
    res.on('close', () => { try { c0.kill('SIGKILL'); } catch { /* noop */ } });
    let c0, h0done = false, b0 = Buffer.alloc(0);
    try { c0 = spawn('curl', ['-s', '-N', '-i', '-L', '-A', UA, '-H', `Referer: ${ABYSS_REFERER}`, up0]); } catch { return send(res, 502, ''); }
    c0.stdout.on('data', d => {
      if (!h0done) {
        b0 = Buffer.concat([b0, d]);
        for (;;) {
          const i = b0.indexOf('\r\n\r\n');
          if (i < 0) return;
          const st = parseInt((b0.slice(0, i).toString('latin1').match(/HTTP\/\S+ (\d{3})/) || [])[1] || 0, 10);
          b0 = b0.slice(i + 4);
          if (st >= 300 && st < 400) continue;
          h0done = true;
          if (st !== 200 && st !== 206) { if (!res.headersSent) res.writeHead(502, { 'access-control-allow-origin': '*' }); try { c0.kill('SIGKILL'); } catch { /* noop */ } return res.end(); }
          res.writeHead(200, {
            'content-type': 'video/mp4',
            'cache-control': 'no-store',
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'content-length, accept-ranges',
          });
          break;
        }
        if (!h0done) return;
        d = b0;
      }
      if (d.length) res.write(d);
    });
    c0.stdout.on('end', () => { if (!h0done) { if (!res.headersSent) res.writeHead(502, { 'access-control-allow-origin': '*' }); return res.end(); } res.end(); });
    c0.on('error', () => { if (!res.headersSent) { try { res.writeHead(502); } catch { /* noop */ } } res.end(); });
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': size,
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'content-range, content-length, accept-ranges',
    });
    return res.end();
  }
  const idx = Math.floor(A / CHUNK);
  const off = A - idx * CHUNK;
  const end = Math.min(B ?? Infinity, idx * CHUNK + CHUNK - 1, size - 1);
  const len = end - A + 1;
  const tok = abyssToken(md5, resId, size, CHUNK, idx);
  const up = `https://${host}/sora/${size}/${tok}`;
  res.on('close', () => { try { child.kill('SIGKILL'); } catch { /* noop */ } });
  let child;
  const args = ['-s', '-N', '-i', '-L', '-A', UA, '-H', `Referer: ${ABYSS_REFERER}`, up];
  try { child = spawn('curl', args); } catch { return send(res, 502, ''); }
  let skip = off, left = len, headerDone = false, buf = Buffer.alloc(0);
  child.stdout.on('data', d => {
    if (!headerDone) {
      buf = Buffer.concat([buf, d]);
      // walk through redirect hop headers; final block decides the status
      for (;;) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const block = buf.slice(0, i).toString('latin1');
        const st = parseInt((block.match(/HTTP\/\S+ (\d{3})/) || [])[1] || 0, 10);
        buf = buf.slice(i + 4);
        if (st >= 300 && st < 400) continue; // another hop follows
        headerDone = true;
        if (st !== 200 && st !== 206) {
          if (!res.headersSent) res.writeHead(502, { 'access-control-allow-origin': '*' });
          try { child.kill('SIGKILL'); } catch { /* noop */ }
          return res.end();
        }
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-length': len,
          'content-range': `bytes ${A}-${end}/${size}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'content-range, content-length, accept-ranges',
        });
        break;
      }
      if (!headerDone) return;
      d = buf; // remainder after the final header block
    }
    if (skip > 0) {
      if (d.length <= skip) { skip -= d.length; return; }
      d = d.slice(skip); skip = 0;
    }
    if (left <= 0) return;
    if (d.length > left) d = d.slice(0, left);
    res.write(d); left -= d.length;
    if (left <= 0) { try { child.kill('SIGKILL'); } catch { /* noop */ } res.end(); }
  });
  child.stdout.on('end', () => {
    if (!headerDone) { if (!res.headersSent) res.writeHead(502, { 'access-control-allow-origin': '*' }); return res.end(); }
    if (left > 0 && !res.writableEnded) res.end();
  });
  child.on('error', () => { if (!res.headersSent) { try { res.writeHead(502); } catch { /* noop */ } } res.end(); });
}
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
// ─── AniHub glass card format (player name front, like MovieBox spec) ────────
const GLASS_CODEC = { h264: 'H.264', avc: 'H.264', hevc: 'HEVC', h265: 'HEVC', av1: 'AV1' };
function qlLabel(label) {
  const px = resPx(label);
  if (px >= 2160) return 'UHD 2160p';
  if (px >= 1080) return 'FHD 1080p';
  if (px >= 720) return `HD ${px}p`;
  if (px) return `SD ${px}p`;
  return 'HLS';
}
function fmtSizeMb(bytes) {
  const mb = (Number(bytes) || 0) / 1048576;
  if (mb < 10) return '';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}
function cleanTitle(t) {
  return String(t || '').replace(/\s*[Ss]\d+\s*[-\u2013]\s*[Ss]?\d+\s*$/, '').replace(/\s+\(?(S\d+[-\u2013]S?\d+)\)?\s*$/, '').trim();
}
function glassCard({ player, title, lang, episode, season, year, quality, sizeBytes, codec, note, url, binge, q }) {
  const t1 = [`◫ S${String(season).padStart(2, '0')} E${String(episode).padStart(2, '0')}`];
  const size = fmtSizeMb(sizeBytes); if (size) t1.push(`◇ ${size}`);
  const cd = GLASS_CODEC[(codec || '').toLowerCase()]; if (cd) t1.push(`▧ ${cd}`);
  const lines = [t1.join(' ')];
  if (lang && !/^original/i.test(lang)) lines.push(`◈ ${lang}`);
  if (note) lines.push(note);
  lines.push(`⌗ ${player}`, `◴ ${year || ''}`.trim());
  return {
    name: `♧ ${quality}  ✹ ${cleanTitle(title)}`,
    description: lines.join('\n'),
    url,
    behaviorHints: { notWebReady: false },
    bingeGroup: `anihub|${cleanTitle(title)}|${player}`,
    _ok: true,
    _q: q,
  };
}

async function abyssStreamCards(url, chosenTitle, episode, lang, season, year) {
  const cards = [];
  const meta = await abyssMeta(url);
  if (!meta?.mp4?.sources?.length) {
    cards.push({
      name: `[AniHub] Abyss ${lang} · App`,
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
    // /ar/ relay: fresh token per request + server-side Referer → plays on
    // every app; chunk-mapped seeking on any file size.
    cards.push(glassCard({
      player: 'Abyss',
      title: chosenTitle,
      lang,
      episode,
      season,
      year,
      quality: qlLabel(src.label),
      sizeBytes: src.size,
      codec: src.codec,
      url: `${PUBLIC_BASE}/ar/${meta.md5_id}/${src.res_id}/${src.size}/${src.base.replace('https://', '')}?v=${Date.now().toString(36)}`,
      q: resPx(src.label) - (src.codec === 'av1' ? 1000 : 0),
    }));
  }));
  if (!cards.length) {
    cards.push({
      name: `[AniHub] Abyss ${lang} · App`,
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
async function resolveEpisode(aliases, episode, season, year) {
  season = Number(season) || 1;
  const { item, best, score } = await findAnime(aliases, season);
  if (!best) return { streams: [], note: 'not found on DesiDubAnime' };
  const chosen = item || best;
  const eps = await animeEpisodes(chosen.slug);
  // EPISODE EXACTNESS: the AJAX list is per-season numbered, so the requested
  // episode number IS the list key — exact match or honest empty. We never
  // substitute another episode.
  const watchUrl = eps.watch.get(episode);
  if (!watchUrl) return { streams: [], note: `episode ${episode} not listed` };
  const embeds = await watchEmbeds(watchUrl, episode);
  if (!embeds.length) return { streams: [], note: `no embeds for E${episode}` };
  DBG('epmatch', `${chosen.slug} E${episode} exact`);

  const jobs = [];
  const streams = [];
  for (const em of embeds) {
    const srv = em.server.toLowerCase();
    if (srv.includes('abyss')) {
      jobs.push(abyssStreamCards(em.url, chosen.title, episode, em.lang, season, year).then(cs => {
        streams.push(...cs);
      }));
    } else if (srv.includes('vmoly')) {
      jobs.push(vmolySources(em.url).then(srcs => {
        if (srcs?.length) {
          for (const u of srcs.slice(0, 3)) {
            // /vm/ relay: server-side UA, all playlists+segments rewritten
            streams.push(glassCard({
              player: 'Vidmoly',
              title: chosen.title,
              lang: em.lang,
              episode,
              season,
              year,
              quality: 'HLS',
              note: '◇ multi-audio हि/த/తె/EN/JA · native seek',
              url: `${PUBLIC_BASE}/vm/${vmB64(u)}.m3u8`,
              q: -1, // HLS card sorts AFTER all resolution cards
            }));
          }
        }
      }));
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
  id: 'community.anihub',
  version: VERSION,
  name: 'AniHub',
  logo: `${PUBLIC_BASE}/logo.png`,
  description: 'Anime in your language — Abyss (up to 1080p, all sizes) + Vidmoly (multi-audio Hindi/Tamil/Telugu/English/Japanese). Direct in-app playback.',
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
    if (u.pathname === '/manifest.json') {
      const dyn = { ...manifest, logo: `${u.protocol}://${u.host}/logo.png` };
      return send(res, 200, dyn);
    }
    if (u.pathname === '/health') return send(res, 200, { ok: true, version: VERSION, pool: poolStats().healthy, cache: cache.size });
    if (u.pathname === '/logo.png') {
      if (!LOGO_BUF) return send(res, 404, { error: 'no logo' });
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      return res.end(LOGO_BUF);
    }
    if (u.pathname === '/') {
      return send(res, 200, `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AniHub</title></head><body style="font-family:system-ui;background:#0b0e14;color:#e8eaf0;max-width:640px;margin:40px auto;padding:0 18px"><h1 style="font-size:28px">Ani<span style="color:#22d3ee">Hub</span> <span style="color:#8d96a5;font-size:14px">v${VERSION}</span></h1><p style="color:#9aa3b2;line-height:1.6">Abyss (360p–1080p, all file sizes) + Vidmoly (multi-audio). Direct in-app playback.</p><a href="stremio://${u.host}/manifest.json" style="display:inline-block;margin-top:16px;padding:14px 34px;border-radius:12px;background:linear-gradient(90deg,#0891b2,#22d3ee);color:#fff;font-weight:700;text-decoration:none">Install in Stremio</a></body></html>`, 'text/html; charset=utf-8');
    }
    if (u.pathname === '/hdr') {
      return send(res, 200, {
        method: req.method,
        range: req.headers.range || null,
        ua: (req.headers['user-agent'] || '').slice(0, 50),
        http: req.httpVersion,
        path: u.pathname,
      });
    }
    const vm = u.pathname.match(/^\/vm\/([A-Za-z0-9_-]+?)(?:\.(?:m3u8|ts))?$/);
    if (vm) return handleVmProxy(res, Buffer.from(vm[1], 'base64url').toString('utf8'), u.pathname.endsWith('.m3u8'));
    const ar = u.pathname.match(/^\/ar\/(\d+)\/(\d+)\/(\d+)\/([a-z0-9.-]+\.[a-z]{2,})$/i);
    if (ar) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-allow-headers': 'range, referer, origin',
          'access-control-max-age': '86400',
        });
        return res.end();
      }
      return handleAbyssProxy(req, res, ar);
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
              const r = await resolveEpisode(meta.aliases, episode, season, meta.year);
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
        const r = await resolveEpisode(meta.aliases, episode, season, meta.year);
        DBG('resolved', meta.name, 'E' + episode, '->', r.streams.length, r.note || '');
        if (r.streams.length) cachePut(ck, r.streams, streamTtl(r.streams));
        else cachePut(ck, r.streams, 60e3);
        // binge prewarm: next 2 episodes quietly
        if (r.streams.length && sm[1] === 'series') {
          setTimeout(() => {
            for (let e = episode + 1; e <= episode + 2; e++) {
              resolveEpisode(meta.aliases, e, season, meta.year).then(x => { if (x.streams.length) cachePut(`${sm[1]}:${imdb}:${season}:${e}`, x.streams, streamTtl(x.streams)); }).catch(() => {});
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
server.listen(PORT, '0.0.0.0', () => console.log(`AniHub v${VERSION} on :${PORT}`));
