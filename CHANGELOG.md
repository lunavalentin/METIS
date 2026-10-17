# METIS change log

## 2026-10-16 — v0.2 dark identity, ESAAA groundwork, publishing

**Changes**
- Always dark (Luna's request): one dark token set; the light theme and the `prefers-color-scheme` switch are removed; the muted basemap is always inverted.
- Display font **Syne** (Google Fonts) for the METIS wordmark (gradient fill), panel titles and dialog titles; Inter stays for body text.
- New logo `assets/metis-logo.svg`: off-centre rings around a dot (map contour lines and a sound wavefront from a source),
  with a violet→pink gradient. It is also the favicon. A first version with 4 rings and a "tick" was dropped because it was illegible at 16 px.
- Floor switcher is now a vertical stack (top floor on top), because ESAAA has many split levels (Wogenscky R2–R4, Miquel parvis level).
- New metadata field `credit` (for archive photos, e.g. Fondation Marta Pan – André Wogenscky).
- Template map centre set to ESAAA (45.8932, 6.1352), from the OSM building "École Supérieure d'Art Annecy Alpes" (way 40958449) via Nominatim.
- `tools/create_accounts.mjs`:
  - runs under Deno (`tools/deno.json` maps `firebase-admin/` → `npm:firebase-admin@13.4.0`);
  - new `--dry-run` flag;
  - new `projectId` argument; creates `projects/<id>` with `public: false` if it is missing.
- Auto-update: `.github/workflows/notify-instances.yml` and `instances.json`; the matching sync workflow lives in each instance.

**Tests**
- `create_accounts.mjs --dry-run` with a 2-row CSV under Deno 2: prints the expected emails and roles; exit code 0.
  The real Firebase path was not run (no project yet).
- Headless Chrome screenshots of the dark UI with the panel open, and of the logo at 256/64/16 px: these render correctly.

## 2026-10-16 — v0.1.1 visual refresh

**Changes**
- `index.html`: full restyle. Inter font; colour tokens with light/dark; full-bleed map with a floating glass header;
  a segmented floor switcher (bottom-left); an "add place" floating button (bottom-centre, icon-only on phones);
  the point panel as a floating card (desktop) or a bottom sheet with a grab handle (≤ 640 px); segmented tabs with
  item counts; rounded cards, tag pills, restyled dialogs, inputs, file picker, progress bar, and Leaflet controls.
- `scripts/map.js`:
  - custom pin markers (`L.divIcon`) whose number shows how many media types a place has;
  - zoom and layer controls moved bottom-right;
  - default base map "Plan" = OSM tiles muted with a CSS filter (inverted in dark mode).
  - **Fix**: place names in tooltips are now HTML-escaped (Leaflet renders tooltip strings as HTML, so this was an XSS hole).
- `scripts/main.js`: floor buttons in place of the select; avatar initials for the logged-in user; panel kicker
  ("n items · n contributors"); `panel-open` / `adding` body classes for the layout.
- `i18n/*.json`: added `itemsN`, `contributors`.

**Dead end**: tried CARTO Positron / Dark Matter tiles. They now return "API KEY REQUIRED" images, so they were replaced by filtered OSM.

**Tests**: headless Chrome screenshots of a static-backend demo with fake data (scratchpad copy, not in the repo):
desktop light, desktop dark, and phone 390 px (inside an iframe, because headless Chrome enforces a minimum window
width). The map, pins, tooltip, panel, tabs and cards render correctly. Fixed during the test: the empty-place pin
inherited `.empty` padding (renamed `.pin-empty`); map controls overlapped the open panel; the active tab was too
faint in dark mode.
**Not visually checked**: the dialogs (login, add place, add content), the FAB, and the sound and 360 tabs. The static demo hides them.

## 2026-10-16 — v0.1 draft (first session)

**Decisions**: see SPEC.md §2 (Q&A with Luna). From-scratch codebase; Firestore + Cloudinary (no Firebase Storage,
which now requires the Blaze plan); instructor-made accounts with role claims; plans georeferenced on OSM.

**Files created**
- `SPEC.md` — design draft v0.1 (architecture, data model, UI, audio engine, rules, timeline, open questions).
- `index.html` — layout + CSS (responsive; bottom-sheet panel under 640 px; light/dark).
- `config.json` — template config. Map centre `[45.8992, 6.1294]` is a placeholder in central Annecy, NOT the verified ESAAA location.
- `scripts/main.js` — UI: login, charter, add point (+GPS), point panel tabs, add-item form, 360 viewer, sound tab.
- `scripts/backend.js` — Firebase (Auth + Firestore) and static backends behind one API.
- `scripts/map.js` — Leaflet geo/plan modes, rotated plan overlays (centre + metres + rotation), floor switcher, markers.
- `scripts/upload.js` — Cloudinary unsigned upload with progress; image resizing; IRs uploaded as `raw`.
- `scripts/audio.js` — convolution engine: mono/stereo/binaural; FOA (AmbiX/FuMa) via 4 mono convolvers → max-rE decoder → 8 HRTF panners; listener orientation follows the pano yaw/pitch; live mic.
- `scripts/irAnalysis.js` — Schroeder EDC, EDT/T20/T30, C50/C80/D50, raw clap cleanup.
- `scripts/i18n.js`, `i18n/{fr,en}.json` — FR/EN UI.
- `firestore.rules` — read if public or signed in; owner/staff edit; staff-only hide.
- `tools/create_accounts.mjs`, `tools/freeze.mjs` — admin scripts (Node + firebase-admin).
- `charter/{fr,en}.md` — placeholders.

**Tests**
- `deno run tests/irAnalysis.test.mjs` (synthetic exponential-decay noise, RT60 = 1.2 s, fs = 48 kHz): 9/9 PASS.
  T30 = 1.194 s, T20 = 1.188 s, EDT = 1.209 s, C80 = 1.658 dB (analytic 1.795 dB, tolerance ±0.5), onset 0.100 s.
  The D50 check is only a range check (0–1), not a real test.
- `deno lint`: only `require-await` style warnings remain.
- Headless Chrome smoke test (local http.server, placeholder Firebase config): page renders the map, header, FR strings.
  No JS interaction was exercised.

**Not tested yet**: anything needing real Firebase/Cloudinary (login, uploads, rules), the audio engine in a browser
(FOA decoder signs/orientation, iOS Safari), Pannellum CORS with Cloudinary, create_accounts.mjs, freeze.mjs, and the rules in the emulator.

**Known issues / next steps**
- The point panel re-renders on every item snapshot, so playback/pano stops when someone else uploads to the same point.
- `hidden` is filtered in the UI only.
- Layers are in config.json; the admin page and placement helper (SPEC §6) are not written yet.
- Cloudinary free-plan per-file limits are unknown; check them in Console → Settings → Usage limits.
- Freeze: local thumbnails are not generated.
