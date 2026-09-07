// Stand-in for the Univer presets so jsdom never starts the real grid (it needs
// canvas, layout and a measure cycle jsdom does not provide). The editor's
// contract — snapshot in, snapshot out — is what the tests exercise, and this
// keeps that honest by echoing back whatever was loaded.
let lastSnapshot: unknown = null;

/** How many grids have been torn down. A test that opens a second file reads
 *  this to prove the first grid did not outlive its tab. */
export const stats = { disposed: 0 };

export const LocaleType = { EN_US: "enUS" } as const;
export const merge = (...objs: object[]) => Object.assign({}, ...objs);

export function createUniver() {
  return {
    univer: { dispose() { stats.disposed += 1; } },
    univerAPI: {
      createWorkbook(snapshot: unknown) {
        lastSnapshot = snapshot;
      },
      getActiveWorkbook() {
        return { save: () => lastSnapshot };
      },
    },
  };
}

export const UniverSheetsCorePreset = () => ({ __preset: "sheets-core" });
export default { createUniver, LocaleType, merge, UniverSheetsCorePreset, stats };
