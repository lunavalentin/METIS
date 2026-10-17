// Browser → Cloudinary upload (unsigned preset) with progress.
// Resource types: images & panos → "image"; video & audio → "video" (Cloudinary files audio
// under video); IRs → "raw" so the WAV is delivered byte-exact (no transcoding of 4-ch files).

export const RESOURCE_TYPE = { photo: 'image', pano: 'image', video: 'video', audio: 'video', ir: 'raw' };

// Uploads an already-checked file (see media.js). onProgress(0..1).
export async function uploadMedia(config, type, file, onProgress = () => {}) {
  // cloudName/uploadPreset come from the admin settings in Firestore (not the public config.json); folder from config.
  const { cloudName, uploadPreset } = { ...config.cloudinary, ...config.uploadSettings };
  const { folder } = config.cloudinary;
  if (!cloudName || !uploadPreset || cloudName === 'TODO') throw new Error('UPLOAD_NOT_CONFIGURED');
  // Size/type/duration were checked (and fixed if needed) by media.js before we get here.
  const blob = file;

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
