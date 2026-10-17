// Data backend. "firebase": Auth + Firestore (live, all projects). "static": one archived project read from data/metis.json
// (the "version statique" download). Both expose the same API, so the UI does not care which one is active.
// Per-project calls act on the project chosen with useProject(pid).

const FB = 'https://www.gstatic.com/firebasejs/10.12.2';

export async function createBackend(config) {
  return config.backend === 'static' ? staticBackend() : firebaseBackend(config);
}

async function staticBackend() {
  const data = await (await fetch('data/metis.json', { cache: 'no-cache' })).json();
  const readOnly = () => Promise.reject(new Error('read-only (static) site'));
  const none = async () => ({});
  return {
    readOnly: true, staticProjectId: data.projectId,
    useProject() {}, onUser: cb => cb(null),
    listPublicProjects: async () => [{ id: data.projectId, ...data.project }],
    listAllProjects: async () => [{ id: data.projectId, ...data.project }],
    getProjectDoc: async () => data.project,
    getSettings: none, getAdmin: none,
    watchPoints(cb) { cb(data.points); return () => {}; },
    watchItems(pointId, cb) { cb(data.items[pointId] || []); return () => {}; },
    exportProject: async () => data,
    login: readOnly, logout: readOnly, acceptCharter: readOnly, createProject: readOnly, updateProject: readOnly,
    saveSettings: readOnly, saveSecrets: readOnly, saveAdmin: readOnly, setPublic: readOnly,
    addPoint: readOnly, updatePoint: readOnly, deletePoint: readOnly,
    addItem: readOnly, updateItem: readOnly, addPointType: readOnly, setHidden: readOnly, deleteItem: readOnly,
    createAuthUser: readOnly, withUserSession: readOnly, setUserDoc: readOnly, deleteUserDoc: readOnly,
  };
}

async function firebaseBackend(config) {
  const { initializeApp, deleteApp } = await import(`${FB}/firebase-app.js`);
  const A = await import(`${FB}/firebase-auth.js`);
  const F = await import(`${FB}/firebase-firestore.js`);

  const app = initializeApp(config.firebase);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  let pid = null;
  const P = (...p) => F.doc(db, 'projects', pid, ...p);
  const pointsCol = () => F.collection(db, 'projects', pid, 'points');
  const itemsCol = ptid => F.collection(db, 'projects', pid, 'points', ptid, 'items');
  const emailOf = u => (u.includes('@') ? u : `${u.trim().toLowerCase()}@${config.accounts.emailDomain}`);
  const denied = e => e?.code === 'permission-denied';

  let current = null; // { uid, username, displayName, role, project, charterAcceptedAt }

  // Secondary Firebase app with in-memory auth: lets a super-admin create accounts or act as one account
  // (password reset, deletion) without leaving their own session.
  async function secondary(fn) {
    const sec = initializeApp(config.firebase, `metis-secondary-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    const sa = A.initializeAuth(sec, { persistence: A.inMemoryPersistence });
    try { return await fn(sa); } finally { await A.signOut(sa).catch(() => {}); await deleteApp(sec).catch(() => {}); }
  }

  return {
    readOnly: false,
    useProject(id) { pid = id; },
    get projectId() { return pid; },

    // cb(user|null). Super-admins / bot: custom claim; everyone else: users/{uid} = { project, role }.
    onUser(cb) {
      A.onAuthStateChanged(auth, async u => {
        if (!u) { current = null; return cb(null); }
        const token = await u.getIdTokenResult();
        const snap = await F.getDoc(F.doc(db, 'users', u.uid)).catch(() => null);
        const profile = snap?.exists() ? snap.data() : {};
        const username = u.email.split('@')[0];
        current = {
          uid: u.uid, username,
          displayName: profile.displayName || u.displayName || username,
          role: token.claims.role || profile.role || 'none',
          project: profile.project || null,
          charterAcceptedAt: profile.charterAcceptedAt || null,
        };
        cb(current);
      });
    },
    login: (username, password) => A.signInWithEmailAndPassword(auth, emailOf(username), password),
    logout: () => A.signOut(auth),
    acceptCharter() { return F.updateDoc(F.doc(db, 'users', current.uid), { charterAcceptedAt: F.serverTimestamp() }); },

    // ---------- projects ----------
    async listPublicProjects() {
      const s = await F.getDocs(F.query(F.collection(db, 'projects'), F.where('public', '==', true)));
      return s.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    async listAllProjects() {                       // super-admins only (rules)
      const s = await F.getDocs(F.collection(db, 'projects'));
      return s.docs.map(d => ({ id: d.id, ...d.data() }));
    },
    // null when it does not exist or the current user may not read it.
    async getProjectDoc(id) {
      try { const s = await F.getDoc(F.doc(db, 'projects', id)); return s.exists() ? s.data() : null; }
      catch (e) { if (denied(e)) return null; throw e; }
    },
    async projectExists(id) {                       // super-admins: is this id already taken?
      return (await F.getDoc(F.doc(db, 'projects', id))).exists();
    },
    async createProject(id, doc) {
      if ((await F.getDoc(F.doc(db, 'projects', id))).exists()) throw new Error(`PROJECT_EXISTS`);
      await F.setDoc(F.doc(db, 'projects', id), { ...doc, createdAt: F.serverTimestamp(), createdBy: current.uid });
    },
    updateProject(patch) { return F.updateDoc(P(), { ...patch, updatedAt: F.serverTimestamp(), updatedBy: current.uid }); },
    setPublic(isPublic) { return F.updateDoc(P(), { public: !!isPublic }); },

    // projects/{pid}/private/settings — { cloudinary: { cloudName, uploadPreset } }: members need it to upload.
    async getSettings() {
      try { const s = await F.getDoc(P('private', 'settings')); return s.exists() ? s.data() : {}; }
      catch (e) { if (denied(e)) return {}; throw e; }
    },
    saveSettings(patch) { return F.setDoc(P('private', 'settings'), { ...patch, updatedAt: F.serverTimestamp(), updatedBy: current.uid }, { merge: true }); },
    // projects/{pid}/secrets/cloudinary — encrypted API key/secret; write-only for super-admins, readable by the cleanup bot.
    saveSecrets(enc) { return F.setDoc(P('secrets', 'cloudinary'), { enc, alg: 'RSA-OAEP-256', updatedAt: F.serverTimestamp(), updatedBy: current.uid }); },
    // projects/{pid}/admin/{accounts|cleanup} — super-admins only.
    async getAdmin(doc) {
      try { const s = await F.getDoc(P('admin', doc)); return s.exists() ? s.data() : {}; }
      catch (e) { if (denied(e)) return {}; throw e; }
    },
    saveAdmin(doc, patch) { return F.setDoc(P('admin', doc), { ...patch, updatedAt: F.serverTimestamp(), updatedBy: current.uid }, { merge: true }); },
    // Site-wide admin settings (e.g. GitHub token for the cleanup button).
    async getGlobal(doc) { const s = await F.getDoc(F.doc(db, 'global', doc)).catch(() => null); return s?.exists() ? s.data() : {}; },
    saveGlobal(doc, patch) { return F.setDoc(F.doc(db, 'global', doc), patch, { merge: true }); },

    // ---------- accounts (super-admins) ----------
    // Creates one Firebase Auth account; returns its uid, or throws 'auth/email-already-in-use'.
    createAuthUser(username, password, displayName) {
      return secondary(async sa => {
        const cred = await A.createUserWithEmailAndPassword(sa, emailOf(username), password);
        await A.updateProfile(cred.user, { displayName });
        return cred.user.uid;
      });
    },
    // Runs fn(user, A) signed in as that account (e.g. A.updatePassword, user.delete()).
    withUserSession(username, password, fn) {
      return secondary(async sa => { const cred = await A.signInWithEmailAndPassword(sa, emailOf(username), password); return fn(cred.user, A); });
    },
    setUserDoc(uid, data) { return F.setDoc(F.doc(db, 'users', uid), data, { merge: true }); },
    deleteUserDoc(uid) { return F.deleteDoc(F.doc(db, 'users', uid)); },

    // ---------- places & items of the current project ----------
    watchPoints(cb, onError) {
      return F.onSnapshot(pointsCol(), s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
    },
    watchItems(pointId, cb, onError) {
      const q = F.query(itemsCol(pointId), F.orderBy('createdAt', 'desc'));
      return F.onSnapshot(q, s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), onError || (e => console.warn('items', e.code)));
    },
    // Everything a static copy needs: project doc, places, items (dates as ISO strings).
    async exportProject() {
      const plain = v => (v?.toDate ? v.toDate().toISOString() : Array.isArray(v) ? v.map(plain)
        : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);
      const project = plain((await F.getDoc(P())).data());
      const pts = await F.getDocs(pointsCol()), points = [], items = {};
      for (const d of pts.docs) {
        points.push({ id: d.id, ...plain(d.data()) });
        const its = await F.getDocs(F.query(itemsCol(d.id), F.orderBy('createdAt', 'desc')));
        items[d.id] = its.docs.map(x => ({ id: x.id, ...plain(x.data()) })).filter(x => !x.hidden);
      }
      return { projectId: pid, project, points: points.filter(p => !p.hidden), items };
    },

    async addPoint({ lat, lng, x, y, floor, name, meta = {} }) {
      const ref = await F.addDoc(pointsCol(), {
        ...(lat !== undefined ? { lat, lng } : { x, y }),
        floor, name, meta, types: [], hidden: false,
        createdBy: current.uid, createdByName: current.displayName, createdAt: F.serverTimestamp(),
      });
      return ref.id;
    },
    // Rename, move, change level or edit the place's own metadata (owner or staff, see firestore.rules).
    updatePoint(pointId, patch) {
      return F.updateDoc(F.doc(pointsCol(), pointId), { ...patch, updatedAt: F.serverTimestamp(), updatedBy: current.uid });
    },
    // Firestore does not cascade: delete every item first, then the place. Media files are removed from the
    // project's cloud by the cleanup job (tools/cleanup.mjs).
    async deletePoint(pointId) {
      const snap = await F.getDocs(itemsCol(pointId));
      await Promise.all(snap.docs.map(d => F.deleteDoc(d.ref)));
      await F.deleteDoc(F.doc(pointsCol(), pointId));
    },
    async addItem(pointId, item) {
      const ref = await F.addDoc(itemsCol(pointId), {
        ...item,
        author: { uid: current.uid, displayName: current.displayName },
        createdAt: F.serverTimestamp(), hidden: false,
      });
      // Keep a summary of media types on the point so the map can colour markers without extra reads.
      await F.updateDoc(F.doc(pointsCol(), pointId), { types: F.arrayUnion(item.type) });
      return ref.id;
    },
    // Keep the place's media-type summary (pin colours) right when an item changes kind (e.g. photo → 360°).
    addPointType(pointId, type) { return F.updateDoc(F.doc(pointsCol(), pointId), { types: F.arrayUnion(type) }); },
    updateItem(pointId, itemId, patch) { return F.updateDoc(F.doc(itemsCol(pointId), itemId), patch); },
    setHidden(pointId, itemId, hidden) { return F.updateDoc(F.doc(itemsCol(pointId), itemId), { hidden, hiddenBy: hidden ? current.uid : null }); },
    deleteItem(pointId, itemId) { return F.deleteDoc(F.doc(itemsCol(pointId), itemId)); },
  };
}
