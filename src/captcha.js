import crypto from 'node:crypto';
import sharp from 'sharp';

/*
 * Self hosted image captcha. No third party service, no fonts needed: each digit is
 * drawn from line strokes with random tilt, wobble and noise, then turned into a PNG
 * so the answer never appears in the page source.
 *
 * A captcha works once, for one attempt, and expires after a few minutes.
 */

const LENGTH = 5;
const TTL_MS = 5 * 60 * 1000;
const MAX_STORED = 5000;
const WIDTH = 260;
const HEIGHT = 90;

// Test hook: outside production, a fixed answer can be set so automated tests can submit the form.
const TEST_CODE = process.env.NODE_ENV !== 'production' && /^\d{5}$/.test(process.env.CAPTCHA_TEST_CODE || '')
  ? process.env.CAPTCHA_TEST_CODE
  : null;

// Stroke outlines on a 10 x 16 grid. Each digit is a list of polylines.
const DIGITS = {
  0: [[[2, 1], [8, 1], [9, 3], [9, 13], [8, 15], [2, 15], [1, 13], [1, 3], [2, 1]]],
  1: [[[3, 4], [5.500, 1], [5.500, 15]], [[3, 15], [8, 15]]],
  2: [[[1.500, 4], [3, 1.500], [7, 1], [9, 3.500], [8.500, 6.500], [1, 15], [9, 15]]],
  3: [[[1.500, 2], [8, 1], [9, 4], [7, 7.500], [4, 8]], [[7, 7.500], [9, 11], [8, 14.500], [2, 15], [1, 13]]],
  4: [[[7, 15], [7, 1], [1, 10.500], [9.500, 10.500]]],
  5: [[[8.500, 1], [2, 1], [1.500, 7], [6.500, 6.500], [9, 9], [9, 13], [7, 15], [1.500, 14.500]]],
  6: [[[8, 1.500], [4, 1.500], [1.500, 5], [1, 12], [3, 15], [7, 15], [9, 12.500], [8.500, 9], [6, 7.500], [1.500, 8.500]]],
  7: [[[1, 1], [9, 1], [4, 15]]],
  8: [[[5, 7.500], [2, 5.500], [2, 2.500], [4, 1], [6, 1], [8, 2.500], [8, 5.500], [5, 7.500], [1.500, 10], [1.500, 13], [3.500, 15], [6.500, 15], [8.500, 13], [8.500, 10], [5, 7.500]]],
  9: [[[8.500, 7], [4, 8.500], [1.500, 7], [1, 3.500], [3, 1], [7, 1], [9, 3.500], [9, 10], [7, 14], [3, 15]]],
};

const INKS = ['#202124', '#1a3f8f', '#7a1f5c', '#0d5c3a', '#8a3b00'];
const rand = (min, max) => min + (crypto.randomInt(0, 10000) / 10000) * (max - min);
const pick = (list) => list[crypto.randomInt(0, list.length)];

function drawSvg(code) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#fffbe6"/>`];

  for (let i = 0; i < 7; i += 1) {
    parts.push(`<path d="M${rand(0, WIDTH).toFixed(1)},${rand(0, HEIGHT).toFixed(1)} Q${rand(0, WIDTH).toFixed(1)},${rand(0, HEIGHT).toFixed(1)} ${rand(0, WIDTH).toFixed(1)},${rand(0, HEIGHT).toFixed(1)}" stroke="${pick(INKS)}" stroke-width="${rand(1, 2.2).toFixed(1)}" fill="none" opacity="${rand(0.25, 0.55).toFixed(2)}"/>`);
  }
  for (let i = 0; i < 70; i += 1) {
    parts.push(`<circle cx="${rand(0, WIDTH).toFixed(1)}" cy="${rand(0, HEIGHT).toFixed(1)}" r="${rand(0.6, 1.8).toFixed(1)}" fill="${pick(INKS)}" opacity="${rand(0.2, 0.6).toFixed(2)}"/>`);
  }

  const slot = (WIDTH - 30) / LENGTH;
  [...code].forEach((digit, i) => {
    const scale = rand(3.1, 3.9);
    const x = 15 + i * slot + rand(0, slot - 10 * scale > 0 ? slot - 10 * scale : 2);
    const y = rand(6, Math.max(7, HEIGHT - 16 * scale - 6));
    const d = DIGITS[digit].map((line) => line
      .map(([px, py], n) => `${n ? 'L' : 'M'}${(px + rand(-0.45, 0.45)).toFixed(2)},${(py + rand(-0.45, 0.45)).toFixed(2)}`)
      .join(' ')).join(' ');
    parts.push(`<path d="${d}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rand(-17, 17).toFixed(1)} ${5 * scale} ${8 * scale}) scale(${scale.toFixed(2)})" stroke="${pick(INKS)}" stroke-width="${rand(0.75, 1.05).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`);
  });

  // A line across the digits makes the characters harder to separate automatically.
  parts.push(`<path d="M0,${rand(25, 65).toFixed(1)} C${rand(60, 100).toFixed(1)},${rand(5, 85).toFixed(1)} ${rand(150, 200).toFixed(1)},${rand(5, 85).toFixed(1)} ${WIDTH},${rand(25, 65).toFixed(1)}" stroke="${pick(INKS)}" stroke-width="2" fill="none" opacity="0.7"/>`);
  parts.push('</svg>');
  return parts.join('');
}

// id -> { answer, expires }
const store = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store) if (entry.expires < now) store.delete(id);
}, 60 * 1000).unref();

export async function createCaptcha() {
  if (store.size >= MAX_STORED) store.delete(store.keys().next().value); // drop the oldest
  const answer = TEST_CODE || Array.from({ length: LENGTH }, () => crypto.randomInt(0, 10)).join('');
  const id = crypto.randomBytes(18).toString('base64url');
  store.set(id, { answer, expires: Date.now() + TTL_MS });
  const png = await sharp(Buffer.from(drawSvg(answer))).png({ compressionLevel: 6 }).toBuffer();
  return { id, image: `data:image/png;base64,${png.toString('base64')}`, expiresInSeconds: TTL_MS / 1000 };
}

/**
 * Checks an answer and always uses the captcha up, right or wrong, so it cannot be guessed at.
 * @returns {'ok' | 'wrong' | 'expired'}
 */
export function verifyCaptcha(id, answer) {
  if (typeof id !== 'string' || typeof answer !== 'string' || id.length > 60) return 'expired';
  const entry = store.get(id);
  store.delete(id);
  if (!entry || entry.expires < Date.now()) return 'expired';
  const given = Buffer.from(answer.replace(/\s/g, '').padEnd(LENGTH, ' ').slice(0, 32));
  const wanted = Buffer.from(entry.answer.padEnd(given.length, ' '));
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted) ? 'ok' : 'wrong';
}
