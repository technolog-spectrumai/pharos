// Everyone's icon is the first letter of their nickname, white on a colour that
// nickname always gets, drawn as an SVG. No photos: nothing is uploaded or sent,
// each device draws the icon itself from the name it already has.

const COLOURS = ["#4f5bc4", "#2f8f6f", "#c2553f", "#b07d1e", "#8a4fbf", "#2b7fb8", "#c24d82", "#55606e"];

/** The first character a person would call a letter (an emoji counts as one). */
export function firstLetter(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toLocaleUpperCase();
}

/** The colour a nickname always gets. */
export function colourFor(name: string): string {
  let h = 0;
  for (const c of name.trim()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The icon for a nickname, as an SVG data URL. */
export function letterIcon(name: string): string {
  const letter = escapeXml(firstLetter(name || "?"));
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<rect width="64" height="64" rx="32" fill="${colourFor(name || "?")}"/>` +
    `<text x="32" y="33" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-size="30" font-weight="700" fill="#fff">${letter}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
