import test from "node:test";
import assert from "node:assert/strict";
import { parseColor, toCss, mapColors, sunsetStyle, sunsetDayStyle, smoothStyle, scaleWidth } from "../colors.js";

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

test("sunsetStyle: flat ground, roads ranked by brightness, clutter and road edges hidden, traffic untouched", () => {
  const style = { layers: [
    { id: "bg", type: "background", paint: { "background-color": "#20262e" } },
    { id: "Water - Fill", type: "fill", source: "vectorTiles", paint: { "fill-color": "#101820" } },
    { id: "Surface - Motorway & Trunk", type: "line", source: "vectorTiles", paint: { "line-color": "hsl(210, 16%, 6%)", "line-width": 3 } },
    { id: "Surface - Street", type: "line", source: "vectorTiles", paint: { "line-color": "hsl(212, 22%, 14%)", "line-width": ["interpolate", ["exponential", 1.3], ["zoom"], 9, 1, 19, ["match", ["get", "subcategory"], ["local"], 20, 16]] } },
    { id: "Surface - Street outline", type: "line", source: "vectorTiles", paint: { "line-color": "#555" } },
    { id: "TransitLabels - Road", type: "symbol", source: "vectorTiles", paint: { "text-color": "#cccccc", "text-halo-color": "#000" } },
    { id: "POI", type: "symbol", source: "vectorTiles", paint: { "text-color": "#fff" } },
    { id: "Traffic - Free flow outline", type: "line", source: "vectorTilesFlow", paint: { "line-color": "#00aa00" } },
    { id: "no paint", type: "fill", source: "vectorTiles" },
  ] };
  const out = sunsetStyle(style).layers;
  assert.ok(near(parseColor(out[0].paint["background-color"]).h, 265));
  assert.ok(parseColor(out[1].paint["fill-color"]).l < parseColor(out[0].paint["background-color"]).l); // water darker than land
  const big = parseColor(out[2].paint["line-color"]), small = parseColor(out[3].paint["line-color"]);
  assert.ok(big.l > small.l + 25 && small.l > 20);                 // main road bright, side street quiet but visible
  assert.equal(out[2].paint["line-width"], 3.6);                    // a little wider
  assert.deepEqual(out[3].paint["line-width"], ["interpolate", ["exponential", 1.3], ["zoom"], 9, 1.2, 19, ["match", ["get", "subcategory"], ["local"], 24, 19.2]]);
  assert.equal(out[4].layout.visibility, "none");                   // no drawn road edges
  assert.ok(parseColor(out[5].paint["text-color"]).l >= 78);
  assert.equal(out[6].layout.visibility, "none");                   // no shop icons
  assert.equal(out[7].paint["line-color"], "#00aa00");              // traffic keeps its meaning
  assert.equal(out[7].layout, undefined);
});

test("sunsetDayStyle: light, warm, main roads stand out, traffic untouched", () => {
  const style = { layers: [
    { id: "bg", type: "background", paint: { "background-color": "#f2f2f2" } },
    { id: "Water - Fill", type: "fill", source: "vectorTiles", paint: { "fill-color": "#a0c8f0" } },
    { id: "Surface - Primary road", type: "line", source: "vectorTiles", paint: { "line-color": "hsl(215, 15%, 62%)" } },
    { id: "Surface - Street", type: "line", source: "vectorTiles", paint: { "line-color": "hsl(215, 15%, 80%)" } },
    { id: "TransitLabels - Road", type: "symbol", source: "vectorTiles", paint: { "text-color": "#555555", "text-halo-color": "#fff" } },
    { id: "Traffic - Slow flow", type: "line", source: "vectorTilesFlow", paint: { "line-color": "#00aa00" } },
  ] };
  const out = sunsetDayStyle(style).layers;
  const ground = parseColor(out[0].paint["background-color"]);
  assert.ok(ground.l >= 86);                                                   // stays a bright map
  assert.ok(near(parseColor(out[1].paint["fill-color"]).h, 186));
  const big = parseColor(out[2].paint["line-color"]), small = parseColor(out[3].paint["line-color"]);
  assert.ok(big.l <= 78 && big.s >= 60);                                       // main road: coral, clear against cream
  assert.ok(small.l > ground.l + 4);                                           // side street: white on cream
  assert.ok(parseColor(out[4].paint["text-color"]).l <= 28);                   // dark text
  assert.equal(out[5].paint["line-color"], "#00aa00");
});

test("smoothStyle without flat: hides clutter only, keeps road edges and widths", () => {
  const style = { layers: [
    { id: "POI", type: "symbol", source: "vectorTiles" },
    { id: "Surface - Railway fill", type: "line", source: "vectorTiles", paint: { "line-width": 2 } },
    { id: "Surface - Street outline", type: "line", source: "vectorTiles", paint: { "line-width": 2 } },
    { id: "Places - Town", type: "symbol", source: "vectorTiles" },
    { id: "TrafficIncidents - Minor jam marker", type: "symbol", source: "vectorTilesIncidents" },
  ] };
  const out = smoothStyle(style).layers;
  assert.deepEqual(out.map((l) => l.layout?.visibility ?? "shown"), ["none", "none", "shown", "shown", "shown"]);
  assert.equal(out[2].paint["line-width"], 2);
  assert.deepEqual(scaleWidth({ stops: [[0, 1], [16, 2]] }, 2), { stops: [[0, 2], [16, 4]] });
});
