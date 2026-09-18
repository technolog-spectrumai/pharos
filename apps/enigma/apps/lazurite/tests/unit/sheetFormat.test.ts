import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_VERSION, cellsToTsv, dumps, isSheet, loads, newWorkbook, workbookFromRows,
} from "../../src/formats/sheet";

// Golden files produced BY toto/primula/sheet_format.py. Unlike the document
// and deck formats there is no server-side sanitiser here — primula stores the
// snapshot verbatim — so byte equality with Python is the whole contract.
const DIR = join(__dirname, "..", "golden", "sheet");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");

describe("sheet format — golden files", () => {
  for (const name of ["blank", "from_rows", "rich"]) {
    it(`${name}: re-serialises byte-identically to Python`, () => {
      expect(dumps(loads(read(`${name}.json`)))).toBe(read(`${name}.json`));
    });
  }

  it("builds a blank workbook with the same shape Python does", () => {
    const mine = newWorkbook("Budget");
    const theirs = loads(read("blank.json"));
    // The id is a fresh uuid on both sides; everything else must match.
    expect({ ...mine, id: "x" }).toEqual({ ...theirs, id: "x" });
    expect(mine.appVersion).toBe(APP_VERSION);
  });

  it("builds the same cellData from rows, skipping empties and typing cells", () => {
    const mine = workbookFromRows("Costs", [
      ["Item", "Cost", "Paid"],
      ["Rent", 1200, true],
      ["Coffee", 3.5, false],
      ["", null, ""],
      ['Unicode ✓ &<>"', 0, ""],
    ], "Q3");
    const theirs = loads(read("from_rows.json"));
    expect({ ...mine, id: "x" }).toEqual({ ...theirs, id: "x" });

    const sheet = mine.sheets[mine.sheetOrder[0]] as Record<string, unknown>;
    const cells = sheet.cellData as Record<string, Record<string, { v: unknown; t: number }>>;
    expect(cells["1"]["1"]).toEqual({ v: 1200, t: 2 });   // number
    expect(cells["1"]["2"]).toEqual({ v: true, t: 3 });   // boolean
    expect(cells["0"]["0"]).toEqual({ v: "Item", t: 1 }); // string
    expect(cells["3"]).toBeUndefined();                   // an all-empty row
    // `false` is a value, not an empty: it must survive.
    expect(cells["2"]["2"]).toEqual({ v: false, t: 3 });
  });

  it("carries styling, merges, freeze panes and unknown keys untouched", () => {
    // The server never inspects a cell, so anything a newer Univer writes must
    // survive a zinnia round trip — that is the whole compatibility story.
    const wb = loads(read("rich.json"));
    expect(wb.styles).toHaveProperty("s1");
    const sheet = wb.sheets[wb.sheetOrder[0]] as Record<string, unknown>;
    expect(sheet.mergeData).toBeTruthy();
    expect(sheet.freeze).toBeTruthy();
    expect(wb.resources).toHaveLength(1);
    expect(wb.futureKey).toEqual({ unknown: "carried" });
    expect(dumps(wb)).toBe(read("rich.json"));
  });
});

describe("identifying a sheet", () => {
  it("accepts a real workbook and rejects everything else", () => {
    expect(isSheet(read("blank.json"))).toBe(true);
    expect(isSheet("[]")).toBe(false);          // an array is not a workbook
    expect(isSheet("{}")).toBe(false);          // no sheets, no sheetOrder
    expect(isSheet("nope")).toBe(false);        // not JSON at all
    expect(isSheet('{"sheets": {}}')).toBe(false);        // sheetOrder missing
    expect(isSheet('{"sheets": [], "sheetOrder": []}')).toBe(false); // sheets not a map
  });

  it("does not confuse an ordinary json file for a sheet", () => {
    expect(isSheet('{"name": "package", "version": "1.0.0"}')).toBe(false);
  });
});

describe("tsv", () => {
  it("serialises a range the way somebody would paste it", () => {
    expect(cellsToTsv([["a", "b"], [1, null], [undefined, "c"]]))
      .toBe("a\tb\n1\t\n\tc");
  });
});
