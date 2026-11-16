import net from 'node:net';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Limits (all adjustable through the environment)
// ---------------------------------------------------------------------------
const mb = (name, fallback) => {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 1024 * 1024;
};
export const MAX_SCREENSHOT_BYTES = mb('MAX_SCREENSHOT_MB', 3);   // size of the uploaded image
export const MAX_STATEMENT_BYTES = mb('MAX_STATEMENT_MB', 5);     // size of a bank statement file
const MIN_SIDE = 200;            // smaller than this cannot be a readable payment screenshot
const MAX_SIDE = 10000;          // pixels per side
const MAX_PIXELS = 40_000_000;   // guards against decompression bombs
const OUTPUT_SIDE = 1600;        // stored images fit inside this square

export const limits = {
  screenshotMb: MAX_SCREENSHOT_BYTES / 1024 / 1024,
  statementMb: MAX_STATEMENT_BYTES / 1024 / 1024,
};

/** An upload problem that is the sender's to fix. `status` is the HTTP status to answer with. */
export class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
const SIGNATURES = [
  (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,                                             // JPEG
  (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),     // PNG
  (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',            // WebP
];

/** Decodes a base64 data URL and applies the cheap checks: type, size and file signature. */
export function decodeImageDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) throw new UploadError('Attach the payment screenshot.');
  const match = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(dataUrl);
  if (!match) throw new UploadError('The screenshot must be a JPG, PNG or WebP image.');
  if (match[1].length > Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 4) {
    throw new UploadError(`The screenshot is too large. The limit is ${limits.screenshotMb} MB.`, 413);
  }
  const buf = Buffer.from(match[1], 'base64');
  if (buf.length > MAX_SCREENSHOT_BYTES) throw new UploadError(`The screenshot is too large. The limit is ${limits.screenshotMb} MB.`, 413);
  if (buf.length < 100 || !SIGNATURES.some((test) => test(buf))) {
    throw new UploadError('That file is not a valid JPG, PNG or WebP image.');
  }
  return buf;
}

/**
 * Fully decodes the image and writes a fresh JPEG. Whatever was uploaded, only the
 * pixels survive: metadata, trailing data and anything hidden in the file are dropped.
 */
export async function sanitiseImage(buf) {
  try {
    const image = sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error', sequentialRead: true });
    const meta = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(meta.format)) throw new UploadError('The screenshot must be a JPG, PNG or WebP image.');
    if (!meta.width || !meta.height || meta.width > MAX_SIDE || meta.height > MAX_SIDE) {
      throw new UploadError(`The screenshot is too big in pixels. Keep each side under ${MAX_SIDE} px.`, 413);
    }
    if (meta.width < MIN_SIDE || meta.height < MIN_SIDE) {
      throw new UploadError(`The screenshot is too small to read. It must be at least ${MIN_SIDE} x ${MIN_SIDE} px.`);
    }
    return await image
      .rotate() // apply the camera orientation, then drop the tag
      .resize({ width: OUTPUT_SIDE, height: OUTPUT_SIDE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch (err) {
    if (err instanceof UploadError) throw err;
    throw new UploadError('That image is damaged or could not be read. Take the screenshot again and retry.');
  }
}

// ---------------------------------------------------------------------------
// Virus scanning with ClamAV (clamd, INSTREAM protocol over TCP)
// ---------------------------------------------------------------------------
const CLAMAV_HOST = (process.env.CLAMAV_HOST || '').trim();
const CLAMAV_PORT = Number(process.env.CLAMAV_PORT) || 3310;
const SCAN_TIMEOUT_MS = 20000;
export const scannerConfigured = CLAMAV_HOST.length > 0;
/** When true, uploads are refused while the scanner is unreachable. Default: accept and mark as not scanned. */
export const scanRequired = process.env.SCAN_REQUIRED === 'true';

function clamd(send) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: CLAMAV_HOST, port: CLAMAV_PORT });
    const chunks = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn(value);
    };
    socket.setTimeout(SCAN_TIMEOUT_MS, () => finish(reject, new Error('scanner timed out')));
    socket.on('error', (err) => finish(reject, err));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
    socket.on('connect', () => send(socket));
  });
}

/** @returns {Promise<{ status: 'clean' | 'infected' | 'unavailable' | 'disabled', signature?: string }>} */
export async function scanBuffer(buf) {
  if (!scannerConfigured) return { status: 'disabled' };
  try {
    const reply = await clamd((socket) => {
      socket.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += 65536) {
        const part = buf.subarray(i, i + 65536);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(part.length);
        socket.write(size);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4)); // zero length chunk ends the stream
    });
    if (reply.endsWith('OK')) return { status: 'clean' };
    const found = /^stream: (.+) FOUND$/.exec(reply);
    if (found) return { status: 'infected', signature: found[1] };
    console.error('clamav: unexpected reply:', reply);
    return { status: 'unavailable' };
  } catch (err) {
    console.error('clamav: scan failed:', err.message);
    return { status: 'unavailable' };
  }
}

export async function scannerHealthy() {
  if (!scannerConfigured) return false;
  try {
    return (await clamd((socket) => socket.write('zPING\0'))) === 'PONG';
  } catch {
    return false;
  }
}

/**
 * Scans an upload and decides what to do with it.
 * Returns 'clean' or 'unscanned'; throws UploadError when the file must be refused.
 */
export async function scanOrThrow(buf, what) {
  const result = await scanBuffer(buf);
  if (result.status === 'infected') {
    console.warn(`clamav: blocked ${what}: ${result.signature}`);
    throw Object.assign(new UploadError('This file was blocked by the virus scanner. Upload a different file.', 422), { signature: result.signature });
  }
  if (result.status === 'clean') return 'clean';
  if (scanRequired) throw new UploadError('The virus scanner is not ready yet. Please try again in a few minutes.', 503);
  return 'unscanned';
}
