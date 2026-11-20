import { badRequest } from './errors.ts';

/** Bounded CSV parser: rejects over-limit input and malformed quoting early. */
export function parseCsv(text: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') {
        rows.push(row);
        if (rows.length > maxRows) {
          throw badRequest('csv_too_many_rows', `CSV exceeds ${maxRows} rows`);
        }
      }
      row = [];
    } else {
      field += c;
    }
  }
  if (inQuotes) throw badRequest('csv_unterminated_quote', 'CSV has an unterminated quoted field');
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  if (rows.length > maxRows) throw badRequest('csv_too_many_rows', `CSV exceeds ${maxRows} rows`);
  return rows;
}
