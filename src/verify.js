import crypto from 'node:crypto';
import { sendMail, messages, MailError } from './mailer.js';

/*
 * Email verification by one time code.
 *
 *   send  -> a 6 digit code is emailed (a captcha is needed to start, so the form cannot be used to spam inboxes)
 *   check -> the right code returns a token
 *   the token is handed in with the registration and proves the leader controls that email
 *
 * Limits, all enforced here on the server:
 *   - a code lives 10 minutes and allows 5 wrong tries
 *   - resend only after a 60 second wait, at most 3 resends per code request
 *   - at most 6 emails per address per hour, and 12 per day
 *   - (per IP limits are applied by the routes, and a site wide daily cap by the mailer)
 */

export const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_WAIT_MS = 60 * 1000;
const MAX_TRIES = 5;
const MAX_RESENDS = 3;
const PER_EMAIL_HOUR = 6;
const PER_EMAIL_DAY = 12;
const TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 20000;

const challenges = new Map(); // key -> { hash, expires, tries, sends, lastSent }
const tokens = new Map();     // token -> { key, expires }
const sendLog = new Map();    // email -> [timestamps]

const keyOf = (roll, email) => `${roll}|${email}`;
const hashCode = (key, code) => crypto.createHash('sha256').update(`${key}|${code}`).digest();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k);
  for (const [k, list] of sendLog) {
    const recent = list.filter((t) => now - t < 24 * 3600 * 1000);
    if (recent.length) sendLog.set(k, recent); else sendLog.delete(k);
  }
}, 60 * 1000).unref();

/** A problem to report to the person, with the HTTP status and seconds to wait when relevant. */
export class VerifyError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** True when a code request is in progress, so a resend does not need a new captcha. */
export function hasLiveChallenge(roll, email) {
  const c = challenges.get(keyOf(roll, email));
  return !!c && c.expires > Date.now();
}

export async function sendCode(roll, email) {
  const now = Date.now();
  const key = keyOf(roll, email);
  const existing = challenges.get(key);
  const live = existing && existing.expires > now ? existing : null;

  if (live) {
    const wait = Math.ceil((live.lastSent + RESEND_WAIT_MS - now) / 1000);
    if (wait > 0) throw new VerifyError(`Please wait ${wait} seconds before asking for another code.`, 429, { resendIn: wait });
    if (live.sends > MAX_RESENDS) {
      throw new VerifyError('Too many codes were sent for this request. Wait 10 minutes, check your Spam folder, then start again.', 429);
    }
  }

  const log = (sendLog.get(email) || []).filter((t) => now - t < 24 * 3600 * 1000);
  if (log.filter((t) => now - t < 3600 * 1000).length >= PER_EMAIL_HOUR) {
    throw new VerifyError('Too many codes were sent to this email in the last hour. Check your Spam folder, or try again later.', 429);
  }
  if (log.length >= PER_EMAIL_DAY) {
    throw new VerifyError('Too many codes were sent to this email today. Please contact the coordinator.', 429);
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  try {
    await sendMail(messages.code(email, code, CODE_TTL_MS / 60000));
  } catch (err) {
    if (err instanceof MailError) throw new VerifyError(err.message, 502);
    throw err;
  }

  if (challenges.size >= MAX_ENTRIES) challenges.delete(challenges.keys().next().value);
  // Each send replaces the code, so only the newest email works.
  challenges.set(key, { hash: hashCode(key, code), expires: now + CODE_TTL_MS, tries: 0, sends: (live?.sends || 0) + 1, lastSent: now });
  log.push(now);
  sendLog.set(email, log);
  return { resendIn: RESEND_WAIT_MS / 1000, expiresIn: CODE_TTL_MS / 1000, resendsLeft: MAX_RESENDS + 1 - ((live?.sends || 0) + 1) };
}

export function checkCode(roll, email, code) {
  const key = keyOf(roll, email);
  const c = challenges.get(key);
  if (!c || c.expires < Date.now()) {
    challenges.delete(key);
    throw new VerifyError('That code has expired. Ask for a new one.', 400, { expired: true });
  }
  const given = hashCode(key, String(code).replace(/\D/g, '').slice(0, 6));
  if (!crypto.timingSafeEqual(given, c.hash)) {
    c.tries += 1;
    if (c.tries >= MAX_TRIES) {
      challenges.delete(key);
      throw new VerifyError('Too many wrong codes. Ask for a new code.', 429, { expired: true });
    }
    const left = MAX_TRIES - c.tries;
    throw new VerifyError(`That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, 400);
  }
  challenges.delete(key);
  if (tokens.size >= MAX_ENTRIES) tokens.delete(tokens.keys().next().value);
  const token = crypto.randomBytes(24).toString('base64url');
  tokens.set(token, { key, expires: Date.now() + TOKEN_TTL_MS });
  return { token, validFor: TOKEN_TTL_MS / 1000 };
}

/** Does this token prove that this leader verified this email? Does not use the token up. */
export function tokenValid(token, roll, email) {
  if (typeof token !== 'string' || token.length > 60) return false;
  const t = tokens.get(token);
  return !!t && t.expires > Date.now() && t.key === keyOf(roll, email);
}

export const useToken = (token) => tokens.delete(token);
