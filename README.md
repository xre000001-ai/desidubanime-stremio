# DesiDubAnime — Stremio Addon (v2.1.0)

Hindi / Tamil / Telugu / Bengali **dubbed anime** from [desidubanime.me](https://www.desidubanime.me) — direct streams, zero server bandwidth.

**Install:** `stremio://5a16d5684c14-desidubanime-stremio.baby-beamup.club/manifest.json`

## How stream finding works (NETHUB-style)
1. **Search** — Cinemeta/IMDb name → site's Kiranime REST search (`/wp-json/kiranime/v1/anime/search`) + WP JSON search in parallel → anime slug.
2. **Episodes** — anime page → real `watch/<slug>-episode-N/` links (cached 1 h).
3. **Servers** — watch page `data-embed-id` (base64 server:url) → Abyss / Mirror / VMoly / Streamp2p / PlayerX.
4. **Resolve** —
   - **VMoly**: page regex → direct HLS through our `/hz/` re-manifestor (quality switching when the source has multiple video variants; हिन्दी/தமிழ்/తెలుగు/English/日本語 multi-audio passthrough) ✅ verified playable
   - **Abyss**: embed-page `datas` blob decrypted locally — AES-256-CTR, key `md5hex(user_id:slug:md5_id)` → full per-quality metadata (360p–1080p, size, codec) → in-app webview player card (`abysscdn.com/?v=<slug>`); direct `/info` attempt kept for deployments that expose it
   - **Mirror (filesforever)**: `/embedhelper2.php` POST (sid + view_token) → browser fallback
   - **Streamp2p / PlayerX**: browser fallback
5. Every direct URL is **range-probed** before the card is served; unresolvable servers get an honest `· Browser` card (opens the embed).
6. Caches (search 6 h, episodes 1 h, embeds 30 m, streams 90 m), 11.5 s wall with "resolving" retry, **binge prewarm** (+2 episodes), background re-resolve of empty results, proxy-pool fallback for blocked API hops.

## Local dev
```
npm install && NMDEBUG=1 PORT=7123 node server.js
```

Deployed on beamup as `5a16d5684c14-desidubanime-stremio`.
