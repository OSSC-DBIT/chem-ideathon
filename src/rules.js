import crypto from 'node:crypto';

/*
 * Input rules shared by the public form and the admin panel, so both accept
 * exactly the same roll numbers, phone numbers and so on.
 */

export const clean = (value, max) =>
  (typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max) : '');
export const cleanPhone = (value) => clean(value, 20).replace(/[\s-]/g, '').replace(/^(\+91|0)/, '');
export const cleanRoll = (value) => clean(value, 20).toUpperCase().replace(/\s/g, '');

export const NAME_RE = /^\p{L}[\p{L} .'-]{1,59}$/u;
export const ROLL_RE = /^[A-Z0-9][A-Z0-9/-]{2,19}$/;
export const PHONE_RE = /^[6-9]\d{9}$/;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const UTR_RE = /^\d{12}$/;
/** A section typed by hand ("Other"): 1 to 20 letters, digits, spaces, and the signs & / - */
export const SECTION_RE = /^[A-Z0-9][A-Z0-9 &/-]{0,19}$/;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
/** A new registration ID, for example IDT26-K7M2QX. Random, so it cannot be guessed from another one. */
export const newCode = () =>
  'IDT26-' + Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
