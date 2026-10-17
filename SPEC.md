# METIS — Mapping Environments through Traces, Images and Sound

Design draft v0.1 — 2026-10-16 — Luna Valentin

## 1. What METIS is

METIS is a web template for collective, place-based documentation. A project defines a
map space (real-world geographic, or a local plan) and stacks map layers on it. Logged-in
participants drop **points** on the map and attach **items** to them: photos, videos, 360°
panoramas, impulse responses, audio and text, each with metadata. Impulse responses can be
auralised in the browser (dry samples or live microphone, with head-tracked binaural
rendering for first-order ambisonic IRs).

It is built for teaching workshops that mix acoustics, multimedia, GIS and other
disciplines. It belongs to the same family as CAVERN and ARIADNE but is a new codebase:
CAVERN is curated and CSV-driven, while METIS is collaborative and upload-driven.

- **METIS** (`lunavalentin/METIS`) is the reusable template.
- **METIS_ESAAA** (`lunavalentin/METIS_ESAAA`) is the first instance: a workshop at ESAAA
  (Annecy). It runs one week at the end of November 2026, with 26 students and 8 instructors.

## 2. Decisions taken (Q&A of 2026-10-16)

| Topic | Decision |
|---|---|
| Codebase | From scratch; no CAVERN code |
| Map space | Per project: `geo` (lat/lon over OSM) or `plan` (local metres) |
| ESAAA map | Outdoor geo map; indoor floor plans **georeferenced on it**, with a floor switcher |
| Points | Created freely by any logged-in user |
| Point model | A point is a shared **place**; many users add items to it |
| Auth | Accounts made by the instructors (no self sign-up) |
| Roles | admin / instructor / student |
| Metadata storage | Firestore |
| File storage | Cloudinary (free plan); long videos as YouTube/Vimeo links |
| Moderation | Items visible immediately; instructors can hide or delete them |
| Visibility | Class-only during the workshop, public after (a single switch) |
| Language | FR/EN interface toggle |
| Metadata form | Fixed fields + free tags + free notes |
| IR input | Flexible: finished IRs of any format, raw claps/balloons, sweeps later |
| Audio features | Dry-sample convolution, live mic through IR, head-tracked FOA, basic IR analysis |
| Rights | Workshop charter page accepted at first login |
| Devices | Phones and laptops equally (responsive) |
| After workshop | Freeze to a static site (JSON + files), so it no longer depends on Firebase |

## 3. Architecture

```
GitHub Pages (static, no build step: ES modules + CDN libs)
 ├── index.html, config.json, i18n/{fr,en}.json, scripts/*.js
 │
 ├── Firebase Auth ........ email/password accounts created by script (tools/create_accounts.mjs)
 ├── Cloud Firestore ...... projects / layers / points / items / users   (Spark plan is enough)
 └── Cloudinary ........... media files, uploaded straight from the browser (unsigned preset)

Static mode (after freeze): config.backend = "static" → reads data/metis.json + assets/
```

**Why not Firebase Storage?** Cloud Storage for Firebase now requires the Blaze
(pay-as-you-go) plan, and Spark projects have no bucket access. Keeping files on
Cloudinary lets the Firebase project stay on Spark with no card on file.

**Libraries**, all loaded from a CDN with pinned versions:

- Leaflet 1.9.4 for the map. It handles both modes (`L.CRS.Simple` for plans).
- Firebase JS SDK 10.12.2 (modular).
- Pannellum 2.5.6 for the 360° viewer.
- Everything else is our own code, including the audio engine. The audio engine uses no
  library (see §7).

## 4. Data model (Firestore)

```
projects/{pid}
  title{fr,en}, subtitle{fr,en}, public: bool, mapMode: "geo"|"plan",
  view {center:[lat,lng], zoom}            # geo
  planBounds {xmax, ymax}                  # plan mode, metres
  floors: [{id:"ext", label{fr,en}}, {id:"rdc", ...}, {id:"r1", ...}]

projects/{pid}/layers/{lid}                # v0.2 — in v0.1 layers live in config.json (committed by admin)
  label{fr,en}, floor, url, opacity, order,
  placement {center:[lat,lng], widthM, heightM, rotationDeg}   # geo mode
  bounds [[y0,x0],[y1,x1]]                                       # plan mode

projects/{pid}/points/{ptid}
  lat, lng (geo) | x, y (plan), floor, name, meta {description, users, intendedUse, unintendedUses, poetic, conditions, tags},
  types[], createdBy, createdByName, createdAt, updatedAt, updatedBy, hidden

projects/{pid}/points/{ptid}/items/{iid}
  type: photo|video|pano|ir|audio|text
  media {url, publicId, resourceType, thumbUrl, bytes, width, height, duration} | videoLink
  meta  {…see §5}
  irInfo {format, channels, sampleRate, order, norm, source, receiver, method, rotationDeg}
  linkedPano (on an IR) | linkedIR (on a 360°)   # CAVIAR pair, settable from either side
  author {uid, displayName}, createdAt, hidden, hiddenBy

users/{uid}
  displayName, role (mirror of the custom claim, for display), charterAcceptedAt
```

Roles live in **Firebase custom claims** (`role`), which the account script sets and the
security rules read from `request.auth.token.role`. Clients cannot change them.

## 5. Metadata form

Fields shared by every item type:

- title; date and time of capture (default: now); author (automatic, editable display name)
- description
- **who uses the space**
- **intended use** of the space
- **non-intended uses observed**
- **sensory / poetic notes** (free text)
- conditions (weather, crowd, time of day; free text)
- tags (free, comma-separated, suggested from existing tags)

Extra fields per type:

- **pano**: initial yaw / north offset
- **ir**: format (mono, stereo, binaural, FOA AmbiX, FOA FuMa); acquisition method (clap,
  balloon, sweep, other); source and receiver description and heights; mic model; IR
  rotation offset relative to the pano
- **audio**: recording device, mono/stereo/ambisonic
- **video**: uploaded file or link

## 6. User interface

- **Map** (full screen): base layer switch (OSM / satellite), floor switcher, layer
  panel with opacity sliders, points coloured by the media they contain.
- **Add point**: "+" button, then tap the map. On a phone, a "use my GPS position" option
  for outdoor points.
- **Point panel** (side panel on desktop, bottom sheet on mobile) has tabs:
  Gallery · 360° · Sound · Texts · Info. Each item shows its author and date.
  The owner and instructors can edit or delete; instructors can hide.
- **Upload sheet**: choose a type, pick or capture a file (`accept`/`capture` attributes
  open the phone camera or recorder), fill the metadata form, see upload progress.
  Images are resized in the browser before upload (photos ≤ 2560 px; panos ≤ 5760×2880,
  which stays under the iOS canvas limit).
- **Sound tab**: choose an IR → choose a source (dry sample / live mic) → play. If a pano
  exists at the point, the 360° viewer drives head rotation. IR analysis is shown beside it.
- **Login / charter**: username + password (the email address is hidden from students, see
  §9); the charter is shown at first login and must be accepted.
- **Admin page** (`admin.html`): public switch, layer placement helper (drag, scale and
  rotate a plan over the map, then save its `placement`), list of hidden items, CSV/JSON export.

## 7. Audio engine (Web Audio, no library)

Per IR format:

| IR format | Chain |
|---|---|
| mono | source → ConvolverNode(1 ch) → out |
| stereo / binaural | source → ConvolverNode(2 ch, `normalize=false`) → out |
| FOA AmbiX (ACN/SN3D, 4 ch) | source → **4 mono convolvers** → B-format (W,Y,Z,X) → virtual-speaker decoder → 8 HRTF PannerNodes → out |
| FOA FuMa | reorder/rescale to AmbiX first (W×√2, X Y Z → ACN order) |

- A 4-channel buffer in **one** ConvolverNode is treated as "true stereo" (2 in → 2 out),
  so FOA has to be split into 4 mono convolutions.
- Binaural decoding uses an 8-speaker cube. The speaker feeds use a max-rE weighted
  sampling decoder: s_i = (1/N)·(W + 3·0.577·(X·x_i + Y·y_i + Z·z_i)). Each speaker feeds a
  `PannerNode` with `panningModel="HRTF"` at a fixed position.
- **Head tracking**: the decoder stays fixed and the **AudioListener** orientation follows
  the Pannellum yaw/pitch (plus the IR's rotation offset). No B-format rotation matrix is
  needed.
- **Sources**: dry samples from `config.audio.samples`, or the live mic. For the mic,
  `getUserMedia` is called with echoCancellation/noiseSuppression/autoGainControl **off**.
  Headphones are required, and the app warns about feedback.
- **Raw clap/balloon**: find the onset, trim 2 ms before it, normalise, and fade the tail
  below −60 dB. The processed IR is used for playback and the original is kept.
- **Sweep deconvolution** (stretch goal, after the workshop): upload a recorded ESS with its
  parameters and run the inverse filter in the browser.

**IR analysis** runs on channel W (or the mono sum). It computes the Schroeder backward
integral and EDT, T20, T30 (linear fit), C50, C80, D50, and draws the waveform and the
energy-decay curve. Octave bands are phase 2.

## 8. Security rules (summary — see `firestore.rules`)

- Read: allowed if `projects/{pid}.public == true` or the user is signed in.
- Points/items: any signed-in user can create; `author.uid` must equal the caller's uid.
  Updating or deleting needs the owner or an instructor/admin. Only an instructor or admin
  can set `hidden`.
- Project document and layers: admin writes. Instructors can write layers.
- users/{uid}: the owner can write `displayName` and `charterAcceptedAt` only.

**Known limit:** `hidden` is filtered in the UI only; a hidden item is still readable via the API by anyone allowed to read.

**Known limit:** Cloudinary delivery URLs are public. "Class-only" hides the index (no one
can list or find items) but not a file whose URL has leaked. This is acceptable for the
workshop and is said plainly in the charter.

**Cloudinary unsigned preset**: restrict it to the folder `metis/<pid>/`, to allowed
formats and to a maximum file size. The preset name is visible in the code, so anyone
could upload with it. Mitigation: rename the preset after the workshop, watch usage, and
delete orphan files during the freeze.

## 9. Accounts

`tools/create_accounts.mjs` (Node + firebase-admin, run by Luna) reads
`accounts.csv` (`username,displayName,role`) and does the following:

- creates `username@<project>.metis` email/password users with random passwords;
- sets the `role` claim and writes `users/{uid}`;
- writes `credentials_PRIVATE.csv` for handing out on paper.

No personal email is collected, which is GDPR-friendly. Students type only their username.

## 10. Freeze to static

`tools/freeze.mjs` does the following:

1. exports the project from Firestore (dropping hidden items) to `data/metis.json`;
2. downloads every Cloudinary original into `assets/<type>/`;
3. rewrites the URLs to relative paths;
4. sets `config.backend = "static"`.

Commit the result to METIS_ESAAA (consider Git LFS or an archive if it is larger than
~1 GB, since GitHub Pages has a ~1 GB soft limit on site size). The same code runs
read-only from then on.

## 11. Budget estimate (to check against the real Cloudinary limits)

26 students × ~40 photos × 1 MB ≈ 1 GB · ~5 panos each × 5 MB ≈ 0.7 GB ·
IRs and audio ≈ 0.5 GB · uploaded short videos ≈ 2–5 GB.
In total this is 4–7 GB of storage plus delivery bandwidth during the week, which fits in
25 credits/month if long videos are links. **TODO:** check the free plan's per-file size
limits under Console → Settings → Account → Usage limits.

## 12. Timeline (workshop end of November; I3DA Venice 19–22 Nov)

| Week | Goal |
|---|---|
| 19 Oct | Spec sign-off; Firebase + Cloudinary accounts; map, auth, add point, upload |
| 26 Oct | Viewers (gallery, pano, text), metadata form, FR/EN, mobile layout |
| 2 Nov | Audio engine (convolution, FOA binaural, live mic), IR analysis |
| 9 Nov | ESAAA instance: plans + georeferencing, accounts, test run with instructors on iOS/Android |
| **≤ 15 Nov** | **Code freeze before Venice** — only content/config after |
| End Nov | Workshop |
| Dec | Freeze to static, make public |

## 13. Open questions

1. Exact workshop dates? Will you be on site, or do the instructors run it alone at first?
2. Do you have ESAAA floor plans (PDF/DWG/images), and how many floors? Which outdoor area
   (campus only, or the neighbourhood / lake shore)?
3. Equipment for students: ambisonic mic(s), recorders, 360 cameras (which model; does it
   output equirectangular directly)?
4. Which dry samples should be offered (voice, clap, instrument, something site-specific)?
5. Who are the 8 instructors (disciplines)? Should any of them be admins?
6. Charter text: who writes it (you, or ESAAA)? Does ESAAA have a GDPR/image-rights template?
7. License of the frozen public site (content license and code license; CAVERN-style
   non-commercial?)
8. Is the name "METIS" final, and is there a logo or visual identity, or should it follow
   the CAVERN/ARIADNE look?
9. Should students see a "my contributions" list and progress (e.g. counts per type)?
10. Should points have categories (e.g. inside/outside, quiet/loud), or are free tags enough?
11. Does the GIS part of the teaching need GeoJSON export or a QGIS-friendly CSV during the
    workshop, or only after?
12. Will the workshop Wi-Fi handle 26 people uploading at once? Is offline queuing needed
    (save on the phone, upload later)?
