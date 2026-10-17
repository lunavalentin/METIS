// Pure helpers of the cleanup job (tested in tests/cleanup.test.mjs).

// Public id of a Cloudinary delivery URL (…/upload/[transformations/][v123/]<public_id>.<ext>); raw files keep their extension.
export function publicIdFromUrl(url, raw = false) {
  const m = String(url || '').match(/\/(?:image|video|raw)\/upload\/(?:[^/]*,[^/]*\/)*(?:v\d+\/)?(.+)$/);
  if (!m) return null;
  return raw ? m[1] : m[1].replace(/\.[a-z0-9]+$/i, '');
}

// Every Cloudinary file a project still uses: item media, floor plans (layers) and sound samples of the project document.
export function referencedIds(projectDoc, items) {
  const ids = new Set();
  const add = (media, raw) => {
    if (!media) return;
    if (media.publicId) ids.add(media.publicId);
    const fromUrl = publicIdFromUrl(media.url, raw);
    if (fromUrl) ids.add(fromUrl);
  };
  for (const it of items) add(it.media, it.media?.resourceType === 'raw');
  for (const l of projectDoc.layers || []) add(l, false);
  for (const s of projectDoc.samples || []) add(s, false);
  return ids;
}

// Which assets to delete: not referenced (raw ids are compared with and without extension) and older than minAgeMs.
export function planDeletions(assets, referenced, now, minAgeMs) {
  const used = a => referenced.has(a.id) || referenced.has(a.id.replace(/\.[a-z0-9]+$/i, ''));
  const orphans = assets.filter(a => !used(a));
  const old = orphans.filter(a => now - a.created > minAgeMs);
  return { orphans, old, tooRecent: orphans.length - old.length };
}

// RSA-OAEP (SHA-256) decryption of a secret written by the admin page (adminlib.encryptSecret).
export async function decryptSecret(privateKeyPem, encB64) {
  const der = Uint8Array.from(atob(privateKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const buf = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, key, Uint8Array.from(atob(encB64), c => c.charCodeAt(0)));
  return JSON.parse(new TextDecoder().decode(buf));
}
