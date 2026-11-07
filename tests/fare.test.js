const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { computeFare, parseZones } = require("../web/fare.js");
const tariff = require(path.join(__dirname, "../web/tariff.json"));

const trip = (...zoneIds) => zoneIds.map((z) => ({ zones: parseZones(z) }));

test("cesta jen po Praze: 30 a 90minutová jízdenka", () => {
  let r = computeFare(trip("P", "P", "0"), 15, tariff);
  assert.equal(r.kind, "prague");
  assert.equal(r.ticket.name, "Praha 30 min");
  assert.equal(r.ticket.full.app, 36);
  r = computeFare(trip("P", "B"), 40, tariff);
  assert.equal(r.ticket.name, "Praha 90 min");
  assert.equal(r.ticket.full.paper, 50);
});

test("pásmo 1 → centrum Prahy = 4 pásma (P, 0, B, 1), jak uvádí tarif 2026", () => {
  const r = computeFare(trip("1", "B", "0", "P"), 35, tariff);
  assert.equal(r.kind, "region");
  assert.deepEqual(r.zones, ["P", "0", "B", "1"]);
  assert.equal(r.count, 4);
  assert.equal(r.ticket.zones, 4);
  assert.equal(r.ticket.full.app, 48);
});

test("dlouhá jízda vyžaduje jízdenku s delší platností i za cenu víc pásem", () => {
  // 3 pásma platí 30 min; jízda 40 min (+ rezerva) → 4 pásma / 60 min
  const r = computeFare(trip("2", "3", "4"), 40, tariff);
  assert.equal(r.count, 3);
  assert.equal(r.ticket.zones, 4);
  assert.equal(r.ticket.minutes, 60);
});

test("hraniční zastávka se započítá výhodněji", () => {
  // zastávka "2,3" na cestě z pásma 2: stačí 1 pásmo… ale nejmenší jízdenka je 2 pásma
  let r = computeFare(trip("2", "2,3"), 8, tariff);
  assert.deepEqual(r.zones, ["2"]);
  assert.equal(r.ticket.zones, 2);
  // 1 → "1,2" → 3: rozsah 1–3, ne víc
  r = computeFare(trip("1", "1,2", "3"), 20, tariff);
  assert.deepEqual(r.zones, ["1", "2", "3"]);
});

test("2pásmová jízdenka neplatí v P, 0, B", () => {
  const r = computeFare(trip("B", "1"), 10, tariff);
  assert.deepEqual(r.zones, ["B", "1"]);
  assert.equal(r.ticket.zones, 3, "B+1 nesmí dostat 2pásmovou jízdenku");
});

test("nad 180 minut jednotlivá jízdenka nestačí, neznámé pásmo je chyba", () => {
  assert.match(computeFare(trip("1", "5"), 200, tariff).error, /180/);
  assert.match(computeFare(trip("1", ""), 10, tariff).error, /pásmo/);
});

test("tarif: ceny rostou s počtem pásem a platnost je nejvýš 180 min", () => {
  const t = tariff.region.tickets;
  for (let i = 1; i < t.length; i++) {
    assert.ok(t[i].full.app > t[i - 1].full.app);
    assert.ok(t[i].minutes >= t[i - 1].minutes && t[i].minutes <= 180);
  }
});
