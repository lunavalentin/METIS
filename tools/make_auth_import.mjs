// Build a `firebase auth:import` file from accounts.csv — no service-account key needed, only `firebase login`.
//   deno run -A --config tools/deno.json tools/make_auth_import.mjs accounts.csv <emailDomain>
//   firebase auth:import auth_import_PRIVATE.json --hash-algo=BCRYPT --project <firebaseProjectId>
// accounts.csv: username,displayName,role[,uid][,password]. Optional uid = update that existing account in place
// (new email/password/name, same id); optional password = use it as is. --words → easy passwords "ciel4821miel".
// Writes auth_import_PRIVATE.json and credentials_PRIVATE.csv in the
// current folder: keep both out of git. The role becomes a custom claim ({"role": ...}) that firestore.rules reads.
// Re-importing the same users overwrites them (new passwords), so run it once, or only on new rows.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomInt, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';

const args = process.argv.slice(2);
const words = args.includes('--words');
const [csvPath, emailDomain] = args.filter(a => !a.startsWith('--'));
if (!csvPath || !emailDomain) throw new Error('usage: make_auth_import.mjs accounts.csv <emailDomain>');

const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789'; // no 0/O/1/l/I
// Short, easy-to-type French words (ASCII only, no look-alike letters issue since they are whole words).
const WORDS = ['ciel', 'vent', 'lac', 'pin', 'sel', 'mer', 'sol', 'feu', 'bois', 'roc', 'miel', 'lune', 'pluie', 'neige', 'sable',
  'fleur', 'herbe', 'pierre', 'nuit', 'jour', 'aube', 'soir', 'mont', 'pont', 'port', 'voile', 'rame', 'barque', 'plume', 'encre',
  'craie', 'toile', 'corde', 'cloche', 'flute', 'harpe', 'piano', 'tambour', 'violon', 'gong'];
const word = () => WORDS[randomInt(WORDS.length)];
const password = () => words
  ? `${word()}${String(randomInt(10000)).padStart(4, '0')}${word()}`
  : Array.from({ length: 10 }, () => ALPHA[randomInt(ALPHA.length)]).join('');
const uid = () => randomBytes(21).toString('base64url').slice(0, 28);

const lines = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
const head = lines[0].split(',').map(s => s.trim());
const rows = lines.slice(1).map(l => Object.fromEntries(l.split(',').map((v, i) => [head[i], v.trim()])));
const users = [], creds = ['username,displayName,role,password'];
for (const { username, displayName, role = 'student', uid: id, password: given } of rows) {
  if (!['student', 'instructor', 'admin'].includes(role)) throw new Error(`bad role for ${username}: ${role}`);
  const pw = given || password();
  users.push({
    localId: id || uid(),
    email: `${username.toLowerCase()}@${emailDomain}`,
    emailVerified: true,
    displayName,
    passwordHash: btoa(bcrypt.hashSync(pw, 10)),
    customAttributes: JSON.stringify({ role }),
  });
  creds.push([username, displayName, role, pw].join(','));
}
writeFileSync('auth_import_PRIVATE.json', JSON.stringify({ users }, null, 1));
writeFileSync('credentials_PRIVATE.csv', creds.join('\n') + '\n');
console.log(`${users.length} users → auth_import_PRIVATE.json + credentials_PRIVATE.csv`);
