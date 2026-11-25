// navlab drive screen: map, speed, camera warnings, TomTom route + turn voice, drive log.
import { distance, bearing, cameraAhead, CameraAlerts, cumulative, locateOnRoute, nextInstruction, fmtDist, sayDist, driveRecord, pointAt, lerpAngle, laneView, limitAt, parseLimit, OverSpeed, tollNote, clock, thin, incidentsOnRoute, turnIcon, thenTurn, tripStats, personalFactor, usualTrip, icsEvent, isDaylight, prepFixes, limitFix, nearestFix, pickLimit } from "./geo.js";

import { sunsetStyle, sunsetDayStyle } from "./colors.js";

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
const BUILD = "202611251313"; // stamped by deploy.sh
const params = new URLSearchParams(location.search);
const SIM = params.has("sim");
const SIM_KMH = Number(params.get("kmh")) || 110;
// test mode start point: ?from=lat,lon or the university
const [simLat, simLon] = (params.get("from") || "24.3665244,54.5647253").split(",").map(Number);
const SIM_START = { lat: simLat, lon: simLon };

// ---------- key ----------
// A setup link carries the key after "#key=": the fragment never leaves the phone.
// iPhone gives a home-screen app its own empty storage, separate from Safari, so the key must travel inside the saved
// link. In Safari the "#key=" part therefore stays in the address bar until Add to Home Screen has captured it.
const STANDALONE = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
if (location.hash.startsWith("#key=")) {
  store.set("navlab.key", decodeURIComponent(location.hash.slice(5)));
  if (STANDALONE) history.replaceState(null, "", location.pathname + location.search);
}
let KEY = store.get("navlab.key", "");

const TT = "https://api.tomtom.com";
async function tt(path, query = {}, body) {
  const pairs = Array.isArray(query) ? query : Object.entries(query); // an array of pairs allows a key twice
  const res = await fetch(`${TT}${path}?${new URLSearchParams([["key", KEY], ...pairs])}`,
    body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  if (!res.ok) throw new Error(`TomTom ${res.status}`);
  return res.json();
}

// ---------- state ----------
const state = {
  pos: null, heading: null, kmh: 0, lastFix: null,
  follow: true, theme: store.get("navlab.theme", "sunset"), voice: store.get("navlab.voice", true), roadLimit: null, limitFixes: [], osmLimits: [], limitWhy: null, course: null,
  cameras: [], alerts: new CameraAlerts(), overSpeed: new OverSpeed(),
  options: null, // routes offered on the plan card, fastest first
  route: null,   // { pts, cum, instructions, lanes, limits, tolls, incidents, summary, dest }
  drive: null,   // active drive: { t0, spoken:Set, offCount, lastReroute, reroutes, ... }
};
let map, meMarker;
// Choices from the Menu, remembered on the phone.
const settings = { avoidTolls: false, avoidMotorways: false, beep: true, ...store.get("navlab.settings", {}) };
const REFRESH_MS = (Number(params.get("refresh")) || 150) * 1000; // how often a drive re-checks traffic

// ---------- voice ----------
function say(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(say.t);
  say.t = setTimeout(() => ($("toast").hidden = true), 6000);
  if (!state.voice || !("speechSynthesis" in window)) return;
  if (speechSynthesis.pending) speechSynthesis.cancel(); // never let old warnings queue up behind new ones
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-GB";
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

// ---------- map and themes ----------
// Each theme = a TomTom vector map style plus a set of screen colours (styles.css, [data-theme]).
// Vector maps keep street names upright when the map turns with the car, and carry live traffic colours.
const THEMES = [
  // Sunset: neon coastal-city-at-dusk look. The dark map is repainted (purple ground, pink roads, teal water);
  // the route is cyan so it stands out from the pink roads.
  // It has a night and a day look and picks by the sun: night look from sunset to sunrise where the car is.
  { id: "sunset", label: "Sunset · auto", auto: {
    night: { map: "2/basic_street-dark-driving", flow: "dark", repaint: sunsetStyle, route: "#3df5ff", casing: "#063a45" },
    day: { map: "2/basic_street-light-driving", flow: "light", repaint: sunsetDayStyle, route: "#6a2cf0", casing: "#ffffff" } } },
  { id: "night", label: "Night", map: "2/basic_street-dark-driving", flow: "dark" },
  { id: "day", label: "Day", map: "2/basic_street-light-driving", flow: "light" },
  { id: "neon", label: "Neon", map: "2/basic_street-dark-driving", flow: "dark" },
  { id: "sat", label: "Satellite", map: "2/basic_street-satellite", flow: "dark" },
];
const theme = () => THEMES.find((t) => t.id === state.theme) || THEMES[0];
// "day" or "night" for a theme that follows the sun, else null. Before the first GPS fix, Abu Dhabi's sun is used.
// ?sun=day|night forces it (for testing).
const sunVariant = () => (theme().auto ? params.get("sun") || (isDaylight(new Date(), state.pos?.lat ?? 24.45, state.pos?.lon ?? 54.38) ? "day" : "night") : null);
// The look in force right now: the theme itself, or its day/night half.
const skin = () => (theme().auto ? theme().auto[state.variant || "night"] : theme());
function applyLook() {
  state.variant = sunVariant();
  document.documentElement.dataset.theme = theme().id;
  if (state.variant) document.documentElement.dataset.variant = state.variant; else delete document.documentElement.dataset.variant;
}
const styleUrl = () => `${TT}/style/1/style/22.2.1-*?key=${KEY}&map=${skin().map}&traffic_flow=2/flow_relative-${skin().flow}&traffic_incidents=2/incidents_${skin().flow}`;
// TomTom's style file is fetched by hand so it can be repaired before the map sees it: it contains a colour
// written as "hsl(160, 43%, 24%%)", which MapLibre rejects, refusing the whole map.
async function loadStyle() {
  const res = await fetch(styleUrl());
  if (!res.ok) throw new Error(`TomTom style ${res.status}`);
  const style = JSON.parse((await res.text()).replaceAll("%%)", "%)"));
  // Street names: the tiles carry the local (Arabic) name in "name" and translations beside it. Prefer English,
  // then the Latin-script spelling, then whatever exists. MapLibre also cannot shape Arabic without an extra plugin.
  const NAME = ["coalesce", ["get", "name_en-GB"], ["get", "name_ngt-Latn"], ["get", "name"]];
  const swap = (v) => (Array.isArray(v) ? (v.length === 2 && v[0] === "get" && v[1] === "name" ? NAME : v.map(swap)) : v);
  for (const layer of style.layers) {
    const tf = layer.layout?.["text-field"];
    if (tf === "{name}") layer.layout["text-field"] = NAME;
    else if (tf === "{name}\n{sub_text}") layer.layout["text-field"] = ["concat", NAME, "\n", ["coalesce", ["get", "sub_text"], ""]];
    else if (Array.isArray(tf)) layer.layout["text-field"] = swap(tf);
  }
  return skin().repaint ? skin().repaint(style) : style;
}
const ATTRIBUTION = '© TomTom · cameras © OpenStreetMap, <a href="https://mapatlas.eu/tools/speed-camera-map">MapAtlas</a> CC BY 4.0';

// Our own layers sit on top of the TomTom style. A theme change replaces the whole style, so they are re-added each time.
function addOverlays() {
  // The route goes above every road but under the street names: before the first layer that draws text.
  const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol" && l.layout?.["text-field"])?.id;
  map.addSource("alts", { type: "geojson", data: altsGeo() });
  map.addLayer({ id: "alts", type: "line", source: "alts", paint: { "line-color": "#9aa4b1", "line-width": 5, "line-opacity": 0.75 }, layout: { "line-cap": "round", "line-join": "round" } }, firstLabel);
  map.addSource("route", { type: "geojson", data: routeGeo(state.route) });
  map.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": skin().casing || "#0b3d91", "line-width": 10 }, layout: { "line-cap": "round", "line-join": "round" } }, firstLabel);
  map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": skin().route || "#4da3ff", "line-width": 6 }, layout: { "line-cap": "round", "line-join": "round" } }, firstLabel);
  map.addSource("cams", { type: "geojson", data: camGeo(), attribution: ATTRIBUTION });
  // Camera dots. From zoom 13 a camera with a known limit is drawn as a small speed-limit sign with the number in it.
  const known = ["!=", ["get", "limit"], null];
  map.addLayer({ id: "cams", type: "circle", source: "cams", minzoom: 9, paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2, 12.9, 5, 13, ["case", known, 11, 6], 16, ["case", known, 15, 8]],
    "circle-color": ["step", ["zoom"], ["case", ["get", "mine"], "#ff4fd8", "#ff9f1a"], 13, ["case", ["get", "mine"], "#ff4fd8", known, "#ffffff", "#ff9f1a"]],
    "circle-stroke-color": ["step", ["zoom"], "#111", 13, ["case", known, "#e02020", "#111"]],
    "circle-stroke-width": ["step", ["zoom"], 1.5, 13, ["case", known, 3, 1.5]] } });
  const font = map.getStyle().layers.find((l) => l.layout?.["text-font"])?.layout["text-font"];
  if (font) map.addLayer({ id: "cam-limits", type: "symbol", source: "cams", minzoom: 13, filter: ["!=", ["get", "limit"], null],
    layout: { "text-field": ["to-string", ["get", "limit"]], "text-font": font, "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 14], "text-allow-overlap": true, "text-ignore-placement": true },
    paint: { "text-color": "#111" } });
}

async function initMap() {
  applyLook();
  let style;
  try { style = await loadStyle(); } catch (e) { say(`Map failed to load. ${e.message}`); return; }
  map = new maplibregl.Map({
    container: "map", style, center: [54.45, 24.42], zoom: 9, attributionControl: { compact: true },
  });
  map.on("dragstart", () => { state.follow = false; $("recenter").hidden = false; });
  // Hold a finger on the map for a moment to route to that exact spot (a car park, a gate).
  let press;
  const cancelPress = () => clearTimeout(press);
  const pin = (ll) => { if (!state.drive) plan({ name: "Dropped pin", lat: ll.lat, lon: ll.lng }); };
  map.on("touchstart", (e) => { cancelPress(); if (e.originalEvent.touches.length === 1) press = setTimeout(() => pin(e.lngLat), 650); });
  for (const ev of ["touchend", "touchcancel", "dragstart", "zoomstart"]) map.on(ev, cancelPress);
  map.on("contextmenu", (e) => pin(e.lngLat));
  map.on("style.load", addOverlays);
  // Tap a camera dot to remove a camera that is not really there.
  map.on("click", "cams", (e) => {
    const [lon, lat] = e.features[0].geometry.coordinates;
    const cam = state.cameras.find((c) => Math.abs(c.lat - lat) < 1e-6 && Math.abs(c.lon - lon) < 1e-6);
    if (cam && confirm("Hide this camera? Use this when no camera is really there. Undo in Menu.")) hideCamera(cam);
  });
  map.once("load", async () => {
    const data = await (await fetch("./cameras.json")).json();
    // Stretches where TomTom's limit is out of date (see build_limit_fixes.py). The app works without the file.
    try { state.limitFixes = prepFixes((await (await fetch("./limit_fixes.json")).json()).fixes); } catch { state.limitFixes = []; }
    // OpenStreetMap's limit for every main road: the second opinion next to TomTom. Big file, so it loads on the side.
    fetch("./limits_osm.json").then((r) => r.json()).then((d) => { state.osmLimits = prepFixes(d.roads); }).catch(() => {});
    const hidden = new Set(store.get("navlab.hiddencams", [])); // cameras the driver marked as not there
    // A speed camera's number: its own tag and the road's limit beside it (worked out when the list is built) go
    // through the same rule as the road sign, because camera lists are years old.
    state.cameras = data.cameras.map((c) => ({ lat: c.lat, lon: c.lon, limit: c.kind === "light" ? null : pickLimit(Number.parseInt(c.maxspeed, 10) || null, c.road ?? null).kmh, light: c.kind === "light" }))
      .filter((c) => !hidden.has(state.alerts.key(c)));
    // camera lists are years old: on a corrected stretch the camera's number follows the corrected limit
    for (const c of state.cameras) if (c.limit != null) c.limit = limitFix(c, null, state.limitFixes, { max: 60 }) ?? c.limit;
    // cameras the driver added by hand live on the phone and join the same list
    state.cameras.push(...store.get("navlab.mycams", []).map((c) => ({ lat: c.lat, lon: c.lon, limit: null, mine: true })));
    map.getSource("cams")?.setData(camGeo());
    document.body.dataset.ready = "1";
  });
  const el = document.createElement("div");
  el.className = "me";
  meMarker = new maplibregl.Marker({ element: el, rotationAlignment: "map" }); // added to the map on the first fix
}

// Removes a camera from this phone's list (the driver saw that none is there). Kept in a list so it can be undone and exported.
function hideCamera(cam) {
  const key = state.alerts.key(cam);
  if (cam.mine) store.set("navlab.mycams", store.get("navlab.mycams", []).filter((c) => state.alerts.key(c) !== key));
  else store.set("navlab.hiddencams", [...new Set([...store.get("navlab.hiddencams", []), key])]);
  state.cameras = state.cameras.filter((c) => c !== cam);
  if (state.route) state.route.camList = state.route.camList.filter((c) => c !== cam);
  map.getSource("cams")?.setData(camGeo());
  $("cam").hidden = true;
  say("Camera hidden.");
}

function setTheme(id) {
  state.theme = id;
  store.set("navlab.theme", id);
  applyLook();
  $("theme").textContent = `Theme: ${theme().label}`;
  if (map) loadStyle().then((style) => map.setStyle(style, { diff: false })).catch((e) => say(`Theme failed to load. ${e.message}`));
}

const camGeo = () => ({ type: "FeatureCollection", features: state.cameras.map((c) => ({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: { mine: !!c.mine, limit: c.limit ?? null } })) });

// One tap while passing a camera the list does not know. Saved on the phone, used from the next pass on.
function addCamera() {
  if (!state.pos) return say("No GPS yet.");
  const c = { lat: state.pos.lat, lon: state.pos.lon, limit: null, mine: true };
  const mine = store.get("navlab.mycams", []);
  mine.push({ lat: c.lat, lon: c.lon, heading: state.heading == null ? null : Math.round(state.heading), kmh: Math.round(state.kmh), t: new Date().toISOString() });
  store.set("navlab.mycams", mine);
  state.cameras.push(c);
  if (state.route) state.route.camList.push(c);
  state.alerts.state.set(state.alerts.key(c), { stage: "done", until: Date.now() + state.alerts.cooldownMs }); // no warning for the one just passed
  map.getSource("cams").setData(camGeo());
  say(`Camera saved. ${mine.length} of your own.`);
}

// Sunrise and sunset: once a minute, and on the first GPS fix, check whether the look should flip.
function followSun() {
  if (!map || !theme().auto || sunVariant() === state.variant) return;
  setTheme(state.theme);
  say(state.variant === "day" ? "Day look." : "Night look.");
}
setInterval(followSun, 60000);

// ---------- smooth display ----------
// GPS arrives about once a second. Drawing each fix as it lands makes the dot hop. So the screen glides from the
// spot last drawn to the new fix over the gap between fixes, and coasts slightly past it if the next fix is late.
const glide = { from: null, to: null, t0: 0, dur: 1000, shown: null, lastFix: 0 };
function glideTo(target) {
  const now = performance.now();
  glide.dur = Math.min(1500, Math.max(100, glide.lastFix ? now - glide.lastFix : 1000));
  glide.lastFix = now;
  glide.from = glide.shown || target;
  glide.to = target;
  glide.t0 = now;
}
function frame() {
  requestAnimationFrame(frame);
  const { from, to } = glide;
  if (!to || !map) return;
  const k = Math.min(1.25, (performance.now() - glide.t0) / glide.dur);
  const lat = from.lat + (to.lat - from.lat) * k, lon = from.lon + (to.lon - from.lon) * k;
  const hdg = lerpAngle(from.hdg, to.hdg, Math.min(1, k));
  glide.shown = { lat, lon, hdg };
  meMarker.setLngLat([lon, lat]).setRotation(hdg);
  if (state.follow) map.jumpTo({ center: [lon, lat], bearing: state.kmh > 10 ? hdg : map.getBearing() });
}
requestAnimationFrame(frame);

// ---------- position ----------
function onFix(lat, lon, speedMs, hdg, t = Date.now()) {
  const pos = { lat, lon };
  const prev = state.lastFix;
  let kmh = speedMs != null && speedMs >= 0 ? speedMs * 3.6 : null;
  let heading = hdg != null && !Number.isNaN(hdg) && hdg >= 0 ? hdg : null;
  if (prev) {
    const moved = distance(prev.pos, pos);
    const dt = (t - prev.t) / 1000;
    if (kmh == null && dt > 0) kmh = (moved / dt) * 3.6;
    if (heading == null && moved > 8) heading = bearing(prev.pos, pos);
  }
  state.pos = pos;
  state.kmh = kmh ?? 0;
  if (heading != null) state.heading = heading;
  if (heading != null && state.kmh >= 15) state.course = { hdg: heading, t }; // last heading taken at driving speed
  if (!prev || distance(prev.pos, pos) > 8 || t - prev.t > 5000) state.lastFix = { pos, t };

  // What gets drawn: the raw fix, or, while navigating and within 30 m of the route, the matching point on the
  // route line facing along the road. That hides sideways GPS wobble. Warnings and guidance still use the raw fix.
  let show = { lat, lon, hdg: state.heading ?? glide.shown?.hdg ?? 0 };
  if (state.drive && state.route) {
    const loc = locateOnRoute(pos, state.route.pts, state.route.cum);
    if (loc.off < 30) { const q = pointAt(state.route.pts, state.route.cum, loc.along); show = { lat: q.lat, lon: q.lon, hdg: q.bearing }; }
  }
  if (!prev) { meMarker.setLngLat([lon, lat]).addTo(map); gps("ok"); map.jumpTo({ center: [lon, lat], zoom: 15 }); suggestUsual(); tickLeave(); followSun(); }
  glideTo(show);
  $("speed").textContent = Math.round(state.kmh);
  showLimit(pos, t);
  if (state.overSpeed.check(state.kmh, state.roadLimit, t)) chime();
  checkCameras(t);
  if (state.drive) guide(t);
}

// Road speed limit, always on screen. Sources, in order of trust:
//   1. a hand-checked correction for this stretch (limit_fixes.json);
//   2. TomTom (the route's own limit while navigating, else a lookup of the road under the car) and OpenStreetMap,
//      combined by pickLimit: where they differ a little, the lower one is shown and the sign gets a "?".
// The last answer stays up; once nothing fresh is known it is greyed and not used for the over-speed warning.
function showLimit(pos, t, ask = true) {
  const hdg = course(t);
  const fixed = limitFix(pos, hdg, state.limitFixes);
  const near = fixed == null ? nearestFix(pos, hdg, state.osmLimits) : null; // OpenStreetMap, or a surveyed sign where it has no number
  const osm = near ? near.kmh : null;
  let tom = state.drive && state.route ? limitAt(state.route.limits, locateOnRoute(pos, state.route.pts, state.route.cum).along) : null;
  state.limitFromRoute = tom != null;
  if (tom == null && fixed == null) {
    if (ask) lookupLimit(pos, t);
    tom = freeLimit.kmh != null && t - freeLimit.t < 60000 ? freeLimit.kmh : null;
  }
  const pick = fixed != null ? { kmh: fixed, unsure: false } : pickLimit(tom, osm, state.limitFromRoute);
  const shown = pick.kmh ?? freeLimit.kmh; // nothing fresh: the last TomTom answer, greyed
  state.roadLimit = pick.kmh;
  state.limitWhy = { fixed, tomtom: tom, osm, second: near?.sign ? "the road-sign survey" : "OpenStreetMap", shown: pick.kmh };
  const el = $("limit");
  el.hidden = false;
  el.textContent = shown ?? "–";
  el.classList.toggle("stale", pick.kmh == null);
  el.classList.toggle("unsure", pick.kmh != null && pick.unsure);
}

// Speed limit lookup: at most one per 8 s, and only after 250 m or 12 s on the move. Standing still it re-asks
// once a minute. A 30-minute drive costs about 200 of the 2,500 free daily requests.
const freeLimit = { kmh: null, t: 0, at: null, busy: false, asked: 0 };
/** Heading from the last fix at driving speed, if it is under two minutes old. */
const course = (now) => (state.course && now - state.course.t < 120000 ? state.course.hdg : null);
async function lookupLimit(pos, now) {
  if (freeLimit.busy || now - freeLimit.asked < 8000) return;
  const moved = freeLimit.at ? distance(freeLimit.at, pos) : Infinity;
  if (moved < 250 && now - freeLimit.asked < (moved < 30 ? 60000 : 12000)) return;
  freeLimit.busy = true;
  freeLimit.asked = now;
  freeLimit.at = pos;
  try {
    const q = { returnSpeedLimit: "true", radius: 40 };
    // The heading picks the right carriageway. In a queue the live heading is noise, and without one TomTom
    // answers for the nearest road, often the service road, so the last heading from driving speed is kept.
    const hdg = course(now);
    if (hdg != null) q.heading = Math.round(hdg);
    const j = await tt(`/search/2/reverseGeocode/${pos.lat},${pos.lon}.json`, q);
    const kmh = parseLimit(j.addresses?.[0]?.address?.speedLimit);
    if (kmh != null) {
      freeLimit.kmh = kmh;
      freeLimit.t = now; // same clock as the fixes
      // show it at once; a parked phone may not send another fix for a while
      if (state.pos) showLimit(state.pos, now, false);
    }
  } catch { /* no signal or quota: the sign simply disappears after 45 s */ }
  freeLimit.busy = false;
}

function checkCameras(now) {
  const chip = $("cam");
  // Below walking pace the heading is noise, so a "camera ahead" call would be a guess.
  // While navigating, only cameras on the route line count, so side streets stay quiet.
  const pool = state.drive ? state.route.camList : state.cameras;
  const hit = state.kmh >= 15 && state.heading != null ? cameraAhead(state.pos, state.heading, pool) : null;
  const overRoad = state.roadLimit != null && state.kmh > state.roadLimit;
  state.camHit = hit ? hit.camera : null; // the camera the pill is about; tapping the pill hides it
  if (!hit) { chip.hidden = true; document.body.classList.toggle("over", overRoad); return; }
  // The road's limit (TomTom's map, fresh) wins over the number stored with the camera, which comes from
  // driver-reported lists and was seen wrong on a real street. The camera's own number is the fallback.
  const limit = state.roadLimit ?? hit.camera.limit;
  const over = (limit != null && state.kmh > limit) || overRoad;
  chip.hidden = false;
  const what = hit.camera.light ? "Red light camera" : "Camera";
  chip.textContent = `${hit.camera.light ? "Red light cam" : "Camera"} ${fmtDist(hit.dist)}${limit ? ` · ${limit}` : ""}`;
  document.body.classList.toggle("over", over);
  const stage = state.alerts.check(hit, now);
  if (stage === "far") say(`${hit.camera.light ? "Red light camera" : "Speed camera"} ahead, ${sayDist(hit.dist)}.${limit ? ` Limit ${limit}.` : ""}`);
  if (stage === "near") say(over ? `${what}. Slow down, limit ${limit}.` : `${what}, ${sayDist(hit.dist)}.`);
}

// ---------- sound ----------
let audio;
// Two short pips for "over the limit". Needs the audio system woken by a tap (the Start button does that).
function chime() {
  if (!settings.beep || !audio) return;
  for (const at of [0, 0.18]) {
    const o = audio.createOscillator(), g = audio.createGain(), t0 = audio.currentTime + at;
    o.frequency.value = 1040;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    o.connect(g).connect(audio.destination);
    o.start(t0);
    o.stop(t0 + 0.15);
  }
}

// ---------- saved places, Home / Work, recents ----------
// A place is where the driver really stopped for a destination (the car park, not the building's map pin).
const places = () => store.get("navlab.places", []);
function savePlace(name, pos) {
  store.set("navlab.places", [{ name, lat: pos.lat, lon: pos.lon }, ...places().filter((p) => p.name !== name)].slice(0, 30));
}
const recents = () => store.get("navlab.recents", []);
function addRecent(dest) {
  if (["Dropped pin", "Home", "Work"].includes(dest.name)) return;
  store.set("navlab.recents", [{ name: dest.name, lat: dest.lat, lon: dest.lon }, ...recents().filter((r) => r.name !== dest.name)].slice(0, 8));
}

// Search box tapped while empty: parking spots first, then recent destinations.
function showPlaces() {
  const box = $("results");
  const spots = places();
  const rows = [...spots.map((pl) => ({ ...pl, kind: "places", note: "Your parking spot" })),
    ...recents().filter((r) => !spots.some((pl) => pl.name === r.name)).map((r) => ({ ...r, kind: "recents", note: "Recent" }))];
  box.replaceChildren(...rows.map((row) => {
    const b = document.createElement("button");
    b.innerHTML = `<strong></strong><span></span><i class="del" role="button" aria-label="Remove">✕</i>`;
    b.firstChild.textContent = row.name;
    b.children[1].textContent = `${row.note} · tap to route`;
    b.onclick = () => { box.hidden = true; $("q").blur(); plan({ name: row.name, lat: row.lat, lon: row.lon, saved: row.kind === "places", parking: row.kind === "places" }); };
    b.lastChild.onclick = (e) => { e.stopPropagation(); store.set(`navlab.${row.kind}`, store.get(`navlab.${row.kind}`, []).filter((x) => x.name !== row.name)); showPlaces(); };
    return b;
  }));
  box.hidden = rows.length === 0;
}

// Home and Work: one tap to route. First tap on an unset one offers to save where the car is now.
function renderQuick() {
  for (const kind of ["home", "work"]) $(kind).classList.toggle("unset", !store.get(`navlab.${kind}`, null));
}
function quick(kind) {
  const label = kind === "home" ? "Home" : "Work";
  const saved = store.get(`navlab.${kind}`, null);
  if (saved) return plan({ ...saved, saved: true });
  if (!state.pos) return say("No GPS yet.");
  if (confirm(`Set ${label} to where you are now? You can also search a place and tap "Set as ${label}".`)) setQuick(kind, state.pos);
}
function setQuick(kind, pos) {
  const label = kind === "home" ? "Home" : "Work";
  store.set(`navlab.${kind}`, { name: label, lat: pos.lat, lon: pos.lon });
  renderQuick();
  say(`${label} saved.`);
}

// ---------- search ----------
let searchTimer;
$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("q").value.trim();
  if (q.length < 3) { showPlaces(); return; }
  searchTimer = setTimeout(() => search(q), 400);
});
$("q").addEventListener("focus", () => { if ($("q").value.trim().length < 3) showPlaces(); });

async function search(q) {
  const c = map.getCenter();
  const near = state.pos || { lat: c.lat, lon: c.lng };
  try {
    const j = await tt(`/search/2/search/${encodeURIComponent(q)}.json`, { limit: 6, countrySet: "AE", lat: near.lat, lon: near.lon });
    const box = $("results");
    box.replaceChildren(...j.results.map((r) => {
      const b = document.createElement("button");
      const name = r.poi?.name || r.address.freeformAddress;
      b.innerHTML = `<strong></strong><span></span>`;
      b.firstChild.textContent = name;
      b.lastChild.textContent = `${r.address.freeformAddress || ""} · ${fmtDist(r.dist || 0)}`;
      b.onclick = () => { box.hidden = true; $("q").value = name; $("q").blur(); plan({ name, lat: r.position.lat, lon: r.position.lon }); };
      return b;
    }));
    box.hidden = j.results.length === 0;
  } catch (e) { say(`Search failed. ${e.message}`); }
}

// ---------- routes ----------
function routeQuery({ alternatives = 0, better = false } = {}) {
  const q = [["traffic", "true"], ["travelMode", "car"], ["routeType", "fastest"], ["instructionsType", "text"], ["language", "en-GB"],
    ["computeTravelTimeFor", "all"], ["sectionType", "lanes"], ["sectionType", "speedLimit"], ["sectionType", "toll"]];
  if (settings.avoidTolls) q.push(["avoid", "tollRoads"]);
  if (settings.avoidMotorways) q.push(["avoid", "motorways"]);
  if (alternatives) q.push(["maxAlternatives", String(alternatives)]);
  // "betterRoute": TomTom returns the given route first and adds another only if it is at least 2 minutes quicker
  if (better) q.push(["alternativeType", "betterRoute"], ["minDeviationTime", "120"], ["minDeviationDistance", "500"]);
  return q;
}

function parseRoute(r, dest) {
  const pts = r.legs.flatMap((l) => l.points.map((p) => ({ lat: p.latitude, lon: p.longitude })));
  const cum = cumulative(pts);
  const instructions = (r.guidance?.instructions || []).map((i) => ({ offset: i.routeOffsetInMeters, message: i.message, maneuver: i.maneuver }));
  const secs = r.sections || [];
  const span = (x) => ({ from: cum[x.startPointIndex] ?? 0, to: cum[x.endPointIndex] ?? cum[cum.length - 1] });
  const lanes = secs.filter((x) => x.sectionType === "LANES").map((x) => ({ ...span(x), lanes: x.lanes }));
  const limits = secs.filter((x) => x.sectionType === "SPEED_LIMIT").map((x) => ({ ...span(x), kmh: x.maxSpeedLimitInKmh }));
  const tolls = secs.filter((x) => x.sectionType === "TOLL").length;
  // Cameras on the route line. 60 m, not less: on a ten-lane motorway the camera pole can stand 50 m from the
  // centre of the driver's carriageway (first real drive: one was missed at 47 m).
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const box = { s: Math.min(...lats) - 0.001, n: Math.max(...lats) + 0.001, w: Math.min(...lons) - 0.001, e: Math.max(...lons) + 0.001 };
  const camList = state.cameras.filter((c) => c.lat > box.s && c.lat < box.n && c.lon > box.w && c.lon < box.e && locateOnRoute(c, pts, cum).off < 60);
  return { pts, cum, instructions, lanes, limits, tolls, incidents: [], dest, camList, cams: camList.length,
    summary: { secs: r.summary.travelTimeInSeconds, noTraffic: r.summary.noTrafficTravelTimeInSeconds ?? null, delay: r.summary.trafficDelayInSeconds ?? 0, metres: r.summary.lengthInMeters } };
}

/**
 * Routes from `from` to `dest`, fastest first. `via` adds a stop on the way (alternatives are not offered then).
 * `supporting` = points of the route being driven, for the mid-drive "is there something quicker" check.
 */
async function fetchRoutes(from, dest, { via = null, alternatives = 0, supporting = null } = {}) {
  const path = [from, via, dest].filter(Boolean).map((p) => `${p.lat},${p.lon}`).join(":");
  const j = await tt(`/routing/1/calculateRoute/${path}/json`, routeQuery({ alternatives: via ? 0 : alternatives, better: !!supporting }),
    supporting ? { supportingPoints: supporting.map((p) => ({ latitude: p.lat, longitude: p.lon })) } : undefined);
  return j.routes.map((r) => parseRoute(r, dest));
}

const line = (pts) => pts.map((p) => [p.lon, p.lat]);
const routeGeo = (route) => (route ? { type: "Feature", geometry: { type: "LineString", coordinates: line(route.pts) }, properties: {} } : { type: "FeatureCollection", features: [] });
// the routes on offer that are not the chosen one, drawn grey underneath it
const altsGeo = () => ({ type: "FeatureCollection", features: (state.options || []).filter((o) => o !== state.route).map((o) => ({ type: "Feature", geometry: { type: "LineString", coordinates: line(o.pts) }, properties: {} })) });
function drawRoute(route) {
  map.getSource("route")?.setData(routeGeo(route));
  map.getSource("alts")?.setData(altsGeo());
}

const arriveAt = (secs) => clock(new Date(Date.now() + secs * 1000));
function routeLine(r) {
  const s = r.summary;
  return [`${Math.round(s.secs / 60)} min`, `${(s.metres / 1000).toFixed(1)} km`, `arrive ${arriveAt(s.secs)}`, `traffic +${Math.round(s.delay / 60)} min`,
    `${r.cams} cameras`, tollNote(r.tolls, new Date())].filter(Boolean).join(" · ");
}

async function plan(dest) {
  if (!state.pos) { say("No GPS position yet. Route needs your location."); return; }
  // Been here before and parked somewhere else than the map pin? Route to that spot instead.
  const spot = dest.saved ? null : places().find((pl) => pl.name === dest.name && distance(pl, dest) < 3000);
  if (spot) dest = { ...dest, lat: spot.lat, lon: spot.lon, saved: true, parking: true };
  try {
    state.options = await fetchRoutes(state.pos, dest, { alternatives: 2 });
  } catch (e) { say(`Route failed. ${e.message}`); return; }
  $("plan-name").textContent = dest.name + (dest.parking ? " · your parking spot" : "");
  $("arrive-by").value = "";
  $("leave-info").textContent = "";
  $("leave-actions").hidden = true;
  $("usual").hidden = true;
  choose(0);
  $("plan").hidden = false;
  state.follow = false;
  const b = new maplibregl.LngLatBounds();
  state.options.forEach((o) => o.pts.forEach((p) => b.extend([p.lon, p.lat])));
  map.fitBounds(b, { padding: { top: 140, bottom: 300, left: 40, right: 40 }, bearing: 0 });
}

// Picks one of the offered routes on the plan card.
function choose(i) {
  state.route = state.options[i];
  drawRoute(state.route);
  $("plan-info").textContent = routeLine(state.route);
  const fastest = state.options[0].summary.secs;
  $("plan-options").replaceChildren(...state.options.map((o, k) => {
    const b = document.createElement("button");
    const extra = Math.round((o.summary.secs - fastest) / 60);
    b.className = k === i ? "on" : "";
    b.innerHTML = `<strong></strong><span></span>`;
    b.firstChild.textContent = `${Math.round(o.summary.secs / 60)} min`;
    b.lastChild.textContent = [k === 0 ? "Fastest" : `+${extra} min`, `${(o.summary.metres / 1000).toFixed(1)} km`, o.tolls ? `${o.tolls} toll` : "no toll", `${o.cams} cam`].join(" · ");
    b.onclick = () => choose(k);
    return b;
  }));
  $("plan-options").hidden = state.options.length < 2;
}

function go() {
  const s = state.route.summary;
  state.drive = { t0: Date.now(), name: state.route.dest.name, predicted: s.secs, noTraffic: s.noTraffic, metres: s.metres, leftM: s.metres, remainingS: s.secs,
    eta: { secs: s.secs, left: s.metres }, // latest traffic-aware time for the road still to drive
    spoken: new Set(), offCount: 0, lastReroute: 0, lastRefresh: Date.now(), refreshing: false, reroutes: 0, switches: 0, via: null, viaPending: false, stops: 0 };
  addRecent(state.route.dest);
  state.options = null;
  drawRoute(state.route);
  $("plan").hidden = true;
  $("nav").hidden = false;
  $("searchbar").hidden = true;
  state.follow = true;
  $("recenter").hidden = true;
  map.setPadding(navPadding());
  map.setZoom(Math.max(map.getZoom(), 15.5));
  say(`Route to ${state.route.dest.name}. ${Math.round(s.secs / 60)} minutes, arriving ${arriveAt(s.secs)}.`);
  loadIncidents(state.route, 0);
}

// While driving the car sits clear of the instruction bar: lower on the screen upright, to the right when the phone is sideways.
const navPadding = () => (innerWidth > innerHeight ? { top: 0, bottom: 0, left: Math.round(innerWidth * 0.44), right: 0 } : { top: 320, bottom: 0, left: 0, right: 0 });
addEventListener("resize", () => { if (map && state.drive) map.setPadding(navPadding()); });

// Called on arrival and by the End button. Both save the drive; only a mis-tap (under a minute or 500 m) is dropped.
function endDrive(arrived) {
  const d = state.drive;
  const rec = d && driveRecord({ ...d, now: Date.now(), arrived });
  if (rec) {
    rec.to_lat = state.route.dest.lat;
    rec.to_lon = state.route.dest.lon;
    if (SIM) rec.simulated = true;
    if (d.switches) rec.switched_route = d.switches;
    if (d.stops) rec.stops = d.stops; // a stop makes "predicted vs took" meaningless; kept so it can be filtered out
    const drives = store.get("navlab.drives", []);
    drives.push(rec);
    store.set("navlab.drives", drives);
    const mins = `Predicted ${Math.round(rec.predicted_s / 60)} minutes, took ${Math.round(rec.actual_s / 60)}.`;
    // End pressed near the destination but not on its map pin = this is where the driver parks. Remember it.
    const parked = !arrived && state.pos && d.leftM < 2000 && !["Dropped pin", "Home", "Work"].includes(d.name) && distance(state.pos, state.route.dest) > 60;
    if (parked) savePlace(d.name, state.pos);
    say(`${rec.ended_early ? `Drive saved, ended ${sayDist(rec.left_m)} early.` : arrived ? "Arrived." : "Drive saved."} ${mins}${parked ? " Parking spot remembered." : ""}`);
  }
  state.drive = null;
  state.route = null;
  state.options = null;
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  drawRoute(null);
  for (const id of ["nav", "lanes", "plan", "stops"]) $(id).hidden = true;
  $("searchbar").hidden = false;
  $("q").value = "";
}

// Replaces the route being driven (wrong turn, quicker road found, stop added or removed).
function adopt(route, drive) {
  state.route = route;
  drive.eta = { secs: route.summary.secs, left: route.summary.metres };
  drive.spoken.clear();
  drive.lastRefresh = Date.now();
  drawRoute(route);
  loadIncidents(route, 0);
}

// Every couple of minutes: ask TomTom how long the road ahead takes now, and whether another road is 2+ minutes quicker.
async function refreshRoute(alongNow) {
  const { route, drive } = state;
  drive.refreshing = true;
  drive.lastRefresh = Date.now();
  try {
    const i0 = Math.max(1, route.cum.findIndex((c) => c >= alongNow));
    const routes = await fetchRoutes(state.pos, route.dest, { alternatives: 1, supporting: thin([state.pos, ...route.pts.slice(i0)], 120) });
    if (state.drive !== drive || state.route !== route) return; // the drive ended or changed while waiting
    const [current, quicker] = routes;
    const saved = quicker ? current.summary.secs - quicker.summary.secs : 0;
    if (quicker && saved >= 120) {
      adopt(quicker, drive);
      drive.switches++;
      say(`Faster route found. Saves ${Math.round(saved / 60)} minutes.`);
    } else {
      drive.eta = { secs: current.summary.secs, left: current.summary.metres };
      loadIncidents(route, alongNow);
    }
  } catch { /* no signal: keep the old estimate and try again at the next interval */ }
  drive.refreshing = false;
}

// Accidents, closures and road works on the route ahead, from TomTom's incident feed. Spoken once each, 2 km before.
async function loadIncidents(route, fromAlong) {
  const lats = route.pts.map((p) => p.lat), lons = route.pts.map((p) => p.lon);
  const box = [Math.min(...lons) - 0.005, Math.min(...lats) - 0.005, Math.max(...lons) + 0.005, Math.max(...lats) + 0.005];
  if ((box[2] - box[0]) * (box[3] - box[1]) > 0.8) return; // TomTom limits the area of one request (about 10,000 km²)
  try {
    const j = await tt("/traffic/services/5/incidentDetails", { bbox: box.join(","), language: "en-GB", timeValidityFilter: "present",
      fields: "{incidents{type,geometry{type,coordinates},properties{iconCategory}}}" });
    route.incidents = incidentsOnRoute(j.incidents || [], route.pts, route.cum, fromAlong);
  } catch { /* feed unavailable: no incident calls this round */ }
}

async function guide(now) {
  const { route, drive } = state;
  const loc = locateOnRoute(state.pos, route.pts, route.cum);
  const left = route.summary.metres - loc.along;
  drive.leftM = left;
  drive.remainingS = (drive.eta.secs * left) / (drive.eta.left || 1);

  if (distance(state.pos, route.dest) < 60 || left < 40) return endDrive(true);
  if (drive.viaPending && distance(state.pos, drive.via) < 80) {
    drive.viaPending = false;
    say(`Stop reached: ${drive.via.name}. Route continues to ${route.dest.name}.`);
  }

  // Off the line for three fixes in a row = a real wrong turn, not GPS jitter. Ask for a new route at most every 15 s.
  drive.offCount = loc.off > 80 ? drive.offCount + 1 : 0;
  if (drive.offCount >= 3 && now - drive.lastReroute > 15000) {
    drive.lastReroute = now;
    drive.offCount = 0;
    try {
      const [fresh] = await fetchRoutes(state.pos, route.dest, { via: drive.viaPending ? drive.via : null });
      if (state.drive !== drive) return;
      adopt(fresh, drive);
      drive.reroutes++;
      say("Rerouting.");
    } catch { /* keep the old route; the next fix will try again after the 15 s gap */ }
    return;
  }
  // traffic re-check; skipped close to the end and while a stop is pending (the stop pins the route)
  if (!drive.refreshing && !drive.viaPending && left > 1500 && Date.now() - drive.lastRefresh > REFRESH_MS) refreshRoute(loc.along);

  const lv = laneView(route.lanes, loc.along);
  $("lanes").hidden = !lv;
  if (lv) $("lanes").replaceChildren(...lv.lanes.map((l) => { const el = document.createElement("span"); el.textContent = l.arrow; if (l.use) el.className = "use"; return el; }));

  for (const inc of route.incidents) {
    const ahead = inc.along - loc.along;
    if (ahead > 0 && ahead <= 2000 && !drive.spoken.has(inc.id)) { drive.spoken.add(inc.id); say(`${inc.text} in ${sayDist(ahead)}.`); }
  }

  const next = nextInstruction(route.instructions, loc.along);
  const etaMin = Math.max(1, Math.round(drive.remainingS / 60));
  $("nav-eta").textContent = `${arriveAt(drive.remainingS)} · ${etaMin} min · ${fmtDist(left)}`;
  if (!next) { $("nav-arrow").textContent = "↑"; $("nav-next").textContent = "Continue to destination"; $("nav-then").hidden = true; return; }
  $("nav-arrow").textContent = turnIcon(next.maneuver);
  $("nav-next").textContent = `${fmtDist(next.toGo)} · ${next.message}`;
  // two turns close together: show and say the second one too, so it does not come as a surprise
  const then = thenTurn(route.instructions, next);
  $("nav-then").hidden = !then;
  if (then) $("nav-then").textContent = `then ${turnIcon(then.maneuver)} ${then.message}`;
  const id = next.offset;
  if (next.toGo <= 70 && !drive.spoken.has(`${id}:now`)) {
    drive.spoken.add(`${id}:now`).add(`${id}:soon`);
    say(then ? `${next.message}, then ${then.message.charAt(0).toLowerCase()}${then.message.slice(1)}` : next.message);
  } else if (next.toGo <= 450 && next.toGo > 120 && !drive.spoken.has(`${id}:soon`)) {
    drive.spoken.add(`${id}:soon`);
    say(`In ${sayDist(next.toGo)}, ${next.message.charAt(0).toLowerCase()}${next.message.slice(1)}`);
  }
}

// ---------- arrive by / leave by ----------
// "Be there by 08:15": TomTom plans backwards using typical traffic for that hour, then the driver's own record
// against TomTom on this destination stretches or shrinks the drive time. Two extra minutes are added to get going.
async function planLeave() {
  const v = $("arrive-by").value;
  const dest = state.route?.dest;
  if (!v || !dest) return;
  const [h, m] = v.split(":").map(Number);
  const arrive = new Date();
  arrive.setHours(h, m, 0, 0);
  if (arrive - Date.now() < 10 * 60000) arrive.setDate(arrive.getDate() + 1); // that time has passed today: tomorrow
  try {
    const j = await tt(`/routing/1/calculateRoute/${state.pos.lat},${state.pos.lon}:${dest.lat},${dest.lon}/json`,
      [["traffic", "true"], ["travelMode", "car"], ["arriveAt", arrive.toISOString().replace(/\.\d{3}Z$/, "Z")],
        ...(settings.avoidTolls ? [["avoid", "tollRoads"]] : []), ...(settings.avoidMotorways ? [["avoid", "motorways"]] : [])]);
    const base = j.routes[0].summary.travelTimeInSeconds;
    const factor = personalFactor(store.get("navlab.drives", []), dest.name);
    const secs = Math.round(base * factor) + 120;
    const leave = new Date(arrive.getTime() - secs * 1000);
    state.leavePlan = { name: dest.name, lat: dest.lat, lon: dest.lon, leaveAt: leave.getTime(), arriveAt: arrive.getTime() };
    const day = leave.toDateString() === new Date().toDateString() ? "" : " tomorrow";
    const own = factor === 1 ? "" : ` · your drives run ${Math.abs(Math.round((factor - 1) * 100))}% ${factor > 1 ? "longer" : "shorter"}`;
    $("leave-info").textContent = `Leave by ${clock(leave)}${day} · ${Math.round(secs / 60)} min${own}`;
    $("leave-actions").hidden = false;
  } catch (e) { $("leave-info").textContent = `Could not plan that. ${e.message}`; $("leave-actions").hidden = true; }
}

// Reminder inside the app: a line on screen counting down, spoken 10 minutes before and at the moment. Works only
// while Drive is open; the calendar button is for when it is closed.
function remindLeave() {
  store.set("navlab.leave", { ...state.leavePlan, said: [] });
  $("plan").hidden = true;
  endDrive(false);
  tickLeave();
  say(`Reminder set. Leave for ${state.leavePlan.name} at ${clock(new Date(state.leavePlan.leaveAt))}.`);
}
function tickLeave() {
  const L = store.get("navlab.leave", null);
  const el = $("leave");
  if (!L || Date.now() - L.leaveAt > 20 * 60000 || state.drive) { el.hidden = true; if (L && (Date.now() - L.leaveAt > 20 * 60000)) localStorage.removeItem("navlab.leave"); return; }
  const mins = Math.round((L.leaveAt - Date.now()) / 60000);
  el.hidden = false;
  $("leave-text").textContent = mins > 0 ? `Leave for ${L.name} in ${mins} min (${clock(new Date(L.leaveAt))})` : `Time to leave for ${L.name}`;
  el.classList.toggle("now", mins <= 0);
  const due = mins <= 0 ? "now" : mins <= 10 ? "soon" : null;
  if (due && !L.said.includes(due)) {
    L.said.push(due);
    store.set("navlab.leave", L);
    chime();
    say(due === "now" ? `Time to leave for ${L.name}.` : `Leave for ${L.name} in ${mins} minutes.`);
  }
}
setInterval(tickLeave, 20000);

// A calendar entry with its own alerts, so the phone reminds even with Drive closed.
function leaveToCalendar() {
  const L = state.leavePlan;
  const file = new File([icsEvent({ title: `Leave for ${L.name}`, start: new Date(L.leaveAt) })], "leave.ics", { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = "leave.ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------- usual trip ----------
// If the log shows the same destination at this time on this kind of day, offer it in one tap.
function suggestUsual() {
  if (state.drive || !state.pos) return;
  const u = usualTrip(store.get("navlab.drives", []), new Date(), state.pos);
  $("usual").hidden = !u;
  if (!u) return;
  $("usual").textContent = `Usual now: ${u.name} →`;
  $("usual").onclick = () => { $("usual").hidden = true; plan({ name: u.name, lat: u.lat, lon: u.lon }); };
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { suggestUsual(); tickLeave(); } });

// ---------- stops on the way ----------
const STOP_KINDS = [["Petrol", "petrol station"], ["Coffee", "coffee"], ["Food", "restaurant"], ["Shop", "supermarket"], ["Pharmacy", "pharmacy"], ["Mosque", "mosque"]];

function openStops() {
  const drive = state.drive;
  $("stops-kinds").replaceChildren(...STOP_KINDS.map(([label, query]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.onclick = () => findStops(label, query);
    return b;
  }));
  $("stops-list").textContent = drive.viaPending ? `Current stop: ${drive.via.name}` : "Pick what you need. Shows places close to your route.";
  $("stops-remove").hidden = !drive.viaPending;
  $("stops").hidden = false;
}

// Places of one kind that cost at most 15 minutes of detour, nearest along the route first.
async function findStops(label, query) {
  const { route, drive } = state;
  $("stops-list").textContent = `Looking for ${label.toLowerCase()}…`;
  try {
    const along = locateOnRoute(state.pos, route.pts, route.cum).along;
    const i0 = Math.max(1, route.cum.findIndex((c) => c >= along));
    const j = await tt(`/search/2/searchAlongRoute/${encodeURIComponent(query)}.json`, { maxDetourTime: 900, limit: 8, spreadingMode: "auto" },
      { route: { points: thin([state.pos, ...route.pts.slice(i0)], 100).map((p) => ({ lat: p.lat, lon: p.lon })) } });
    if (state.drive !== drive) return;
    const rows = j.results.map((r) => ({ name: r.poi?.name || label, lat: r.position.lat, lon: r.position.lon, detour: r.detourTime || 0,
      ahead: locateOnRoute({ lat: r.position.lat, lon: r.position.lon }, route.pts, route.cum).along - along })).filter((r) => r.ahead > 0).sort((a, b) => a.ahead - b.ahead);
    if (!rows.length) { $("stops-list").textContent = `No ${label.toLowerCase()} close to the route ahead.`; return; }
    $("stops-list").replaceChildren(...rows.map((r) => {
      const b = document.createElement("button");
      b.innerHTML = `<strong></strong><span></span>`;
      b.firstChild.textContent = r.name;
      b.lastChild.textContent = `${fmtDist(r.ahead)} ahead · +${Math.max(1, Math.round(r.detour / 60))} min`;
      b.onclick = () => setStop(r);
      return b;
    }));
  } catch (e) { $("stops-list").textContent = `Search failed. ${e.message}`; }
}

// Adds (or with null, removes) the stop and re-routes through it.
async function setStop(stop) {
  const { route, drive } = state;
  $("stops").hidden = true;
  try {
    const [fresh] = await fetchRoutes(state.pos, route.dest, { via: stop });
    if (state.drive !== drive) return;
    drive.via = stop;
    drive.viaPending = !!stop;
    if (stop) drive.stops++;
    adopt(fresh, drive);
    say(stop ? `Stop added: ${stop.name}. Arriving ${arriveAt(fresh.summary.secs)}.` : "Stop removed.");
  } catch (e) { say(`Could not change the route. ${e.message}`); }
}

// ---------- drives log ----------
function showDrives() {
  const drives = store.get("navlab.drives", []);
  const st = tripStats(drives, new Date());
  $("drives-stats").textContent = st.drives
    ? [`Last 7 days: ${st.weekDrives} drives · ${st.weekKm} km · ${st.weekMin} min`,
      st.compared ? `TomTom vs you over ${st.compared} full drives: you take ${Math.abs(st.errorPct)}% ${st.errorPct >= 0 ? "longer" : "less"} · ${st.trafficMin} min lost to traffic` : "Finish a full drive to compare TomTom's times with yours",
      `Your cameras: ${store.get("navlab.mycams", []).length} added · ${store.get("navlab.hiddencams", []).length} hidden`].join("\n")
    : "";
  const list = $("drives-list");
  if (!drives.length) list.textContent = "No drives yet. Finish a route and it shows here.";
  else list.replaceChildren(...drives.slice().reverse().map((d) => {
    const row = document.createElement("div");
    const diff = Math.round((d.actual_s - d.predicted_s) / 60);
    row.className = "drive";
    row.textContent = `${d.start.slice(0, 16).replace("T", " ")} · ${d.to} · predicted ${Math.round(d.predicted_s / 60)} · took ${Math.round(d.actual_s / 60)} (${diff >= 0 ? "+" : ""}${diff} min)${d.ended_early ? ` · ended ${fmtDist(d.left_m)} early` : ""}${d.simulated ? " · simulated" : ""}`;
    return row;
  }));
  $("drives").hidden = false;
}

// ---------- start ----------
let wakeLock;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not supported or denied: screen may dim */ }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !$("start").isConnected) keepAwake(); });

// GPS status line under the search box: waiting, blocked (with the fix), or hidden once a real fix arrives.
function gps(status) {
  const el = $("gps");
  el.hidden = status === "ok";
  el.classList.toggle("bad", status === "blocked");
  if (status === "waiting") el.textContent = "Waiting for GPS…";
  if (status === "blocked") el.textContent = "Location is blocked. iPhone Settings → Privacy & Security → Location Services → Safari Websites → While Using, and turn on Precise Location. Then reopen Drive.";
  if (status === "none") el.textContent = "This browser gives no location to web apps.";
}

function startTracking() {
  if (SIM) return startSim();
  if (!navigator.geolocation) return gps("none");
  gps("waiting");
  navigator.geolocation.watchPosition(
    (p) => onFix(p.coords.latitude, p.coords.longitude, p.coords.speed, p.coords.heading, p.timestamp),
    (e) => { if (e.code === 1) gps("blocked"); else if (!state.pos) gps("waiting"); },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}

// Test mode (?sim): drives the planned route at a fixed speed, one fix per second. Parked at the start point until a route is started.
function startSim() {
  let along = 0, last = null;
  onFix(SIM_START.lat, SIM_START.lon, 0, null);
  setInterval(() => {
    if (!state.drive) { along = 0; last = null; return; }
    const { pts, cum } = state.route;
    if (last !== state.route) { along = locateOnRoute(state.pos, pts, cum).along; last = state.route; }
    along = Math.min(along + SIM_KMH / 3.6, cum[cum.length - 1]);
    let i = cum.findIndex((c) => c >= along);
    if (i <= 0) i = 1;
    const t = (along - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    const a = pts[i - 1], b = pts[i];
    onFix(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t, SIM_KMH / 3.6, bearing(a, b));
  }, Number(params.get("tick")) || 1000);
}

function boot() {
  if (!KEY) { $("setup").hidden = false; return; }
  $("setup").hidden = true;
  initMap();
  $("theme").textContent = `Theme: ${theme().label}`;
}

// accepts the bare key or the whole setup link
$("save-key").onclick = () => { const raw = $("key-input").value.trim(); const v = raw.includes("#key=") ? raw.split("#key=")[1] : raw; if (v) { KEY = v; store.set("navlab.key", v); boot(); } };
if (!STANDALONE && !SIM) $("start-hint").textContent = "Safari: first Share → Add to Home Screen, then open Drive from the home screen";
$("start").onclick = () => {
  $("start").remove();
  try { audio = new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch { /* no sound system: chimes stay silent */ }
  say("Ready.");
  keepAwake();
  startTracking();
};
$("recenter").onclick = () => { state.follow = true; $("recenter").hidden = true; if (state.pos) map.easeTo({ center: [state.pos.lon, state.pos.lat], zoom: 15.5 }); };
$("theme").onclick = () => setTheme(THEMES[(THEMES.indexOf(theme()) + 1) % THEMES.length].id);
$("addcam").onclick = addCamera;
function setVoice(on) {
  state.voice = on;
  store.set("navlab.voice", on);
  $("voice").textContent = on ? "Voice on" : "Voice off";
  $("voice").classList.toggle("off", !on);
  if (!on && "speechSynthesis" in window) speechSynthesis.cancel(); // cut off anything mid-sentence
}
$("voice").onclick = () => { setVoice(!state.voice); if (state.voice) say("Voice on."); };
setVoice(state.voice);
// Menu: a switch shows its state in its own label.
function renderMenu() {
  $("beep").textContent = `Over-limit chime: ${settings.beep ? "on" : "off"}`;
  $("avoid-tolls").textContent = `Avoid tolls: ${settings.avoidTolls ? "on" : "off"}`;
  $("avoid-motorways").textContent = `Avoid motorways: ${settings.avoidMotorways ? "on" : "off"}`;
  $("restore-cams").textContent = `Restore hidden cameras (${store.get("navlab.hiddencams", []).length})`;
  for (const [id, on] of [["beep", settings.beep], ["avoid-tolls", settings.avoidTolls], ["avoid-motorways", settings.avoidMotorways]]) $(id).classList.toggle("on", on);
}
function flip(key) {
  settings[key] = !settings[key];
  store.set("navlab.settings", settings);
  renderMenu();
  if (key === "beep" && settings.beep) chime();
}
$("more").onclick = () => { renderMenu(); $("menu").hidden = false; };
$("menu-close").onclick = () => ($("menu").hidden = true);
$("beep").onclick = () => flip("beep");
$("avoid-tolls").onclick = () => flip("avoidTolls");
$("avoid-motorways").onclick = () => flip("avoidMotorways");
$("reset-quick").onclick = () => { localStorage.removeItem("navlab.home"); localStorage.removeItem("navlab.work"); renderQuick(); say("Home and Work cleared."); };
$("home").onclick = () => quick("home");
$("work").onclick = () => quick("work");
$("set-home").onclick = () => setQuick("home", state.route.dest);
$("set-work").onclick = () => setQuick("work", state.route.dest);
$("add-stop").onclick = openStops;
$("cam").onclick = () => { if (state.camHit) hideCamera(state.camHit); };
// Tap the limit sign to see where the number comes from.
$("limit").onclick = () => {
  const w = state.limitWhy;
  if (!w) return;
  const text = w.fixed != null ? `Limit ${w.fixed}: corrected from an official notice.`
    : w.tomtom != null && w.osm != null && w.tomtom !== w.osm ? `TomTom says ${w.tomtom}, ${w.second} says ${w.osm}. Showing ${w.shown}.`
    : w.shown != null ? `Limit ${w.shown} (${[w.tomtom != null && "TomTom", w.osm != null && w.second].filter(Boolean).join(" and ")}).`
    : "No fresh limit for this road.";
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(say.t);
  say.t = setTimeout(() => ($("toast").hidden = true), 6000);
};
$("arrive-by").onchange = planLeave;
$("leave-remind").onclick = remindLeave;
$("leave-calendar").onclick = leaveToCalendar;
$("leave-x").onclick = () => { localStorage.removeItem("navlab.leave"); $("leave").hidden = true; };
$("leave-go").onclick = () => { const L = store.get("navlab.leave", null); if (L) plan({ name: L.name, lat: L.lat, lon: L.lon }); };
$("restore-cams").onclick = () => { localStorage.removeItem("navlab.hiddencams"); say("Hidden cameras are back after you reopen Drive."); renderMenu(); };
$("stops-close").onclick = () => ($("stops").hidden = true);
$("stops-remove").onclick = () => setStop(null);
renderQuick();
$("go").onclick = go;
$("cancel").onclick = () => endDrive(false);
$("stop").onclick = () => endDrive(false);
$("log").onclick = () => { $("menu").hidden = true; showDrives(); };
$("drives-close").onclick = () => ($("drives").hidden = true);
$("drives-export").onclick = async () => {
  const text = JSON.stringify({ drives: store.get("navlab.drives", []), my_cameras: store.get("navlab.mycams", []), hidden_cameras: store.get("navlab.hiddencams", []), places: places() }, null, 1);
  try { if (navigator.share) await navigator.share({ title: "navlab drives", text }); else await navigator.clipboard.writeText(text); } catch { /* user closed the share sheet */ }
};

if ("serviceWorker" in navigator && location.protocol === "https:") {
  // updateViaCache "none": the phone always checks the server for a new version of the app
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).then((r) => r.update()).catch(() => {});
  // When a new version takes over, reload once so the screen matches it. Never in the middle of a drive.
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController && !state.drive) location.reload(); });
}
$("build").textContent = `version ${BUILD}`;
boot();
window.navlab = { state, settings, onFix, plan, go, glide, map: () => map }; // handles for testing from the console
