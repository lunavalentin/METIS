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
- [ ] 2. Project loading from Firestore (`projects/{pid}` holds the config; `config.json` keeps only the site-wide Firebase web config).
- [ ] 3. Public world map (dots = public projects), logout → world, project switcher for super-admins.
- [ ] 4. "Nouveau projet" form + JSON import/export; keys encrypted in the browser; "Tester la connexion".
- [ ] 5. **Project base module (admin side)**: after creating a project, set up its base:
      - upload floor plans (images/PDF pages) to the project's Cloudinary;
      - define levels (names FR/EN, order) and attach a plan to each;
      - place/align each plan on the map (drag, rotate, scale, opacity; replaces the `?align=` tool);
      - set the project's home view (centre, zoom), samples, charter text, limits.
      Everything saved in the project config, editable later from the same module.
- [ ] 6. Account generation: number of students / instructors in the form/JSON → accounts created from the admin's browser
      (secondary Firebase session), CSV downloaded + copy in `projects/{pid}/admin/accounts`; "+ N comptes"; password reset.
- [ ] 7. Global cleanup job (nightly, loops over projects, decrypts each project's Cloudinary keys).
- [ ] 8. Archive mode (`status: archived`, read-only) + admin-only "Télécharger la version statique" (ZIP built in the browser).
- [ ] 9. Publish from the METIS repo (GitHub Pages); retire METIS_ESAAA.
