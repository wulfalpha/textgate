const mimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function imageReference(source) {
  if (!source || /^[a-z][a-z\d+.-]*:|^[\\/]/i.test(source)) {
    throw new Error('Use a relative local image path. Remote and embedded images are not loaded.');
  }
  try { return decodeURIComponent(source.split(/[?#]/, 1)[0]); }
  catch { throw new Error('The image path contains an invalid URL escape.'); }
}

function placeholder(image, reason) {
  const element = image.ownerDocument.createElement('span');
  element.className = 'image-placeholder';
  element.setAttribute('role', 'img');
  element.textContent = `Image unavailable${image.alt ? ` (${image.alt})` : ''}: ${reason}`;
  element.setAttribute('aria-label', element.textContent);
  image.replaceWith(element);
}

// Hydrate an inert sanitized fragment before it enters the live document.
// Only validated native image bytes become data URLs; source URLs never load.
export async function loadImages(fragment, { invoke, document, maxImages = 32, maxBytes = 32 * 1024 * 1024 }) {
  const images = [...fragment.querySelectorAll('img')];
  const sources = images.map((image) => image.getAttribute('src') ?? '');
  for (const image of images) image.removeAttribute('src');
  const cache = new Map();
  let bytes = 0;
  for (let index = 0; index < images.length; index++) {
    const image = images[index];
    try {
      if (index >= maxImages) throw new Error('Preview supports up to 32 images at once.');
      const reference = imageReference(sources[index]);
      let result = cache.get(reference);
      if (!result) {
        result = await invoke('load_note_image', { document, reference });
        if (!mimeTypes.has(result?.mime) || typeof result.data !== 'string' || !result.data.length || result.data.length % 4 || !/^[A-Za-z\d+/]*={0,2}$/.test(result.data)) {
          throw new Error('The file did not return a supported image.');
        }
        bytes += result.data.length / 4 * 3 - (result.data.endsWith('==') ? 2 : result.data.endsWith('=') ? 1 : 0);
        if (bytes > maxBytes) throw new Error('Preview image data exceeds 32 MiB.');
        cache.set(reference, result);
      }
      image.src = `data:${result.mime};base64,${result.data}`;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('error', () => placeholder(image, 'The image could not be decoded.'), { once: true });
    } catch (error) {
      placeholder(image, error?.message ?? String(error));
    }
  }
  return fragment;
}
