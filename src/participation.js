import { db } from './db.js';

/*
 * Two things that depend on how the event day is organised:
 *
 * 1. Halves. Events run in the 1st half or the 2nd half of the day. By default a student may
 *    take part in one event in each half, so the question is never just "is this student
 *    registered" but "is this student busy at that time".
 *
 * 2. Registration IDs. They read IDT26-<event code><number>, for example IDT26-TB007 for the
 *    seventh entry of Treasure Hunt + Bounty.
 */

// ---------------------------------------------------------------------------
// Halves
// ---------------------------------------------------------------------------
export const SLOTS = ['first', 'second'];
export const slotLabel = (slot) => ({ first: '1st half', second: '2nd half' }[slot] || '');

/** The ways a student can be limited. Chosen by the organisers in Settings. */
export const RULES = ['perHalf', 'one', 'any'];
export const ruleSentence = (rule) => ({
  perHalf: 'A student can join one event in each half.',
  one: 'A student can join only one event.',
  any: 'A student cannot be in two teams of the same event.',
}[rule]);

/** Do two events take place at the same time? An event with no half set counts as the whole day. */
const sameTime = (a, b) => !a || !b || a === b;

const liveEntriesOf = db.prepare(`
  SELECT r.id, r.code, r.team_name, r.event_id, e.title, e.slot
  FROM members m
  JOIN registrations r ON r.id = m.registration_id
  JOIN events e ON e.id = r.event_id
  WHERE r.status != 'rejected' AND m.roll = ?
`);

/**
 * Is this student already taken for the time of `event`?
 * Returns the registration that blocks them, or null. `selfId` is a registration to ignore
 * (the one being edited). Rejected registrations never block anyone.
 */
export function findClash(settings, event, roll, selfId = 0) {
  for (const entry of liveEntriesOf.all(roll)) {
    if (entry.id === selfId) continue;
    if (entry.event_id === event.id) return { ...entry, sameEvent: true };
    if (settings.participation === 'one') return entry;
    if (settings.participation === 'perHalf' && sameTime(entry.slot, event.slot)) return entry;
  }
  return null;
}

/** "Poster Presentation (1st half)", or just the title when the event has no half set. */
export const eventWithHalf = (title, slot) => (slotLabel(slot) ? `${title} (${slotLabel(slot)})` : title);

// ---------------------------------------------------------------------------
// Event codes and registration IDs
// ---------------------------------------------------------------------------
export const EVENT_CODE_RE = /^[A-Z][A-Z0-9]{1,3}$/;
const codeTaken = db.prepare('SELECT 1 FROM events WHERE code = ? AND id != ?');

/**
 * A short code for an event, from the first letters of its first and last word:
 * "Treasure Hunt + Bounty" gives TB, "Poster Presentation" gives PP. If that is taken, other
 * letters of the title are tried, then a digit is added.
 */
export function suggestEventCode(title, selfId = 0) {
  const words = String(title).toUpperCase().split(/[^A-Z0-9]+/).filter((w) => /^[A-Z]/.test(w));
  const first = words[0] || 'EV';
  const last = words[words.length - 1] || first;
  const candidates = [
    first[0] + last[0],
    (first.slice(0, 2) + 'X').slice(0, 2),
    ...words.slice(1).map((w) => first[0] + w[0]),
    ...[...first.slice(1)].map((ch) => first[0] + ch),
  ].filter((c) => EVENT_CODE_RE.test(c));
  for (const code of candidates) if (!codeTaken.get(code, selfId)) return code;
  for (let n = 2; n < 100; n += 1) {
    const code = `${first[0]}${last[0]}${n}`.slice(0, 4);
    if (!codeTaken.get(code, selfId)) return code;
  }
  return `E${selfId || 0}`.slice(0, 4);
}

export const eventCodeTaken = (code, selfId = 0) => !!codeTaken.get(code, selfId);

const bumpSequence = db.prepare('UPDATE events SET last_seq = last_seq + 1 WHERE id = ?');
const readSequence = db.prepare('SELECT code, last_seq FROM events WHERE id = ?');
const idTaken = db.prepare('SELECT 1 FROM registrations WHERE code = ?');

/**
 * The next registration ID for an event, for example IDT26-PP012. Numbers run per event and are
 * never reused, even when a registration is deleted. Call this inside the same transaction that
 * inserts the registration.
 */
export function nextRegistrationId(eventId) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    bumpSequence.run(eventId);
    const { code, last_seq: seq } = readSequence.get(eventId);
    const id = `IDT26-${code}${String(seq).padStart(3, '0')}`;
    if (!idTaken.get(id)) return id; // only skips ahead if an event code was reused
  }
  throw new Error('Could not allocate a registration ID.');
}

/** Registration IDs people may type: the new IDT26-PP012 style and the older random IDT26-K7M2QX. */
export const REGISTRATION_ID_RE = /^IDT26-[A-Z0-9]{3,12}$/;

// ---------------------------------------------------------------------------
// One time: give every existing event a code (events created before codes existed).
// ---------------------------------------------------------------------------
for (const event of db.prepare("SELECT id, title FROM events WHERE code = '' ORDER BY id").all()) {
  db.prepare('UPDATE events SET code = ? WHERE id = ?').run(suggestEventCode(event.title, event.id), event.id);
}
