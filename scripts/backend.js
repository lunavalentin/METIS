// Data backend. "firebase": Auth + Firestore (live). "static": read-only data/metis.json (after freeze).
// Both expose the same API so the UI does not care which one is active.

const FB = 'https://www.gstatic.com/firebasejs/10.12.2';

export async function createBackend(config) {
  return config.backend === 'static' ? staticBackend(config) : firebaseBackend(config);
}

async function staticBackend() {
  const data = await (await fetch('data/metis.json')).json();
  const readOnly = () => Promise.reject(new Error('read-only (static) site'));
  return {
    readOnly: true,
    onUser: cb => cb(null),
    async getProject() { return data.project; },
    watchPoints(cb) { cb(data.points); return () => {}; },
    watchItems(pointId, cb) { cb(data.items[pointId] || []); return () => {}; },
    login: readOnly, logout: readOnly, acceptCharter: readOnly,
    addPoint: readOnly, updatePoint: readOnly, deletePoint: readOnly,
    addItem: readOnly, updateItem: readOnly, setHidden: readOnly, deleteItem: readOnly,
  };
}

async function firebaseBackend(config) {
  const { initializeApp } = await import(`${FB}/firebase-app.js`);
  const A = await import(`${FB}/firebase-auth.js`);
  const F = await import(`${FB}/firebase-firestore.js`);

  const app = initializeApp(config.firebase);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const pid = config.project.id;
  const pointsCol = F.collection(db, 'projects', pid, 'points');
  const itemsCol = ptid => F.collection(db, 'projects', pid, 'points', ptid, 'items');

  let current = null; // { uid, displayName, role, charterAcceptedAt }

  return {
    readOnly: false,

    // cb(user|null). Role comes from the custom claim set by tools/create_accounts.mjs.
    onUser(cb) {
      A.onAuthStateChanged(auth, async u => {
        if (!u) { current = null; return cb(null); }
        const token = await u.getIdTokenResult();
        const snap = await F.getDoc(F.doc(db, 'users', u.uid));
        const profile = snap.exists() ? snap.data() : {};
        current = {
          uid: u.uid,
          displayName: profile.displayName || u.displayName || u.email.split('@')[0],
          role: token.claims.role || 'student',
          charterAcceptedAt: profile.charterAcceptedAt || null,
        };
        cb(current);
      });
    },

    login(username, password) {
      const email = username.includes('@') ? username : `${username.trim().toLowerCase()}@${config.accounts.emailDomain}`;
      return A.signInWithEmailAndPassword(auth, email, password);
    },
    logout: () => A.signOut(auth),

    acceptCharter() {
      return F.setDoc(F.doc(db, 'users', current.uid), { charterAcceptedAt: F.serverTimestamp() }, { merge: true });
    },

    // Returns null when the project is class-only and nobody is logged in (permission denied).
    async getProject() {
      try {
        const s = await F.getDoc(F.doc(db, 'projects', pid));
        return s.exists() ? s.data() : { public: false };
      } catch (e) {
        if (e.code === 'permission-denied') return null;
        throw e;
      }
    },

    watchPoints(cb, onError) {
      return F.onSnapshot(pointsCol, s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
    },

    watchItems(pointId, cb, onError) {
      const q = F.query(itemsCol(pointId), F.orderBy('createdAt', 'desc'));
      return F.onSnapshot(q, s => cb(s.docs.map(d => ({ id: d.id, ...d.data() }))), onError);
    },

    async addPoint({ lat, lng, x, y, floor, name, meta = {} }) {
      const ref = await F.addDoc(pointsCol, {
        ...(lat !== undefined ? { lat, lng } : { x, y }),
        floor, name, meta, types: [], hidden: false,
        createdBy: current.uid, createdByName: current.displayName, createdAt: F.serverTimestamp(),
      });
      return ref.id;
    },

    // Rename, move, change level or edit the place's own metadata (owner or staff, see firestore.rules).
    updatePoint(pointId, patch) {
      return F.updateDoc(F.doc(pointsCol, pointId), { ...patch, updatedAt: F.serverTimestamp(), updatedBy: current.uid });
    },

    // Firestore does not cascade: delete every item first, then the place. Media files stay on Cloudinary
    // (an unsigned client cannot delete them); tools/freeze.mjs only copies what is still referenced.
    async deletePoint(pointId) {
      const snap = await F.getDocs(itemsCol(pointId));
      await Promise.all(snap.docs.map(d => F.deleteDoc(d.ref)));
      await F.deleteDoc(F.doc(pointsCol, pointId));
    },

    async addItem(pointId, item) {
      const ref = await F.addDoc(itemsCol(pointId), {
        ...item,
        author: { uid: current.uid, displayName: current.displayName },
        createdAt: F.serverTimestamp(), hidden: false,
      });
      // Keep a summary of media types on the point so the map can colour markers without extra reads.
      await F.updateDoc(F.doc(db, 'projects', pid, 'points', pointId), { types: F.arrayUnion(item.type) });
      return ref.id;
    },

    updateItem(pointId, itemId, patch) {
      return F.updateDoc(F.doc(itemsCol(pointId), itemId), patch);
    },
    setHidden(pointId, itemId, hidden) {
      return F.updateDoc(F.doc(itemsCol(pointId), itemId), { hidden, hiddenBy: hidden ? current.uid : null });
    },
    deleteItem(pointId, itemId) {
      return F.deleteDoc(F.doc(itemsCol(pointId), itemId));
    },
  };
}
