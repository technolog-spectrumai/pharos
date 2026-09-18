// Reading CSV.
//
// Lazurite's sheet already WRITES it (`apps/lazurite/src/formats/csv.ts`, RFC
// 4180 with proper quoting). Nothing in the repo read it until the writer needed to build
// a table from a pasted spreadsheet, and reading is the harder direction:
//
//   name,note
//   "Smith, John","he said ""no"""
//   "two
//   lines",x
//
// Splitting on commas gives four fields for row two instead of two, and
// splitting on newlines cuts row three in half. A field may contain the
// delimiter, a doubled quote, or a literal line break, and only a scanner that
// tracks whether it is inside quotes can tell those from real separators.
//
// So this is a character scan, not a split. It lives in petalite rather than in
// one app because the moment the sheet grows an importer there would otherwise be
// a second parser, and two parsers disagree at exactly these edges.

/** Delimiters worth guessing between. A spreadsheet in a European locale
 *  exports semicolons, and someone pasting one should not have to know. */
const CANDIDATES = [",", ";", "\t"] as const;

/** Strip a UTF-8 byte-order mark. Excel writes one; left in place it becomes
 *  part of the first header cell, where it is invisible and breaks matching. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Which delimiter this text is most likely using.
 *
 *  Counts candidates OUTSIDE quotes across the first few lines and takes the
 *  most frequent, so a file of prose containing commas inside quoted fields is
 *  not mistaken for comma-separated. Ties go to the earlier candidate, which
 *  makes a comma the default — the overwhelmingly common case.
 */
export function sniffDelimiter(text: string): string {
  const sample = stripBom(text).split(/\r?\n/).slice(0, 20).join("\n");
  let best: string = CANDIDATES[0];
  let bestCount = 0;
  for (const candidate of CANDIDATES) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < sample.length; i++) {
      const ch = sample[i];
      if (ch === '"') {
        // A doubled quote inside a quoted field is an escaped quote, not a
        // close — skip its partner so the state stays right.
        if (quoted && sample[i + 1] === '"') i++;
        else quoted = !quoted;
      } else if (ch === candidate && !quoted) {
        count++;
      }
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export interface ParseOptions {
  /** Defaults to whatever `sniffDelimiter` decides. */
  delimiter?: string;
  /** Pad short rows so every row has the same length. On by default: a table
   *  is rectangular, and a ragged parse would build one with missing cells. */
  rectangular?: boolean;
}

/** CSV text as rows of cells.
 *
 *  Returns `[]` for empty input rather than `[[""]]` — nothing parsed is not
 *  the same as one empty cell, and a caller deciding whether to enable an
 *  Insert button needs to tell those apart.
 */
export function parseCsv(text: string, options: ParseOptions = {}): string[][] {
  const source = stripBom(text);
  if (source.trim() === "") return [];

  const delimiter = options.delimiter || sniffDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let sawAny = false;

  const endField = () => {
    row.push(field);
    field = "";
    sawAny = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'; // an escaped quote
          i++;
        } else {
          quoted = false;
        }
      } else {
        // Includes newlines: inside quotes they are content, not row ends.
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      // Only opens a quoted field at the START of one. `a"b` is a literal
      // quote in an unquoted field, which is what a spreadsheet writes.
      quoted = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === "\r") {
      // CRLF, and a lone CR from a very old Mac export.
      if (source[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
    }
  }

  // A trailing newline ends the last row and leaves nothing behind; anything
  // else means the file ended mid-row and that row still counts.
  if (field !== "" || row.length > 0 || !sawAny) endRow();

  if (options.rectangular !== false && rows.length > 0) {
    const width = Math.max(...rows.map((r) => r.length));
    for (const r of rows) {
      while (r.length < width) r.push("");
    }
  }
  return rows;
}
