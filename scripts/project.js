// Project configuration. config.json holds only site-wide settings (Firebase web config, defaults, public key);
// each project's settings live in Firestore projects/{pid}. toProjectConfig() merges both into the shape the
// map and the UI use (state.config), so the rest of the code does not care where a value comes from.

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// Defaults for a new project document (also the JSON template for import/export).
export function newProjectDoc(site, { id, title, center }) {
  const d = site.defaults;
  return {
    title: title || { fr: id, en: id }, subtitle: { fr: '', en: '' },
    public: false, status: 'active',
    dates: { start: '', end: '' },
    map: { ...d.map, center: center || [46.2, 6.15] },
    floors: structuredClone(d.floors), layers: [],
    samples: [], charter: { fr: '', en: '' },
    limits: structuredClone(d.limits),
    cloudinary: { cloudName: '', folder: `metis/${id}` },
    accounts: { students: 0, instructors: 0 },
  };
}

export function toProjectConfig(site, doc, pid) {
  const d = site.defaults, s = site.site;
  return {
    backend: site.backend, firebase: site.firebase, accounts: site.accounts, secretsPublicKey: site.secretsPublicKey,
    project: {
      id: pid, title: doc.title || { fr: pid, en: pid }, subtitle: doc.subtitle || {},
      defaultLang: s.defaultLang, repo: s.repo, charterPath: s.charterPath, charter: doc.charter || {},
      status: doc.status || 'active', public: !!doc.public, dates: doc.dates || {},
    },
    map: { ...d.map, ...(doc.map || {}) },
    floors: doc.floors?.length ? doc.floors : structuredClone(d.floors),
    layers: doc.layers || [],
    // Site samples are always offered; project samples (uploaded to the project's cloud) come first.
    audio: { samples: [...(doc.samples || []), ...d.samples] },
    limits: { ...d.limits, ...(doc.limits || {}), perPlace: { ...d.limits.perPlace, ...(doc.limits?.perPlace || {}) } },
    cloudinary: { folder: `metis/${pid}`, ...(doc.cloudinary || {}) },
    doc,
  };
}
