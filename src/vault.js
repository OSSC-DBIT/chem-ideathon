import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/*
 * Encryption at rest.
 *
 * One secret, DATA_KEY, protects everything stored on disk:
 *   - the SQLite database file (SQLCipher, AES-256, through the database driver)
 *   - every payment screenshot (AES-256-GCM, done here)
 *
 * Two independent 256 bit keys are derived from DATA_KEY, one for each job, so the same key
 * is never used by two different ciphers.
 *
 * DATA_KEY_OLD is only set while changing the key: data that does not open with DATA_KEY is
 * opened with DATA_KEY_OLD and written back with DATA_KEY.
 */

const PRODUCTION = process.env.NODE_ENV === 'production';
const SECRET = process.env.DATA_KEY || '';
const OLD_SECRET = process.env.DATA_KEY_OLD || '';

if (PRODUCTION && SECRET.length < 32) {
  throw new Error(
    'DATA_KEY must be set and at least 32 characters long in production. It encrypts the database and the payment ' +
    'screenshots. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  );
}
if (SECRET && SECRET.length < 32) {
  throw new Error('DATA_KEY is too short. Use at least 32 characters (see .env.example).');
}

export const encryptionOn = SECRET.length > 0;

const derive = (secret, purpose) => crypto.scryptSync(secret, `chem-ideathon:${purpose}:v1`, 32);

/** Raw database keys as hex, in the form SQLCipher takes them. null when encryption is off. */
export const dbKey = encryptionOn ? derive(SECRET, 'database').toString('hex') : null;
export const oldDbKey = OLD_SECRET ? derive(OLD_SECRET, 'database').toString('hex') : null;

const fileKey = encryptionOn ? derive(SECRET, 'files') : null;
const oldFileKey = OLD_SECRET ? derive(OLD_SECRET, 'files') : null;

// ---------------------------------------------------------------------------
// Files: MAGIC (4 bytes) | IV (12) | auth tag (16) | ciphertext
// ---------------------------------------------------------------------------
const MAGIC = Buffer.from('IDT1');
const isSealed = (buf) => buf.length > 32 && buf.subarray(0, 4).equals(MAGIC);

function sealWith(key, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function openWith(key, sealed) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, sealed.subarray(4, 16));
  decipher.setAuthTag(sealed.subarray(16, 32));
  return Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]); // throws if tampered or wrong key
}

/** Encrypts file contents for storage. Returned unchanged when encryption is off (development). */
export const sealFile = (plain) => (encryptionOn ? sealWith(fileKey, plain) : plain);

/** Decrypts stored file contents. Files written before encryption was switched on are returned as they are. */
export function openFile(stored) {
  if (!isSealed(stored)) return stored;
  if (!encryptionOn) throw new Error('This file is encrypted and DATA_KEY is not set.');
  return openWith(fileKey, stored);
}

/**
 * Brings every file in a folder up to the current key: plain files are encrypted, and files
 * sealed with DATA_KEY_OLD are re-sealed. Runs at start-up. Returns counts for the log.
 */
export function sealFolder(dir) {
  const result = { encrypted: 0, rekeyed: 0, unreadable: 0 };
  if (!encryptionOn) return result;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!fs.statSync(file).isFile()) continue;
    const stored = fs.readFileSync(file);
    let plain = null;
    if (!isSealed(stored)) {
      plain = stored;
      result.encrypted += 1;
    } else {
      try {
        openWith(fileKey, stored);
        continue; // already under the current key
      } catch {
        try {
          if (!oldFileKey) throw new Error('no old key');
          plain = openWith(oldFileKey, stored);
          result.rekeyed += 1;
        } catch {
          result.unreadable += 1;
          continue;
        }
      }
    }
    // Write to a temporary name first so a crash cannot leave a half written file.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, sealWith(fileKey, plain), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return result;
}
