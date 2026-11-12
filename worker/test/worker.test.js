import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { _internal } from "../src/index.js";

const ORIGIN = "https://twarr58.github.io";
const KEY = "secret-key-123";
let calls = [];
let upstreamStatus = 200;

const feed = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", geometry: { type: "Point", coordinates: [14.42, 50.08] }, properties: { route_type: "tram", vehicle_id: "a" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [14.9, 50.5] }, properties: { route_type: "bus", vehicle_id: "b" } },
  ],
};

beforeEach(() => {
  calls = [];
  upstreamStatus = 200;
  _internal.cache.clear();
  _internal.resetCooldown();
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), key: init?.headers?.["X-Access-Token"] });
    if (upstreamStatus !== 200) return new Response(`{"error":"nope","key":"${KEY}"}`, { status: upstreamStatus });
    const u = new URL(url);
    if (u.pathname === "/v2/public/vehiclepositions") return Response.json(feed);
    if (u.pathname.startsWith("/v2/gtfs/trips/")) return Response.json({ trip_id: "x", stop_times: [{ stop_sequence: 1, stop_id: "U1Z1P", trip_id: "x", pickup_type: "0", drop_off_type: "3" }] });
    return Response.json({ ok: true, path: u.pathname, search: u.search });
  };
});

const env = { GOLEMIO_API_KEY: KEY, ALLOWED_ORIGINS: `${ORIGIN},http://localhost:8000` };
const req = (path, { origin = ORIGIN, method = "GET" } = {}) =>
  worker.fetch(new Request(`https://emhadecko.example.workers.dev${path}`, { method, headers: origin ? { Origin: origin } : {} }), env);

test("klíč se pošle jen na Golemio a nikdy se nevrátí klientovi", async () => {
  const res = await req("/v2/public/vehiclepositions");
  assert.equal(res.status, 200);
  assert.equal(calls[0].key, KEY);
  assert.ok(calls[0].url.startsWith("https://api.golemio.cz/"));
  const text = await res.text();
  assert.ok(!text.includes(KEY));
  for (const [, v] of res.headers) assert.ok(!v.includes(KEY));
});

test("chyba z Golemia nepropustí jeho tělo (ani klíč v něm)", async () => {
  upstreamStatus = 401;
  const res = await req("/v2/public/vehiclepositions");
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes(KEY));
});

test("cizí nebo chybějící Origin → 403, bez dotazu na Golemio", async () => {
  assert.equal((await req("/v2/public/vehiclepositions", { origin: "https://evil.example" })).status, 403);
  assert.equal((await req("/v2/public/vehiclepositions", { origin: null })).status, 403);
  assert.equal(calls.length, 0);
});

test("CORS preflight a hlavičky", async () => {
  const pre = await req("/v2/public/vehiclepositions", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const res = await req("/v2/public/vehiclepositions");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});

test("jen allowlist endpointů a jen GET", async () => {
  assert.equal((await req("/v2/gtfs/stops")).status, 404);
  assert.equal((await req("/v2/vehiclepositions")).status, 404);
  assert.equal((await req("/v2/public/vehiclepositions", { method: "POST" })).status, 405);
  assert.equal(calls.length, 0);
});

test("polohy: jeden dotaz na Golemio pro všechny klienty, výřez filtruje Worker", async () => {
  const a = await (await req("/v2/public/vehiclepositions?boundingBox=50.15,14.3,50.0,14.6")).json();
  const b = await (await req("/v2/public/vehiclepositions?boundingBox=51.0,14.0,49.9,15.5")).json();
  const c = await (await req("/v2/public/vehiclepositions?routeType=bus")).json();
  assert.deepEqual(a.features.map((f) => f.properties.vehicle_id), ["a"]);
  assert.deepEqual(b.features.map((f) => f.properties.vehicle_id), ["a", "b"]);
  assert.deepEqual(c.features.map((f) => f.properties.vehicle_id), ["b"]);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).search, "", "Golemio dostane dotaz na celý feed bez parametrů klienta");
});

test("validace parametrů", async () => {
  for (const q of [
    "/v2/public/vehiclepositions?boundingBox=1,2,3",
    "/v2/public/vehiclepositions?boundingBox=60,14,59,15",
    "/v2/public/vehiclepositions?routeType=rocket",
    "/v2/public/vehiclepositions/abc?scopes=everything",
    "/v2/public/vehiclepositions/abc",
    "/v2/public/vehiclepositions/..%2Fgtfs?scopes=info",
    "/v2/gtfs/trips/x",
    "/v2/public/departureboards?stopIds[]=notjson",
    '/v2/public/departureboards?stopIds[]={"0":["U1Z1P"]}&limit=500',
  ]) {
    assert.equal((await req(q)).status, 400, q);
  }
  assert.equal(calls.length, 0);
});

test("detail vozidla, zastávky spoje a odjezdy projdou s povolenými parametry", async () => {
  let r = await req("/v2/public/vehiclepositions/service-0-9273?scopes=info&scopes=stop_times&scopes=vehicle_descriptor");
  assert.equal(r.status, 200);
  r = await req("/v2/gtfs/trips/22_1_261106?includeStopTimes=true");
  assert.deepEqual(await r.json(), { stop_times: [{ stop_sequence: 1, stop_id: "U1Z1P", pickup_type: "0", drop_off_type: "3" }] });
  r = await req(`/v2/public/departureboards?stopIds[]=${encodeURIComponent('{"0":["U1Z1P"]}')}&limit=12&minutesAfter=90`);
  assert.equal(r.status, 200);
  assert.equal(calls.length, 3);
});

test("rate limit podle IP", async () => {
  let n = 0;
  const limited = { ...env, LIMITER: { limit: async () => ({ success: ++n <= 2 }) } };
  const call = () => worker.fetch(new Request("https://w.example/v2/public/vehiclepositions", { headers: { Origin: ORIGIN, "CF-Connecting-IP": "1.2.3.4" } }), limited);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 429);
});

test("bez nastaveného klíče vrátí 500, ne požadavek bez klíče", async () => {
  const r = await worker.fetch(new Request("https://w.example/v2/public/vehiclepositions", { headers: { Origin: ORIGIN } }), { ALLOWED_ORIGINS: ORIGIN });
  assert.equal(r.status, 500);
  assert.equal(calls.length, 0);
});

test("přestupní tablo: povolené parametry projdou, ostatní 400", async () => {
  let r = await req("/v4/pid/transferboards?aswId=1330_1&vehicleRegistrationNumber=8544&routeType=0&timeFrom=2026-11-06T23:10:00&limit=12");
  assert.equal(r.status, 200);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/v4/pid/transferboards");
  assert.equal(u.searchParams.get("timeFrom"), "2026-11-06T23:10:00");
  for (const q of [
    "/v4/pid/transferboards?aswId=abc&vehicleRegistrationNumber=1&routeType=0",
    "/v4/pid/transferboards?aswId=1330&routeType=0",
    "/v4/pid/transferboards?aswId=1330&vehicleRegistrationNumber=1&tripNumber=2&routeType=0",
    "/v4/pid/transferboards?aswId=1330&vehicleRegistrationNumber=1&routeType=5",
    "/v4/pid/transferboards?aswId=1330&vehicleRegistrationNumber=1&routeType=0&timeFrom=tomorrow",
    "/v4/pid/transferboards?aswId=1330&vehicleRegistrationNumber=1&routeType=0&limit=99",
  ]) assert.equal((await req(q)).status, 400, q);
  assert.equal(calls.length, 1);
});

test("trasa spoje: podle trip_id, jen scopes=shapes, dlouhá cache", async () => {
  let r = await req("/v2/public/gtfs/trips/331_926_260627?scopes=shapes");
  assert.equal(r.status, 200);
  assert.equal(new URL(calls[0].url).pathname, "/v2/public/gtfs/trips/331_926_260627");
  r = await req("/v2/public/gtfs/trips/331_926_260627?scopes=shapes");
  assert.equal(calls.length, 1, "druhý dotaz jde z cache");
  assert.equal((await req("/v2/public/gtfs/trips/331_926_260627?scopes=vehicle_descriptor")).status, 400);
  assert.equal((await req("/v2/public/gtfs/trips/331_926_260627")).status, 400);
  assert.equal((await req("/v2/public/gtfs/trips/331_926_260627?scopes=stop_times&scopes=shapes&scopes=info")).status, 200);
});

test("detail vozidla se necachuje dlouho ani pro samotnou trasu (vozidlo mění spoje)", async () => {
  await req("/v2/public/vehiclepositions/service-0-1?scopes=shapes");
  _internal.cache.forEach((v) => { v.exp = Date.now() - 1; }); // simulace uplynutí 5 s
  await req("/v2/public/vehiclepositions/service-0-1?scopes=shapes");
  assert.equal(calls.length, 2);
});

test("429 od Golemia: poslední platná data, pauza na Golemio, označení zdroje", async () => {
  // 1) úspěšné načtení poloh
  let r = await req("/v2/public/vehiclepositions");
  assert.equal(r.status, 200);
  // 2) cache vyprší, Golemio vrací 429 → dostaneme poslední platná data (ne chybu)
  _internal.cache.forEach((v) => { v.exp = Date.now() - 1; });
  upstreamStatus = 429;
  r = await req("/v2/public/vehiclepositions");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).features.length, 2);
  // 3) během pauzy se na Golemio nevolá; endpoint bez starých dat vrátí 429 se zdrojem "upstream"
  const before = calls.length;
  r = await req("/v2/public/gtfs/trips/1_2_3?scopes=shapes");
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("X-Limit-Source"), "upstream");
  assert.ok(Number(r.headers.get("Retry-After")) >= 1);
  assert.match(r.headers.get("Access-Control-Expose-Headers"), /X-Limit-Source/);
  assert.equal(calls.length, before, "v pauze žádný dotaz na Golemio");
});

test("rate limit Workeru je označený jako zdroj worker", async () => {
  const limited = { ...env, LIMITER: { limit: async () => ({ success: false }) } };
  const r = await worker.fetch(new Request("https://w.example/v2/public/vehiclepositions", { headers: { Origin: ORIGIN } }), limited);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("X-Limit-Source"), "worker");
});

test("odjezdy a příjezdy uzlu: povolené parametry projdou, ostatní 400, Worker doplní časové pásmo", async () => {
  const r = await req("/v2/pid/departureboards?aswIds[]=458_101&aswIds[]=458&mode=arrivals&limit=20&minutesAfter=90");
  assert.equal(r.status, 200);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/v2/pid/departureboards");
  assert.deepEqual(u.searchParams.getAll("aswIds[]"), ["458", "458_101"]);
  assert.equal(u.searchParams.get("mode"), "arrivals");
  assert.equal(u.searchParams.get("preferredTimezone"), "Europe_Prague");
  for (const q of [
    "/v2/pid/departureboards",
    "/v2/pid/departureboards?aswIds[]=abc",
    "/v2/pid/departureboards?aswIds[]=1&aswIds[]=2&aswIds[]=3&aswIds[]=4&aswIds[]=5",
    "/v2/pid/departureboards?aswIds[]=458&mode=mixed",
    "/v2/pid/departureboards?aswIds[]=458&limit=500",
    "/v2/pid/departureboards?ids[]=U458Z101P",
  ]) assert.equal((await req(q)).status, 400, q);
  assert.equal(calls.length, 1);
});

test("po 429 se čekající požadavek neodešle na Golemio", async () => {
  const pending = [];
  globalThis.fetch = () => new Promise((resolve) => pending.push(resolve));
  const requests = Array.from({ length: 5 }, (_, i) =>
    req(`/v2/public/vehiclepositions/queued-${i}?scopes=info`));
  assert.equal(pending.length, 4);
  pending[0](new Response(null, { status: 429 }));
  for (const resolve of pending.slice(1)) resolve(Response.json({ ok: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 4);
  const responses = await Promise.all(requests);
  assert.equal(responses[0].status, 429);
  assert.equal(responses[4].status, 429);
  assert.equal(responses[4].headers.get("X-Limit-Source"), "upstream");
});
