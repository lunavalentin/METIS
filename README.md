# METIS — Mapping Environments through Traces, Images and Sound

Collaborative, map-based documentation template for teaching workshops (acoustics, multimedia, GIS).
Design: see [SPEC.md](SPEC.md). Change log: [CHANGELOG.md](CHANGELOG.md).

## Run locally
    python3 -m http.server 8000      # then open http://localhost:8000

## Set up a new instance (e.g. METIS_ESAAA)
1. Copy this folder into a new repo; edit `config.json` (project id, titles, map centre, floors, layers, samples).
2. Firebase (Spark plan is enough): create a project → Authentication: enable Email/Password →
   Firestore: create database (europe-west) → paste `firestore.rules` → add a Web app and copy its config into
   `config.json.firebase` → Authentication → Settings → Authorized domains: add `lunavalentin.github.io`.
3. Create `projects/<id>` in Firestore with `{ public: false }`.
4. Cloudinary: create an **unsigned** upload preset restricted to folder `metis/<id>`, allowed formats and max size;
   put cloud name + preset in `config.json.cloudinary`.
5. Accounts: `accounts.csv` (`username,displayName,role`) →
   `GOOGLE_APPLICATION_CREDENTIALS=serviceAccount.json deno run -A --config tools/deno.json tools/create_accounts.mjs accounts.csv <emailDomain> <projectId>`
   (add `--dry-run` first; Node works too). Also creates `projects/<id>` with `public: false`.
6. Put floor plans in `assets/layers/`, dry samples in `assets/samples/`, write `charter/{fr,en}.md`.
7. Push to GitHub, enable Pages.

## Updates (template → instances)
Instances copy the template's code with `.github/workflows/sync-template.yml`. The paths copied are listed in
the instance's `metis.sync.json` under `managed`; everything else (config, charter, assets, data) belongs to the instance.
The sync runs every hour, from the Actions tab ("Run workflow"), and right after each push to this template if the
`INSTANCES_DISPATCH_TOKEN` secret is set (see `.github/workflows/notify-instances.yml`; instances are listed in `instances.json`).
To freeze an instance, set `"enabled": false` in its `metis.sync.json`.

## After the workshop
`tools/freeze.mjs <id>` → set `"backend": "static"` → set `public: true` / commit.

## Tests
    deno run tests/irAnalysis.test.mjs    # or node

## Credits
Luna Leila Valentin. License: TODO.
