// Colour helpers for repainting a map style. Pure functions, tested under node.

/** "#rgb", "#rrggbb", "rgb()", "rgba()", "hsl()", "hsla()" -> { h, s, l, a } (h 0-360, s/l 0-100), or null if not a colour. */
export function parseColor(str) {
  if (typeof str !== "string") return null;
  const t = str.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (m) {
    const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    return rgbToHsl(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), 1);
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t);
  if (m) return rgbToHsl(+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]);
  m = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(t);
  if (m) return { h: +m[1] % 360, s: +m[2], l: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  return null;
}

function rgbToHsl(r, g, b, a) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: s * 100, l: l * 100, a };
}

export const toCss = ({ h, s, l, a }) => `hsla(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(l)}%, ${+a.toFixed(3)})`;

/** Applies fn to every colour string inside a style value (plain string, stops, or expression). Other values pass through. */
export function mapColors(value, fn) {
  if (typeof value === "string") {
    const c = parseColor(value);
    return c ? toCss(fn(c)) : value;
  }
  if (Array.isArray(value)) return value.map((v) => mapColors(v, fn));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapColors(v, fn)]));
  return value;
}

/**
 * Repaints a dark map style as a neon sunset: purple ground, teal water, pink roads, warm labels.
 * Only the base map is touched. Traffic layers keep their real colours, because green/orange/red carry meaning there.
 */
export function sunsetStyle(style, baseSource = "vectorTiles") {
  for (const layer of style.layers) {
    if (!layer.paint) continue;
    if (layer.type !== "background" && layer.source !== baseSource) continue;
    const water = /water|ocean|sea|river|lake/i.test(layer.id);
    const paint = (c) => {
      if (layer.type === "symbol") return { ...c, h: 325, s: Math.max(c.s, 60), l: Math.max(c.l, 78) };            // label text: pale pink
      if (water) return { ...c, h: 186, s: 70, l: Math.min(Math.max(c.l, 14), 26) };                               // water: deep teal
      if (layer.type === "line") return { ...c, h: 322, s: 85, l: Math.min(Math.max(c.l + 22, 42), 66) };          // roads and outlines: hot pink
      return { ...c, h: 268, s: Math.max(c.s, 45), l: Math.min(Math.max(c.l * 0.75, 7), 22) };                     // ground, buildings, parks: purple night
    };
    const keys = layer.type === "symbol" ? ["text-color"] : Object.keys(layer.paint).filter((k) => k.endsWith("-color"));
    for (const k of keys) if (layer.paint[k] !== undefined) layer.paint[k] = mapColors(layer.paint[k], paint);
    if (layer.type === "symbol" && layer.paint["text-halo-color"] !== undefined) layer.paint["text-halo-color"] = "hsla(275, 60%, 8%, 0.9)";
  }
  return style;
}
