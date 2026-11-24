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
    if (off < best.off) best = { off, along: cum[i] + t * Math.sqrt(len2), index: i };
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
