import crypto from 'node:crypto';
import { db } from './db.js';

// ---------------------------------------------------------------------------
// Who can sign in.
//
// The OWNER account comes from the environment (ADMIN_USERNAME, ADMIN_PASSWORD). Its password
// is never stored; only a scrypt hash is kept in memory. The owner can create ORGANISER
// accounts from the admin panel, so each person signs in as themselves and the activity log
// shows who did what. Organiser passwords are stored as salted scrypt hashes.
// ---------------------------------------------------------------------------
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const adminConfigured = ADMIN_PASSWORD.length > 0;
export const OWNER = ADMIN_USERNAME;
export const MIN_PASSWORD = 12;

if (process.env.NODE_ENV === 'production' && ADMIN_PASSWORD.length < MIN_PASSWORD) {
  throw new Error('ADMIN_PASSWORD must be set and at least 12 characters long in production.');
}

const SALT = crypto.randomBytes(16);
const scrypt = (text, salt = SALT) => crypto.scryptSync(text, salt, 32);
const passwordHash = adminConfigured ? scrypt(ADMIN_PASSWORD) : null;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

const findOrganiser = db.prepare('SELECT username, salt, hash FROM organisers WHERE username = ?');
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;

/** Returns the account name when the username and password are right, otherwise null. */
export function checkCredentials(username, password) {
  if (!adminConfigured || typeof username !== 'string' || typeof password !== 'string') return null;
  if (password.length > 200 || username.length > 100) return null;
  const name = username.trim();

  const ownerOk = crypto.timingSafeEqual(sha256(name), sha256(OWNER)) &&
    crypto.timingSafeEqual(scrypt(password), passwordHash);
  if (ownerOk) return OWNER;

  // The hash is computed whether or not the account exists, so the reply time does not
  // reveal which usernames are real.
  const row = findOrganiser.get(name.toLowerCase());
  const hash = scrypt(password, row ? Buffer.from(row.salt, 'hex') : SALT);
  if (row && crypto.timingSafeEqual(hash, Buffer.from(row.hash, 'hex'))) return row.username;
  return null;
}

export const isOwner = (session) => !!session && session.username === OWNER;

export function listOrganisers() {
  return db.prepare('SELECT username, created_at AS createdAt, created_by AS createdBy FROM organisers ORDER BY username').all();
}

function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return 'That password is too long.';
  return null;
}

function storePassword(username, password) {
  const salt = crypto.randomBytes(16);
  db.prepare('UPDATE organisers SET salt = ?, hash = ? WHERE username = ?')
    .run(salt.toString('hex'), scrypt(password, salt).toString('hex'), username);
}

/** Creates an organiser account. Returns an error message, or null on success. */
export function addOrganiser(username, password, createdBy) {
  const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(name)) return 'Usernames are 3 to 30 characters: small letters, digits, dot, dash or underscore.';
  if (name === OWNER.toLowerCase()) return 'That username belongs to the owner account.';
  const weak = checkNewPassword(password);
  if (weak) return weak;
  if (findOrganiser.get(name)) return 'That username is already taken.';
  db.prepare('INSERT INTO organisers (username, salt, hash, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(name, '', '', new Date().toISOString(), createdBy);
  storePassword(name, password);
  return null;
}

/** Removes an organiser and signs them out everywhere. Returns false when there is no such account. */
export function removeOrganiser(username) {
  const name = String(username || '').trim().toLowerCase();
  const removed = db.prepare('DELETE FROM organisers WHERE username = ?').run(name).changes > 0;
  if (removed) db.prepare('DELETE FROM admin_sessions WHERE username = ?').run(name);
  return removed;
}

/** Lets an organiser change their own password. Returns an error message, or null on success. */
export function changeOwnPassword(session, current, next) {
  if (isOwner(session)) return 'The owner password is set with ADMIN_PASSWORD in the .env file on the server.';
  if (checkCredentials(session.username, typeof current === 'string' ? current : '') !== session.username) {
    return 'The current password is not right.';
  }
  const weak = checkNewPassword(next);
  if (weak) return weak;
  storePassword(session.username, next);
  // Other devices signed in with the old password are signed out; this session stays.
  db.prepare('DELETE FROM admin_sessions WHERE username = ? AND token_hash != ?').run(session.username, session.token_hash);
  return null;
}

// ---------------------------------------------------------------------------
// Sessions live in the database (hashed), so they can be revoked and they
// survive restarts. Each session carries its own CSRF token.
// ---------------------------------------------------------------------------
export const SESSION_COOKIE = 'idt_session';
const SESSION_MS = 8 * 3600 * 1000;

const insertSession = db.prepare('INSERT INTO admin_sessions (token_hash, csrf, username, expires_at) VALUES (?, ?, ?, ?)');
const findSession = db.prepare('SELECT * FROM admin_sessions WHERE token_hash = ?');
const dropSession = db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?');
const dropExpired = db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?');
setInterval(() => dropExpired.run(Date.now()), 15 * 60 * 1000).unref();
dropExpired.run(Date.now());

const hashToken = (token) => sha256(token).toString('hex');

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

export function createSession(req, res, username) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  insertSession.run(hashToken(token), csrf, username, Date.now() + SESSION_MS);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: SESSION_MS,
    path: '/',
  });
  return csrf;
}

export function getSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const row = findSession.get(hashToken(token));
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

export function destroySession(req, res) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) dropSession.run(hashToken(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Requires a valid session, and a matching CSRF token on anything that changes data. */
export function requireAdmin(req, res, next) {
  if (!adminConfigured) return res.status(503).json({ error: 'Admin access is not configured. Set ADMIN_PASSWORD.' });
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Please sign in.' });
  if (!['GET', 'HEAD'].includes(req.method)) {
    const sent = String(req.headers['x-csrf-token'] || '');
    const a = sha256(sent);
    const b = sha256(session.csrf);
    if (!crypto.timingSafeEqual(a, b)) return res.status(403).json({ error: 'Security check failed. Reload the page and try again.' });
  }
  req.admin = session;
  res.set('Cache-Control', 'no-store');
  next();
}

/** For routes only the owner account may use (managing organiser accounts). Runs after requireAdmin. */
export function requireOwner(req, res, next) {
  if (!isOwner(req.admin)) return res.status(403).json({ error: 'Only the owner account can do this.' });
  next();
}

// ---------------------------------------------------------------------------
// Generic middleware
// ---------------------------------------------------------------------------
export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; " +
      "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
}

/** Rejects cross site writes: the Origin header, when present, must match the Host. */
export function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* malformed origin */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross site request blocked.' });
  }
  if (!req.is('application/json')) return res.status(415).json({ error: 'Unsupported content type.' });
  next();
}

/** Fixed window rate limiter, kept in memory. `onlyFailures` counts only responses with status >= 400. */
export function rateLimit({ windowMs, max, onlyFailures = false, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.reset < now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(req.ip, entry);
    }
    if (entry.count >= max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: message || 'Too many requests. Please try again in a few minutes.' });
    }
    if (onlyFailures) {
      res.on('finish', () => { if (res.statusCode >= 400) entry.count += 1; });
    } else {
      entry.count += 1;
    }
    next();
  };
}
