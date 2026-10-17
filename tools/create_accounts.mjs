// Create workshop accounts + the projects/<id> document. Admin only (needs a service-account key; never commit it).
//   Deno: GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json deno run -A --config tools/deno.json tools/create_accounts.mjs accounts.csv <emailDomain> <projectId>
//   Node: npm i firebase-admin && GOOGLE_APPLICATION_CREDENTIALS=... node tools/create_accounts.mjs accounts.csv <emailDomain> <projectId>
//   Add --dry-run to only print what would happen (no credentials needed).
// accounts.csv: username,displayName,role   (role = student | instructor | admin)
// Writes credentials_PRIVATE.csv (username,password) in the current folder. Re-running skips existing users (passwords unchanged).
import { readFileSync, writeFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const [csvPath, emailDomain, projectId] = args.filter(a => !a.startsWith('--'));
if (!csvPath || !emailDomain || !projectId) throw new Error('usage: create_accounts.mjs accounts.csv <emailDomain> <projectId> [--dry-run]');

// Readable passwords: no 0/O/1/l/I.
const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
const password = () => Array.from({ length: 10 }, () => ALPHA[randomInt(ALPHA.length)]).join('');

let auth, db, FieldValue;
if (!dryRun) {
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  ({ getAuth: auth } = await import('firebase-admin/auth'));
  const fs = await import('firebase-admin/firestore');
  initializeApp({ credential: applicationDefault() });
  auth = auth(); db = fs.getFirestore(); FieldValue = fs.FieldValue;
  // Class-only by default; flip `public` to true after the workshop.
  const proj = db.doc(`projects/${projectId}`);
  if (!(await proj.get()).exists) { await proj.set({ public: false, createdAt: FieldValue.serverTimestamp() }); console.log(`created projects/${projectId} (public: false)`); }
}

const rows = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/).slice(1).map(l => l.split(',').map(s => s.trim()));
const out = ['username,displayName,role,password'];
for (const [username, displayName, role = 'student'] of rows) {
  if (!['student', 'instructor', 'admin'].includes(role)) throw new Error(`bad role for ${username}: ${role}`);
  const email = `${username.toLowerCase()}@${emailDomain}`;
  if (dryRun) { console.log(`[dry-run] ${role.padEnd(10)} ${email}  "${displayName}"`); continue; }
  let user, pw = '(unchanged)';
  try {
    user = await auth.getUserByEmail(email);
    console.log(`exists  ${username}`);
  } catch {
    pw = password();
    user = await auth.createUser({ email, password: pw, displayName, emailVerified: true });
    console.log(`created ${username}`);
  }
  await auth.setCustomUserClaims(user.uid, { role });
  await db.doc(`users/${user.uid}`).set({ displayName, role, createdAt: FieldValue.serverTimestamp() }, { merge: true });
  out.push([username, displayName, role, pw].join(','));
}
if (dryRun) { console.log(`[dry-run] ${rows.length} accounts, nothing written`); process.exit(0); }
writeFileSync('credentials_PRIVATE.csv', out.join('\n') + '\n');
console.log(`wrote credentials_PRIVATE.csv (${rows.length} accounts)`);
