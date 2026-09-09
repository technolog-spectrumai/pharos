// Reading CSV — the cases that break a naive split.
//
// Each of these is a real file somebody exports from a real spreadsheet. The
// point of the parser is that `text.split(",")` handles none of them, and the
// point of these tests is to say which one each guards.
import { describe, expect, it } from "vitest";
import { parseCsv, sniffDelimiter } from "../../src/formats/csv";

describe("parsing", () => {
  it("reads a plain grid", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a delimiter that is inside quotes", () => {
    // `"Smith, John"` is ONE cell. Splitting on commas makes it two, and every
    // column after it shifts — the failure that corrupts a whole import while
    // looking like a slightly odd table.
    expect(parseCsv('name,note\n"Smith, John",ok')).toEqual([
      ["name", "note"],
      ["Smith, John", "ok"],
    ]);
  });

  it("keeps a newline that is inside quotes", () => {
    // A quoted field may span lines. Splitting on \n cuts the row in half and
    // produces a table with a stray extra row.
    expect(parseCsv('a,b\n"two\nlines",x')).toEqual([
      ["a", "b"],
      ["two\nlines", "x"],
    ]);
  });

  it("unescapes a doubled quote", () => {
    // RFC 4180 escapes `"` as `""`. Left alone, the text keeps the doubling
    // and the field looks subtly wrong rather than obviously broken.
    expect(parseCsv('say\n"he said ""no"""')).toEqual([["say"], ['he said "no"']]);
  });

  it("treats a bare quote mid-field as text", () => {
    // `5" pipe` is not a quoted field — a quote only opens one at the start.
    expect(parseCsv('size\n5" pipe')).toEqual([["size"], ['5" pipe']]);
  });

  it("handles CRLF line endings", () => {
    // What Excel on Windows writes. A parser that splits on "\n" leaves a
    // trailing \r on every last cell, invisible until it breaks a comparison.
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips a byte-order mark", () => {
    // Excel writes one. Left in, it joins the first header cell where it
    // cannot be seen and quietly breaks any match against that column name.
    const [header] = parseCsv("﻿name,note\nx,y");
    expect(header[0]).toBe("name");
  });

  it("does not invent a row from a trailing newline", () => {
    expect(parseCsv("a,b\n1,2\n")).toHaveLength(2);
  });

  it("keeps a final row that has no newline after it", () => {
    expect(parseCsv("a,b\n1,2")).toHaveLength(2);
  });

  it("pads short rows so the result is rectangular", () => {
    // A table needs a fixed column count. Ragged input is normal — a row whose
    // trailing cells are empty is often written short.
    expect(parseCsv("a,b,c\n1\n2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
      ["2", "3", ""],
    ]);
  });

  it("can be asked to leave rows ragged", () => {
    expect(parseCsv("a,b,c\n1", { rectangular: false })).toEqual([["a", "b", "c"], ["1"]]);
  });

  it("keeps empty cells rather than dropping them", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });

  it("returns nothing for empty input", () => {
    // Not `[[""]]`. A caller deciding whether to enable an Insert button has
    // to tell "nothing parsed" from "one empty cell".
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("   \n  ")).toEqual([]);
  });
});

describe("guessing the delimiter", () => {
  it("defaults to a comma", () => {
    expect(sniffDelimiter("a,b,c\n1,2,3")).toBe(",");
  });

  it("finds semicolons, which a European locale exports", () => {
    expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";");
  });

  it("finds tabs, which is what a paste from a spreadsheet usually is", () => {
    expect(sniffDelimiter("a\tb\tc\n1\t2\t3")).toBe("\t");
  });

  it("ignores delimiters that are inside quotes", () => {
    // One real semicolon per row, and a pile of commas locked inside a quoted
    // field. Counting blindly picks the comma and produces one column.
    const text = 'a;b\n"x, y, z, w";q';
    expect(sniffDelimiter(text)).toBe(";");
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["x, y, z, w", "q"],
    ]);
  });

  it("is overridable, for the file it guesses wrong", () => {
    expect(parseCsv("a;b", { delimiter: "," })).toEqual([["a;b"]]);
  });
});

describe("agreeing with the writer", () => {
  it("round-trips everything Primula's exporter can produce", async () => {
    // The strongest statement available: the repo's CSV WRITER already exists
    // (apps/primula/src/formats/csv.ts) and quotes to RFC 4180. If the reader
    // and the writer ever disagree, a sheet exported from Primula and pasted
    // into the writer comes back wrong — so they are tested against each other
    // rather than each against its own idea of the format.
    const { rowsToCsv } = await import("../../../../apps/primula/src/formats/csv");
    const rows = [
      ["name", "note", "qty"],
      ["Smith, John", 'he said "no"', "3"],
      ["two\nlines", "", "0"],
      ["plain", "semi;colon", "tab\there"],
    ];
    expect(parseCsv(rowsToCsv(rows))).toEqual(rows);
  });
});
