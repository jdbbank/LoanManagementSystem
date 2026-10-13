// Binary fixtures + multipart helpers for the upload suites (KYC evidence and staff avatars).
// The server accepts images by magic bytes only, so these are signature-correct buffers.
const SIGN = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  webp: null, // RIFF....WEBP, built below
};

const filler = (kb) => Buffer.alloc(Math.max(1, kb) * 1024, 0x41);

export const pngBytes = (kb = 4) => Buffer.concat([SIGN.png, filler(kb), Buffer.from([0x00, 0x00])]);
export const jpegBytes = (kb = 4) => Buffer.concat([SIGN.jpeg, filler(kb), Buffer.from([0xff, 0xd9])]);
export const webpBytes = (kb = 4) => {
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + 4 + 4 + kb * 1024, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, filler(kb)]);
};

/** Not an image at all: correct extension, HTML/script payload inside. */
export const fakeImageBytes = () => Buffer.from('<html><script>alert(1)</script></html>'.repeat(4), 'utf8');
/** A real image hidden behind a .txt filename (magic bytes win, name must not matter). */
export const imageNamedTxt = () => pngBytes(2);

/**
 * Builds one multipart request body. Node 18+ ships FormData/Blob, and `fetch` sets the
 * boundary itself, so no hand-rolled multipart encoding is needed.
 */
export function multipartFile(buffer, { filename = 'upload.png', type = 'application/octet-stream', field = 'file' } = {}) {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), filename);
  return form;
}

export function multipartWithFields(buffer, fields, { filename = 'upload.png', type = 'image/png', field = 'file' } = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  form.append(field, new Blob([buffer], { type }), filename);
  return form;
}
