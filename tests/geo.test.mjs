import test from "node:test";
import assert from "node:assert/strict";
import { distance, bearing, angleDiff, cameraAhead, CameraAlerts, cumulative, locateOnRoute, nextInstruction, fmtDist, sayDist, driveRecord, pointAt, lerpAngle, laneView, limitAt, parseLimit, OverSpeed, darbPeak, tollNote, clock, thin, incidentsOnRoute, turnIcon, thenTurn, tripStats, personalFactor, usualTrip, icsEvent, isDaylight, prepFixes, limitFix, pickLimit } from "../geo.js";

const P = { lat: 24.4, lon: 54.5 };
const north = (m) => ({ lat: P.lat + m / 111195, lon: P.lon });
const east = (m) => ({ lat: P.lat, lon: P.lon + m / (111195 * Math.cos((P.lat * Math.PI) / 180)) });

test("distance and bearing", () => {
  assert.ok(Math.abs(distance(P, north(1000)) - 1000) < 2);
  assert.ok(Math.abs(distance(P, east(500)) - 500) < 2);
  assert.ok(angleDiff(bearing(P, north(100)), 0) < 0.5);
  assert.ok(angleDiff(bearing(P, east(100)), 90) < 0.5);
  assert.equal(angleDiff(350, 10), 20);
});

test("cameraAhead picks nearest in the travel cone only", () => {
  const cams = [north(700), north(400), east(200), north(-300), north(1500)];
  const hit = cameraAhead(P, 0, cams);
  assert.ok(Math.abs(hit.dist - 400) < 2);
  assert.equal(cameraAhead(P, 180, [north(400)]), null); // behind
  assert.equal(cameraAhead(P, 0, [east(200)]), null); // off to the side
  assert.equal(cameraAhead(P, 0, [north(1500)]), null); // too far
});

test("alerts: far once, near once, then quiet until cooldown ends", () => {
  const a = new CameraAlerts({ nearAt: 300, cooldownMs: 1000 });
  const cam = north(800);
  assert.equal(a.check({ camera: cam, dist: 800 }, 0), "far");
  assert.equal(a.check({ camera: cam, dist: 600 }, 10), null);
  assert.equal(a.check({ camera: cam, dist: 290 }, 20), "near");
  assert.equal(a.check({ camera: cam, dist: 100 }, 30), null);
  assert.equal(a.check({ camera: cam, dist: 800 }, 500), null); // still cooling down
  assert.equal(a.check({ camera: cam, dist: 800 }, 2000), "far"); // next pass
  assert.equal(a.check(null, 0), null);
});

test("alerts: first sight already close gives near, not far", () => {
  const a = new CameraAlerts();
  assert.equal(a.check({ camera: north(200), dist: 200 }, 0), "near");
});

test("locateOnRoute: along distance and off-route distance", () => {
  const pts = [P, north(1000), { lat: north(1000).lat, lon: east(1000).lon }];
  const cum = cumulative(pts);
  assert.ok(Math.abs(cum[2] - 2000) < 5);
  const on = locateOnRoute(north(400), pts, cum);
  assert.ok(on.off < 1 && Math.abs(on.along - 400) < 3);
  const side = locateOnRoute({ lat: north(400).lat, lon: east(120).lon }, pts, cum);
  assert.ok(Math.abs(side.off - 120) < 3 && Math.abs(side.along - 400) < 3);
  const leg2 = locateOnRoute({ lat: north(1000).lat, lon: east(300).lon }, pts, cum);
  assert.ok(Math.abs(leg2.along - 1300) < 5 && leg2.index === 1);
});

test("nextInstruction and formatting", () => {
  const ins = [{ offset: 0, message: "Leave" }, { offset: 250, message: "Turn right" }, { offset: 900, message: "Arrive" }];
  assert.equal(nextInstruction(ins, 100).message, "Turn right");
  assert.equal(Math.round(nextInstruction(ins, 100).toGo), 150);
  assert.equal(nextInstruction(ins, 250).message, "Arrive");
  assert.equal(nextInstruction(ins, 899), null);
  assert.equal(fmtDist(447), "450 m");
  assert.equal(fmtDist(2340), "2.3 km");
  assert.equal(sayDist(420), "400 metres");
  assert.equal(sayDist(2000), "2 kilometres");
  assert.equal(sayDist(20), "50 metres");
});

test("driveRecord: arrival, End near the destination, End early, mis-tap", () => {
  const base = { t0: 0, name: "X", predicted: 1200, noTraffic: 1100, metres: 20000, reroutes: 0 };
  const arrived = driveRecord({ ...base, now: 1300e3, leftM: 20, remainingS: 2, arrived: true });
  assert.equal(arrived.predicted_s, 1200); assert.equal(arrived.actual_s, 1300); assert.equal(arrived.ended_early, undefined);
  const nearEnd = driveRecord({ ...base, now: 1250e3, leftM: 250, remainingS: 30, arrived: false });
  assert.equal(nearEnd.predicted_s, 1200); assert.equal(nearEnd.ended_early, undefined);
  const early = driveRecord({ ...base, now: 700e3, leftM: 8000, remainingS: 480, arrived: false });
  assert.equal(early.ended_early, true); assert.equal(early.predicted_s, 720); assert.equal(early.left_m, 8000); assert.equal(early.full_predicted_s, 1200);
  assert.equal(driveRecord({ ...base, now: 20e3, leftM: 19900, remainingS: 1190, arrived: false }), null);
});

test("pointAt and lerpAngle", () => {
  const pts = [P, north(1000), { lat: north(1000).lat, lon: east(1000).lon }];
  const cum = cumulative(pts);
  const a = pointAt(pts, cum, 400);
  assert.ok(distance(a, north(400)) < 2 && angleDiff(a.bearing, 0) < 1);
  const b = pointAt(pts, cum, 1500);
  assert.ok(angleDiff(b.bearing, 90) < 1 && Math.abs(distance(b, north(1000)) - 500) < 3);
  assert.ok(distance(pointAt(pts, cum, 99999), pts[2]) < 1); // clamped to the end
  assert.ok(distance(pointAt(pts, cum, -5), P) < 1);
  assert.equal(lerpAngle(350, 10, 0.5), 0);
  assert.equal(lerpAngle(10, 350, 0.5), 0);
  assert.equal(lerpAngle(90, 180, 0.5), 135);
});

test("laneView: shows the next lane section only when near, marks usable lanes", () => {
  const secs = [
    { from: 1000, to: 1100, lanes: [{ directions: ["STRAIGHT"] }, { directions: ["STRAIGHT"], follow: "STRAIGHT" }, { directions: ["STRAIGHT", "SLIGHT_RIGHT"], follow: "SLIGHT_RIGHT" }] },
    { from: 5000, to: 5050, lanes: [{ directions: ["LEFT"], follow: "LEFT" }] },
  ];
  assert.equal(laneView(secs, 0), null); // 1 km away
  const v = laneView(secs, 400);
  assert.equal(Math.round(v.toGo), 600);
  assert.deepEqual(v.lanes, [{ arrow: "↑", use: false }, { arrow: "↑", use: true }, { arrow: "↗", use: true }]);
  assert.equal(laneView(secs, 1050).toGo, 0); // inside the section
  assert.equal(laneView(secs, 1200), null); // passed it, next one is far
  assert.equal(laneView(secs, 4500).lanes[0].arrow, "←");
  assert.equal(laneView(secs, 6000), null);
  assert.equal(laneView([], 10), null);
});

test("limitAt", () => {
  const limits = [{ from: 0, to: 500, kmh: 60 }, { from: 500, to: 2000, kmh: 120 }, { from: 2600, to: 3000, kmh: 80 }];
  assert.equal(limitAt(limits, 100), 60);
  assert.equal(limitAt(limits, 500), 120);
  assert.equal(limitAt(limits, 2300), null); // gap in the data
  assert.equal(limitAt(limits, 2999), 80);
  assert.equal(limitAt(limits, 9999), null);
});

test("parseLimit", () => {
  assert.equal(parseLimit("140.00KPH"), 140);
  assert.equal(parseLimit("40.00KPH"), 40);
  assert.equal(parseLimit("50.00MPH"), 80);
  assert.equal(parseLimit(undefined), null);
  assert.equal(parseLimit("fast"), null);
});

test("OverSpeed: chimes once on crossing, repeats while over, re-arms under the limit", () => {
  const o = new OverSpeed({ margin: 2, repeatMs: 15000 });
  assert.equal(o.check(120, 120, 0), false);
  assert.equal(o.check(122, 120, 1000), false); // inside the margin
  assert.equal(o.check(125, 120, 2000), true);
  assert.equal(o.check(130, 120, 5000), false); // still over, too soon
  assert.equal(o.check(130, 120, 18000), true); // repeat
  assert.equal(o.check(110, 120, 19000), false);
  assert.equal(o.check(125, 120, 20000), true); // re-armed
  assert.equal(o.check(200, null, 21000), false); // no limit known
});

test("tolls: Darb peak hours and the note", () => {
  const at = (iso) => new Date(iso); // local time
  assert.equal(darbPeak(at("2026-11-24T08:00:00")), true);   // Tuesday morning peak
  assert.equal(darbPeak(at("2026-11-24T12:00:00")), false);
  assert.equal(darbPeak(at("2026-11-24T15:00:00")), true);
  assert.equal(darbPeak(at("2026-11-24T19:00:00")), false);
  assert.equal(darbPeak(at("2026-11-29T08:00:00")), false);  // Sunday
  assert.equal(tollNote(0, at("2026-11-24T08:00:00")), "");
  assert.equal(tollNote(2, at("2026-11-24T08:00:00")), "2 toll gates · about AED 8 now");
  assert.equal(tollNote(1, at("2026-11-24T12:00:00")), "1 toll gate · bridge gates free now");
  assert.equal(clock(at("2026-11-24T07:05:00")), "07:05");
});

test("thin keeps both ends", () => {
  const a = Array.from({ length: 1000 }, (_, i) => i);
  const b = thin(a, 120);
  assert.equal(b.length, 120); assert.equal(b[0], 0); assert.equal(b.at(-1), 999);
  assert.deepEqual(thin([1, 2, 3], 120), [1, 2, 3]);
});

test("incidentsOnRoute: on the line, ahead only, no plain queues", () => {
  const pts = [P, north(5000)];
  const cum = cumulative(pts);
  const ll = (p) => [p.lon, p.lat];
  const inc = (cat, p, type = "Point") => ({ properties: { iconCategory: cat }, geometry: type === "Point" ? { type, coordinates: ll(p) } : { type, coordinates: [ll(p), ll(north(4900))] } });
  const got = incidentsOnRoute([
    inc(1, north(3000)), inc(9, north(1500), "LineString"), inc(6, north(2000)), // queue: skipped
    inc(8, { lat: north(2500).lat, lon: east(400).lon }),                        // 400 m to the side
    inc(1, north(200)),                                                          // already behind
  ], pts, cum, 500);
  assert.deepEqual(got.map((x) => x.text), ["Road works", "Accident"]);
  assert.ok(Math.abs(got[0].along - 1500) < 5);
});

test("turn symbols and then-turn", () => {
  assert.equal(turnIcon("TURN_LEFT"), "←");
  assert.equal(turnIcon("ROUNDABOUT_CROSS"), "⟳");
  assert.equal(turnIcon("TAKE_EXIT"), "↗");
  assert.equal(turnIcon("SOMETHING_NEW"), "↑");
  const ins = [{ offset: 100, message: "Turn right" }, { offset: 260, message: "Turn left" }, { offset: 2000, message: "Arrive" }];
  assert.equal(thenTurn(ins, ins[0]).message, "Turn left");   // 160 m apart
  assert.equal(thenTurn(ins, ins[1]), null);                   // next one is far
  assert.equal(thenTurn(ins, ins[2]), null);                   // nothing after
  const follow = [{ offset: 100, message: "Take the motorway" }, { offset: 150, message: "Follow E11", maneuver: "FOLLOW" }];
  assert.equal(thenTurn(follow, follow[0]), null);            // "then follow the road" is noise
});

const D = (o) => ({ start: "2026-11-23T08:00:00", to: "Uni", predicted_s: 1200, no_traffic_s: 1000, actual_s: 1320, metres: 24000, reroutes: 0, to_lat: 24.3655, to_lon: 54.5633, ...o });

test("tripStats: week totals, average error, traffic time; test drives and partial drives handled", () => {
  const now = new Date("2026-11-24T20:00:00");
  const s = tripStats([
    D({}), D({ start: "2026-11-24T08:00:00", actual_s: 1200 }),
    D({ start: "2026-10-01T08:00:00", actual_s: 1440 }),            // old: counts for error, not for the week
    D({ simulated: true, actual_s: 60 }),                           // ignored everywhere
    D({ start: "2026-11-24T17:00:00", ended_early: true, left_m: 4000, actual_s: 900 }), // in the week, not in the error
  ], now);
  assert.equal(s.drives, 4); assert.equal(s.weekDrives, 3);
  assert.equal(s.weekKm, 24 + 24 + 20); assert.equal(s.weekMin, 22 + 20 + 15);
  assert.equal(s.compared, 3); assert.equal(s.errorPct, 10);       // (+10% + 0% + 20%) / 3
  assert.equal(s.trafficMin, Math.round((320 + 200 + 440) / 60));
  assert.equal(tripStats([], now).errorPct, null);
});

test("personalFactor: own destination first, then all drives, else no correction", () => {
  assert.equal(personalFactor([], "Uni"), 1);
  assert.equal(personalFactor([D({})], "Uni"), 1);                                  // one drive is not a pattern
  assert.equal(personalFactor([D({}), D({ actual_s: 1440 })], "Uni"), 1.15);        // median of 1.10 and 1.20
  assert.equal(personalFactor([D({}), D({}), D({})], "Mall"), 1.1);                 // falls back to all drives
  assert.equal(personalFactor([D({ actual_s: 9999 }), D({ actual_s: 9999 })], "Uni"), 1.6); // capped
  assert.equal(personalFactor([D({ stops: 1 }), D({ stops: 1 })], "Uni"), 1);       // drives with a stop do not count
});

test("usualTrip: same kind of day and time, twice or more, not where the car already is", () => {
  const drives = [D({}), D({ start: "2026-11-20T08:20:00" }), D({ start: "2026-11-19T18:00:00", to: "Home", to_lat: 24.33, to_lon: 54.70 })];
  const tue8 = new Date("2026-11-24T08:10:00"), far = { lat: 24.33, lon: 54.70 };
  assert.equal(usualTrip(drives, tue8, far).name, "Uni");
  assert.equal(usualTrip(drives, tue8, far).times, 2);
  assert.equal(usualTrip(drives, new Date("2026-11-24T13:00:00"), far), null);           // wrong time of day
  assert.equal(usualTrip(drives, new Date("2026-11-28T08:10:00"), far), null);           // Saturday
  assert.equal(usualTrip(drives, tue8, { lat: 24.3655, lon: 54.5633 }), null);           // already there
  assert.equal(usualTrip([D({})], tue8, far), null);                                     // once is not usual
  assert.equal(usualTrip([D({ to_lat: undefined }), D({ to_lat: undefined })], tue8, far), null); // old records without a position
});

test("icsEvent builds a calendar entry with alerts", () => {
  const ics = icsEvent({ title: "Leave for Uni", start: new Date("2026-11-25T03:53:00Z") });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR") && ics.endsWith("END:VCALENDAR"));
  assert.ok(ics.includes("DTSTART:20261125T035300Z") && ics.includes("DTEND:20261125T035800Z"));
  assert.ok(ics.includes("SUMMARY:Leave for Uni") && ics.includes("TRIGGER:-PT10M") && ics.includes("TRIGGER:PT0M"));
  assert.ok(ics.includes("\r\n"));
});

test("isDaylight: Abu Dhabi sunrise and sunset, and the far north", () => {
  const AD = [24.45, 54.38];
  // 24 Nov: sunrise about 06:42, sunset about 17:33 local (UTC+4)
  const at = (iso) => new Date(iso + "+04:00");
  assert.equal(isDaylight(at("2026-11-24T06:20:00"), ...AD), false);
  assert.equal(isDaylight(at("2026-11-24T07:05:00"), ...AD), true);
  assert.equal(isDaylight(at("2026-11-24T12:00:00"), ...AD), true);
  assert.equal(isDaylight(at("2026-11-24T17:10:00"), ...AD), true);
  assert.equal(isDaylight(at("2026-11-24T17:55:00"), ...AD), false);
  assert.equal(isDaylight(at("2026-11-24T23:30:00"), ...AD), false);
  assert.equal(isDaylight(at("2026-11-24T02:00:00"), ...AD), false);
  // 21 Jun: sunrise about 05:34, sunset about 19:13 local
  assert.equal(isDaylight(at("2026-06-21T05:10:00"), ...AD), false);
  assert.equal(isDaylight(at("2026-06-21T06:00:00"), ...AD), true);
  assert.equal(isDaylight(at("2026-06-21T18:50:00"), ...AD), true);
  assert.equal(isDaylight(at("2026-06-21T19:40:00"), ...AD), false);
  // Tromso: midnight sun in June, polar night in December
  assert.equal(isDaylight(new Date("2026-06-21T00:00:00Z"), 69.65, 18.96), true);
  assert.equal(isDaylight(new Date("2026-12-21T11:00:00Z"), 69.65, 18.96), false);
});

test("limitFix: corrected limit only on the matching carriageway", () => {
  // two carriageways 30 m apart: eastbound (south line) fixed to 120, westbound (north line) fixed to 140
  const eastbound = [P, east(1000)].map((p) => [p.lat, p.lon]);
  const up = 30 / 111195;
  const westbound = [east(1000), P].map((p) => [p.lat + up, p.lon]);
  const fixes = prepFixes([{ kmh: 120, pts: eastbound }, { kmh: 140, pts: westbound }]);
  const mid = east(500);
  // on the eastbound line, 6 m off centre, heading east
  assert.equal(limitFix({ lat: mid.lat + 6 / 111195, lon: mid.lon }, 90, fixes), 120);
  // on the westbound line heading west
  assert.equal(limitFix({ lat: mid.lat + up, lon: mid.lon }, 270, fixes), 140);
  // GPS drifted halfway between the two: heading decides
  assert.equal(limitFix({ lat: mid.lat + 14 / 111195, lon: mid.lon }, 270, fixes), 140);
  assert.equal(limitFix({ lat: mid.lat + 16 / 111195, lon: mid.lon }, 90, fixes), 120);
  // heading unknown: the nearer line
  assert.equal(limitFix({ lat: mid.lat + 4 / 111195, lon: mid.lon }, null, fixes), 120);
  // a road crossing the corridor at right angles is not on it
  assert.equal(limitFix(mid, 0, fixes), null);
  // a parallel service road 80 m away, and a point past the end of the stretch
  assert.equal(limitFix({ lat: mid.lat - 80 / 111195, lon: mid.lon }, 90, fixes), null);
  assert.equal(limitFix(east(1400), 90, fixes), null);
  assert.equal(limitFix(mid, 90, []), null);
});

test("limitFix: a two-way road matches either heading", () => {
  const line = [P, east(1000)].map((p) => [p.lat, p.lon]);
  const mid = east(500);
  const oneWay = prepFixes([{ kmh: 80, pts: line }]);
  const twoWay = prepFixes([{ kmh: 80, pts: line, two: 1 }]);
  assert.equal(limitFix(mid, 270, oneWay), null);
  assert.equal(limitFix(mid, 270, twoWay), 80);
  assert.equal(limitFix(mid, 90, twoWay), 80);
  assert.equal(limitFix(mid, 0, twoWay), null);
});

test("pickLimit: lower of two close sources, TomTom when they are far apart", () => {
  assert.deepEqual(pickLimit(null, null), { kmh: null, unsure: false });
  assert.deepEqual(pickLimit(120, null), { kmh: 120, unsure: false });
  assert.deepEqual(pickLimit(null, 100), { kmh: 100, unsure: false });
  assert.deepEqual(pickLimit(120, 120), { kmh: 120, unsure: false });
  assert.deepEqual(pickLimit(140, 120), { kmh: 120, unsure: true }); // E22: the limit was cut, TomTom lagged
  assert.deepEqual(pickLimit(100, 120), { kmh: 100, unsure: true }); // E20: the limit was cut, OpenStreetMap lagged
  // 60+ apart: two different roads. On a route TomTom's number is the route's own; off a route it only guessed the nearest road.
  assert.deepEqual(pickLimit(40, 120), { kmh: 120, unsure: true });
  assert.deepEqual(pickLimit(40, 120, true), { kmh: 40, unsure: true });
  assert.deepEqual(pickLimit(140, 60, true), { kmh: 140, unsure: true });
});

test("nearestFix: a minor road matches only close by, and a sign-read number is flagged", async () => {
  const { nearestFix } = await import("../geo.js");
  const line = [[24.4, 54.5], [24.4, 54.51]];
  const fixes = prepFixes([{ kmh: 40, pts: line, two: 1, m: 1, s: 1 }, { kmh: 80, pts: line.map(([la, lo]) => [la + 40 / 111195, lo]) }]);
  const at = (m) => ({ lat: 24.4 + m / 111195, lon: 54.505 });
  assert.deepEqual({ ...nearestFix(at(5), 90, fixes), off: 0 }, { off: 0, kmh: 40, sign: true });
  assert.equal(limitFix(at(18), 90, fixes), 80); // 18 m from the side street, 22 m from the main road: side street is out of reach
  assert.equal(nearestFix(at(18), 90, fixes).sign, false);
  assert.equal(limitFix(at(-14), 90, fixes), null);
});

test("nearestFix: the nearest road having no known limit means no answer, not the neighbour's limit", async () => {
  const { nearestFix } = await import("../geo.js");
  const main = [[24.4, 54.5], [24.4, 54.51]];
  const ramp = main.map(([la, lo]) => [la + 15 / 111195, lo]);
  const fixes = prepFixes([{ kmh: 140, pts: main }, { pts: ramp }]);
  const at = (m) => ({ lat: 24.4 + m / 111195, lon: 54.505 });
  assert.equal(limitFix(at(2), 90, fixes), 140);
  assert.equal(nearestFix(at(13), 90, fixes), null); // on the ramp, 13 m from the motorway line
  assert.equal(limitFix(at(13), 90, prepFixes([{ kmh: 140, pts: main }])), 140); // without the ramp piece it would borrow 140
});
