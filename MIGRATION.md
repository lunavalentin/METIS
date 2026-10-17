# METIS multi-project migration — plan and status

Decided 2026-10-17 (Luna): one static GitHub Pages site (the METIS repo), no per-workshop copies. One Firebase project
(`metis-esaaa`) covers all projects. Each project has its own config (in Firestore) and its own Cloudinary account.
Users belong to one project. Only Luna and Celeste are admins (super-admins, all projects). The public page is a world
map of public projects; a logged-in user sees only their own project, and logs out to see the world map again.
ESAAA is dropped: Luna will rebuild it from scratch as a test project.

## Status
- [x] 0. Clean-up. Old ESAAA Firestore data deleted (backup: `METIS_ESAAA_private/backup_esaaa_firestore_2026-10-17.json`).
      32 student/instructor accounts deleted. Kept: `luna`, `celess` (admin claim), `nettoyage` (service), now `@metis.users`
      (credentials in `METIS_ESAAA_private/mig/keep.csv`).
- [x] 0b. Secrets. RSA-OAEP 3072 key pair: public key → to embed in the site; private key → GitHub secret `METIS_PRIVATE_KEY`
      (METIS repo) + `METIS_ESAAA_private/metis_secrets_PRIVATE_KEY.pem`. `METIS_BOT_PASSWORD` set on METIS.
      Browser-encrypt → decrypt round-trip tested.
- [x] 1. Rules (`firestore.rules`, deployed). Super = claim `admin`; bot = claim `service`; members = `users/{uid}.project/role`;
      `projects/{pid}`: get (member/public) vs list (only `public == true`); `private` (members), `secrets` (bot only),
      `admin` (super; bot writes `cleanup` only); writes blocked when `status != "active"`.
      **33/33 live checks pass** (scratchpad `rules_test.py`, test projects zz-a / zz-b removed afterwards).
- [x] 2. Project loading from Firestore: `config.json` = site-wide only (Firebase web config, defaults, secrets public key);
      `scripts/project.js` merges `projects/{pid}` into the map/UI config; backend works on `useProject(pid)`.
- [x] 3. World map (`WorldMap`, public dots; all + private marked for super-admins), visitor → read-only public project + back button,
      member → own project only (logout → world), super-admin switcher (world / projects / new), last project remembered.
      **19/19 live checks** (headless Chrome + live Firebase; github.io referer injected on googleapis calls only).
- [x] 4. "Nouveau projet" (switcher → ＋): form + JSON import, address search (Nominatim), accounts count, cloud keys;
      "Tester la connexion" = unsigned upload with the preset + signed delete with the keys; keys encrypted (RSA-OAEP) before saving.
      **11/11 live checks** (preset OK, fake keys refused → creation blocked, created without keys, duplicate id refused).
- [x] 5. **Project base module (admin side)** — ⚙ Réglages → Base. **13/13 live checks** (levels, PNG + 2-page PDF plans,
      placement editor, home view, sample, charter, limits, level deletion).: after creating a project, set up its base:
      - upload floor plans (images/PDF pages) to the project's Cloudinary;
      - define levels (names FR/EN, order) and attach a plan to each;
      - place/align each plan on the map (drag, rotate, scale, opacity; replaces the `?align=` tool);
      - set the project's home view (centre, zoom), samples, charter text, limits.
      Everything saved in the project config, editable later from the same module.
- [x] 6. Account generation (**18/18 live checks**: generate, CSV + Firebase copy, login → own project + project charter,
      reset → new password works / old refused, delete → refused, accounts from the new-project form). Spec: number of students / instructors in the form/JSON → accounts created from the admin's browser
      (secondary Firebase session), CSV downloaded + copy in `projects/{pid}/admin/accounts`; "+ N comptes"; password reset.
- [x] 7. Global cleanup (`tools/cleanup.mjs` + `cleanup-lib.mjs`, workflow in METIS, nightly + dispatch with `project`).
      Unit tests 6/6 (plans/samples/items kept, orphans + old `_test` removed, < 1 h kept). Live: local + Actions runs
      log in, list projects, decrypt keys (shape check), count references, write the report shown in ⚙ Stockage.
      **Real deletion not re-tested**: needs a project's real Cloudinary keys (the deletion code is unchanged from the run that deleted 13 files on 2026-10-17).
- [x] 8. Archive (status toggle; members read-only, admins can still edit) + "Télécharger la version statique": ZIP built in the
      browser (site + vendor libs + Google Fonts + data + media with local links). Tested live (6/6) and offline with
      Firebase/Cloudinary/CDNs/Fonts blocked (11/11: plan, photo, IR analysis + playback, samples, text, fonts).
- [x] 9. Published: GitHub Pages on the METIS repo → https://lunavalentin.github.io/METIS/. Live end-to-end 8/8 (real referer:
      world map, student login → own project, create place, text, photo upload to the project's Cloudinary, logout, admin panel).
      METIS_ESAAA workflows (sync, cleanup) disabled; its repo and site are left as they are (unused).
      All test projects and test accounts deleted (2026-10-17): Firestore has no project; Auth has luna, celess, nettoyage.

## Left for Luna
- Create the first real project (e.g. ESAAA) with ＋ Nouveau projet — with the Cloudinary **API key + secret**, so the
  connection test also confirms the keys and the nightly cleanup can run for it.
- New fine-grained GitHub token for **lunavalentin/METIS** (Actions: read & write) → ⚙ → Stockage → Jeton GitHub
  (the old one was for METIS_ESAAA). Without it the nightly cleanup still runs; only the button needs it.
- Cloudinary `cwmp8wdp` still holds small test files under `metis/zz-*` and the old `metis/esaaa` uploads (Media Library → delete).
- Optional: delete the old `METIS_ESAAA` repo / Pages, and the unused `INSTANCES_DISPATCH_TOKEN` secret on METIS.
