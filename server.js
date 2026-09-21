#!/usr/bin/env node
// DesiDubAnime — Stremio addon v1.0.0
// Hindi/Tamil/Telugu/Bengali dubbed anime from desidubanime.me
// Abyss player resolution (AES-CTR decrypt) + multiple servers

'use strict';

import express from 'express';
import crypto from 'node:crypto';

const app = express();
const VERSION = '1.0.0';
const PORT = parseInt(process.env.PORT, 10) || 7000;
const BASE = 'https://www.desidubanime.me';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const IMDB_SUGGEST = 'https://v2.sg.media-imdb.com/suggestion';

// ─── TTL Cache ───────────────────────────────────────────────────────────────
const _cache = new Map();
function cacheGet(key) {
  const ent = _cache.get(key);
  if (!ent) return null;
  if (Date.now() > ent.exp) { _cache.delete(key); return null; }
  return ent.val;
}
function cachePut(key, val, ttlMs) {
  _cache.set(key, { val, exp: Date.now() + ttlMs });
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────
async function fetchText(url, timeout = 10000) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

async function fetchJSON(url, timeout = 8000) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': UA },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ─── IMDb / Cinemeta resolution ─────────────────────────────────────────────
async function cinemeta(ctype, imdb) {
  const key = `cm:${ctype}:${imdb}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  const d = await fetchJSON(`${CINEMETA}/meta/${ctype}/${imdb}.json`);
  const m = d?.meta;
  if (m?.name) {
    const year = String(m.releaseInfo || '').match(/^(\d{4})/)?.[1] || '';
    const val = { name: m.name, year, tmdb: String(m.moviedb_id || '') };
    cachePut(key, val, 12 * 3600_000);
    return val;
  }
  cachePut(key, null, 3600_000);
  return null;
}

async function imdbSuggestId(imdb) {
  const key = `imdb:${imdb}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  try {
    const l = imdb[0] || 'x';
    const r = await fetch(`${IMDB_SUGGEST}/${l}/${encodeURIComponent(imdb)}.json`, {
      signal: AbortSignal.timeout(5000), headers: { 'User-Agent': UA },
    });
    if (!r.ok) { cachePut(key, null, 3600_000); return null; }
    const d = await r.json();
    for (const e of (d.d || [])) {
      if (e.id === imdb && e.l) {
        const val = { name: e.l, year: String(e.y || '') };
        cachePut(key, val, 12 * 3600_000);
        return val;
      }
    }
  } catch {}
  cachePut(key, null, 3600_000);
  return null;
}

async function getMeta(ctype, imdb) {
  const [cm, imdbM] = await Promise.all([cinemeta(ctype, imdb), imdbSuggestId(imdb)]);
  return cm || imdbM;
}

// ─── DesiDubAnime search ────────────────────────────────────────────────────
// WordPress site: search via /?s={query} and parse HTML
async function searchAnime(query) {
  const key = `search:${query.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const html = await fetchText(`${BASE}/?s=${encodeURIComponent(query)}`, 12000);
  if (!html) { cachePut(key, [], 300_000); return []; }

  // Parse search results: /anime/{slug}/ links with titles
  const results = [];
  const re = /href="(https:\/\/www\.desidubanime\.me\/anime\/([^"]+))"[^>]*>[\s\S]*?(?:<h[2-5][^>]*>([^<]+)<\/h|alt="([^"]*)")/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    const slug = m[2];
    const title = (m[3] || m[4] || '').trim();
    if (slug && title && !results.some(r => r.slug === slug)) {
      results.push({ slug, title, url });
    }
  }

  // Also try simpler pattern: anime card titles
  const re2 = /class="[^"]*film-name[^"]*"[^>]*>\s*<a[^>]*href="[^"]*\/anime\/([^"]+)"[^>]*>([^<]+)/gi;
  while ((m = re2.exec(html))) {
    const slug = m[1].replace(/\/$/, '');
    const title = m[2].trim();
    if (slug && title && !results.some(r => r.slug === slug)) {
      results.push({ slug, title, url: `${BASE}/anime/${slug}/` });
    }
  }

  cachePut(key, results, 10 * 60_000);
  return results;
}

// ─── Fetch watch page embed URLs ─────────────────────────────────────────────
async function getEpisodeEmbeds(animeSlug, episode) {
  const key = `embeds:${animeSlug}:${episode}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  // Try the watch URL pattern
  const watchUrl = `${BASE}/watch/${animeSlug}-episode-${episode}/`;
  const html = await fetchText(watchUrl, 12000);
  if (!html) { cachePut(key, null, 300_000); return null; }

  // Extract embed-id attributes (base64 encoded)
  const embeds = [];
  const embedRe = /data-embed-id="([^"]+)"/g;
  let m;
  while ((m = embedRe.exec(html))) {
    const raw = m[1];
    const parts = raw.split(':');
    if (parts.length === 2) {
      try {
        const serverName = Buffer.from(parts[0], 'base64').toString('utf-8');
        const url = Buffer.from(parts[1], 'base64').toString('utf-8');
        const isDub = serverName.toLowerCase().endsWith('dub');
        const isSub = serverName.toLowerCase().endsWith('sub');
        const server = serverName.replace(/(dub|sub)$/i, '').trim();
        embeds.push({ server, url, lang: isDub ? 'DUB' : isSub ? 'SUB' : 'DUB' });
      } catch {}
    }
  }

  // Also extract episode list from the page
  const episodes = [];
  const epRe = /\/watch\/[^"]*-episode-(\d+)/g;
  let ep;
  while ((ep = epRe.exec(html))) {
    const num = parseInt(ep[1], 10);
    if (!episodes.includes(num)) episodes.push(num);
  }
  episodes.sort((a, b) => a - b);

  const result = { embeds, episodes };
  cachePut(key, result, 30 * 60_000);
  return result;
}

// ─── Abyss player decryption (same as BanglaPlex) ───────────────────────────
function b64Pad(s) { const r = s.length % 4; return r ? s + '='.repeat(4 - r) : s; }

async function decryptAbyssMedia(blob, keyStr) {
  try {
    const md5hex = crypto.createHash('md5').update(keyStr).digest('hex');
    const keyBytes = new TextEncoder().encode(md5hex);
    const counter = new Uint8Array(keyBytes.slice(0, 16));
    const encBytes = new Uint8Array(blob.media.length);
    for (let i = 0; i < blob.media.length; i++) encBytes[i] = blob.media.charCodeAt(i);
    const key = await crypto.webcrypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR', length: 128 }, false, ['decrypt']);
    const algo = { name: 'AES-CTR', counter, length: 128 };
    const dec = await crypto.webcrypto.subtle.decrypt(algo, key, encBytes);
    return JSON.parse(new TextDecoder().decode(dec));
  } catch { return null; }
}

async function resolveAbyss(abyssUrl) {
  const key = `abyss:${abyssUrl}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const html = await fetchText(abyssUrl, 15000);
  if (!html) { cachePut(key, null, 600_000); return null; }

  // Extract the datas blob
  const dm = html.match(/const datas = "([^"]+)"/);
  if (!dm) { cachePut(key, null, 600_000); return null; }

  try {
    const blob = JSON.parse(Buffer.from(dm[1], 'base64').toString('latin1'));
    const keyStr = `${blob.user_id}:${blob.slug}:${blob.md5_id}`;
    const media = await decryptAbyssMedia(blob, keyStr);
    if (!media) { cachePut(key, null, 600_000); return null; }

    // media is an array of objects with source/file URLs
    const sources = [];
    if (Array.isArray(media)) {
      for (const item of media) {
        if (item.file) sources.push({ url: item.file, label: item.label || 'Default' });
        if (item.source && Array.isArray(item.source)) {
          for (const s of item.source) {
            if (s.file) sources.push({ url: s.file, label: s.label || item.label || 'Default' });
          }
        }
      }
    } else if (media.file) {
      sources.push({ url: media.file, label: 'Default' });
    }

    cachePut(key, sources, 6 * 3600_000);
    return sources;
  } catch { cachePut(key, null, 600_000); return null; }
}

// ─── Resolve VMoly embed ────────────────────────────────────────────────────
async function resolveVMoly(vmolyUrl) {
  const key = `vmoly:${vmolyUrl}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const html = await fetchText(vmolyUrl, 12000);
  if (!html) { cachePut(key, null, 600_000); return null; }

  // VMoly usually has a file/sources in a JavaScript variable
  const fileMatch = html.match(/(?:file|source|url)\s*[:=]\s*["'](https?:\/\/[^"']+)["']/i);
  if (fileMatch) {
    cachePut(key, [{ url: fileMatch[1], label: 'Default' }], 6 * 3600_000);
    return [{ url: fileMatch[1], label: 'Default' }];
  }

  // Try eval/sources pattern
  const sourcesMatch = html.match(/sources\s*:\s*(\[[\s\S]*?\])/);
  if (sourcesMatch) {
    try {
      const sources = JSON.parse(sourcesMatch[1]);
      const result = sources.map(s => ({ url: s.file || s.src || s.url, label: s.label || 'Default' })).filter(s => s.url);
      cachePut(key, result, 6 * 3600_000);
      return result;
    } catch {}
  }

  cachePut(key, null, 600_000);
  return null;
}

// ─── Match anime title to IMDb ID ───────────────────────────────────────────
async function findImdbId(title, year) {
  const key = `imdb-search:${title.toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  try {
    const cleanTitle = title.replace(/\s*\[.*?\]\s*/g, '').replace(/\s*\(.*?\)\s*/g, '').trim();
    const l = cleanTitle[0]?.toLowerCase() || 'x';
    const r = await fetch(`${IMDB_SUGGEST}/${l}/${encodeURIComponent(cleanTitle)}.json`, {
      signal: AbortSignal.timeout(5000), headers: { 'User-Agent': UA },
    });
    if (!r.ok) { cachePut(key, null, 3600_000); return null; }
    const d = await r.json();
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(cleanTitle);
    for (const e of (d.d || [])) {
      if (!e.id?.startsWith('tt')) continue;
      const en = norm(e.l || '');
      if (en === want || en.includes(want) || want.includes(en)) {
        cachePut(key, e.id, 24 * 3600_000);
        return e.id;
      }
    }
    // Fallback: first tt result
    const first = d.d?.find(e => e.id?.startsWith('tt'));
    if (first) {
      cachePut(key, first.id, 24 * 3600_000);
      return first.id;
    }
  } catch {}
  cachePut(key, null, 3600_000);
  return null;
}

// ─── Manifest ────────────────────────────────────────────────────────────────
const MANIFEST = {
  id: 'community.desidubanime',
  version: VERSION,
  name: 'DesiDubAnime',
  description: 'Hindi/Tamil/Telugu/Bengali dubbed anime from DesiDubAnime.me — Abyss player resolved, direct HLS streams.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: false, configurationRequired: false },
};

// ─── Landing Page ────────────────────────────────────────────────────────────
const LANDING_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DesiDubAnime — Stremio Addon</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:#0b0e14;color:#e8eaf0;min-height:100vh}
  .wrap{max-width:880px;margin:0 auto;padding:48px 20px 64px}
  header{text-align:center;margin-bottom:36px}
  h1{font-size:34px;font-weight:800;margin-top:16px}
  h1 span{background:linear-gradient(90deg,#ff6b35,#ffc107);-webkit-background-clip:text;background-clip:text;color:transparent}
  .tag{color:#9aa3b2;margin-top:8px;font-size:15px;line-height:1.6}
  .install{display:inline-block;margin-top:26px;padding:15px 42px;border-radius:12px;background:linear-gradient(90deg,#e65100,#ff6b35);color:#fff;font-size:18px;font-weight:700;text-decoration:none;box-shadow:0 6px 24px rgba(230,81,0,.45);transition:transform .15s}
  .install:hover{transform:translateY(-2px)}
  .note{color:#7c8596;font-size:13px;margin-top:12px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:40px}
  .card{background:#141925;border:1px solid #232b3d;border-radius:14px;padding:20px}
  .card h3{font-size:16px;margin-bottom:8px;color:#ff6b35}
  .card p{font-size:14px;color:#aab3c2;line-height:1.55}
  .b{color:#5dd3ff;font-weight:600}
  .badge{display:inline-block;background:#e65100;color:#fff;padding:3px 10px;border-radius:12px;font-size:11px;margin:2px}
  footer{margin-top:44px;text-align:center;color:#5c6675;font-size:13px;line-height:2}
  footer a{color:#5dd3ff;text-decoration:none}
</style></head><body><div class="wrap">
<header>
  <h1>Desi<span>Dub</span>Anime</h1>
  <div class="tag">
    <span class="badge">Hindi</span><span class="badge">Tamil</span><span class="badge">Telugu</span>
    <span class="badge">Bengali</span><span class="badge">Malayalam</span><span class="badge">Kannada</span>
    <br><br>
    Indian regional dubbed anime &mdash; <span class="b">Abyss player resolved</span>, direct streams.
  </div>
  <a class="install" id="install" href="#">⬇ Install in Stremio</a>
  <div class="note">works on Stremio desktop, Android, Android TV &amp; Firestick</div>
</header>

<div class="grid">
  <div class="card"><h3>🗣️ Multi-Language Dubs</h3>
    <p>Hindi, Tamil, Telugu, Bengali, Malayalam, Kannada &mdash; every available dub as a separate stream card.</p></div>
  <div class="card"><h3>🔓 Abyss Player Resolved</h3>
    <p>Abyss player streams are <span class="b">decrypted (AES-CTR)</span> and served as direct HLS &mdash; plays in Stremio app.</p></div>
  <div class="card"><h3>📺 Multiple Servers</h3>
    <p>Mirror, Streamp2p, Abyss, VMoly &mdash; fallback chain ensures streams always work.</p></div>
  <div class="card"><h3>⚡ Zero Bandwidth</h3>
    <p>Server only resolves tiny JSON. Video plays <span class="b">direct from CDN</span>.</p></div>
</div>

<footer>
  v${VERSION} &middot; <a href="/manifest.json">manifest.json</a> &middot; <a href="/health">health</a>
</footer>
</div>
<script>document.getElementById('install').href='stremio://'+location.host+'/manifest.json';</script>
</body></html>`;

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/manifest.json', (req, res) => res.json(MANIFEST));
app.get('/health', (req, res) => res.json({ ok: true, version: VERSION, cache: _cache.size, uptime: Math.round(process.uptime()) }));

app.get('/stream/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!['movie', 'series'].includes(type)) return res.json({ streams: [] });

    const parts = id.replace(/\.json$/, '').split(':');
    const imdb = parts[0];
    if (!imdb?.startsWith('tt')) return res.json({ streams: [] });

    const season = parts[1] ? parseInt(parts[1], 10) : 1;
    const episode = parts[2] ? parseInt(parts[2], 10) : 1;

    // Get title from IMDb/Cinemeta
    const meta = await getMeta(type, imdb);
    if (!meta?.name) return res.json({ streams: [] });

    // Search DesiDubAnime
    const results = await searchAnime(meta.name);
    if (!results.length) return res.json({ streams: [], message: 'not found on DesiDubAnime' });

    // Best match
    const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const want = norm(meta.name);
    let best = results.find(r => norm(r.title) === want || norm(r.title).includes(want) || want.includes(norm(r.title))) || results[0];

    // Get episode embeds
    const epData = await getEpisodeEmbeds(best.slug, episode);
    if (!epData?.embeds?.length) return res.json({ streams: [], message: 'no embeds found' });

    const streams = [];

    // Resolve each server
    for (const embed of epData.embeds) {
      if (embed.server.toLowerCase().includes('abyss')) {
        // Resolve Abyss player — direct HLS
        const sources = await resolveAbyss(embed.url);
        if (sources?.length) {
          for (const src of sources) {
            streams.push({
              name: `[ DesiDubAnime ] 🎬 Abyss ${embed.lang}`,
              title: `${best.title} E${episode}\nAbyss · ${embed.lang} · HLS`,
              url: src.url,
              behaviorHints: { notWebReady: false },
            });
          }
        }
      } else if (embed.server.toLowerCase().includes('vmoly')) {
        // VMoly — try to resolve
        const sources = await resolveVMoly(embed.url);
        if (sources?.length) {
          for (const src of sources) {
            streams.push({
              name: `[ DesiDubAnime ] 🎬 VMoly ${embed.lang}`,
              title: `${best.title} E${episode}\nVMoly · ${embed.lang}`,
              url: src.url,
              behaviorHints: { notWebReady: false },
            });
          }
        }
        // Fallback: browser embed
        if (!sources?.length) {
          streams.push({
            name: `[ DesiDubAnime ] 🌐 VMoly ${embed.lang}`,
            title: `${best.title} E${episode}\nVMoly · ${embed.lang} · Browser`,
            externalUrl: embed.url,
            behaviorHints: { notWebReady: true },
          });
        }
      } else {
        // Mirror, Streamp2p — browser embeds
        streams.push({
          name: `[ DesiDubAnime ] 🌐 ${embed.server} ${embed.lang}`,
          title: `${best.title} E${episode}\n${embed.server} · ${embed.lang} · Browser`,
          externalUrl: embed.url,
          behaviorHints: { notWebReady: true },
        });
      }
    }

    return res.json({ streams });
  } catch (e) {
    console.error('Stream error:', e.message);
    return res.json({ streams: [] });
  }
});

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(LANDING_HTML);
});

// ─── Boot ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`DesiDubAnime v${VERSION} on :${PORT}`);
});