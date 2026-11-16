import crypto from 'node:crypto';
import { db } from './db.js';

// ---------------------------------------------------------------------------
// Admin credentials come from the environment. The password is never stored;
// only a scrypt hash is kept in memory for comparison.
// ---------------------------------------------------------------------------
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const adminConfigured = ADMIN_PASSWORD.length > 0;

if (process.env.NODE_ENV === 'production' && ADMIN_PASSWORD.length < 12) {
  throw new Error('ADMIN_PASSWORD must be set and at least 12 characters long in production.');
}

const SALT = crypto.randomBytes(16);
const scrypt = (text) => crypto.scryptSync(text, SALT, 32);
const passwordHash = adminConfigured ? scrypt(ADMIN_PASSWORD) : null;
const sha256 = (text) => crypto.createHash('sha256').update(text).digest();

export function checkCredentials(username, password) {
  if (!adminConfigured || typeof username !== 'string' || typeof password !== 'string') return false;
  if (password.length > 200 || username.length > 100) return false;
  const userOk = crypto.timingSafeEqual(sha256(username.trim()), sha256(ADMIN_USERNAME));
  const passOk = crypto.timingSafeEqual(scrypt(password), passwordHash);
  return userOk && passOk;
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
