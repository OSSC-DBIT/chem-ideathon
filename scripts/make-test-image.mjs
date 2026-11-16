// Prints a test image as a data URL. Usage: node scripts/make-test-image.mjs <good|tiny|huge|corrupt>
import crypto from 'node:crypto';
import sharp from 'sharp';

const kind = process.argv[2] || 'good';
const solid = (width, height) => sharp({ create: { width, height, channels: 3, background: '#2e7d32' } }).png().toBuffer();

let buf;
if (kind === 'tiny') {
  buf = await solid(40, 40);
} else if (kind === 'huge') {
  // Random noise does not compress, so this PNG is far over the upload limit.
  buf = await sharp(crypto.randomBytes(1300 * 1300 * 3), { raw: { width: 1300, height: 1300, channels: 3 } }).png().toBuffer();
} else if (kind === 'corrupt') {
  buf = (await solid(600, 900)).subarray(0, 120); // right signature, broken body
} else {
  buf = await solid(600, 900);
}
process.stdout.write(`data:image/png;base64,${buf.toString('base64')}`);
