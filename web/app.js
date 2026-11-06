/* emhadecko — realtime poloha vozidel PID na OpenStreetMap.
 *
 * Data: Golemio API GET /v2/public/vehiclepositions (GeoJSON FeatureCollection)
 * https://api.golemio.cz/pid/docs/openapi/
 */
(() => {
  "use strict";

  const CFG = Object.assign(
    { apiBase: "https://api.golemio.cz", needsKey: true, pollSeconds: 10 },
    window.EMHADECKO_CONFIG || {},
  );
  const POLL_MS = Math.max(5, CFG.pollSeconds) * 1000;
  const KEY_STORAGE = "emhadecko.golemioKey";
  const TYPES_STORAGE = "emhadecko.types";
  const SNAP_METERS = 2000; // větší skok než tohle se neanimuje

  const TYPES = {
    metro: "Metro",
    tram: "Tramvaj",
    bus: "Autobus",
    trolleybus: "Trolejbus",
    train: "Vlak",
    ferry: "Přívoz",
    funicular: "Lanovka",
  };
  const COLORS = Object.fromEntries(
    Object.keys(TYPES).map((t) => [t, getComputedStyle(document.documentElement).getPropertyValue(`--${t}`).trim()]),
  );
  const METRO_COLORS = { A: "#1a9e3f", B: "#f5b400", C: "#e2001a" };

  // ---------- storage (může selhat v private módu) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  // ---------- mapa ----------
  const map = L.map("map", { zoomControl: true, preferCanvas: false }).setView([50.0835, 14.4341], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · data <a href="https://golemio.cz">Golemio</a> / PID',
  }).addTo(map);

  // ---------- UI ----------
  const $status = document.getElementById("status");
  const $lines = document.getElementById("lines");
  const $types = document.getElementById("types");
  const $dialog = document.getElementById("key-dialog");
  const $keyInput = document.getElementById("key-input");
  const $changeKey = document.getElementById("change-key");

  let enabledTypes;
  try { enabledTypes = new Set(JSON.parse(store.get(TYPES_STORAGE)) || Object.keys(TYPES)); }
  catch { enabledTypes = new Set(Object.keys(TYPES)); }

  for (const [type, label] of Object.entries(TYPES)) {
    const l = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = enabledTypes.has(type);
    cb.addEventListener("change", () => {
      cb.checked ? enabledTypes.add(type) : enabledTypes.delete(type);
      store.set(TYPES_STORAGE, JSON.stringify([...enabledTypes]));
      applyFilter();
    });
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = COLORS[type];
    l.append(cb, sw, label);
    $types.append(l);
  }

  let lineFilter = null;
  $lines.addEventListener("input", () => {
    const parts = $lines.value.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    lineFilter = parts.length ? new Set(parts) : null;
    applyFilter();
  });

  function setStatus(text, isError = false) {
    $status.textContent = text;
    $status.classList.toggle("err", isError);
  }

  // ---------- API klíč ----------
  function getKey() { return store.get(KEY_STORAGE); }

  function askKey() {
    return new Promise((resolve) => {
      $keyInput.value = getKey() || "";
      $dialog.addEventListener("close", () => {
        const v = $keyInput.value.trim();
        if (v) store.set(KEY_STORAGE, v);
        resolve(v || getKey());
      }, { once: true });
      $dialog.showModal();
    });
  }

  if (CFG.needsKey) {
    $changeKey.hidden = false;
    $changeKey.addEventListener("click", async () => { await askKey(); refresh(); });
  }

  // ---------- vozidla ----------
  /** @type {Map<string, {marker: L.Marker, props: object, from: L.LatLng, to: L.LatLng, t0: number, dur: number, iconKey: string}>} */
  const vehicles = new Map();

  function visible(p) {
    if (!enabledTypes.has(p.route_type)) return false;
    if (lineFilter && !lineFilter.has(String(p.gtfs_route_short_name).toUpperCase())) return false;
    return true;
  }

  function applyFilter() {
    for (const v of vehicles.values()) {
      const show = visible(v.props);
      const on = map.hasLayer(v.marker);
      if (show && !on) v.marker.addTo(map);
      else if (!show && on) v.marker.remove();
    }
    updateCount();
  }

  function colorFor(p) {
    if (p.route_type === "metro" && METRO_COLORS[p.gtfs_route_short_name]) return METRO_COLORS[p.gtfs_route_short_name];
    return COLORS[p.route_type] || "#555";
  }

  function iconFor(p) {
    const color = colorFor(p);
    const late = (p.delay ?? 0) >= 180;
    const hasBearing = typeof p.bearing === "number";
    const key = `${p.gtfs_route_short_name}|${color}|${late}|${hasBearing ? Math.round(p.bearing / 5) * 5 : "-"}`;

    const root = document.createElement("div");
    root.className = "veh" + (late ? " late" : "");
    if (hasBearing) {
      const a = document.createElement("div");
      a.className = "arrow";
      a.style.color = color;
      a.style.transform = `rotate(${Math.round(p.bearing / 5) * 5}deg)`;
      root.append(a);
    }
    const b = document.createElement("div");
    b.className = "badge";
    b.style.background = color;
    b.textContent = p.gtfs_route_short_name;
    root.append(b);

    return { key, icon: L.divIcon({ html: root, className: "", iconSize: [0, 0] }) };
  }

  function fmtDelay(sec) {
    if (sec == null) return "neznámé";
    const m = Math.round(sec / 60);
    if (m === 0) return "včas";
    return m > 0 ? `+${m} min` : `${m} min`;
  }

  function popupContent(id) {
    const v = vehicles.get(id);
    const p = v ? v.props : {};
    const el = document.createElement("div");
    const rows = [
      ["Linka", `${p.gtfs_route_short_name} (${TYPES[p.route_type] || p.route_type})`],
      ["Zpoždění", fmtDelay(p.delay)],
      ["Vozidlo", p.vehicle_id],
      ["Spoj", p.gtfs_trip_id],
      ["Stav", p.state_position],
    ];
    for (const [k, val] of rows) {
      if (val == null || val === "") continue;
      const r = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = k + ": ";
      r.append(b, String(val));
      el.append(r);
    }
    return el;
  }

  function upsert(feature, now) {
    const g = feature.geometry;
    const p = feature.properties || {};
    if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) return null;
    const id = p.vehicle_id || p.gtfs_trip_id;
    if (!id) return null;
    const latlng = L.latLng(g.coordinates[1], g.coordinates[0]);

    let v = vehicles.get(id);
    if (!v) {
      const { key, icon } = iconFor(p);
      const marker = L.marker(latlng, { icon, keyboard: false });
      marker.bindPopup(() => popupContent(id));
      v = { marker, props: p, from: latlng, to: latlng, t0: now, dur: 0, iconKey: key };
      vehicles.set(id, v);
      if (visible(p)) marker.addTo(map);
      return id;
    }

    const cur = v.marker.getLatLng();
    v.props = p;
    v.from = cur;
    v.to = latlng;
    v.t0 = now;
    v.dur = cur.distanceTo(latlng) > SNAP_METERS ? 0 : POLL_MS;

    const { key, icon } = iconFor(p);
    if (key !== v.iconKey) { v.marker.setIcon(icon); v.iconKey = key; }
    if (v.marker.isPopupOpen()) v.marker.setPopupContent(popupContent(id));

    const show = visible(p), on = map.hasLayer(v.marker);
    if (show && !on) v.marker.addTo(map);
    else if (!show && on) v.marker.remove();
    return id;
  }

  // plynulý přesun mezi dvěma polohami (lineární interpolace)
  function animate(now) {
    for (const v of vehicles.values()) {
      if (v.from === v.to) continue;
      const t = v.dur ? Math.min(1, (now - v.t0) / v.dur) : 1;
      if (map.hasLayer(v.marker)) {
        v.marker.setLatLng([
          v.from.lat + (v.to.lat - v.from.lat) * t,
          v.from.lng + (v.to.lng - v.from.lng) * t,
        ]);
      }
      if (t >= 1) { v.from = v.to; v.marker.setLatLng(v.to); }
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  function updateCount(extra = "") {
    let shown = 0;
    for (const v of vehicles.values()) if (map.hasLayer(v.marker)) shown++;
    setStatus(`${shown} / ${vehicles.size} vozidel${extra}`);
  }

  // ---------- fetch ----------
  function bboxParam() {
    const b = map.getBounds().pad(0.2);
    const f = (n) => n.toFixed(5);
    // formát: topLeft.lat,topLeft.lon,bottomRight.lat,bottomRight.lon
    return [f(b.getNorth()), f(b.getWest()), f(b.getSouth()), f(b.getEast())].join(",");
  }

  let inflight = null;
  let lastOk = null;

  async function fetchPositions() {
    const url = new URL("/v2/public/vehiclepositions", CFG.apiBase);
    url.searchParams.set("boundingBox", bboxParam());
    const headers = { Accept: "application/json" };
    if (CFG.needsKey) {
      let key = getKey();
      if (!key) key = await askKey();
      if (!key) throw new Error("Chybí API klíč.");
      headers["X-Access-Token"] = key;
    }

    inflight?.abort();
    inflight = new AbortController();
    const res = await fetch(url, { headers, signal: inflight.signal, cache: "no-store" });
    if (res.status === 401 || res.status === 403) {
      if (CFG.needsKey) {
        setStatus("Neplatný API klíč.", true);
        await askKey();
      }
      throw new Error(`HTTP ${res.status}: neautorizováno`);
    }
    if (res.status === 429) throw new Error("Překročen limit požadavků (429), zkusím později.");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function refresh() {
    clearTimeout(timer);
    try {
      const data = await fetchPositions();
      const now = performance.now();
      const seen = new Set();
      for (const f of data.features || []) {
        const id = upsert(f, now);
        if (id) seen.add(id);
      }
      for (const [id, v] of vehicles) {
        if (!seen.has(id)) { v.marker.remove(); vehicles.delete(id); }
      }
      lastOk = new Date();
      updateCount(` · ${lastOk.toLocaleTimeString("cs-CZ")}`);
    } catch (e) {
      if (e.name !== "AbortError") {
        console.error(e);
        setStatus(`Chyba: ${e.message}`, true);
      }
    } finally {
      schedule();
    }
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(refresh, POLL_MS);
  }

  let moveTimer = null;
  map.on("moveend", () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(refresh, 400);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else refresh();
  });

  refresh();
})();
