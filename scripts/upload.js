// Browser → Cloudinary upload (unsigned preset), with client-side image resizing and progress.
// Resource types: images & panos → "image"; video & audio → "video" (Cloudinary files audio
// under video); IRs → "raw" so the WAV is delivered byte-exact (no transcoding of 4-ch files).

export const RESOURCE_TYPE = { photo: 'image', pano: 'image', video: 'video', audio: 'video', ir: 'raw' };

// Downscale an image file to fit maxW×maxH; returns a JPEG Blob (or the original if small enough).
export async function resizeImage(file, maxW, maxH = maxW) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  if (k === 1 && file.type === 'image/jpeg') { bmp.close(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.88));
}

// Prepares the file for its type (resizing images), then uploads. onProgress(0..1).
export async function uploadMedia(config, type, file, onProgress = () => {}) {
  // cloudName/uploadPreset come from the admin settings in Firestore (not the public config.json); folder from config.
  const { cloudName, uploadPreset } = { ...config.cloudinary, ...config.uploadSettings };
  const { folder } = config.cloudinary;
  if (!cloudName || !uploadPreset || cloudName === 'TODO') throw new Error('UPLOAD_NOT_CONFIGURED');
  const u = config.upload;
  let blob = file;
  try {
    if (type === 'photo') blob = await resizeImage(file, u.photoMaxPx);
    if (type === 'pano') blob = await resizeImage(file, u.panoMaxW, u.panoMaxW / 2); // ≤ 5760×2880 fits iOS canvas limit
  } catch (e) {
    console.warn('image decode', e);
    throw new Error('IMAGE_DECODE'); // e.g. HEIC in a browser that cannot read it
  }
  if (type === 'video' && file.size > u.maxVideoMB * 1e6) {
    throw new Error(`video > ${u.maxVideoMB} MB: use a YouTube/Vimeo link`);
  }

  const resourceType = RESOURCE_TYPE[type];
  const form = new FormData();
  form.append('file', blob, file.name);
  form.append('upload_preset', uploadPreset);
  form.append('folder', `${folder}/${type}`);

  const res = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(xhr.responseText)));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.send(form);
  });

  return {
    url: res.secure_url,
    publicId: res.public_id,
    resourceType,
    bytes: res.bytes,
    width: res.width ?? null,
    height: res.height ?? null,
    duration: res.duration ?? null,
    thumbUrl: thumbnail(res.secure_url, type),
  };
}

// Cloudinary on-the-fly thumbnail via URL transformation (images and video posters).
export function thumbnail(url, type, w = 400) {
  if (type === 'photo' || type === 'pano') return url.replace('/upload/', `/upload/c_limit,w_${w},q_auto,f_auto/`);
  if (type === 'video') return url.replace('/upload/', `/upload/c_limit,w_${w},so_1/`).replace(/\.\w+$/, '.jpg');
  return null;
}

// YouTube / Vimeo URL → embeddable iframe src (or null).
export function videoEmbed(link) {
  const yt = link.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([\w-]{11})/);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}`;
  const vm = link.match(/vimeo\.com\/(\d+)/);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return null;
}
