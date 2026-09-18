// A worksheet as CSV.
//
// Deliberately NOT `cellsToTsv` (sheet.ts). That one joins on a hardcoded tab,
// quotes nothing at all, and `.trim()`s the result — fine for the clipboard,
// wrong for a file: a value holding a comma, a quote or a newline would corrupt
// every row after it, and the trim would silently drop trailing blank rows that
// are part of the sheet's shape. This writer is the RFC-4180 one; the TSV one
// keeps its own single caller and its own test.
//
// What is exported, and why:
//
//  * **The active worksheet only.** CSV has no concept of a second sheet, and
//    silently concatenating them would produce a file nobody could take apart.
//  * **Computed values, not formulas.** What every other spreadsheet writes on
//    "Save as CSV": a reader wants the number, and `=A1*2` in a CSV is a string
//    that means nothing without the engine that produced it.
//  * **A merged range writes into its TOP-LEFT cell**, blanks elsewhere. The
//    grid is rectangular in CSV whether or not it was on screen.

import type { Workbook } from "./sheet";

/** One cell as CSV: quoted only when it must be.
 *
 *  RFC 4180: a field containing a comma, a double quote or a line break is
 *  wrapped in double quotes, and each embedded quote is doubled. Everything
 *  else travels bare, so an ordinary sheet reads as an ordinary CSV. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows of values to CSV text.
 *
 *  CRLF between records, as RFC 4180 specifies and as Excel expects. No
 *  trailing newline is added and none is trimmed: the row count is the sheet's
 *  own, and dropping empty trailing rows would change the shape of the data. */
export function rowsToCsv(rows: Array<Array<unknown>>): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

/** Univer's cell record, as much of it as this needs. */
interface Cell {
  /** The value. For a formula cell this is what the engine last computed. */
  v?: unknown;
  /** The formula itself, which is exactly what CSV does NOT want. */
  f?: string;
}

interface MergeRange {
  startRow: number;
  endRow: number;
  startColumn: number;
  endColumn: number;
}

interface Sheet {
  cellData?: Record<string, Record<string, Cell>>;
  mergeData?: MergeRange[];
  [key: string]: unknown;
}

/** The sheet a workbook snapshot is currently showing.
 *
 *  `sheetOrder[0]` rather than a stored "active" id: the snapshot does not
 *  carry which tab is on screen, and the first in order is the one a reader
 *  means by "the sheet". The editor passes the live active sheet when it has
 *  one; this is the fallback for a snapshot read off disk. */
export function activeSheet(workbook: Workbook): Sheet | null {
  const id = workbook.sheetOrder?.[0];
  if (!id) return null;
  const sheet = (workbook.sheets as Record<string, Sheet> | undefined)?.[id];
  return sheet ?? null;
}

/** The used extent of a sheet, as [rows, columns].
 *
 *  From `Object.keys()`, never from `.length`: `cellData` is a SPARSE
 *  string-keyed map, and a sheet whose row 3 is entirely empty simply has no
 *  `"3"` key (the `from_rows` golden is exactly that). Treating it as an array
 *  would stop at the first hole and truncate the export. */
export function usedExtent(sheet: Sheet): [number, number] {
  let maxRow = -1;
  let maxCol = -1;
  for (const [rowKey, row] of Object.entries(sheet.cellData ?? {})) {
    const r = Number(rowKey);
    if (!Number.isInteger(r)) continue;
    let rowHasCell = false;
    for (const colKey of Object.keys(row ?? {})) {
      const c = Number(colKey);
      if (!Number.isInteger(c)) continue;
      rowHasCell = true;
      if (c > maxCol) maxCol = c;
    }
    if (rowHasCell && r > maxRow) maxRow = r;
  }
  return [maxRow + 1, maxCol + 1];
}

/**
 * A workbook's active worksheet as CSV text.
 *
 * `values` is the editor's own read of the live grid when it has one —
 * `getActiveSheet().getDataRange().getValues()` — which is the only
 * guaranteed-computed source, because Univer recalculates asynchronously after
 * a load. Without it this falls back to the snapshot's stored `v`, which is
 * what the engine last wrote.
 */
export function workbookToCsv(workbook: Workbook, values?: Array<Array<unknown>>): string {
  if (values) return rowsToCsv(values);

  const sheet = activeSheet(workbook);
  if (!sheet) return "";
  const [rowCount, colCount] = usedExtent(sheet);
  if (rowCount === 0 || colCount === 0) return "";

  // Every cell a merge covers EXCEPT its top-left is blanked, so the range
  // reads once rather than repeating down and across.
  const covered = new Set<string>();
  for (const m of sheet.mergeData ?? []) {
    for (let r = m.startRow; r <= m.endRow; r++) {
      for (let c = m.startColumn; c <= m.endColumn; c++) {
        if (r !== m.startRow || c !== m.startColumn) covered.add(`${r}:${c}`);
      }
    }
  }

  const rows: Array<Array<unknown>> = [];
  for (let r = 0; r < rowCount; r++) {
    const row: unknown[] = [];
    for (let c = 0; c < colCount; c++) {
      if (covered.has(`${r}:${c}`)) {
        row.push("");
        continue;
      }
      // `v`, never `f`: the computed value is what a CSV reader can use.
      row.push(sheet.cellData?.[String(r)]?.[String(c)]?.v ?? "");
    }
    rows.push(row);
  }
  return rowsToCsv(rows);
}
