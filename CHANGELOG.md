# METIS change log

## 2026-10-17 — v0.9.3 ambisonic IRs: processing verified, format auto-detected, 360° link always visible

- **Ambisonics compliance tested** (`tests/irprocess.test.mjs`, now 19/19): a 4-channel AmbiX IR with known channel gains
  (W 1, Y 0.6, Z −0.3, X 0.75), (a) normalise + align + trim, (b) METIS-sweep deconvolution + all → 4 channels of equal length,
  **ratios and signs kept to < 1e-3**, one common gain (loudest channel −1.00 dBFS). By design: same cut, same gain, same linear filter
  on every channel; the 24-bit WAV keeps the channel order.
- IR form: the format is preselected from the file's channel count (4 → AmbiX unless FuMa is already chosen; 2 → stereo unless
  binaural is chosen; 1 → mono), with a note telling the user to check it. `checkFile` now reports `info.channels`.
- "Photo 360° liée (CAVERN)" is always shown in the IR form. Without a 360° in the place it is disabled, with a hint; the reverse
  ("Réponse impulsionnelle liée" in the 360° form) likewise. Before, it was hidden, which looked like a missing feature.
- Browser test (mock): the hint is shown in a place without a 360°; a 4-ch file → AmbiX + note; the processed preview has 4 channels
  and T30 1.21 s (synthetic IR built with RT 1.2 s); in a place with a 360°, the link offers it. No errors.

## 2026-10-17 — v0.9.2 convolution levels fixed (no more saturation); sweep no longer preselects a deconvolution

- Choosing "sinus glissant (sweep)" no longer preselects the METIS-sweep deconvolution; the default stays "Aucune" (Luna's request).
- **Saturation, measured** (OfflineAudioContext in headless Chrome, the real `buildChain`, the 3 provided samples at −1 dBFS peak,
  IRs normalised to −1 dBFS: mono RT 1.1 s, stereo and FOA AmbiX RT 1.2 s): output peaks were **+6 to +34 dBFS**, with up to 160 000 clipped samples.
  Cause: the convolvers run with `normalize = false`, so the IR's whole energy is added at unity gain.
- **Fix** (`scripts/audio.js`):
  1. `irGain()`: input gain = 10^(−6/20) / √(energy of the reference channel) (W for FOA, ×2 for FuMa W; the louder of the first two channels
     otherwise), with the same factor on all channels;
  2. +6 dB FOA make-up (the 8-speaker binaural decode measured 5.8–6.6 dB quieter);
  3. `DynamicsCompressor` limiter (−6 dB threshold, ratio 20, 2 ms attack) placed **after** the volume slider;
  4. a final soft clipper (WaveShaper, linear below 0.8, tanh rounding, ≤ 0.95).
  `buildChain` accepts an optional context (for offline tests).
- **After** (same measurement): no clipped sample in any of the 9 IR × sample cases, at volume 1.0 or at the slider maximum 1.5.
  Pluck ≈ −6 dBFS, claps ≈ −14 dBFS, sweep ≈ −0.6 dBFS. Mono, stereo and FOA agree within ≈ 1 dB.
  Mistake along the way: the first soft-clip curve assumed an input range of ±2, but WaveShaper curves span −1…+1, so it doubled quiet signals
  (+6 dB, clipping everywhere). The measurement caught it, and it was fixed.
- The full UI walkthrough still passes (Acoustique and CAVERN play; analysis unchanged).
- Not tested: real devices' output stages; real measured IRs with strong low-frequency modes (the limiter handles them, but untested).

## 2026-10-17 — v0.9 IR processing at upload (normalise, align, trim, sweep deconvolution)

Luna asked for advanced IR options: normalise, align (remove pre-delay), deconvolve a sweep, etc.

**New `scripts/irprocess.js`** (pure functions; own radix-2 FFT):
- **Deconvolution of a recorded exponential sweep**: (a) parametric ESS (Farina inverse filter: time-reversed sweep with a −6 dB/oct
  envelope, gain-calibrated in-band), with the **METIS sweep preset** (100 Hz–8 kHz, 1.5 s, 20 ms fades = `assets/samples/sweep.wav`) or
  custom f1/f2/duration; (b) **reference file**: regularised spectral division Y·X*/(|X|²+ε), ε = −40 dB of max |X|².
- **Align**: onset at −20 dB of the peak, searched within 50 ms before the peak (so ESS harmonic responses, ≥ 237 ms earlier for the
  METIS sweep, are ignored); keeps 2 ms. Same cut on all channels.
- **Trim**: cut where the 10 ms energy envelope comes within +3 dB of the noise floor, then a 10 ms fade. The floor is the median of the
  last 20 % of the non-silent signal.
- **Normalise**: peak at −1 dBFS. Output: **24-bit WAV, every channel kept**. After a deconvolution, align + trim always apply.
- IR form → "Options avancées": the checkboxes, a deconvolution choice (method "sweep" preselects the METIS sweep), **"Appliquer et écouter"**
  (preview player + duration, channels, removed pre-delay, T30, EDT), and automatic processing on save if not previewed.
  This replaces the old "raw clap/balloon" checkbox (old items keep their flag). The processing history is stored in
  `irInfo.processing` and shown in the IR's metadata.

**Tests** (`tests/irprocess.test.mjs`, 13/13 PASS; synthetic room IR: 30 ms pre-delay + direct + noise tail RT = 0.8 s, METIS sweep, noise 1e-4):
- ESS: correlation **1.0000 at lag 0** with the true IR in the same band; T30 0.797 vs 0.797 s; peak −1 dBFS; onset at 2.2 ms.
- Reference file: correlation 0.991 at a 6-sample (0.13 ms) offset (a different pulse shape from the ESS kernel); T30 0.799 s.
- Pre-delay removal on the true IR: 28.00 ms removed (expected 28). Tail trim at a −54 dB floor keeps 0.61 s (expected 0.5–0.65 s).
- Corrections to *my test design* along the way: (1) comparing a 100 Hz–8 kHz result with a full-band truth was meaningless → the test now
  compares in the same band; (2) I expected the deconvolved tail to hit the noise at ≈ 0.84 s, but the measured envelope shows the ESS
  SNR gain keeps the decay clean down to ≈ −114 dB at 1.6 s → the expectation was corrected. A real fix came out of it: the trim's
  noise-floor estimate now ignores trailing digital silence, which had prevented any trimming.
- Browser (mock + real Cloudinary upload): a 3.5 s recording of the METIS sweep → preview "2.01 s, T30 0.80 s, EDT 0.78 s"; with the
  reference file → "1.51 s, T30 0.80 s". The processed 24-bit WAV (217 KB) was uploaded and stored with its processing history.
  The removed pre-delay was first shown as 1927.8 ms (it included the 1.5 s deconvolution shift) → now only the acoustic pre-delay is reported.
- **Not tested**: real measured sweeps, multichannel (FOA) sweep recordings in the browser, and speed on phones (FFT of ~2^18–2^20 points).

## 2026-10-17 — v0.8.1 no stale translations after an update

- Luna saw raw keys (`add_text`, `f_creditText`) right after v0.8 went live. The live `i18n/*.json` were correct, but her browser
  had reused a cached copy (GitHub Pages sends `max-age=600`) next to the new `main.js`. `config.json` and `i18n/*.json` are now
  fetched with `cache: 'no-cache'` (always revalidated; 304 when unchanged). JS modules can still be mixed for up to 10 min after a deploy.

## 2026-10-17 — v0.8 clean upload forms; IRs only in Acoustique

- **IRs live in Acoustique**: the Sons tab lists and adds recordings only. Acoustique has "+ Réponse impulsionnelle", the player,
  the analysis and the IR cards (edit/hide/delete). IRs now have their own per-place limit (`perPlace.irs` = 3; before, they shared
  "sounds" with recordings). Admins can raise it in "Modifier le lieu".
- **One form per type** (`FORM_FIELDS`), with no "Type" dropdown (the button chooses it) and a type-specific title ("Ajouter une photo"…).
  The place questions (who uses / intended / non-intended uses) are removed from every file form; they belong to the place.
  - Photo: file, title, date, description, sensory notes, credit, tags.
  - 360°: same + linked IR; orientation under "Options avancées".
  - Video: link, title, date, description, credit, tags.
  - Recording: file, title, date, description, sensory notes, conditions, recording device, credit, tags.
  - IR: file, title, date, format (readable names: "Ambisonique 1er ordre — AmbiX (4 canaux)"…), method, "raw clap/balloon"
    (only shown for clap/balloon), source, receiver/mic, linked 360°, description, tags; mic orientation under "Options avancées".
  - Text: title, text (1 000), author/source, tags.
- Editing only writes the fields its form shows; the other metadata keeps its value. Before, every metadata key was rewritten, so
  hiding fields could have erased values.
- Tests (mock, headless Chrome): fields per form as listed; Sons buttons = audio only; Acoustique buttons = IR only; the raw checkbox
  is hidden for sweeps; editing a photo's title keeps a hidden `users` value; the full walkthrough passes (tabs, players, CAVERN, edit,
  delete, logout, EN). No errors.

## 2026-10-17 — v0.7.1 cleanup verified live

- First dry run failed: Cloudinary answered "unknown api_key". Added a diagnostic that describes the shape of rejected credentials
  (never their value): it showed 10-character non-numeric values instead of the 15-digit key / ~27-character secret. Luna re-entered them.
- Dry run: 1 place, 3 files in use, 20 stored, 17 orphaned (4 younger than 1 h). The 13 listed were all test files from earlier checks.
- The "Nettoyer maintenant" button first failed with GitHub 403 (token had Actions: Read-only); fixed with Actions: Read and write.
- **Live run from the button** (trigger "admin: Luna"): 13 deleted, 1.4 MB freed. Two of them, checked afterwards, now return 404
  on Cloudinary. The 3 files of Luna's "Imaginary Place" were kept. The remaining 4 recent orphans go in the next nightly run.

## 2026-10-17 — v0.7 Cloudinary cleanup (deleted files really removed)

**Problem verified on the live services**: deleting a file or a place on the site removed the Firestore document, but the file stayed on
Cloudinary (HTTP 200 afterwards). An unsigned preset can upload but never delete, and deleting needs the API secret, which cannot be in the page.

**Fix** (Luna chose the nightly-cleanup option and asked for an "instant clean" button):
- `tools/cleanup.mjs` (template, synced): logs in as bot account `nettoyage` (new role `service`) and lists every item's
  `media.publicId` in Firestore. It then lists Cloudinary `image`/`video`/`raw` assets under `config.cloudinary.folder` (Admin API) and deletes
  those that are no longer referenced and are older than 1 h, with `invalidate=true` so derived thumbnails and CDN copies go too. It writes a
  report to `projects/<id>/admin/cleanup` and the Actions summary. **Safety stop**: if Firestore lists no referenced file while Cloudinary
  holds more than 5, nothing is deleted (`FORCE=1` overrides). `--dry-run` lists without deleting.
- ESAAA `.github/workflows/cleanup.yml`: runs nightly at 02:00 UTC and on `workflow_dispatch` (inputs `dry_run`, `trigger`).
  Secrets: `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (to be set by Luna), `METIS_BOT_PASSWORD` (set).
- ⚙ Réglages: a "Nettoyage du stockage" section with the last report, a GitHub token field, and **Nettoyer maintenant** / **Simulation**
  buttons. These start the workflow through the GitHub API, then wait for the bot's report.
  The token is stored in `projects/<id>/admin/settings` (admins only).
- Rules: `projects/{pid}/admin/{doc}` is read by admins only and written by admins, plus the service role for `cleanup` only.
  `make_auth_import.mjs` accepts the `service` role. `config.project.repo` (ESAAA: `lunavalentin/METIS_ESAAA`) turns the section on.

**Tests**
- The bot logs in with role `service`.
- Rules on the live project: the bot writes `admin/cleanup` (200), but cannot write or read `admin/settings` (403);
  a student can neither read nor write `admin/cleanup` (403).
- `cleanup.mjs --dry-run` against the live Firestore with fake Cloudinary keys: login, settings and every place/item listed OK;
  it stopped at the Cloudinary listing (401 "unknown api_key"), as expected without the real keys.
- ⚙ section (mock, headless Chrome): the report line, the buttons, and the missing-token message render; no errors.
- **Not tested yet**: a real Cloudinary list/delete and the GitHub-API trigger. These need Luna's Cloudinary API key/secret and a fine-grained token.

## 2026-10-17 — v0.6.4 add buttons per tab

- No add button on Infos any more. Galerie shows "+ Photo", "+ Image 360°" and "+ Vidéo (lien)"; Sons shows "+ Enregistrement audio"
  and "+ Réponse impulsionnelle"; Textes shows "+ Texte". Each shows n/max and is disabled at its limit ("limite atteinte").
  Video links have no limit. A button opens the form with the type fixed. Before, a single "add" button pre-selected the
  first type that was not full, so video only appeared once the images were full.
- Type badge on cards no longer stretches across the card.
- Checked in headless Chrome (mock): buttons per tab, counts and disabled states, the "+ Vidéo (lien)" form (type locked,
  no file field), saving a YouTube link. No errors.

## 2026-10-17 — v0.6.3 image form without the place questions

- Photo and 360° uploads no longer ask the place-level questions ("Qui utilise cet espace ?", "Usage prévu", "Usages non prévus
  observés"); these belong to the place (Infos tab). Still asked for recordings, IRs and texts. Hidden fields keep existing values when editing.
- Checked in headless Chrome (mock): the visible fields per type match the above.

## 2026-10-17 — v0.6.2 uploads verified on the live site; automatic retry

**Cloudinary connected**: cloud `cwmp8wdp`, unsigned preset `metis_esaaa` (saved by Luna in ⚙ Settings → Firestore).

**Tests on real services**
- curl upload of each type through the preset: photo/360° (`image`), recording (`video`), IR (`raw`) all OK.
  Delivery sends `Access-Control-Allow-Origin: *`; the IR and the recording come back **byte-identical** (md5);
  the `c_limit,w_800` thumbnail transform works. A BMP was also accepted, so the preset's "Allowed formats" is not set yet
  (the site refuses BMP on its own).
- **End-to-end on the live site** (headless Chrome, student `basalte`): login, charter, new place on R3, upload of photo + 360° +
  recording + IR linked to the 360° → "4 contenus"; Acoustique plays; analysis of the IR loaded from Cloudinary is
  EDT 1.09 / T20 1.10 / T30 1.10 s (test IR built with RT = 1.1 s); the CAVERN view loads the 360° from Cloudinary and plays;
  gallery thumbnails load; the place was then deleted, and Firestore was checked to hold only Luna's "Imaginary Place".
- Mishaps during testing, all from my test scripts, not the site:
  - a wrong file path crashed a run halfway → its leftover place was deleted through the REST API;
  - a run reused a logged-in browser profile → invalid, rerun with a fresh profile and stricter success checks;
  - output was buffered by a `grep` pipe.

**Change**: `upload.js` now retries network failures and Cloudinary 5xx/420/429 twice (after 1.5 s, then 4 s).
Other Cloudinary errors show Cloudinary's own message, and the final network failure shows a clear message.
Real network errors happened once during the live test. Verified by forcing the first request to fail (CDP `Fetch.failRequest`):
the upload succeeded on the retry, after 2.3 s.

**Leftovers**: about 9 small test files in Cloudinary under `metis/esaaa/` (the site cannot delete Cloudinary files);
they can be removed in the Media Library.

## 2026-10-17 — v0.6.1 admins can upload heavier / longer files

- When a file is over the size or duration limit, admins get an extra **"Envoyer tel quel (admin)"** button next to Compress / Convert.
  It skips only `lim_imageBig`, `lim_soundBig` and `lim_soundLong`. Format checks and the AIFF → WAV conversion still apply.
  There is a hard ceiling of `limits.adminMaxMB` = 50 MB per file. The form hint tells admins about it, and the file line shows
  "limite levée par un·e admin".
- Tests (mock, headless Chrome): admin + 34 MB PNG → override offered and accepted; admin + 66 MB WAV → no override
  (over 50 MB), only trim/convert; student + 34 MB PNG → only Compress. No errors.
- Open: Cloudinary free-plan per-file maximums are unverified. An admin upload above them will fail with Cloudinary's error.

## 2026-10-17 — v0.6 bounded uploads (Cloudinary kept)

Luna considered Firebase Storage, but it needs the Blaze plan and a card, which cannot be hard-capped. After comparing the
options she chose to stay on Cloudinary's free plan (no card, no billing risk) and asked for strict limits.

**Limits** (`config.limits`; defaults in `scripts/media.js`):
- **Images**: JPEG/PNG only; photo ≤ 2 MB, 360° ≤ 6 MB. If bigger → warning + **Compress** (canvas → JPEG, longest side 2560 / 5760 px,
  quality stepped 0.88 → 0.55 until under the limit).
- **Sounds**: MP3/WAV/AIFF only; ≤ 5 min and ≤ 10 MB. Too long → **Keep the first 5 minutes and convert**; too big →
  **Convert** (recordings → MP3 128 kbps stereo / 96 mono via lamejs 1.2.1 from cdnjs; IRs → 16-bit WAV, keeping every channel).
  **AIFF** is always converted to WAV (lossless; own AIFF/AIFF-C parser), because Chrome cannot decode AIFF.
- **Texts**: 1 000 characters (textarea maxlength + counter; also enforced in `firestore.rules` → `textOk()`).
  Other metadata fields: 1 000 (textareas) / 200 (single-line).
- **Per place**: 3 images (photo + 360°), 3 sounds (recording + IR), 5 texts. Full types are disabled in the form;
  **admins** can raise the limits per place in "Modifier le lieu" (`point.limits`; a rule now allows only admins to change it).
- **Video**: links only (YouTube/Vimeo, validated); no video files. Automatic resizing in `upload.js` was removed
  (compression is now explicit, as requested).

**Tests**
- Conversions (headless Chrome, `limtest.html` in the scratchpad):
  - 34 MB PNG photo → 1.70 MB JPEG 2560×1920; as a 360° → 5.42 MB JPEG; BMP refused; small JPEG accepted unchanged.
  - 6-min stereo WAV (66 MB) → 4.57 MB MP3, 4:59.8. **Bug found and fixed**: MP3 padding made a file trimmed to exactly 5:00
    fail the re-check; it now trims to 4:59.75 with a 0.5 s tolerance.
  - 11 MB 24-bit 4-channel IR → 7.32 MB 16-bit WAV, still 4 channels.
  - 16-bit stereo and 24-bit mono AIFF → WAV, decoded correctly.
- Form (mock backend): at 3 images, photo/360° are disabled; text capped at 1 000; a bad video link is refused;
  admin raises images to 4 → stored, and photo/360° are enabled again. No errors.
- **Not tested**: a real Cloudinary upload (account pending); MP3 encoding speed on phones.

## 2026-10-17 — v0.5 admin settings: file storage + visibility

- **Settings dialog** (gear icon, admins only):
  - Cloudinary cloud name + unsigned upload preset, stored in Firestore `projects/<id>/private/settings`
    (signed-in users can read it, admins write it; new rule). It is no longer in the public `config.json`, because Cloudinary
    advises treating the preset name as sensitive. `config.cloudinary` now only keeps `folder`.
  - "Projet public" switch, writing `projects/<id>.public`, with a confirmation before going public.
- Upload errors: the storage configuration is checked before any image processing (`UPLOAD_NOT_CONFIGURED`), and an unreadable
  image (e.g. HEIC in Chrome) gives a clear message (`IMAGE_DECODE`).
- Tests (mock backend, headless Chrome): the gear is shown for admins; an upload without settings shows the
  "not configured" message; saving stores the settings; going public asks for confirmation; no errors.
  Not tested: a real upload (waiting for Luna's Cloudinary account).

## 2026-10-17 — v0.4.2 CAVIAR → CAVERN (naming correction)

Luna meant **CAVERN** (her CAVERN template: 360° photo + IR convolution), not CAVIAR. The behaviour is unchanged.
Renamed the UI strings (FR/EN), the i18n keys (`openCavern`, `cavernHint`, `cavernAvailable`), the action `data-act="cavern"`,
the code comments and the SPEC. The earlier v0.4 entry still describes the "CAVIAR" assumption, which is now resolved.
Re-ran the UI walkthrough: it passes with no errors.

## 2026-10-17 — v0.4.1 blue → purple → pink scale

Luna preferred a blue–purple–pink scale to the rainbow.
- The `--rainbow` gradient became `--scale` (#4fc3ff → #5b8cff → #8b7bff → #c48bff → #ff6fb5); `button.rainbow` became `button.grad`.
- New type colours along the scale: audio #4fc3ff, IR #5b8cff, text #8b7bff, 360° #b57bff, video #e07bff, photo #ff6fb5.
- The active-level marker, the volume slider and the EDC curve use the same scale (no more yellow or green).
- Re-ran the headless UI walkthrough: everything passes, with no errors.

## 2026-10-17 — v0.4 place panel rework, admin editing, rainbow highlights, CAVIAR

Asked by Luna: admins can remove or correct anything; colourful dots and rainbow highlights; everything FR/EN; new tab
order with Acoustics and CAVIAR; per-file metadata; logout needs confirmation.

**Changes**
- Place panel tabs, in order: **Infos** (place metadata, level, creator, contributors, coloured counts per type) ·
  **Galerie** (photos, videos, 360° photos; 360° opens full screen) · **Sons** (recordings + IR files) · **Textes** · **Acoustique**.
- **Acoustique** (new `scripts/acoustics.js`): choose an IR, then a source: provided samples, recordings from this place,
  the visitor's own audio file (decoded locally, never uploaded) or the live mic. Loop and volume; EDC + EDT/T20/T30/C50/C80/D50.
  A playing sound is no longer cut when someone else uploads to the same place.
- **CAVIAR**: a 360° photo ↔ IR link, set from either side in the upload/edit form ("Photo 360° liée" on an IR,
  "Réponse impulsionnelle liée" on a 360°). Linked pairs open a full-screen 360° view where the binaural rendering follows the gaze.
  Assumption: "CAVIAR" = an immersive mode inside METIS (Codes/CAVIAR is CCRMA's Max system, not a web app to link to).
- **Editing**: admins and the place's creator can rename a place, change its level, edit its metadata, move it on the map,
  or delete it (with all its items, after confirmation). Admins and authors can edit any file's metadata, links, or replace the file.
  Instructors keep hide/unhide and delete for moderation. Places now have their own metadata (`point.meta`, `createdByName`).
- Styled confirmation dialogs (`#confirm`) for logout, deleting a place and deleting a file (replacing `window.confirm`).
- Rainbow accents on the dark theme:
  - one hue per media type (photo pink, video orange, 360° yellow, IR green, audio cyan, text violet);
  - pins are rings split by the media types a place holds;
  - wordmark, add button, active tab and the CAVIAR buttons use the rainbow; cards have a coloured edge.
- i18n audit: 54 missing keys added (116 in each language). This includes the map controls (zoom, recenter, base layers),
  which now relabel on a language switch, and the alignment tool.
- Placeholder dry samples `assets/samples/{clap,pluck,sweep}.wav` (synthesised: noise-burst claps, Karplus–Strong phrase,
  100 Hz–8 kHz ESS). The configs pointed at sample files that did not exist.

**Tests** (headless Chrome via CDP, mock in-memory backend logged in as admin, synthetic photo/360°/IR/recording; harness in the scratchpad, not in the repo):
- all 5 tabs render; the Acoustique player starts; the CAVIAR viewer opens and plays; renaming a place and retitling an item work;
- logout: cancel keeps the session, confirm logs out; deleting a place removes it and closes the panel;
- English mode: no French words found in the header, levels, panel or map controls (21-word check list);
- IR analysis on the synthetic IR (built with RT = 1.1 s): EDT 1.09 s, T20 1.10 s, T30 1.10 s;
- no exceptions, console errors or HTTP errors. `deno lint` is clean.
**Not tested**: the real Firebase writes of the new fields (rules unchanged and expected to allow them: owner/staff for
points and items); audio on iOS Safari; the live mic in a real browser (headless used a fake device); uploads (Cloudinary not set up).

## 2026-10-17 — v0.3.1 plan visibility, level focus

- `blend: "lines"` overlays are now tinted violet with stronger contrast (invert → grayscale → contrast 3.2 → sepia/hue-rotate),
  because the thin grey lines were nearly invisible on the dark map. Checked in headless Chrome on the dark and satellite bases.
- Choosing a level that has a plan flies to it at zoom ≥ `config.map.levelZoom` (default 19).
- `make_auth_import.mjs`: optional `uid`/`password` columns and `--words` (see the 2026-10-17 accounts change in ESAAA).
- Login: Firebase error codes are shown for non-credential failures; no autocorrect or autocapitalize on the username.

**ESAAA placement redone**: the first R3 placement (42°) was **wrong by ~180°**. It was based on matching the plan's curved
element to a curved skylight. The silo 2014 plan labels that curve "ACCUEIL" (a desk) and the top of the plan "CÔTÉ SEMNOZ"
(the uphill, south-west side). The new fit was done by an optimiser: a two-way chamfer distance between the plan's thick walls
(dark pixels after a 3×3 opening) and the OSM outlines of ways 40958449 and 229390588, on Esri z19 imagery.
A first one-way version shrank the plan to its scale limit (a known failure) and was discarded.
Result: centre 45.893309, 6.134979; 194.5 × 126.4 m; rotation 228.5°. Visual check: the earth hatching lands on the
forested slope, the walls follow both buildings, and the plan's tree symbols land on real trees. Likely within a few metres; not surveyed.
**Dead end**: registering the silo "PLAN-USAGES" level-3 diagram onto the Vurpas plan failed (cost ~33–35 px). Its parts are at
inconsistent scales (~2.4× vs ~1.4×), so it is a schematic, not a scaled plan; it was not added as a map layer.

## 2026-10-17 — v0.3 serif wordmark, recenter, plan overlays + alignment tool

**Changes**
- Display font changed from Syne to **Cormorant Garamond** (Luna wanted something more elegant). Used for the
  wordmark (letter-spaced, pale gradient), panel titles and dialog titles.
- **Recenter** button (bottom-right, above the zoom buttons): flies back to `config.map.center`/`zoom` (or to the plan bounds in plan mode).
- Layers: new `attribution` option (credit shown in the map footer) and `blend: "lines"` for black-on-white drawings,
  which are inverted and screen-blended so they show as light lines on the dark map. These overlays live in Leaflet's
  tile pane, because blending is isolated per pane. In the overlay pane they rendered as black rectangles; that was the first attempt.
- **Alignment tool**: open the site with `?align=<layerId>`. It switches to the satellite base, adds a draggable centre handle
  and rotation/width/opacity sliders (height follows the image ratio), and copies `{"placement": …}` JSON for config.json.

**ESAAA (instance config, not template)**: test layer `vurpas-r3` = the Vurpas R+3 plan, hotlinked from
vurpas-architectes.com (no copy in the repo), credited "© Vurpas Architectes — test only".
The first placement was fitted by eye on Esri imagery, using the curved hall wall ↔ curved skylight, the two rooms that
stick out ↔ the roof blocks, and the tree symbols ↔ real trees: centre 45.893247, 6.135063; 194.5 × 126.5 m; rotation 42°.
It is approximate (off by several metres) and needs finishing with `?align=vurpas-r3`.

**Tests**: headless Chrome screenshots of the ESAAA config with the new template code: align mode on satellite
(lines visible, panel works); floor stack; wordmark. The alignment drag/sliders were not exercised (static screenshot only).

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
