import test from "node:test";
import assert from "node:assert/strict";
import { distance, bearing, angleDiff, cameraAhead, CameraAlerts, cumulative, locateOnRoute, nextInstruction, fmtDist, sayDist, driveRecord, pointAt, lerpAngle } from "../geo.js";

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
