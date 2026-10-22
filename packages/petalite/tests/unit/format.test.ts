// Sizes, dates and names, as every panel shows them.
//
// Written once because four hand-copied variants disagreed at the edges — one
// handled a missing size, one stopped at GB. These pin the edges, since the
// middle never drifted.
import { describe, expect, it } from "vitest";
import { baseName, formatDate, formatSize } from "../../src/files/format";

describe("showing a size", () => {
  it("says nothing for a size that is not known", () => {
    // A folder row, or a file whose stat failed, has no size. A blank cell is
    // the honest answer; "0 B" would claim the file is empty.
    expect(formatSize(undefined)).toBe("");
  });

  it("shows an empty file as zero bytes rather than blank", () => {
    // Zero is falsy, so it is the size most easily confused with "unknown".
    expect(formatSize(0)).toBe("0 B");
  });

  it("shows whole bytes without a decimal", () => {
    expect(formatSize(1)).toBe("1 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("steps up a unit at each 1024, with one decimal", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 ** 2)).toBe("1.0 MB");
    expect(formatSize(1024 ** 3)).toBe("1.0 GB");
    expect(formatSize(1024 ** 4)).toBe("1.0 TB");
  });

  it("stays in terabytes past the last unit instead of running off the end", () => {
    // The variant that stopped at GB printed "1024.0 GB" for a terabyte; one
    // with no ceiling would index past the table and print "undefined".
    expect(formatSize(1024 ** 5)).toBe("1024.0 TB");
  });
});

describe("showing a date", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
  ])("says nothing for %s", (_label, value) => {
    expect(formatDate(value)).toBe("");
  });

  it("says nothing for a value that is not a date, rather than 'Invalid Date'", () => {
    // `new Date("soon")` does not throw — it formats as the literal text
    // "Invalid Date", which is worse in a column than an empty cell.
    expect(formatDate("soon")).toBe("");
    expect(formatDate(Number.NaN)).toBe("");
  });

  it("treats epoch zero as a date, not as a missing one", () => {
    // The guard checks null and undefined by name rather than truthiness, so
    // a file stamped at the epoch still shows a date.
    expect(formatDate(0)).not.toBe("");
    expect(formatDate(0)).toBe(new Date(0).toLocaleDateString());
  });

  it("reads milliseconds and a date string for the same instant identically", () => {
    // `stat` hands back milliseconds; a string is accepted because Date is.
    // The two spellings of one moment must not show two different days.
    const iso = "2024-03-05T12:00:00.000Z";
    const ms = Date.parse(iso);
    expect(formatDate(ms)).toBe(formatDate(iso));
    expect(formatDate(ms)).toBe(new Date(ms).toLocaleDateString());
  });
});

describe("the last part of a path", () => {
  it("takes the file name from a POSIX path", () => {
    expect(baseName("/home/me/notes/todo.md")).toBe("todo.md");
  });

  it("takes the file name from a Windows path", () => {
    // Tauri hands back native separators, so a backslash is a separator too.
    expect(baseName("C:\\Users\\me\\report.csv")).toBe("report.csv");
  });

  it("ignores a trailing separator, naming the folder", () => {
    expect(baseName("/home/me/notes/")).toBe("notes");
  });

  it("answers a bare name unchanged", () => {
    expect(baseName("todo.md")).toBe("todo.md");
  });

  it("answers the path itself when it has no named part", () => {
    // The filesystem root has nothing after its separator. Returning "" would
    // draw a nameless row; the path is at least something to show.
    expect(baseName("/")).toBe("/");
    expect(baseName("")).toBe("");
  });
});
