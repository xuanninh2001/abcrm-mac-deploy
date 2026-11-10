import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";

export type Sheet = { name: string; headers: string[]; rows: Record<string, string>[] };
export const MAX_ROWS = 100_000;   // synchronous MVP limit; streaming import is a later milestone

export class ImportFileError extends Error {}

/** Decodes CSV bytes: UTF-8 (with/without BOM), UTF-16 LE/BE with BOM, else Windows-1252. */
export function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { return new TextDecoder("windows-1252").decode(buf); }
}

export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", ";", "\t", "|"];
  return candidates.reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ",");
}

function uniqueHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base} (${n + 1})`;
  });
}

function toSheet(name: string, matrix: string[][]): Sheet {
  const [head, ...body] = matrix;
  if (!head || head.every((h) => !h.trim())) throw new ImportFileError(`Sheet "${name}" has no header row`);
  const headers = uniqueHeaders(head);
  const rows = body
    .filter((r) => r.some((v) => v.trim() !== ""))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
  if (rows.length > MAX_ROWS) throw new ImportFileError(`Sheet "${name}" has ${rows.length} rows (max ${MAX_ROWS})`);
  return { name, headers, rows };
}

export function parseCsvBuffer(buf: Buffer, name = "csv"): Sheet {
  const text = decodeText(buf);
  const matrix = parseCsv(text, { delimiter: detectDelimiter(text), relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
  return toSheet(name, matrix);
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("richText" in v) return v.richText.map((p) => p.text).join("");
    if ("text" in v && typeof v.text === "string") return v.text;          // hyperlink
    if ("result" in v) return v.result === undefined ? "" : String(v.result);   // formula
    if ("error" in v) return "";
  }
  return String(v);
}

export async function parseXlsxBuffer(buf: Buffer): Promise<Sheet[]> {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as unknown as ArrayBuffer); } catch { throw new ImportFileError("Not a valid .xlsx file"); }
  const sheets: Sheet[] = [];
  wb.eachSheet((ws) => {
    const matrix: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as ExcelJS.CellValue[]).slice(1);   // exceljs rows are 1-indexed
      matrix.push(values.map(cellText));
    });
    if (matrix.length) sheets.push(toSheet(ws.name, matrix));
  });
  if (!sheets.length) throw new ImportFileError("Workbook has no data");
  return sheets;
}

export async function parseFile(buf: Buffer, filename: string): Promise<Sheet[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) return parseXlsxBuffer(buf);
  if (lower.endsWith(".csv") || lower.endsWith(".tsv") || lower.endsWith(".txt")) return [parseCsvBuffer(buf, filename)];
  throw new ImportFileError("Unsupported file type (use .csv or .xlsx)");
}
