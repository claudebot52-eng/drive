import test from "node:test";
import assert from "node:assert/strict";
import { parseColor, toCss, mapColors, sunsetStyle, sunsetDayStyle } from "../colors.js";

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

test("parseColor: hex, rgb, hsl, and non-colours", () => {
  const red = parseColor("#ff0000");
  assert.ok(near(red.h, 0) && near(red.s, 100) && near(red.l, 50) && red.a === 1);
  const short = parseColor("#0f0");
  assert.ok(near(short.h, 120) && near(short.l, 50));
  const blue = parseColor("rgba(0, 0, 255, 0.5)");
  assert.ok(near(blue.h, 240) && blue.a === 0.5);
  assert.deepEqual(parseColor("hsl(160, 43%, 24%)"), { h: 160, s: 43, l: 24, a: 1 });
  assert.equal(parseColor("hsla(10, 20%, 30%, 0.4)").a, 0.4);
  const grey = parseColor("#808080");
  assert.ok(near(grey.s, 0) && near(grey.l, 50));
  for (const x of ["Noto-Bold", "{name}", "interpolate", "", 12, null]) assert.equal(parseColor(x), null);
});

test("mapColors walks stops and expressions, leaves everything else alone", () => {
  const pink = (c) => ({ ...c, h: 320 });
  assert.equal(mapColors("#ff0000", pink), "hsla(320, 100%, 50%, 1)");
  const stops = { base: 1, stops: [[10, "#000000"], [15, "hsl(200, 50%, 40%)"]] };
  const out = mapColors(stops, pink);
  assert.equal(out.base, 1);
  assert.equal(out.stops[1][0], 15);
  assert.equal(out.stops[1][1], "hsla(320, 50%, 40%, 1)");
  assert.deepEqual(mapColors(["interpolate", ["linear"], ["zoom"], 5, "#00f"], pink).slice(0, 4), ["interpolate", ["linear"], ["zoom"], 5]);
  assert.equal(toCss({ h: 1.4, s: 2.6, l: 3, a: 0.25 }), "hsla(1, 3%, 3%, 0.25)");
});

test("sunsetStyle repaints the base map only", () => {
  const style = { layers: [
    { id: "bg", type: "background", paint: { "background-color": "#20262e" } },
    { id: "Water", type: "fill", source: "vectorTiles", paint: { "fill-color": "#101820" } },
    { id: "Major road", type: "line", source: "vectorTiles", paint: { "line-color": "#454d57", "line-width": 3 } },
    { id: "Road label", type: "symbol", source: "vectorTiles", paint: { "text-color": "#cccccc", "text-halo-color": "#000" } },
    { id: "Traffic flow", type: "line", source: "vectorTilesFlow", paint: { "line-color": "#00aa00" } },
    { id: "no paint", type: "fill", source: "vectorTiles" },
  ] };
  const out = sunsetStyle(style).layers;
  assert.ok(near(parseColor(out[0].paint["background-color"]).h, 268));
  assert.ok(near(parseColor(out[1].paint["fill-color"]).h, 186));
  assert.ok(near(parseColor(out[2].paint["line-color"]).h, 322));
  assert.equal(out[2].paint["line-width"], 3);
  assert.ok(parseColor(out[3].paint["text-color"]).l >= 78);
  assert.equal(out[4].paint["line-color"], "#00aa00"); // traffic keeps its meaning
});

test("sunsetDayStyle: light, warm, traffic untouched", () => {
  const style = { layers: [
    { id: "bg", type: "background", paint: { "background-color": "#f2f2f2" } },
    { id: "Water", type: "fill", source: "vectorTiles", paint: { "fill-color": "#a0c8f0" } },
    { id: "Major road", type: "line", source: "vectorTiles", paint: { "line-color": "#ffffff" } },
    { id: "Road label", type: "symbol", source: "vectorTiles", paint: { "text-color": "#555555", "text-halo-color": "#fff" } },
    { id: "Traffic flow", type: "line", source: "vectorTilesFlow", paint: { "line-color": "#00aa00" } },
  ] };
  const out = sunsetDayStyle(style).layers;
  assert.ok(parseColor(out[0].paint["background-color"]).l >= 86);            // stays a bright map
  assert.ok(near(parseColor(out[1].paint["fill-color"]).h, 184));
  const road = parseColor(out[2].paint["line-color"]);
  assert.ok(near(road.h, 345) && road.l <= 74);                               // visible against the light ground
  assert.ok(parseColor(out[3].paint["text-color"]).l <= 26);                  // dark text
  assert.equal(out[4].paint["line-color"], "#00aa00");
});
