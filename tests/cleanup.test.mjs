// Run: deno run tests/cleanup.test.mjs
import { publicIdFromUrl, referencedIds, planDeletions } from '../tools/cleanup-lib.mjs';
let fails = 0; const ok = (n, c, d) => { console.log(`${c ? 'PASS' : 'FAIL'} ${n}${d ? ' ' + d : ''}`); if (!c) fails++; };
const U = 'https://res.cloudinary.com/demo';
ok('public id from image URL', publicIdFromUrl(`${U}/image/upload/v1792/metis/p/photo/abc.jpg`) === 'metis/p/photo/abc');
ok('public id from transformed URL', publicIdFromUrl(`${U}/image/upload/c_limit,w_400,q_auto,f_auto/v1792/metis/p/photo/abc.jpg`) === 'metis/p/photo/abc');
ok('raw keeps extension', publicIdFromUrl(`${U}/raw/upload/v1/metis/p/ir/x.wav`, true) === 'metis/p/ir/x.wav');
const doc = { layers: [{ url: `${U}/image/upload/v1/metis/p/plan/plan1.png`, publicId: 'metis/p/plan/plan1' }], samples: [{ url: `${U}/video/upload/v1/metis/p/sample/s1.wav`, publicId: 'metis/p/sample/s1' }] };
const items = [{ media: { url: `${U}/image/upload/v1/metis/p/photo/ph1.jpg`, publicId: 'metis/p/photo/ph1', resourceType: 'image' } },
  { media: { url: `${U}/raw/upload/v1/metis/p/ir/ir1.wav`, publicId: 'metis/p/ir/ir1.wav', resourceType: 'raw' } }, { meta: { text: 'no media' } }];
const ref = referencedIds(doc, items);
const now = Date.parse('2026-10-17T12:00:00Z'), H = 3600e3;
const assets = [
  { type: 'image', id: 'metis/p/plan/plan1', created: now - 5 * H }, { type: 'video', id: 'metis/p/sample/s1', created: now - 5 * H },
  { type: 'image', id: 'metis/p/photo/ph1', created: now - 5 * H }, { type: 'raw', id: 'metis/p/ir/ir1.wav', created: now - 5 * H },
  { type: 'image', id: 'metis/p/photo/deleted', created: now - 5 * H }, { type: 'image', id: 'metis/p/_test/t1', created: now - 2 * H },
  { type: 'video', id: 'metis/p/audio/fresh', created: now - 10 * 60e3 },
];
const { old, tooRecent } = planDeletions(assets, ref, now, H);
ok('plans, samples, photos and IRs in use are kept', !old.some(a => /plan1|s1|ph1|ir1/.test(a.id)));
ok('deleted file and old test upload are removed', JSON.stringify(old.map(a => a.id).sort()) === JSON.stringify(['metis/p/_test/t1', 'metis/p/photo/deleted']), JSON.stringify(old.map(a => a.id)));
ok('a file younger than 1 h waits', tooRecent === 1);
if (fails) throw new Error(`${fails} failure(s)`);
