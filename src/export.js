import ExcelJS from 'exceljs';

const ist = (iso) =>
  iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '';

/** Builds { columns, rows } for either layout. `regs` carry a `members` array. */
export function buildTable(regs, layout) {
  if (layout === 'participants') {
    const columns = ['Reg ID', 'Event', 'Team', 'Role', 'Name', 'Roll number', 'Branch', 'Phone', 'Status', 'Team amount (Rs)', 'Transaction ID'];
    const rows = [];
    for (const r of regs) {
      r.members.forEach((m, i) => {
        rows.push([r.code, r.eventTitle, r.teamName, i === 0 ? 'Leader' : 'Member', m.name, m.roll, m.branch, m.phone, r.status, r.amount, r.utr]);
      });
    }
    return { columns, rows };
  }

  const columns = [
    'Reg ID', 'Event', 'Team', 'Members', 'Leader name', 'Leader roll number', 'Leader phone', 'Leader email',
    'All members', 'Amount (Rs)', 'Transaction ID', 'Status', 'Reject reason', 'Registered at', 'Decided at', 'Decided by',
  ];
  const rows = regs.map((r) => [
    r.code, r.eventTitle, r.teamName, r.memberCount, r.members[0]?.name || '', r.members[0]?.roll || '',
    r.leaderPhone, r.leaderEmail, r.members.map((m) => `${m.name} (${m.roll}, ${m.branch})`).join('; '),
    r.amount, r.utr, r.status, r.rejectReason, ist(r.createdAt), ist(r.decidedAt), r.decidedBy || '',
  ]);
  return { columns, rows };
}

function csvCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv({ columns, rows }) {
  return '﻿' + [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export async function toXlsx({ columns, rows }, sheetName) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Ideathon 26 registration';
  const sheet = workbook.addWorksheet(sheetName, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.addRow(columns);
  // Values are written as plain strings or numbers, never as formulas.
  for (const row of rows) sheet.addRow(row.map((v) => (typeof v === 'number' ? v : String(v ?? ''))));
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE500' } };
  sheet.columns.forEach((column, i) => {
    const longest = Math.max(columns[i].length, ...rows.map((row) => String(row[i] ?? '').length));
    column.width = Math.min(Math.max(longest + 2, 10), 60);
  });
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
