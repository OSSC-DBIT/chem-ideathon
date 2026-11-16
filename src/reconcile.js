import ExcelJS from 'exceljs';

const MAX_ROWS = 100000;
const UTR_IN_TEXT = /(?<!\d)\d{12}(?!\d)/g;
const NUMBER_IN_TEXT = /\d[\d,]*(?:\.\d+)?/g;

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

/** Turns an uploaded statement into a list of text rows. */
export async function statementRows(kind, content) {
  if (kind === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(content, 'base64'));
    const rows = [];
    workbook.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        if (rows.length >= MAX_ROWS) return;
        const cells = [];
        row.eachCell((cell) => cells.push(cellText(cell.value)));
        rows.push(cells.join(' | '));
      });
    });
    return rows;
  }
  return String(content).split(/\r?\n/).slice(0, MAX_ROWS);
}

/**
 * Finds every 12 digit UPI reference in the statement and checks each
 * registration against it. Returns one result per registration.
 */
export function matchStatement(rows, registrations) {
  const index = new Map(); // utr -> { line, amounts }
  for (const row of rows) {
    const utrs = row.match(UTR_IN_TEXT);
    if (!utrs) continue;
    const rest = row.replace(UTR_IN_TEXT, ' ');
    // "1,000.00" is read both as 1000 and as its comma separated pieces, because in a
    // CSV row the comma may be a thousands separator or a column break.
    const amounts = [];
    for (const token of rest.match(NUMBER_IN_TEXT) || []) {
      amounts.push(Number(token.replace(/,/g, '')));
      for (const piece of token.split(',')) amounts.push(Number(piece));
    }
    for (const utr of utrs) {
      if (!index.has(utr)) index.set(utr, { line: row.replace(/\s+/g, ' ').trim().slice(0, 240), amounts });
    }
  }

  const results = registrations.map((reg) => {
    const hit = index.get(reg.utr);
    return {
      id: reg.id,
      code: reg.code,
      teamName: reg.team_name,
      eventTitle: reg.event_title,
      utr: reg.utr,
      amount: reg.amount,
      found: !!hit,
      amountOk: !!hit && hit.amounts.includes(reg.amount),
      line: hit ? hit.line : '',
    };
  });

  return { rowsScanned: rows.length, utrsInStatement: index.size, results };
}
