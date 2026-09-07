import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { csvCell, rowsToCsv, usedExtent, workbookToCsv } from "../../src/formats/csv";
import { loads } from "../../src/formats/sheet";

const golden = (name: string) =>
  loads(readFileSync(join(__dirname, "../golden/sheet", name), "utf8"));

describe("quoting a cell", () => {
  it("leaves an ordinary value bare", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(false)).toBe("false");
  });

  it("writes an empty field for nothing at all", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes the three characters that would otherwise corrupt the file", () => {
    // This is the whole reason cellsToTsv could not be reused: it quotes none
    // of these, so one comma would shift every later column by one.
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("carriage\rreturn")).toBe('"carriage\rreturn"');
  });

  it("survives a value that is all four at once", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });
});

describe("writing rows", () => {
  it("separates records with CRLF, as RFC 4180 and Excel expect", () => {
    expect(rowsToCsv([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d");
  });

  it("keeps trailing empty rows, because they are part of the shape", () => {
    // `cellsToTsv` .trim()s and would silently drop these.
    expect(rowsToCsv([["a"], [""], [""]])).toBe("a\r\n\r\n");
  });
});

describe("the used extent of a sparse sheet", () => {
  it("comes from the KEYS, never from a length", () => {
    // cellData is a sparse string-keyed map: a sheet whose row 1 is entirely
    // empty simply has no "1" key. Reading it as an array would stop at that
    // hole and truncate the export.
    const sheet = { cellData: { "0": { "0": { v: "a" } }, "2": { "3": { v: "d" } } } };
    expect(usedExtent(sheet)).toEqual([3, 4]);
  });

  it("answers zero for a sheet with nothing in it", () => {
    expect(usedExtent({ cellData: {} })).toEqual([0, 0]);
    expect(usedExtent({})).toEqual([0, 0]);
  });
});

describe("a workbook as CSV", () => {
  it("exports the active worksheet from a golden snapshot", () => {
    const csv = workbookToCsv(golden("from_rows.json"));
    expect(csv).toBeTruthy();
    // The golden has a row of headers; whatever else it holds, the first line
    // must be a real record and not a formula or an object.
    expect(csv.split("\r\n")[0]).not.toContain("[object");
  });

  it("is empty for an empty workbook rather than throwing", () => {
    expect(workbookToCsv(golden("blank.json"))).toBe("");
  });

  it("prefers the editor's computed values when it has them", () => {
    // The facade read is the only guaranteed-computed source: Univer
    // recalculates asynchronously after a load, so the snapshot's stored `v`
    // is merely what the engine last wrote.
    const csv = workbookToCsv(golden("blank.json"), [["computed", 7]]);
    expect(csv).toBe("computed,7");
  });

  it("writes a formula's VALUE, never the formula", () => {
    // The gap the plan called out: no fixture anywhere read an `f` key, so the
    // "computed values" claim was unverifiable. This is that fixture.
    const wb = {
      ...golden("blank.json"),
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: 2 }, "1": { v: 3 }, "2": { v: 6, f: "=A1*B1" } },
          },
        },
      },
      sheetOrder: ["s1"],
    };
    const csv = workbookToCsv(wb as never);
    expect(csv).toBe("2,3,6");
    expect(csv).not.toContain("=A1*B1");
  });

  it("writes a merged range once, into its top-left cell", () => {
    const wb = {
      ...golden("blank.json"),
      sheets: {
        s1: {
          cellData: {
            "0": { "0": { v: "merged" }, "2": { v: "after" } },
            "1": { "2": { v: "below" } },
          },
          mergeData: [{ startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 }],
        },
      },
      sheetOrder: ["s1"],
    };
    // The range covers (0,0)-(1,1); only its top-left carries the value, and
    // the grid stays rectangular.
    expect(workbookToCsv(wb as never)).toBe("merged,,after\r\n,,below");
  });

  it("round-trips a value holding a comma, a quote and a newline", () => {
    const nasty = 'a,b "c"\nd';
    const wb = {
      ...golden("blank.json"),
      sheets: { s1: { cellData: { "0": { "0": { v: nasty }, "1": { v: "next" } } } } },
      sheetOrder: ["s1"],
    };
    const csv = workbookToCsv(wb as never);
    expect(csv).toBe('"a,b ""c""\nd",next');
    // Parsed back by the rules RFC 4180 states, the field is unchanged.
    const field = csv.slice(1, csv.lastIndexOf('"')).replace(/""/g, '"');
    expect(field).toBe(nasty);
  });
});
