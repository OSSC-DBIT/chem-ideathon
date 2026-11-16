import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'ideathon.db'));

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
}
addColumn('registrations', 'scan_status', "TEXT NOT NULL DEFAULT 'unscanned'"); // clean | unscanned
addColumn('students', 'email', "TEXT NOT NULL DEFAULT ''");

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
  notice: '',
  branches: ['CSE', 'ISE', 'ECE', 'EEE', 'AI & ML', 'AI & DS', 'Mechanical', 'Civil'],
  contactName: 'Prof Chinmayi G',
  contactPhone: '',
  allowMultiEvent: false,     // default rule: one student, one event
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
  };
}

/** Registration window state, computed from settings. */
export function registrationState(settings = getSettings()) {
  const base = { opensAt: settings.opensAt || null, closesAt: settings.closesAt || null };
  if (!settings.upiId) {
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
// First run: seed the events from the poster.
// ---------------------------------------------------------------------------
if (db.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0) {
  const insert = db.prepare(`
    INSERT INTO events (title, description, team_based, min_members, max_members, max_teams, fee, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const seed = [
    ['Poster Presentation', 'Innovative research, models and concepts, presented visually.', 1, 5, 6, 15],
    ['Technical & General Quiz', 'Analytical reasoning, quick thinking and core knowledge.', 1, 5, 6, 15],
    ['Cooking Without Fire', 'Teamwork, resourcefulness and culinary creativity.', 1, 5, 6, 15],
    ['Photo & Video Editing', 'A timed solo media challenge with visual storytelling.', 0, 1, 1, 0],
    ['Treasure Hunt + Bounty', 'Clues, bonus tasks and coordination across the campus.', 1, 5, 6, 15],
  ];
  seed.forEach(([title, description, team, min, max, cap], i) => insert.run(title, description, team, min, max, cap, 50, i + 1));
}
