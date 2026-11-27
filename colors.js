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

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;

// Layers that make the screen read as a reference map and say nothing to a driver: shop and landmark icons, house
// numbers, building edges, railways, ferries, footpaths, one-way arrows, land-use patches, plot borders.
const CLUTTER = /^(POI|House Number|Buildings - (Outline|Shadow|Underground)|Water - (Shadow|Line)|NatureLabels - Physiography|Borders - Landuse|Landuse - (Military|Urban|Recreation|Transit|Sport)|Surface - (Ferry|Path|Rail ferry|Restricted road dash|Road under construction))|Railway|Road arrow|under construction/i;
const ROAD_EDGE = /Road outline|road outline|Trunk outline|Street outline|small scale outline/;
const ROAD = /^(Surface|Tunnel|Bridge)\b.*(road|Road|Street|Trunk)/;

/** Multiplies the widths a line-width value produces by `f`, leaving zoom levels and match labels alone. */
export function scaleWidth(v, f) {
  if (typeof v === "number") return +(v * f).toFixed(3);
  if (Array.isArray(v)) {
    if (v[0] === "interpolate") return v.map((x, i) => (i >= 4 && i % 2 === 0 ? scaleWidth(x, f) : x));
    if (v[0] === "step") return v.map((x, i) => (i >= 2 && i % 2 === 0 ? scaleWidth(x, f) : x));
    if (v[0] === "match") return v.map((x, i) => (i >= 3 && (i % 2 === 1 || i === v.length - 1) ? scaleWidth(x, f) : x));
    return v;
  }
  if (v && typeof v === "object" && Array.isArray(v.stops)) return { ...v, stops: v.stops.map(([z, w]) => [z, scaleWidth(w, f)]) };
  return v;
}

/**
 * Turns a reference map into a driving picture: clutter hidden, and with `flat` the roads lose their drawn edges
 * and get a little wider, so they read as smooth ribbons on plain ground. Traffic layers are never touched.
 */
export function smoothStyle(style, { flat = false, widen = 1.2, baseSource = "vectorTiles" } = {}) {
  for (const layer of style.layers) {
    if (layer.source !== baseSource) continue;
    const hide = CLUTTER.test(layer.id) || (flat && layer.type === "line" && ROAD_EDGE.test(layer.id));
    if (hide) { layer.layout = { ...layer.layout, visibility: "none" }; continue; }
    if (flat && layer.type === "line" && ROAD.test(layer.id) && layer.paint?.["line-width"] !== undefined) {
      layer.paint["line-width"] = scaleWidth(layer.paint["line-width"], widen);
      layer.layout = { ...layer.layout, "line-cap": "round", "line-join": "round" };
    }
    if (layer.type === "fill-extrusion" && layer.paint) layer.paint["fill-extrusion-opacity"] = 0.5;
  }
  return style;
}

const isWater = (id) => /water|ocean|sea|river|lake/i.test(id);
const isGreen = (id) => /park|wood|forest|grass|green|vegetation|golf|garden|natural/i.test(id);
function repaint(style, baseSource, pick, halo) {
  smoothStyle(style, { flat: true, baseSource });
  for (const layer of style.layers) {
    if (!layer.paint) continue;
    if (layer.type !== "background" && layer.source !== baseSource) continue;
    const keys = layer.type === "symbol" ? ["text-color"] : Object.keys(layer.paint).filter((k) => k.endsWith("-color"));
    const paint = pick(layer);
    for (const k of keys) if (layer.paint[k] !== undefined) layer.paint[k] = mapColors(layer.paint[k], paint);
    if (layer.type === "symbol" && layer.paint["text-halo-color"] !== undefined) layer.paint["text-halo-color"] = halo;
  }
  return style;
}

/**
 * Night look, painted over a dark map style: one deep indigo ground with no land-use patchwork, near-black teal
 * water, roads as soft ribbons without edges. The dark TomTom style draws a bigger road darker, so darkness is read
 * as rank: side streets become a quiet violet just above the ground, main roads a bright lilac-pink.
 * Only the base map is touched. Traffic layers keep their real colours, because green/orange/red carry meaning there.
 */
export function sunsetStyle(style, baseSource = "vectorTiles") {
  return repaint(style, baseSource, (layer) => (c) => {
    if (layer.type === "symbol") return { ...c, h: 300, s: 45, l: Math.max(c.l, 80) };                      // label text: pale lilac
    if (isWater(layer.id)) return { ...c, h: 200, s: 60, l: 9 };                                             // water: near-black teal
    if (layer.type === "line" && ROAD.test(layer.id)) {
      const t = clamp01((c.l - 6) / 8);                                                                      // 0 = motorway, 1 = side street
      return { ...c, h: mix(318, 272, t), s: mix(72, 30, t), l: mix(62, 27, t) };
    }
    if (layer.type === "line") return { ...c, h: 275, s: 35, l: 30, a: c.a * 0.6 };                          // borders: faint
    if (isGreen(layer.id)) return { ...c, h: 250, s: 40, l: 15 };                                            // parks: a shade off the ground
    if (/Building/i.test(layer.id)) return { ...c, h: 268, s: 38, l: 17 };                                   // buildings: just visible
    return { ...c, h: 265, s: 48, l: 11 };                                                                   // all ground: one colour
  }, "hsla(268, 55%, 8%, 0.85)");
}

/**
 * Daytime partner of sunsetStyle, painted over a light map style: one cream ground, pale turquoise water, white
 * side streets and soft coral main roads (the light TomTom style also draws a bigger road darker). Traffic layers
 * are left alone here too.
 */
export function sunsetDayStyle(style, baseSource = "vectorTiles") {
  return repaint(style, baseSource, (layer) => (c) => {
    if (layer.type === "symbol") return { ...c, h: 285, s: 40, l: Math.min(c.l, 28) };                       // label text: deep purple
    if (isWater(layer.id)) return { ...c, h: 186, s: 55, l: 80 };                                            // water: pale turquoise
    if (layer.type === "line" && ROAD.test(layer.id)) {
      const t = clamp01((c.l - 60) / 20);                                                                    // 0 = motorway, 1 = side street
      return { ...c, h: mix(350, 20, t), s: mix(78, 60, t), l: mix(72, 99, t) };
    }
    if (layer.type === "line") return { ...c, h: 30, s: 30, l: 72, a: c.a * 0.6 };                           // borders: faint
    if (isGreen(layer.id)) return { ...c, h: 140, s: 36, l: 85 };                                            // parks: soft mint
    if (/Building/i.test(layer.id)) return { ...c, h: 30, s: 45, l: 88 };                                    // buildings: just visible
    return { ...c, h: 34, s: 62, l: 92 };                                                                    // all ground: one cream
  }, "hsla(34, 100%, 97%, 0.9)");
}

const MAIN_ROADS = ["motorway", "trunk", "primary", "secondary", "tertiary"];
/**
 * Fewer things on the screen, for every drawn theme. Colours are not touched.
 *  - traffic: free-flowing (green) lines go, so a colour on a road always means "slow here"; slow lines only on
 *    main roads; no outlines or hatch patterns; of the incident layers only closed roads and the bigger jam signs stay
 *  - buildings go; side-street names wait until the map is zoomed right in; sector names show on the overview only
 *  - car-park aisles go, service roads and side streets appear later
 */
export function calmStyle(style, baseSource = "vectorTiles") {
  for (const layer of style.layers) {
    const id = layer.id;
    const hide = () => { layer.layout = { ...layer.layout, visibility: "none" }; };
    if (layer.source !== baseSource) {
      if (id.startsWith("Traffic - ")) {
        if (/Free flow|outline$|pattern$/.test(id)) hide();
        else if (/Slow flow$/.test(id) && layer.filter) layer.filter = ["all", layer.filter, ["match", ["get", "road_category"], MAIN_ROADS, true, false]];
      } else if (id.startsWith("TrafficIncidents - ")) {
        if (/No delay|Minor jam/.test(id) || !(/marker$/.test(id) || id === "TrafficIncidents - Closed road")) hide();
      }
      continue;
    }
    if (id === "Buildings - Fill" || id === "3D - Building") hide();
    else if (id === "Places - Neighbourhood" || id === "Places - Village / Hamlet") layer.maxzoom = 12.5;   // sector names ("E19-1", "Al Wahdah 16")
    else if (id === "TransitLabels - Road" && layer.filter) {
      layer.filter = ["all", layer.filter, ["any", ["match", ["get", "category"], MAIN_ROADS, true, false], ["all", [">=", ["zoom"], 15.5], ["==", ["get", "category"], "street"]]]];
      layer.layout = { ...layer.layout, "symbol-spacing": 520 };
    } else if (/^Surface - Minor road( outline)?$/.test(id)) {
      layer.minzoom = 15;
      if (layer.filter) layer.filter = ["all", layer.filter, ["!=", ["get", "subcategory"], "parking"]];
    } else if (/^Surface - Street( outline)?$/.test(id)) layer.minzoom = Math.max(layer.minzoom || 0, 13);
  }
  return style;
}
