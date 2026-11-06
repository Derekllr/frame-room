import {LIMITS, PhotoError, fit, photoHeader} from './core.mjs';

function canvasOf(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
}

function jpegOf(canvas, quality) {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({type:'image/jpeg', quality});
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new PhotoError('unreadable')), 'image/jpeg', quality));
}

export async function processPhoto(file) {
  if (!file.size) throw new PhotoError('unreadable');
  if (file.size > LIMITS.bytes) throw new PhotoError('fileLarge');
  const original = photoHeader(await file.slice(0, 512 * 1024).arrayBuffer());
  const target = fit(original.width, original.height, LIMITS.edge);
  let bitmap, canvas, thumb;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation:'from-image', resizeWidth:target.width, resizeHeight:target.height, resizeQuality:'high' });
    let { width, height } = target;
    canvas = canvasOf(width, height);
    const ctx = canvas.getContext('2d', {alpha:false});
    if (!ctx) throw new PhotoError('unreadable');
    const draw = () => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
    };
    draw();
    // Avoid inflating already optimized inputs; don't chase tiny files at the expense of detail.
    const budget = Math.min(LIMITS.target, Math.max(16_000, Math.floor(file.size * .90)));
    let blob;
    for (const quality of [.84, .76, .66, .56]) {
      blob = await jpegOf(canvas, quality);
      if (blob.size <= budget) break;
    }
    if (blob.size > budget && Math.max(width, height) > 1160) {
      ({width, height} = fit(width, height, 1160));
      canvas.width = width; canvas.height = height;
      draw();
      blob = await jpegOf(canvas, .66);
    }
    bitmap.close(); bitmap = null;
    const t = fit(width, height, 300);
    thumb = canvasOf(t.width, t.height);
    thumb.getContext('2d', {alpha:false}).drawImage(canvas, 0, 0, t.width, t.height);
    const thumbnail = await jpegOf(thumb, .72);
    return { name:file.name, originalBytes:file.size, originalWidth:original.width, originalHeight:original.height,
      bytes:blob.size, width, height, blob, thumbnail };
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    throw new PhotoError('unreadable');
  } finally {
    bitmap?.close();
    if (canvas) { canvas.width = 1; canvas.height = 1; }
    if (thumb) { thumb.width = 1; thumb.height = 1; }
  }
}
