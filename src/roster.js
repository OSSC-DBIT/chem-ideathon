import ExcelJS from 'exceljs';
import { db, tx } from './db.js';

/*
 * The student list ("roster"): the 1st year students who may register.
 * Organisers upload it from the admin panel. When the roster is switched on,
 * only ERP IDs on the list are accepted and names come from the list.
 */

const ROLL_RE = /^[A-Z0-9][A-Z0-9/-]{2,19}$/;
const MAX_ROWS = 20000;

export const normaliseRoll = (value) => String(value ?? '').normalize('NFKC').toUpperCase().replace(/\s/g, '').slice(0, 20);
const tidy = (value, max) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, max);
const tidyPhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  const last10 = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(last10) ? last10 : '';
};

/** "a", "Sec A" and "section a" all become "A"; anything else is kept as typed, in capitals. */
export const tidySection = (value) => tidy(value, 30).replace(/^sec(tion)?\.?\s*[-:]?\s*/i, '').toUpperCase();

const tidyEmail = (value) => {
  const email = tidy(value, 120).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : '';
};

/** "asha.rao@example.com" becomes "as***@example.com": enough to recognise, not enough to harvest. */
export const maskEmail = (email) => {
  const [local, domain] = String(email || '').split('@');
  return local && domain ? `${local.slice(0, 2)}***@${domain}` : '';
};

/**
 * "Asha Rao" becomes "As** Ra*". The public ERP ID lookup returns this, so the form can
 * confirm "yes, that is my teammate" without turning the lookup into a way to download the
 * college's student list.
 */
export const maskName = (name) => String(name || '').split(' ').filter(Boolean)
  .map((word) => (word.length <= 1 ? word : word.length === 2 ? `${word[0]}*` : word.slice(0, 2) + '*'.repeat(word.length - 2)))
  .join(' ');

const findStudent = db.prepare('SELECT roll, name, branch, phone, email, section FROM students WHERE roll = ?');
const upsertStudent = db.prepare(`
  INSERT INTO students (roll, name, branch, phone, email, section) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(roll) DO UPDATE SET name = excluded.name, branch = excluded.branch, phone = excluded.phone,
    email = excluded.email, section = excluded.section
`);
const countStudents = db.prepare('SELECT COUNT(*) AS n FROM students');

export const getStudent = (roll) => findStudent.get(roll) || null;
export const studentCount = () => countStudents.get().n;

// ---------------------------------------------------------------------------
// Reading an uploaded file into rows of cells
// ---------------------------------------------------------------------------
function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text).join('');
    if (value.result != null) return String(value.result);
    if (value.text != null) return String(value.text);
    return '';
  }
  return String(value);
}

/** Small CSV reader: handles quotes, and commas, tabs or semicolons as the separator. */
export function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || '';
  const count = (ch) => firstLine.split(ch).length - 1;
  const delimiter = count('\t') >= count(',') && count('\t') >= count(';') && count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ',';

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      rows.push(row); row = [];
      if (rows.length >= MAX_ROWS) return rows;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export async function tableRows(kind, raw) {
  if (kind !== 'xlsx') return parseDelimited(raw.toString('utf8').replace(/^﻿/, ''));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw);
  const rows = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow((row) => {
      if (rows.length >= MAX_ROWS) return;
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => { cells[col - 1] = cellText(cell.value); });
      rows.push(Array.from(cells, (c) => c ?? ''));
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Turning rows into students
// ---------------------------------------------------------------------------
const HEADINGS = {
  roll: /erp|roll|usn|reg(istration|n)?\.?\s*(no|num|id)?|admission|student\s*id|^id$/i,
  name: /name/i,
  branch: /branch|dep(t|artment)|course|program|stream/i,
  section: /section|^sec\.?$|division|^div\.?$/i,
  phone: /phone|mobile|contact|whats\s*app/i,
  email: /e-?mail/i,
};

/** Finds which column holds what. Uses the heading row when there is one, else assumes roll, name, branch, phone, email, section. */
function mapColumns(rows) {
  for (let r = 0; r < Math.min(rows.length, 15); r += 1) {
    const cells = rows[r].map((c) => tidy(c, 60));
    const roll = cells.findIndex((c) => HEADINGS.roll.test(c) && !HEADINGS.name.test(c));
    const name = cells.findIndex((c) => HEADINGS.name.test(c));
    if (roll >= 0 && name >= 0) {
      return {
        start: r + 1,
        roll,
        name,
        branch: cells.findIndex((c, i) => i !== roll && i !== name && HEADINGS.branch.test(c) && !HEADINGS.section.test(c)),
        section: cells.findIndex((c, i) => i !== roll && i !== name && HEADINGS.section.test(c)),
        phone: cells.findIndex((c, i) => i !== roll && i !== name && HEADINGS.phone.test(c) && !HEADINGS.email.test(c)),
        email: cells.findIndex((c, i) => i !== roll && i !== name && HEADINGS.email.test(c)),
      };
    }
  }
  return { start: 0, roll: 0, name: 1, branch: 2, phone: 3, email: 4, section: 5 };
}

/** @returns {{ students: Map<string, object>, skipped: number, problems: string[] }} */
export function readRoster(rows) {
  const cols = mapColumns(rows);
  const students = new Map();
  const problems = [];
  let skipped = 0;
  const note = (text) => { if (problems.length < 8) problems.push(text); };

  for (let r = cols.start; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row || row.every((c) => !String(c ?? '').trim())) continue;
    const roll = normaliseRoll(row[cols.roll]);
    const name = tidy(row[cols.name], 60);
    if (!ROLL_RE.test(roll) || !/\d/.test(roll)) { skipped += 1; note(`Row ${r + 1}: "${tidy(row[cols.roll], 24)}" is not a valid ERP ID.`); continue; }
    if (name.length < 2) { skipped += 1; note(`Row ${r + 1}: ERP ID ${roll} has no name.`); continue; }
    if (students.has(roll)) { skipped += 1; note(`Row ${r + 1}: ERP ID ${roll} appears more than once. The first one was kept.`); continue; }
    students.set(roll, {
      roll,
      name,
      branch: cols.branch >= 0 ? tidy(row[cols.branch], 40) : '',
      phone: cols.phone >= 0 ? tidyPhone(row[cols.phone]) : '',
      email: cols.email >= 0 ? tidyEmail(row[cols.email]) : '',
      section: cols.section >= 0 ? tidySection(row[cols.section]) : '',
    });
  }
  return { students, skipped, problems };
}

/** mode "replace" swaps the whole list; "merge" adds new students and updates existing ones. */
export function importStudents(students, mode) {
  return tx(() => {
    if (mode === 'replace') db.exec('DELETE FROM students');
    for (const s of students.values()) upsertStudent.run(s.roll, s.name, s.branch, s.phone, s.email, s.section);
    return studentCount();
  });
}
