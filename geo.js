// Pure geometry and alert logic. No browser APIs, so it runs under node for tests.

const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Distance in metres between two {lat, lon} points. */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Compass bearing from a to b, 0-360. */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle between two bearings, 0-180. */
export function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Nearest camera in front of the car, or null.
 * "In front" = within `range` metres and within `cone` degrees of the direction of travel.
 */
export function cameraAhead(pos, heading, cameras, { range = 900, cone = 30 } = {}) {
  let best = null;
  const latWin = range / 111000;
  for (const c of cameras) {
    if (Math.abs(c.lat - pos.lat) > latWin) continue; // cheap reject before the trig
    const d = distance(pos, c);
    if (d > range) continue;
    if (angleDiff(bearing(pos, c), heading) > cone) continue;
    if (!best || d < best.dist) best = { camera: c, dist: d };
  }
  return best;
}

/**
 * Decides when to speak about a camera. Two calls per pass: far (first sight) and near (<= nearAt).
 * A camera goes quiet for `cooldownMs` after the near call so the opposite carriageway or a U-turn does not repeat it.
 */
export class CameraAlerts {
  constructor({ nearAt = 300, cooldownMs = 120000 } = {}) {
    this.nearAt = nearAt;
    this.cooldownMs = cooldownMs;
    this.state = new Map(); // camera key -> { stage, until }
  }

  key(c) {
    return `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  }

  /** Returns "far", "near" or null for this fix. */
  check(hit, now) {
    if (!hit) return null;
    const k = this.key(hit.camera);
    const s = this.state.get(k);
    if (s && s.stage === "done") {
      if (now < s.until) return null;
      this.state.delete(k);
    }
    const cur = this.state.get(k);
    if (hit.dist <= this.nearAt) {
      this.state.set(k, { stage: "done", until: now + this.cooldownMs });
      return "near";
    }
    if (!cur) {
      this.state.set(k, { stage: "far", until: 0 });
      return "far";
    }
    return null;
  }
}

/** Running distance along a list of {lat, lon} points. Returns an array the same length as pts. */
export function cumulative(pts) {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + distance(pts[i - 1], pts[i]));
  return out;
}

/**
 * Where the car is relative to a route: closest segment, distance off the line, metres travelled along it.
 * Uses a flat-earth projection per segment, accurate enough at city scale.
 */
export function locateOnRoute(pos, pts, cum) {
  let best = { off: Infinity, along: 0, index: 0 };
  const kx = 111320 * Math.cos(rad(pos.lat));
  const ky = 110540;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = (pts[i].lon - pos.lon) * kx, ay = (pts[i].lat - pos.lat) * ky;
    const bx = (pts[i + 1].lon - pos.lon) * kx, by = (pts[i + 1].lat - pos.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const off = Math.hypot(ax + t * dx, ay + t * dy);
    if (off < best.off) best = { off, along: cum[i] + t * (cum[i + 1] - cum[i]), index: i }; // true segment length, not the flat one
  }
  return best;
}

/** First instruction still ahead of the car, with metres to go, or null at the end of the route. */
export function nextInstruction(instructions, along) {
  for (const ins of instructions) {
    if (ins.offset > along + 5) return { ...ins, toGo: ins.offset - along };
  }
  return null;
}

/** "450 m" / "2.3 km" */
export function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Spoken distance, rounded the way a person would say it. */
export function sayDist(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace(".0", "")} kilometres`;
  return `${Math.max(50, Math.round(m / 50) * 50)} metres`;
}

/**
 * Log entry for a finished drive, or null when it is too short to mean anything (a mis-tap).
 * Ending by hand within 300 m of the destination counts as arriving. Ending earlier keeps the drive but compares only
 * the part driven: TomTom's full prediction minus the time it still expected for the road left.
 */
export function driveRecord({ t0, now, name, predicted, noTraffic, metres, reroutes, leftM, remainingS, arrived }) {
  const actual = Math.round((now - t0) / 1000);
  const complete = arrived || leftM < 300;
  if (!complete && (actual < 60 || metres - leftM < 500)) return null;
  const rec = { start: new Date(t0).toISOString(), to: name, predicted_s: complete ? predicted : Math.max(0, Math.round(predicted - remainingS)),
    no_traffic_s: noTraffic, actual_s: actual, metres, reroutes };
  if (!complete) { rec.ended_early = true; rec.left_m = Math.round(leftM); rec.full_predicted_s = predicted; }
  return rec;
}

/** Point and direction of travel at `along` metres down a route. */
export function pointAt(pts, cum, along) {
  const a = Math.max(0, Math.min(along, cum[cum.length - 1]));
  let i = cum.findIndex((c) => c >= a);
  if (i <= 0) i = 1;
  const seg = cum[i] - cum[i - 1];
  const k = seg === 0 ? 0 : (a - cum[i - 1]) / seg;
  const p = pts[i - 1], q = pts[i];
  return { lat: p.lat + (q.lat - p.lat) * k, lon: p.lon + (q.lon - p.lon) * k, bearing: bearing(p, q) };
}

/** Bearing part-way from a to b, turning the short way round. */
export function lerpAngle(a, b, k) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * k + 360) % 360;
}

const ARROWS = { STRAIGHT: "↑", SLIGHT_RIGHT: "↗", RIGHT: "→", SHARP_RIGHT: "↘", RIGHT_U_TURN: "↷", SLIGHT_LEFT: "↖", LEFT: "←", SHARP_LEFT: "↙", LEFT_U_TURN: "↶" };

/**
 * Lane picture for the next manoeuvre, or null when none is near.
 * sections: [{ from, to, lanes: [{ directions: [...], follow? }] }] with from/to in metres along the route.
 * Shown from `lookahead` metres before the lane section until its end. Lanes run left to right.
 * A lane with `follow` is one the route can use; its arrow is the direction to take from it.
 */
export function laneView(sections, along, lookahead = 800) {
  for (const s of sections) {
    if (s.to < along) continue;
    if (s.from - along > lookahead) return null; // sections are in route order, so nothing nearer follows
    return {
      toGo: Math.max(0, s.from - along),
      lanes: s.lanes.map((l) => ({ arrow: ARROWS[l.follow || l.directions[0]] || "↑", use: !!l.follow })),
    };
  }
  return null;
}

/** Speed limit in km/h at `along` metres down the route, or null where the map has none. */
export function limitAt(limits, along) {
  for (const l of limits) if (along >= l.from && along < l.to) return l.kmh;
  return null;
}

/** Readies limit_fixes.json for limitFix: points as {lat, lon}, plus a padded bounding box per piece for a quick skip. */
export function prepFixes(raw) {
  const pad = 0.0006; // about 60 m
  return raw.map((f) => {
    const pts = f.pts.map(([lat, lon]) => ({ lat, lon }));
    const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
    return { kmh: f.kmh ?? null, two: !!f.two, minor: !!f.m, sign: !!f.s, pts, cum: cumulative(pts),
      box: { s: Math.min(...lats) - pad, n: Math.max(...lats) + pad, w: Math.min(...lons) - pad, e: Math.max(...lons) + pad } };
  });
}

/**
 * The limit piece for the road under `pos` as { kmh, sign, off }, or null when none applies there. Each piece is one
 * carriageway drawn in driving direction. It applies within `max` metres of its line (12 m for a minor road, so a
 * service road does not lend its limit to the main road beside it) and, when the heading is known, only to a car
 * pointing the same way: the opposite carriageway runs 30 m alongside and can differ. `sign` = the number was read
 * from a surveyed sign pole, not from OpenStreetMap. A piece without kmh is a road with no known limit: when it is
 * the nearest one the answer is null.
 */
export function nearestFix(pos, heading, fixes, opts) {
  const hit = nearestPiece(pos, heading, fixes, opts);
  // nearest road has no known limit: say so, do not fall back to the next road over
  return hit && hit.piece.kmh != null ? { off: hit.off, kmh: hit.piece.kmh, sign: hit.piece.sign } : null;
}

/** The piece itself (also one without a number) nearest to `pos` under nearestFix's rules: { piece, off, along }, or null. */
export function nearestPiece(pos, heading, fixes, { max = 25, turn = 50, minorMax = 12 } = {}) {
  let best = null;
  for (const f of fixes) {
    if (pos.lat < f.box.s || pos.lat > f.box.n || pos.lon < f.box.w || pos.lon > f.box.e) continue;
    const loc = locateOnRoute(pos, f.pts, f.cum);
    if (loc.off > (f.minor ? Math.min(max, minorMax) : max)) continue;
    if (heading != null) {
      const off = angleDiff(heading, bearing(f.pts[loc.index], f.pts[loc.index + 1]));
      if (off > turn && !(f.two && 180 - off <= turn)) continue; // a two-way road is drawn once and serves both headings
    }
    if (!best || loc.off < best.off) best = { piece: f, off: loc.off, along: loc.along };
  }
  return best;
}

/** Limit in km/h from nearestFix, or null. */
export function limitFix(pos, heading, fixes, opts) {
  return nearestFix(pos, heading, fixes, opts)?.kmh ?? null;
}

/**
 * The limit to show when TomTom and OpenStreetMap may both know the road. Same number or one source: that number.
 * Up to 40 km/h apart: the lower one, marked unsure. Every Abu Dhabi limit change checked in 2024-26 was a cut that
 * one of the two had not caught up with, so the lower was right, and a limit shown too low costs a minute while one
 * shown too high costs a fine. Further apart, one of them is describing a different road (a service road beside a
 * motorway): on a route TomTom's number belongs to the road being driven, so it is kept; without a route TomTom
 * only guessed the nearest road, while the OpenStreetMap road was matched by position and heading, so that wins.
 */
export function pickLimit(tomtom, osm, onRoute = false) {
  if (tomtom == null || osm == null) return { kmh: tomtom ?? osm ?? null, unsure: false };
  if (tomtom === osm) return { kmh: tomtom, unsure: false };
  if (Math.abs(tomtom - osm) <= 40) return { kmh: Math.min(tomtom, osm), unsure: true };
  return { kmh: onRoute ? tomtom : osm, unsure: true };
}

/** "140.00KPH" (or MPH) from TomTom reverse geocoding -> km/h as a whole number, or null. */
export function parseLimit(text) {
  const m = /^([\d.]+)\s*(KPH|MPH)$/i.exec(text || "");
  if (!m) return null;
  const v = Number(m[1]);
  return Math.round(m[2].toUpperCase() === "MPH" ? v * 1.609344 : v);
}

/**
 * Over-speed chime logic. Returns true when a chime is due: on first going more than `margin` km/h over the limit,
 * then every `repeatMs` while still over. Dropping back under the limit re-arms it.
 */
export class OverSpeed {
  constructor({ margin = 2, repeatMs = 15000 } = {}) { this.margin = margin; this.repeatMs = repeatMs; this.last = null; }
  check(kmh, limit, now) {
    if (limit == null || kmh <= limit + this.margin) { this.last = null; return false; }
    if (this.last != null && now - this.last < this.repeatMs) return false;
    this.last = now;
    return true;
  }
}

/** Abu Dhabi's four bridge toll gates charge Monday-Saturday 07:00-09:00 and 15:00-19:00 (rule as of 2026). */
export function darbPeak(date) {
  const day = date.getDay(), h = date.getHours();
  return day !== 0 && ((h >= 7 && h < 9) || (h >= 15 && h < 19));
}

/** Short toll line for a route with n toll gates, or "" for none. AED 4 per charged crossing. */
export function tollNote(n, date) {
  if (!n) return "";
  return `${n} toll gate${n > 1 ? "s" : ""} · ${darbPeak(date) ? `about AED ${4 * n} now` : "bridge gates free now"}`;
}

/** "14:05" */
export const clock = (date) => `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** At most `max` points, evenly thinned, always keeping the first and the last. */
export function thin(pts, max) {
  if (pts.length <= max) return pts.slice();
  const step = (pts.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => pts[Math.round(i * step)]);
}

const INCIDENT_NAMES = { 1: "Accident", 2: "Fog", 3: "Danger on the road", 7: "Lane closed", 8: "Road closed", 9: "Road works", 11: "Flooding", 14: "Broken down vehicle" };

/**
 * Traffic incidents that lie on the route ahead of `fromAlong`, nearest first: [{ id, along, text }].
 * Plain queues (category 6) are left out: the arrival time already includes them.
 */
export function incidentsOnRoute(incidents, pts, cum, fromAlong, maxOff = 50) {
  const out = [];
  for (const inc of incidents) {
    const name = INCIDENT_NAMES[inc.properties?.iconCategory];
    const g = inc.geometry;
    if (!name || !g) continue;
    const c = g.type === "Point" ? g.coordinates : g.coordinates[0];
    const loc = locateOnRoute({ lat: c[1], lon: c[0] }, pts, cum);
    if (loc.off > maxOff || loc.along <= fromAlong) continue;
    out.push({ id: `${inc.properties.iconCategory}:${c[0].toFixed(4)},${c[1].toFixed(4)}`, along: loc.along, text: name });
  }
  return out.sort((a, b) => a.along - b.along);
}

const TURN_ICONS = {
  TURN_LEFT: "←", TURN_RIGHT: "→", SHARP_LEFT: "↙", SHARP_RIGHT: "↘", BEAR_LEFT: "↖", BEAR_RIGHT: "↗", KEEP_LEFT: "↖", KEEP_RIGHT: "↗",
  STRAIGHT: "↑", FOLLOW: "↑", ENTER_MOTORWAY: "↑", ENTER_FREEWAY: "↑", ENTER_HIGHWAY: "↑", DEPART: "↑", SWITCH_MAIN_ROAD: "↑", SWITCH_PARALLEL_ROAD: "↗",
  TAKE_EXIT: "↗", MOTORWAY_EXIT_RIGHT: "↗", MOTORWAY_EXIT_LEFT: "↖", MAKE_UTURN: "↶", TRY_MAKE_UTURN: "↶", ENTRANCE_RAMP: "↗",
  ROUNDABOUT_CROSS: "⟳", ROUNDABOUT_RIGHT: "⟳", ROUNDABOUT_LEFT: "⟳", ROUNDABOUT_BACK: "⟳",
  ARRIVE: "⚑", ARRIVE_LEFT: "⚑", ARRIVE_RIGHT: "⚑", WAYPOINT_REACHED: "⚑", WAYPOINT_LEFT: "⚑", WAYPOINT_RIGHT: "⚑",
};
/** One big symbol for a TomTom manoeuvre code. Unknown codes fall back to straight ahead. */
export const turnIcon = (maneuver) => TURN_ICONS[maneuver] || "↑";

/** The instruction right after `next`, if it follows within `within` metres (two turns in quick succession). */
export function thenTurn(instructions, next, within = 250) {
  const i = instructions.findIndex((x) => x.offset === next.offset && x.message === next.message);
  const after = i >= 0 ? instructions[i + 1] : null;
  // "then follow the road" is not a turn worth announcing
  if (!after || ["FOLLOW", "DEPART", "STRAIGHT"].includes(after.maneuver)) return null;
  return after.offset - next.offset <= within ? after : null;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// drives that can be compared with TomTom's prediction: real, finished, no stop on the way
const comparable = (d) => !d.simulated && !d.ended_early && !d.stops && d.predicted_s > 0;

/** Numbers for the Drives screen. `now` is a Date. */
export function tripStats(drives, now) {
  const real = drives.filter((d) => !d.simulated);
  const week = real.filter((d) => now - new Date(d.start) < 7 * 86400000);
  const cmp = real.filter(comparable);
  const drivenM = (d) => d.metres - (d.left_m || 0);
  return {
    drives: real.length,
    weekDrives: week.length,
    weekKm: Math.round(week.reduce((s, d) => s + drivenM(d), 0) / 1000),
    weekMin: Math.round(week.reduce((s, d) => s + d.actual_s, 0) / 60),
    // how far off TomTom is on average: +8 means drives take 8% longer than predicted
    errorPct: cmp.length ? Math.round((cmp.reduce((s, d) => s + (d.actual_s - d.predicted_s) / d.predicted_s, 0) / cmp.length) * 100) : null,
    compared: cmp.length,
    trafficMin: Math.round(cmp.filter((d) => d.no_traffic_s).reduce((s, d) => s + Math.max(0, d.actual_s - d.no_traffic_s), 0) / 60),
  };
}

/**
 * How the driver's real times compare with TomTom's for one destination: 1.08 = 8% longer.
 * Needs 2 comparable drives there, else 3 anywhere, else 1 (no correction). Kept within 0.7-1.6.
 */
export function personalFactor(drives, name) {
  const cmp = drives.filter(comparable);
  const here = cmp.filter((d) => d.to === name);
  const pool = here.length >= 2 ? here : cmp.length >= 3 ? cmp : [];
  if (!pool.length) return 1;
  return Math.min(1.6, Math.max(0.7, median(pool.map((d) => d.actual_s / d.predicted_s))));
}

/**
 * The trip the driver usually makes around this time: same kind of day (Mon-Fri or weekend), start within 90 minutes of now,
 * made at least twice, and not where the car already is. Returns { name, lat, lon, times } or null.
 */
export function usualTrip(drives, now, pos) {
  const workday = (d) => d.getDay() >= 1 && d.getDay() <= 5;
  const minutes = (d) => d.getHours() * 60 + d.getMinutes();
  const hits = new Map();
  for (const d of drives) {
    if (d.simulated || d.to_lat == null) continue;
    const s = new Date(d.start);
    const gap = Math.abs(minutes(s) - minutes(now));
    if (workday(s) !== workday(now) || Math.min(gap, 1440 - gap) > 90) continue;
    const h = hits.get(d.to) || { name: d.to, lat: d.to_lat, lon: d.to_lon, times: 0 };
    h.times++;
    hits.set(d.to, h);
  }
  const best = [...hits.values()].filter((h) => h.times >= 2 && (!pos || distance(pos, h) > 1500)).sort((a, b) => b.times - a.times)[0];
  return best || null;
}

/** A one-event calendar file with an alert at the start, for "leave now" reminders that work with the app closed. */
export function icsEvent({ title, start, minutes = 5, alertBefore = 10 }) {
  const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(start.getTime() + minutes * 60000);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//navlab//drive//EN", "BEGIN:VEVENT", `UID:${stamp(start)}-${Math.round(start / 1000)}@navlab`,
    `DTSTAMP:${stamp(start)}`, `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`, `SUMMARY:${title.replace(/[,;\\]/g, " ")}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${title.replace(/[,;\\]/g, " ")}`, `TRIGGER:-PT${alertBefore}M`, "END:VALARM",
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${title.replace(/[,;\\]/g, " ")}`, "TRIGGER:PT0M", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}

/**
 * Whether the sun is up at this moment and place (standard sunrise/sunset formula, good to a few minutes).
 * Far north or south where the sun does not rise or set that day, returns the right constant answer.
 */
export function isDaylight(date, lat, lon) {
  const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const n = Math.floor((date.getTime() - start) / 86400000); // day of the year, UTC
  const lngHour = lon / 15;
  const event = (rising) => {
    const tt = n + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * tt - 3.289;
    const L = (M + 1.916 * Math.sin(rad(M)) + 0.02 * Math.sin(rad(2 * M)) + 282.634 + 720) % 360;
    let RA = (deg(Math.atan(0.91764 * Math.tan(rad(L)))) + 360) % 360;
    RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
    const sinDec = 0.39782 * Math.sin(rad(L)), cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(rad(90.833)) - sinDec * Math.sin(rad(lat))) / (cosDec * Math.cos(rad(lat)));
    if (cosH > 1) return "never-rises";
    if (cosH < -1) return "never-sets";
    const H = (rising ? 360 - deg(Math.acos(cosH)) : deg(Math.acos(cosH))) / 15;
    return (H + RA - 0.06571 * tt - 6.622 - lngHour + 48) % 24; // hour of the day, UTC
  };
  const rise = event(true), set = event(false);
  if (rise === "never-rises" || set === "never-rises") return false;
  if (rise === "never-sets" || set === "never-sets") return true;
  const now = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  return rise < set ? now >= rise && now < set : now >= rise || now < set;
}

// ---------- place search (OpenStreetMap names, second source next to TomTom) ----------
/** Lower case, accents off, punctuation to spaces. Arabic letters are kept. */
export function normName(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ًͯ-ْ]/g, "").replace(/[^a-z0-9ء-ي]+/g, " ").trim();
}
const lead = (n) => n.replace(/^(the|al) /, "");

/** places_osm.json -> search index. Entry: [name, lat, lon, kind index, area index or -1, weight 0..3]. */
export function prepPlaces(data) {
  return { kinds: data.kinds, areas: data.areas, p: data.p, n: data.p.map((r) => normName(r[0])) };
}

/**
 * Places whose name holds every typed word as the start of a word ("yas ba" finds "Yas Bay Waterfront").
 * Best first: exact name, then name starting with the text, then heavier class, then nearer.
 * `top` marks a hit good enough to stand above TomTom's list.
 */
export function searchPlaces(index, query, near, limit = 6) {
  const q = normName(query);
  if (!index || q.length < 2) return [];
  let toks = q.split(" ");
  const core = toks.filter((t) => t !== "al" && t !== "the");
  if (core.length) toks = core;
  const longest = toks.reduce((a, b) => (b.length > a.length ? b : a));
  const ql = lead(q), hits = [];
  for (let i = 0; i < index.n.length; i++) {
    const n = index.n[i];
    if (!n.includes(longest)) continue;
    let ok = true;
    for (const t of toks) if (!(n.startsWith(t) || n.includes(" " + t))) { ok = false; break; }
    if (!ok) continue;
    const r = index.p[i], nl = lead(n);
    const exact = nl === ql, starts = nl.startsWith(ql);
    const dist = near ? distance(near, { lat: r[1], lon: r[2] }) : 0;
    const extra = Math.max(0, n.split(" ").length - toks.length);
    // a small shop that merely shares the name ("Baniyas" the jeweller) must not outrank the district
    const score = r[5] * 10 + (exact ? (r[5] ? 40 : 15) : 0) + (starts ? 20 : 0) - extra * 2 - 4 * Math.log2(1 + dist / 10000);
    hits.push({ name: r[0], lat: r[1], lon: r[2], kind: index.kinds[r[3]], area: r[4] >= 0 ? index.areas[r[4]] : "", dist, score, top: starts && r[5] >= 1 });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * One list from both sources: strong own hits, then TomTom's, then the remaining own hits.
 * A TomTom entry with the same name within 500 m of an own hit is dropped. Items: { name, lat, lon, sub, dist }.
 */
export function mergePlaces(own, tomtom, { top = 3, rest = 3 } = {}) {
  const same = (a, b) => normName(a.name) === normName(b.name) && distance(a, b) < 500;
  const first = own.filter((h) => h.top).slice(0, top);
  const later = own.filter((h) => !first.includes(h)).slice(0, rest);
  const mid = tomtom.filter((t) => !first.some((h) => same(h, t)));
  return [...first, ...mid, ...later.filter((h) => !mid.some((t) => same(h, t)))];
}

// ---------- the driver's own speed limits ----------
/** The part of a line between `from` and `to` metres along it, as [[lat, lon], ...]. */
export function sliceLine(pts, cum, from, to) {
  const a = Math.max(0, from), b = Math.min(cum[cum.length - 1], to);
  const ends = [pointAt(pts, cum, a), pointAt(pts, cum, b)];
  return [ends[0], ...pts.filter((_, i) => cum[i] > a && cum[i] < b), ends[1]].map((p) => [+p.lat.toFixed(6), +p.lon.toFixed(6)]);
}

/**
 * The stretch of road a limit typed in by the driver should cover, as { two, pts } in the limits-layer format.
 * Best: the mapped road piece under the car, up to `reach` metres each way (a mapped piece ends where the road or
 * its limit changes). Else the route line, 300 m back and 700 m on. Else a straight line along the heading.
 */
export function limitPatch(pos, heading, { roads = [], route = null, reach = 1500 } = {}) {
  const hit = nearestPiece(pos, heading, roads);
  if (hit) {
    const pts = sliceLine(hit.piece.pts, hit.piece.cum, hit.along - reach, hit.along + reach);
    if (pts.length > 1 && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1])) return { two: hit.piece.two, pts };
  }
  if (route) {
    const loc = locateOnRoute(pos, route.pts, route.cum);
    if (loc.off < 40 && route.cum[route.cum.length - 1] > 50) return { two: false, pts: sliceLine(route.pts, route.cum, loc.along - 300, loc.along + 700) };
  }
  const h = rad(heading ?? 0), kx = 111320 * Math.cos(rad(pos.lat));
  const at = (m) => [+(pos.lat + (m * Math.cos(h)) / 110540).toFixed(6), +(pos.lon + (m * Math.sin(h)) / kx).toFixed(6)];
  return { two: heading == null, pts: heading == null ? [at(-300), at(300)] : [at(-200), at(600)] };
}
