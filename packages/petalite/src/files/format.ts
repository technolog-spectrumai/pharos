// Sizes and dates, in one place.
//
// Vesper has this function copy-pasted into four components in two subtly
// different variants (one handles `undefined`, one stops at GB). That is the
// kind of drift that ends with two panels disagreeing about what 1.5 MB is, so
// here it is written once.
export function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** Epoch milliseconds is what `stat` hands back; the string case is kept
 *  because `Date` accepts one and refusing it would be a rule with no reason. */
export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
