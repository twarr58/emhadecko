/**
 * emhadecko — Cloudflare Worker, který drží Golemio API klíč mimo prohlížeč.
 *
 * Vrstvy ochrany:
 *  1. klíč je jen v secretu GOLEMIO_API_KEY, nikdy se nevrací ani neloguje
 *  2. allowlist: jen GET a jen endpointy, které stránka používá, s validací parametrů
 *     (polohy, detail vozidla, trasa a zastávky spoje, odjezdy, přestupní tablo)
 *  3. CORS + kontrola Origin: odpovídá jen povoleným originům (ALLOWED_ORIGINS)
 *  4. cache: polohy se z Golemia stahují max. 1× za POSITIONS_TTL pro všechny klienty
 *     a výřez mapy se filtruje tady → zneužití nevyčerpá limit klíče
 *  5. rate limit podle IP (binding LIMITER, pokud je nastavený)
 *  6. strop nákladů řeší free tarif Cloudflare (100k požadavků/den, pak stop, žádné poplatky)
 */

const UPSTREAM = "https://api.golemio.cz";
const POSITIONS_TTL = 5_000; // ms
const CACHE_MAX_ENTRIES = 300;
const UPSTREAM_TIMEOUT = 10_000;

const SCOPES = new Set(["info", "stop_times", "shapes", "vehicle_descriptor"]);
const ROUTE_TYPES = new Set(["tram", "metro", "train", "bus", "ferry", "funicular", "trolleybus"]);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ---------- cache v paměti isolate (Cache API na workers.dev nefunguje) ----------
// Ukládáme promise, takže souběžné požadavky na stejná data sdílí jeden dotaz na Golemio.
const cache = new Map();

function cached(key, ttl, load) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return hit.value;
  const value = load().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, { exp: now + ttl, value });
  if (cache.size > CACHE_MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.exp <= now) cache.delete(k);
    // pořád moc? smaž nejstarší (Map drží pořadí vložení)
    for (const k of cache.keys()) { if (cache.size <= CACHE_MAX_ENTRIES) break; cache.delete(k); }
  }
  return value;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function upstream(env, path, params = []) {
  if (!env.GOLEMIO_API_KEY) throw new HttpError(500, "worker is not configured");
  const url = new URL(path, UPSTREAM);
  for (const [k, v] of params) url.searchParams.append(k, v);
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Access-Token": env.GOLEMIO_API_KEY },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
  });
  if (!res.ok) {
    // chyby z Golemia nepřeposíláme doslova (nic citlivého v nich nemá být, ale jistota je jistota)
    throw new HttpError(res.status === 429 ? 429 : res.status === 404 ? 404 : 502, `upstream ${res.status}`);
  }
  return res.json();
}

// ---------- validace ----------
function parseBBox(s) {
  if (s == null) return null;
  const v = s.split(",").map(Number);
  if (v.length !== 4 || v.some((n) => !Number.isFinite(n))) throw new HttpError(400, "invalid boundingBox");
  const [north, west, south, east] = v;
  if (north < south || east < west || north > 52 || south < 48 || west < 11 || east > 20) throw new HttpError(400, "boundingBox out of range");
  return { north, west, south, east };
}

function intParam(q, name, def, min, max) {
  const raw = q.get(name);
  if (raw == null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `invalid ${name}`);
  return n;
}

// ---------- endpointy ----------
async function vehiclePositions(env, q) {
  const bbox = parseBBox(q.get("boundingBox"));
  const types = q.getAll("routeType");
  if (types.some((t) => !ROUTE_TYPES.has(t))) throw new HttpError(400, "invalid routeType");
  const all = await cached("positions", POSITIONS_TTL, () => upstream(env, "/v2/public/vehiclepositions"));
  const features = (all.features || []).filter((f) => {
    const c = f?.geometry?.type === "Point" ? f.geometry.coordinates : null;
    if (bbox && (!c || c[1] > bbox.north || c[1] < bbox.south || c[0] < bbox.west || c[0] > bbox.east)) return false;
    if (types.length && !types.includes(f?.properties?.route_type)) return false;
    return true;
  });
  return { body: { type: "FeatureCollection", features }, maxAge: 5 };
}

async function vehicleDetail(env, q, vehicleId) {
  if (!ID_RE.test(vehicleId)) throw new HttpError(400, "invalid vehicle id");
  const scopes = [...new Set(q.getAll("scopes"))].sort();
  if (!scopes.length || scopes.some((s) => !SCOPES.has(s))) throw new HttpError(400, "invalid scopes");
  // vše vázané na vozidlo je realtime: vozidlo během dne přejíždí mezi spoji,
  // takže ani trasu nejde cachovat déle (trasu spoje stránka bere z tripShape)
  const body = await cached(`veh:${vehicleId}:${scopes}`, 5_000,
    () => upstream(env, `/v2/public/vehiclepositions/${encodeURIComponent(vehicleId)}`, scopes.map((s) => ["scopes", s])));
  return { body, maxAge: 5 };
}

// trasa spoje podle trip_id: statická data jízdního řádu, dají se cachovat dlouho
async function tripShape(env, q, tripId) {
  if (!ID_RE.test(tripId)) throw new HttpError(400, "invalid trip id");
  const scopes = q.getAll("scopes");
  if (scopes.length !== 1 || scopes[0] !== "shapes") throw new HttpError(400, "only scopes=shapes is supported");
  const body = await cached(`tripshape:${tripId}`, 6 * 3_600_000,
    () => upstream(env, `/v2/public/gtfs/trips/${encodeURIComponent(tripId)}`, [["scopes", "shapes"]]));
  return { body, maxAge: 3600 };
}

async function tripStops(env, q, tripId) {
  if (!ID_RE.test(tripId)) throw new HttpError(400, "invalid trip id");
  if (q.get("includeStopTimes") !== "true") throw new HttpError(400, "only includeStopTimes=true is supported");
  const body = await cached(`trip:${tripId}`, 6 * 3_600_000, async () => {
    const d = await upstream(env, `/v2/gtfs/trips/${encodeURIComponent(tripId)}`, [["includeStopTimes", "true"]]);
    // stránka potřebuje pořadí, ID zastávky a typ nástupu/výstupu (3 = na znamení)
    return {
      stop_times: (d?.stop_times || []).map((st) => ({
        stop_sequence: st.stop_sequence, stop_id: st.stop_id, pickup_type: st.pickup_type, drop_off_type: st.drop_off_type,
      })),
    };
  });
  return { body, maxAge: 3600 };
}

async function departures(env, q) {
  const groups = q.getAll("stopIds[]");
  if (groups.length !== 1) throw new HttpError(400, "exactly one stopIds[] group is supported");
  let ids;
  try { ids = Object.values(JSON.parse(groups[0])).flat(); } catch { throw new HttpError(400, "invalid stopIds[]"); }
  if (!ids.length || ids.length > 4 || ids.some((id) => typeof id !== "string" || !ID_RE.test(id))) throw new HttpError(400, "invalid stopIds[]");
  const limit = intParam(q, "limit", 10, 1, 20);
  const minutesAfter = intParam(q, "minutesAfter", 60, 1, 120);
  const group = JSON.stringify({ 0: ids });
  const body = await cached(`dep:${group}:${limit}:${minutesAfter}`, 10_000, () =>
    upstream(env, "/v2/public/departureboards", [["stopIds[]", group], ["limit", String(limit)], ["minutesAfter", String(minutesAfter)]]));
  return { body, maxAge: 10 };
}

// přestupní tablo PID (stejné jako ve vozidlech): odjezdy z uzlu bez vlastního vozidla
const TB_ROUTE_TYPES = new Set(["0", "1", "2", "3", "4", "7", "11"]);
async function transferBoards(env, q) {
  const aswId = q.get("aswId") || "";
  if (!/^\d{1,5}(_\d{1,4})?$/.test(aswId)) throw new HttpError(400, "invalid aswId");
  const reg = q.get("vehicleRegistrationNumber");
  const tripNumber = q.get("tripNumber");
  if (!!reg === !!tripNumber) throw new HttpError(400, "exactly one of vehicleRegistrationNumber or tripNumber");
  if (reg && !/^[0-9A-Za-z]{1,20}$/.test(reg)) throw new HttpError(400, "invalid vehicleRegistrationNumber");
  if (tripNumber && !/^\d{1,8}$/.test(tripNumber)) throw new HttpError(400, "invalid tripNumber");
  const routeType = q.get("routeType") || "";
  if (!TB_ROUTE_TYPES.has(routeType)) throw new HttpError(400, "invalid routeType");
  const timeFrom = q.get("timeFrom");
  if (timeFrom != null && !/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(timeFrom)) throw new HttpError(400, "invalid timeFrom");
  const limit = intParam(q, "limit", 12, 1, 20);
  const params = [["aswId", aswId], reg ? ["vehicleRegistrationNumber", reg] : ["tripNumber", tripNumber], ["routeType", routeType], ["limit", String(limit)]];
  if (timeFrom) params.push(["timeFrom", timeFrom]);
  const key = `tb:${params.map((p) => p.join("=")).join("&")}`;
  const body = await cached(key, 15_000, () => upstream(env, "/v4/pid/transferboards", params));
  return { body, maxAge: 15 };
}

function route(path) {
  let m;
  if (path === "/v2/public/vehiclepositions") return (env, q) => vehiclePositions(env, q);
  if ((m = /^\/v2\/public\/vehiclepositions\/([^/]+)$/.exec(path))) return (env, q) => vehicleDetail(env, q, decodeURIComponent(m[1]));
  if ((m = /^\/v2\/public\/gtfs\/trips\/([^/]+)$/.exec(path))) return (env, q) => tripShape(env, q, decodeURIComponent(m[1]));
  if ((m = /^\/v2\/gtfs\/trips\/([^/]+)$/.exec(path))) return (env, q) => tripStops(env, q, decodeURIComponent(m[1]));
  if (path === "/v2/public/departureboards") return (env, q) => departures(env, q);
  if (path === "/v4/pid/transferboards") return (env, q) => transferBoards(env, q);
  return null;
}

// ---------- HTTP ----------
function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function json(status, body, origin, extra = {}) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
    ...extra,
  };
  if (origin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = origin && allowedOrigins(env).includes(origin) ? origin : null;

    if (url.pathname === "/healthz") return new Response("ok");

    // vrstva 3: jen z povolených originů (prohlížeč Origin posílá vždy u cross-origin fetch)
    if (!allowed) return json(403, { error: "origin not allowed" }, null);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": allowed,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Accept",
          "Access-Control-Max-Age": "86400",
          Vary: "Origin",
        },
      });
    }
    if (request.method !== "GET") return json(405, { error: "method not allowed" }, allowed);

    // vrstva 2: allowlist endpointů
    const handler = route(url.pathname);
    if (!handler) return json(404, { error: "not found" }, allowed);

    // vrstva 5: rate limit podle IP
    if (env.LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return json(429, { error: "too many requests" }, allowed, { "Retry-After": "60" });
    }

    try {
      const { body, maxAge } = await handler(env, url.searchParams);
      return json(200, body, allowed, { "Cache-Control": `public, max-age=${maxAge}` });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      return json(status, { error: e instanceof HttpError ? e.message : "upstream unavailable" }, allowed);
    }
  },
};

// jen pro testy
export const _internal = { cache, parseBBox };
