# METIS — Mapping Environments through Traces, Images and Sound

One website for many workshops: **https://lunavalentin.github.io/METIS/**
Design notes: [SPEC.md](SPEC.md) (original design) · [MIGRATION.md](MIGRATION.md) (multi-project architecture, status) · [CHANGELOG.md](CHANGELOG.md).

## How it works
- **Visitors** see a world map with one dot per *public* project, and can browse a project read-only.
- **Students / instructors** log in with the username + password generated for them and land directly in their project
  (log out to see the world map again). Instructors can also hide or delete content.
- **Admins** (Luna, Celeste) have a project menu in the header: world map, every project, **＋ Nouveau projet**;
  and **⚙ Réglages du projet** in a project: Général · Base · Comptes · Stockage · Archive.

## Create a project (admins, on the website)
1. Create a free Cloudinary account for the project and an **unsigned upload preset** (Settings → Upload → Upload presets).
   Note the cloud name, the preset name, and the API key + secret (Settings → API Keys).
2. Header menu → **＋ Nouveau projet** (or import a JSON exported from another project). Fill in the title, place, dates,
   number of student and instructor accounts, the Cloudinary fields, and press **Tester la connexion**.
3. **Créer le projet**: the accounts are generated and their CSV (usernames + passwords) downloads; a copy stays in
   ⚙ → Comptes. The settings panel then opens on **Base**: levels, floor plans (PNG/JPEG/PDF) placed on the map,
   home view, sound samples, charter, limits.
4. ⚙ → Général → **Projet public** to put it on the world map.

## End of a workshop
⚙ → Archive: **Archiver** (read-only for everyone but admins; files stay on the project's Cloudinary) and
**Télécharger la version statique** (a self-contained ZIP: unzip, then `python3 -m http.server` in the folder).

## Behind the scenes
- `config.json`: site-wide settings only (Firebase web config, defaults, public key for secrets). Each project's settings live
  in Firestore `projects/<id>`; its upload preset in `projects/<id>/private`; its Cloudinary API keys **encrypted** in
  `projects/<id>/secrets` (only the cleanup job can decrypt them: GitHub secret `METIS_PRIVATE_KEY`).
- Rules: `firestore.rules` (deploy: `firebase deploy --only firestore:rules`).
- Cleanup: `.github/workflows/cleanup.yml` runs `tools/cleanup.mjs` nightly (and from ⚙ → Stockage → Nettoyer maintenant,
  which needs a fine-grained GitHub token with *Actions: read & write* on this repo): it deletes, on each project's Cloudinary,
  the files no longer used by its places, plans or samples.
- Admin accounts (claims `admin` / `service`) are made with `tools/make_auth_import.mjs` + `firebase auth:import`.

## Tests
    deno run tests/irAnalysis.test.mjs; deno run tests/irprocess.test.mjs; deno run tests/cleanup.test.mjs

## Credits
Luna Leila Valentin, with Celeste Betancur Gutierrez.
