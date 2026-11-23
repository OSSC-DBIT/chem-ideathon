import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3-multiple-ciphers';
import { dbKey, oldDbKey, encryptionOn, sealFolder } from './vault.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'ideathon.db');

// ---------------------------------------------------------------------------
// Opening the database. With DATA_KEY set the whole file is encrypted (SQLCipher, AES-256).
// ---------------------------------------------------------------------------
function withKey(key) {
  const handle = new Database(DB_FILE);
  if (key) {
    handle.pragma("cipher = 'sqlcipher'");
    handle.pragma(`key = "x'${key}'"`);
  }
  try {
    handle.prepare('SELECT COUNT(*) FROM sqlite_master').get(); // fails here when the key is wrong
  } catch (err) {
    handle.close(); // never leave a failed connection holding the file
    throw err;
  }
  return handle;
}

function tryOpen(key) {
  try {
    return withKey(key);
  } catch (err) {
    if (err.code !== 'SQLITE_NOTADB') throw err;
    return null;
  }
}

/** Re-encrypts the file in place under the current key. `from` is the key it opens with now (null = plain). */
function convert(from, what) {
  const backup = `${DB_FILE}.converting`;
  const handle = withKey(from);
  handle.pragma('wal_checkpoint(TRUNCATE)');
  handle.pragma('journal_mode = DELETE');
  fs.copyFileSync(DB_FILE, backup); // safety copy, removed as soon as the result is verified
  try {
    if (!from) handle.pragma("cipher = 'sqlcipher'");
    handle.pragma(`rekey = "x'${dbKey}'"`);
    handle.close();
    withKey(dbKey).close();
  } catch (err) {
    try { handle.close(); } catch { /* already closed */ }
    fs.copyFileSync(backup, DB_FILE);
    fs.rmSync(backup, { force: true });
    throw new Error(`Could not ${what}: ${err.message}. The database was left unchanged.`);
  }
  fs.rmSync(backup, { force: true });
  console.log(`database: ${what} done`);
}

function openDatabase() {
  const isNew = !fs.existsSync(DB_FILE) || fs.statSync(DB_FILE).size === 0;
  if (isNew) return withKey(dbKey);

  const direct = tryOpen(dbKey);
  if (direct) return direct;

  if (!encryptionOn) {
    throw new Error('The database is encrypted but DATA_KEY is not set. Set DATA_KEY to the key it was encrypted with.');
  }
  const plain = tryOpen(null);
  if (plain) {
    // An existing database from before encryption was switched on.
    plain.close();
    convert(null, 'encrypt the existing database');
    return withKey(dbKey);
  }
  const previous = oldDbKey ? tryOpen(oldDbKey) : null;
  if (previous) {
    previous.close();
    convert(oldDbKey, 'change the database key');
    return withKey(dbKey);
  }
  throw new Error(
    'DATA_KEY does not match this database. Use the key it was encrypted with. ' +
    'To change the key, put the old one in DATA_KEY_OLD and the new one in DATA_KEY.',
  );
}

export const db = openDatabase();

// Screenshots: encrypt any that are still plain, and move any under an old key to the current one.
{
  const moved = sealFolder(UPLOAD_DIR);
  if (moved.encrypted || moved.rekeyed) console.log(`uploads: ${moved.encrypted} encrypted, ${moved.rekeyed} moved to the new key`);
  if (moved.unreadable) console.error(`uploads: ${moved.unreadable} file(s) could not be opened with DATA_KEY or DATA_KEY_OLD`);
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    team_based  INTEGER NOT NULL DEFAULT 1,
    min_members INTEGER NOT NULL DEFAULT 1,
    max_members INTEGER NOT NULL DEFAULT 1,
    max_teams   INTEGER NOT NULL DEFAULT 0,   -- 0 means no limit
    fee         INTEGER NOT NULL DEFAULT 50,  -- rupees per participant
    is_open     INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS registrations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT NOT NULL UNIQUE,
    event_id      INTEGER NOT NULL REFERENCES events(id),
    team_name     TEXT NOT NULL,
    leader_email  TEXT NOT NULL,
    leader_phone  TEXT NOT NULL,
    member_count  INTEGER NOT NULL,
    amount        INTEGER NOT NULL,
    utr           TEXT NOT NULL,
    screenshot    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    reject_reason TEXT NOT NULL DEFAULT '',
    decided_by    TEXT,
    decided_at    TEXT,
    created_at    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reg_event  ON registrations(event_id, status);
  CREATE INDEX IF NOT EXISTS idx_reg_utr    ON registrations(utr);

  CREATE TABLE IF NOT EXISTS members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    name            TEXT NOT NULL,
    roll            TEXT NOT NULL,
    branch          TEXT NOT NULL,
    phone           TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_member_reg  ON members(registration_id);
  CREATE INDEX IF NOT EXISTS idx_member_roll ON members(roll);

  CREATE TABLE IF NOT EXISTS students (
    roll   TEXT PRIMARY KEY,
    name   TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT '',
    phone  TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS organisers (
    username   TEXT PRIMARY KEY,
    salt       TEXT NOT NULL,
    hash       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    csrf       TEXT NOT NULL,
    username   TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
`);

// Columns added after the first release. Safe to run on every start.
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return !exists; // true when the column was added just now
}
addColumn('registrations', 'scan_status', "TEXT NOT NULL DEFAULT 'unscanned'"); // clean | unscanned
addColumn('students', 'email', "TEXT NOT NULL DEFAULT ''");
addColumn('registrations', 'source', "TEXT NOT NULL DEFAULT 'online'"); // online | admin (added by an organiser)
addColumn('registrations', 'note', "TEXT NOT NULL DEFAULT ''");          // organiser's note, for example how a team paid
addColumn('members', 'section', "TEXT NOT NULL DEFAULT ''");             // class section, for example A or B
addColumn('students', 'section', "TEXT NOT NULL DEFAULT ''");
addColumn('events', 'code', "TEXT NOT NULL DEFAULT ''");         // short code used in registration IDs, for example PP
addColumn('events', 'slot', "TEXT NOT NULL DEFAULT ''");         // first | second half of the day, or '' when not set
addColumn('events', 'last_seq', 'INTEGER NOT NULL DEFAULT 0');   // running number of the event's registration IDs
const rulesAdded = addColumn('events', 'rules', "TEXT NOT NULL DEFAULT ''"); // rules and format, one per line
// How the team pays: upi (transaction ID and screenshot) or cash (collected by the organisers).
if (addColumn('registrations', 'pay_method', "TEXT NOT NULL DEFAULT 'upi'")) {
  db.exec("UPDATE registrations SET pay_method = 'cash' WHERE utr = ''"); // hand added teams with no transaction ID
}

// ---------------------------------------------------------------------------
// Settings: a small key/value store, edited from the admin panel.
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  eventName: "Ideathon '26",
  eventDate: '2026-11-28',
  venue: 'DBIT Campus, Kumbalagodu, Bengaluru',
  regMode: 'open',            // open | closed | scheduled
  opensAt: '',                // ISO strings, used when regMode is "scheduled"
  closesAt: '',
  upiId: (process.env.UPI_ID || '').trim(),
  upiName: (process.env.UPI_NAME || 'Ideathon 26').trim(),
  paymentMode: 'upi',         // upi: paid online | cash: collected by the organisers. One or the other, never a choice.
  cashNote: 'Pay the amount in cash to the event coordinator at the Department of Chemistry and tell them your registration ID.',
  instructions: [             // shown before a student picks an event
    'Open to 1st year students of Don Bosco Institute of Technology only.',
    'The entry fee is per participant, for each event.',
    'The team leader registers the whole team. Keep every member\'s roll number and section ready.',
    'Read the rules of the event before you register for it.',
    'Details cannot be changed after you submit. For a correction, contact the coordinator.',
    'A registration is confirmed only after the organisers have recorded the payment.',
    'Winners get prize money and every participant gets a certificate.',
  ],
  notice: '',
  branches: ['CSE', 'ISE', 'ECE', 'EEE', 'AI & ML', 'AI & DS', 'Mechanical', 'Civil'],
  sections: 'ABCDEFGHIJKLMNOP'.split(''),               // A to P: the sections students can pick from
  allowOtherSection: true,    // students may choose "Other" and type a section that is not in the list
  contactName: 'Prof Chinmayi G',
  contactPhone: '',
  participation: 'perHalf',   // perHalf: one event in each half | one: one event only | any: no limit across events
  rosterRequired: false,      // only roll numbers on the uploaded student list may register
  matchLeaderPhone: false,    // the leader's phone must match the phone on the student list
  emailVerification: false,   // the leader must confirm their email with a code before paying
};

const selectSettings = db.prepare('SELECT key, value FROM settings');
const upsertSetting = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
);

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  for (const row of selectSettings.all()) {
    if (row.key in out) {
      try { out[row.key] = JSON.parse(row.value); } catch { /* keep default */ }
    }
  }
  return out;
}

export function saveSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key in DEFAULT_SETTINGS) upsertSetting.run(key, JSON.stringify(value));
  }
}

// The yes/no "more than one event" setting became a three way rule. Carry a saved choice over once.
{
  const old = db.prepare("SELECT value FROM settings WHERE key = 'allowMultiEvent'").get();
  const current = db.prepare("SELECT 1 FROM settings WHERE key = 'participation'").get();
  if (old && !current && old.value === 'true') saveSettings({ participation: 'any' });
  if (old) db.prepare("DELETE FROM settings WHERE key = 'allowMultiEvent'").run();
}

// The built in section list grew from A-H to A-P. A saved list is upgraded only when it is still
// exactly the old default, so a list an organiser changed on purpose is left alone.
{
  const saved = db.prepare("SELECT value FROM settings WHERE key = 'sections'").get();
  if (saved && saved.value === JSON.stringify('ABCDEFGH'.split(''))) saveSettings({ sections: DEFAULT_SETTINGS.sections });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const insertAudit = db.prepare('INSERT INTO audit (at, actor, action, detail) VALUES (?, ?, ?, ?)');
export function audit(actor, action, detail = '') {
  insertAudit.run(new Date().toISOString(), actor, action, String(detail).slice(0, 500));
}

/**
 * How teams pay right now: ['cash'], ['upi'], or [] when UPI is chosen but no UPI ID is set yet
 * (nobody can pay, so registration stays closed). Always one way at most.
 */
export function payMethods(settings = getSettings()) {
  if (settings.paymentMode === 'cash') return ['cash'];
  return settings.upiId ? ['upi'] : [];
}

export function eventToJson(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    teamBased: !!row.team_based,
    minMembers: row.min_members,
    maxMembers: row.max_members,
    maxTeams: row.max_teams,
    fee: row.fee,
    isOpen: !!row.is_open,
    sort: row.sort,
    archived: !!row.archived,
    code: row.code,
    slot: row.slot,
    rules: row.rules ? row.rules.split('\n') : [],
  };
}

/** Registration window state, computed from settings. */
export function registrationState(settings = getSettings()) {
  const base = { opensAt: settings.opensAt || null, closesAt: settings.closesAt || null };
  if (!payMethods(settings).length) {
    return { ...base, state: 'closed', message: 'Registrations are not open yet. Payment details are being set up.' };
  }
  if (settings.regMode === 'closed') return { ...base, state: 'closed', message: 'Registrations are closed.' };
  if (settings.regMode === 'scheduled') {
    const now = Date.now();
    const opens = settings.opensAt ? Date.parse(settings.opensAt) : NaN;
    const closes = settings.closesAt ? Date.parse(settings.closesAt) : NaN;
    if (!Number.isNaN(opens) && now < opens) return { ...base, state: 'upcoming', message: 'Registrations open soon.' };
    if (!Number.isNaN(closes) && now >= closes) return { ...base, state: 'closed', message: 'Registrations are closed.' };
  }
  return { ...base, state: 'open', message: '' };
}

// ---------------------------------------------------------------------------
// First run: seed the events from the poster. The rules come from the department's event flow
// document; organisers edit them under Events.
// ---------------------------------------------------------------------------
const EVENT_RULES = {
  'Poster Presentation': [
    'Present innovative research, models or concepts visually, as a team.',
    'How it runs: registration and setup, station briefing, interactive presentation, question and answer session, final scoring.',
    'Be ready to answer the judges\' questions about your poster.',
    'Judged on: innovation, scientific depth, visual appeal, clarity, and how well you answer questions.',
  ],
  'Technical & General Quiz': [
    'A multi-round team quiz on technology, current affairs, pop culture and logical reasoning.',
    'How it runs: rule briefing, an opening elimination or MCQ round, then visual, audio or logic rounds, a rapid-fire round, and the final round.',
    'The team may discuss among themselves in every round.',
    'Scores are verified after each stage. Winners are decided on total points.',
    'Judged on: correct answers, response speed, consistency across rounds, and the final point tally.',
  ],
  'Cooking Without Fire': [
    'Prepare your dishes without any heat source.',
    'How it runs: registration and briefing, preparation and assembly, display and plating, judging, winner announcement.',
    'Be ready to explain your dish and your choices to the judges.',
    'Judged on: balance of taste and texture, culinary creativity, hygiene, plating, and the team\'s reasoning.',
  ],
  'Photo & Video Editing': [
    'A timed solo challenge. Raw photos or videos and an editing brief are given to every participant at the start.',
    'Edit within the fixed time, using the tools you prefer: trimming, colour correction, enhancement and sequencing.',
    'Export your final version in the format the organisers ask for.',
    'You may be asked to briefly present or explain your editing choices.',
    'Judged on: creativity, technical skill, storytelling, polish, and presentation quality.',
  ],
  'Treasure Hunt + Bounty': [
    'Check in as a team and attend the rules briefing. Each team gets an opening clue and a scoring sheet.',
    'Clue stations lead your team across the venue. Mini-challenges unlock the next clue or give a scoring advantage.',
    'Bounty tasks are optional bonus missions that carry extra points.',
    'The final checkpoint checks the clues you completed, your bonus scores and your finish time.',
    'Judged on: accuracy, clues solved, bounty tasks completed, teamwork, and completion time.',
  ],
};
if (db.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0) {
  const insert = db.prepare(`
    INSERT INTO events (title, description, team_based, min_members, max_members, max_teams, fee, sort, rules)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seed = [
    ['Poster Presentation', 'Innovative research, models and concepts, presented visually.', 1, 5, 6, 15],
    ['Technical & General Quiz', 'Analytical reasoning, quick thinking and core knowledge.', 1, 5, 6, 15],
    ['Cooking Without Fire', 'Teamwork, resourcefulness and culinary creativity.', 1, 5, 6, 15],
    ['Photo & Video Editing', 'A timed solo media challenge with visual storytelling.', 0, 1, 1, 0],
    ['Treasure Hunt + Bounty', 'Clues, bonus tasks and coordination across the campus.', 1, 5, 6, 15],
  ];
  seed.forEach(([title, description, team, min, max, cap], i) =>
    insert.run(title, description, team, min, max, cap, 50, i + 1, (EVENT_RULES[title] || []).join('\n')));
}

// A database from before events had rules: fill in the rules of the built in events, once.
if (rulesAdded) {
  const fill = db.prepare("UPDATE events SET rules = ? WHERE title = ? AND rules = ''");
  for (const [title, lines] of Object.entries(EVENT_RULES)) fill.run(lines.join('\n'), title);
}
