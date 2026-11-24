// navlab drive screen: map, speed, camera warnings, TomTom route + turn voice, drive log.
import { distance, bearing, cameraAhead, CameraAlerts, cumulative, locateOnRoute, nextInstruction, fmtDist, sayDist, driveRecord } from "./geo.js";

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
const BUILD = "202611241227"; // stamped by deploy.sh
const params = new URLSearchParams(location.search);
const SIM = params.has("sim");
const SIM_KMH = Number(params.get("kmh")) || 110;
const SIM_START = { lat: 24.3665244, lon: 54.5647253 };

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
async function tt(path, query = {}) {
  const res = await fetch(`${TT}${path}?${new URLSearchParams({ key: KEY, ...query })}`);
  if (!res.ok) throw new Error(`TomTom ${res.status}`);
  return res.json();
}

// ---------- state ----------
const state = {
  pos: null, heading: null, kmh: 0, lastFix: null,
  follow: true, night: store.get("navlab.night", true), voice: store.get("navlab.voice", true),
  cameras: [], alerts: new CameraAlerts(),
  route: null,   // { pts, cum, instructions, summary, dest }
  drive: null,   // active drive: { t0, spoken:Set, offCount, lastReroute, reroutes, ... }
};
let map, meMarker;

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

// ---------- map ----------
const tileUrl = () => `${TT}/map/1/tile/basic/${state.night ? "night" : "main"}/{z}/{x}/{y}.png?tileSize=512&language=en-GB&key=${KEY}`;

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: { base: { type: "raster", tiles: [tileUrl()], tileSize: 512, attribution: "© TomTom · cameras © OpenStreetMap" } },
      layers: [{ id: "base", type: "raster", source: "base" }],
    },
    center: [54.45, 24.42], zoom: 9, attributionControl: { compact: true },
  });
  map.on("dragstart", () => { state.follow = false; $("recenter").hidden = false; });
  map.on("load", async () => {
    map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "route-casing", type: "line", source: "route", paint: { "line-color": "#0b3d91", "line-width": 9 }, layout: { "line-cap": "round", "line-join": "round" } });
    map.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#4da3ff", "line-width": 5 }, layout: { "line-cap": "round", "line-join": "round" } });
    const data = await (await fetch("./cameras.json")).json();
    state.cameras = data.cameras.map((c) => ({ lat: c.lat, lon: c.lon, limit: Number.parseInt(c.maxspeed, 10) || null }));
    map.addSource("cams", { type: "geojson", data: { type: "FeatureCollection", features: state.cameras.map((c) => ({ type: "Feature", geometry: { type: "Point", coordinates: [c.lon, c.lat] }, properties: {} })) } });
    map.addLayer({ id: "cams", type: "circle", source: "cams", minzoom: 9, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2, 15, 7], "circle-color": "#ff9f1a", "circle-stroke-color": "#111", "circle-stroke-width": 1.5 } });
    document.body.dataset.ready = "1";
  });
  const el = document.createElement("div");
  el.className = "me";
  meMarker = new maplibregl.Marker({ element: el, rotationAlignment: "map" }); // added to the map on the first fix
}

function setNight(on) {
  state.night = on;
  store.set("navlab.night", on);
  map.getSource("base").setTiles([tileUrl()]);
  $("night").textContent = on ? "Day" : "Night";
}

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
  if (!prev || distance(prev.pos, pos) > 8 || t - prev.t > 5000) state.lastFix = { pos, t };

  if (!prev) { meMarker.setLngLat([lon, lat]).addTo(map); gps("ok"); map.jumpTo({ center: [lon, lat], zoom: 15 }); }
  meMarker.setLngLat([lon, lat]);
  if (state.heading != null) meMarker.setRotation(state.heading);
  if (state.follow) {
    map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15), bearing: state.kmh > 10 && state.heading != null ? state.heading : map.getBearing(), duration: 900 });
  }
  $("speed").textContent = Math.round(state.kmh);
  checkCameras(t);
  if (state.drive) guide(t);
}

function checkCameras(now) {
  const chip = $("cam");
  // Below walking pace the heading is noise, so a "camera ahead" call would be a guess.
  // While navigating, only cameras on the route line count, so side streets stay quiet.
  const pool = state.drive ? state.route.camList : state.cameras;
  const hit = state.kmh >= 15 && state.heading != null ? cameraAhead(state.pos, state.heading, pool) : null;
  if (!hit) { chip.hidden = true; document.body.classList.remove("over"); return; }
  const limit = hit.camera.limit;
  const over = limit != null && state.kmh > limit;
  chip.hidden = false;
  chip.textContent = `Camera ${fmtDist(hit.dist)}${limit ? ` · limit ${limit}` : ""}`;
  document.body.classList.toggle("over", over);
  const stage = state.alerts.check(hit, now);
  if (stage === "far") say(`Speed camera ahead, ${sayDist(hit.dist)}.${limit ? ` Limit ${limit}.` : ""}`);
  if (stage === "near") say(over ? `Camera. Slow down, limit ${limit}.` : `Camera, ${sayDist(hit.dist)}.`);
}

// ---------- search ----------
let searchTimer;
$("q").addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = $("q").value.trim();
  if (q.length < 3) { $("results").hidden = true; return; }
  searchTimer = setTimeout(() => search(q), 400);
});

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

// ---------- route ----------
async function fetchRoute(from, dest) {
  const j = await tt(`/routing/1/calculateRoute/${from.lat},${from.lon}:${dest.lat},${dest.lon}/json`,
    { traffic: "true", travelMode: "car", routeType: "fastest", instructionsType: "text", language: "en-GB", computeTravelTimeFor: "all" });
  const r = j.routes[0];
  const pts = r.legs.flatMap((l) => l.points.map((p) => ({ lat: p.latitude, lon: p.longitude })));
  const cum = cumulative(pts);
  const instructions = (r.guidance?.instructions || []).map((i) => ({ offset: i.routeOffsetInMeters, message: i.message, maneuver: i.maneuver }));
  // cameras that sit on the route line (within 35 m)
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const box = { s: Math.min(...lats) - 0.001, n: Math.max(...lats) + 0.001, w: Math.min(...lons) - 0.001, e: Math.max(...lons) + 0.001 };
  const camList = state.cameras.filter((c) => c.lat > box.s && c.lat < box.n && c.lon > box.w && c.lon < box.e && locateOnRoute(c, pts, cum).off < 35);
  return { pts, cum, instructions, dest, camList, cams: camList.length, summary: { secs: r.summary.travelTimeInSeconds, noTraffic: r.summary.noTrafficTravelTimeInSeconds ?? null, delay: r.summary.trafficDelayInSeconds ?? 0, metres: r.summary.lengthInMeters } };
}

function drawRoute(route) {
  map.getSource("route").setData(route ? { type: "Feature", geometry: { type: "LineString", coordinates: route.pts.map((p) => [p.lon, p.lat]) }, properties: {} } : { type: "FeatureCollection", features: [] });
}

async function plan(dest) {
  if (!state.pos) { say("No GPS position yet. Route needs your location."); return; }
  const from = state.pos;
  try {
    state.route = await fetchRoute(from, dest);
  } catch (e) { say(`Route failed. ${e.message}`); return; }
  drawRoute(state.route);
  const s = state.route.summary;
  $("plan-name").textContent = dest.name;
  $("plan-info").textContent = `${Math.round(s.secs / 60)} min · ${(s.metres / 1000).toFixed(1)} km · traffic +${Math.round(s.delay / 60)} min · ${state.route.cams} cameras`;
  $("plan").hidden = false;
  state.follow = false;
  const b = new maplibregl.LngLatBounds();
  state.route.pts.forEach((p) => b.extend([p.lon, p.lat]));
  map.fitBounds(b, { padding: { top: 140, bottom: 220, left: 40, right: 40 }, bearing: 0 });
}

function go() {
  const s = state.route.summary;
  state.drive = { t0: Date.now(), name: state.route.dest.name, predicted: s.secs, noTraffic: s.noTraffic, metres: s.metres, leftM: s.metres, remainingS: s.secs, spoken: new Set(), offCount: 0, lastReroute: 0, reroutes: 0 };
  $("plan").hidden = true;
  $("nav").hidden = false;
  $("searchbar").hidden = true;
  state.follow = true;
  $("recenter").hidden = true;
  map.setPadding({ top: 320, bottom: 0, left: 0, right: 0 });
  say(`Route to ${state.route.dest.name}. ${Math.round(s.secs / 60)} minutes.`);
}

// Called on arrival and by the End button. Both save the drive; only a mis-tap (under a minute or 500 m) is dropped.
function endDrive(arrived) {
  const d = state.drive;
  const rec = d && driveRecord({ ...d, now: Date.now(), arrived });
  if (rec) {
    if (SIM) rec.simulated = true;
    const drives = store.get("navlab.drives", []);
    drives.push(rec);
    store.set("navlab.drives", drives);
    const mins = `Predicted ${Math.round(rec.predicted_s / 60)} minutes, took ${Math.round(rec.actual_s / 60)}.`;
    say(rec.ended_early ? `Drive saved, ended ${sayDist(rec.left_m)} early. ${mins}` : `${arrived ? "Arrived" : "Drive saved"}. ${mins}`);
  }
  state.drive = null;
  state.route = null;
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  drawRoute(null);
  $("nav").hidden = true;
  $("plan").hidden = true;
  $("searchbar").hidden = false;
  $("q").value = "";
}

async function guide(now) {
  const { route, drive } = state;
  const loc = locateOnRoute(state.pos, route.pts, route.cum);
  const left = route.summary.metres - loc.along;
  drive.leftM = left;
  drive.remainingS = (route.summary.secs * left) / route.summary.metres;

  if (distance(state.pos, route.dest) < 60 || left < 40) return endDrive(true);

  // Off the line for three fixes in a row = a real wrong turn, not GPS jitter. Ask for a new route at most every 15 s.
  drive.offCount = loc.off > 80 ? drive.offCount + 1 : 0;
  if (drive.offCount >= 3 && now - drive.lastReroute > 15000) {
    drive.lastReroute = now;
    drive.offCount = 0;
    try {
      state.route = await fetchRoute(state.pos, route.dest);
      drive.reroutes++;
      drive.spoken.clear();
      drawRoute(state.route);
      say("Rerouting.");
    } catch { /* keep the old route; the next fix will try again after the 15 s gap */ }
    return;
  }

  const next = nextInstruction(route.instructions, loc.along);
  const etaMin = Math.max(1, Math.round((route.summary.secs * left) / route.summary.metres / 60));
  $("nav-eta").textContent = `${etaMin} min · ${fmtDist(left)}`;
  if (!next) { $("nav-next").textContent = "Continue to destination"; return; }
  $("nav-next").textContent = `${fmtDist(next.toGo)} · ${next.message}`;
  const id = next.offset;
  if (next.toGo <= 70 && !drive.spoken.has(`${id}:now`)) {
    drive.spoken.add(`${id}:now`).add(`${id}:soon`);
    say(next.message);
  } else if (next.toGo <= 450 && next.toGo > 120 && !drive.spoken.has(`${id}:soon`)) {
    drive.spoken.add(`${id}:soon`);
    say(`In ${sayDist(next.toGo)}, ${next.message.charAt(0).toLowerCase()}${next.message.slice(1)}`);
  }
}

// ---------- drives log ----------
function showDrives() {
  const drives = store.get("navlab.drives", []);
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
  $("night").textContent = state.night ? "Day" : "Night";
}

// accepts the bare key or the whole setup link
$("save-key").onclick = () => { const raw = $("key-input").value.trim(); const v = raw.includes("#key=") ? raw.split("#key=")[1] : raw; if (v) { KEY = v; store.set("navlab.key", v); boot(); } };
if (!STANDALONE && !SIM) $("start-hint").textContent = "Safari: first Share → Add to Home Screen, then open Drive from the home screen";
$("start").onclick = () => { $("start").remove(); say("Ready."); keepAwake(); startTracking(); };
$("recenter").onclick = () => { state.follow = true; $("recenter").hidden = true; if (state.pos) map.easeTo({ center: [state.pos.lon, state.pos.lat], zoom: 15.5 }); };
$("night").onclick = () => setNight(!state.night);
function setVoice(on) {
  state.voice = on;
  store.set("navlab.voice", on);
  $("voice").textContent = on ? "Voice on" : "Voice off";
  $("voice").classList.toggle("off", !on);
  if (!on && "speechSynthesis" in window) speechSynthesis.cancel(); // cut off anything mid-sentence
}
$("voice").onclick = () => { setVoice(!state.voice); if (state.voice) say("Voice on."); };
setVoice(state.voice);
$("go").onclick = go;
$("cancel").onclick = () => endDrive(false);
$("stop").onclick = () => endDrive(false);
$("log").onclick = showDrives;
$("drives-close").onclick = () => ($("drives").hidden = true);
$("drives-export").onclick = async () => {
  const text = JSON.stringify(store.get("navlab.drives", []), null, 1);
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
window.navlab = { state, onFix, plan, go }; // handles for testing from the console
