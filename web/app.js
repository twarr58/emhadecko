/* emhadecko — realtime poloha vozidel PID na OpenStreetMap.
 *
 * Data: Golemio API GET /v2/public/vehiclepositions (GeoJSON FeatureCollection)
 * https://api.golemio.cz/pid/docs/openapi/
 */
(() => {
  "use strict";

  const CFG = Object.assign(
    { apiBase: "https://api.golemio.cz", apiKey: "", proxy: false, pollSeconds: 10 },
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
  const map = L.map("map", { zoomControl: true }).setView([50.0835, 14.4341], 13);
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
  // ---------- hledání linek jako aditivní chipy ----------
  // Rozepsaný text funguje jako náhled (filtr se uplatní hned), Enter nebo čárka z něj udělá chip.
  const $chips = document.getElementById("chips");
  const CHIPS_STORAGE = "emhadecko.lines";
  let chips = [];
  try { chips = (JSON.parse(store.get(CHIPS_STORAGE)) || []).filter((x) => typeof x === "string").slice(0, 20); } catch { chips = []; }

  const typedLines = () => $lines.value.split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

  function renderChips() {
    // trvalá poznámka u linek, které teď nejedou (zastávky z jízdního řádu)
    const $note = document.getElementById("line-note");
    const idle = chips.filter((l) => lineData?.get(l)?.static && ![...vehicles.values()].some((v) => routeKey(v.props) === l));
    $note.hidden = !idle.length;
    $note.textContent = idle.length ? `${idle.length === 1 ? "Linka" : "Linky"} ${idle.join(", ")} teď ${idle.length === 1 ? "nejede" : "nejedou"} – zastávky a trasa podle jízdního řádu.` : "";
    $chips.replaceChildren(...chips.map((line) => {
      const sample = [...vehicles.values()].find((v) => String(v.props.gtfs_route_short_name).toUpperCase() === line);
      const btn = h("button", { type: "button", "aria-label": `Odebrat linku ${line}`, title: "Odebrat" }, "×");
      btn.addEventListener("click", () => { removeChip(line); $lines.focus(); });
      const st = lineData.get(line);
      const color = sample ? colorFor(sample.props) : st?.color;
      const isStatic = !sample && st?.static;
      return h("li", { class: `chip${isStatic ? " static" : ""}`, style: color ? `--c:${color}` : null,
        title: isStatic ? `Linka ${line} teď nejede – zastávky a trasa podle jízdního řádu` : null }, h("span", null, line), btn);
    }));
  }

  function commitTyped() {
    const added = typedLines().filter((x) => !chips.includes(x));
    chips = [...chips, ...added].slice(0, 20);
    $lines.value = "";
    store.set(CHIPS_STORAGE, JSON.stringify(chips));
    renderChips();
    syncLineStops();
    return added;
  }

  function removeChip(line) {
    chips = chips.filter((x) => x !== line);
    store.set(CHIPS_STORAGE, JSON.stringify(chips));
    renderChips();
    drawLineStops();
    onLineFilter(true, false);
  }

  $lines.addEventListener("input", () => {
    if (/[,;]/.test($lines.value)) { commitTyped(); onLineFilter(true); return; } // čárka = hotovo
    onLineFilter(false);
  });
  $lines.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitTyped(); onLineFilter(true); }
    else if (e.key === "Backspace" && !$lines.value && chips.length) { removeChip(chips[chips.length - 1]); }
    else if (e.key === "Escape" && ($lines.value || chips.length)) {
      e.stopPropagation(); // neuzavírat kartu
      if ($lines.value) $lines.value = "";
      else { chips = []; store.set(CHIPS_STORAGE, "[]"); renderChips(); drawLineStops(); }
      onLineFilter(true, false);
    }
  });

  function setStatus(text, isError = false, isWarn = false) {
    $status.textContent = text;
    $status.classList.toggle("err", isError);
    $status.classList.toggle("warn", isWarn);
  }

  /** chyba z HTTP odpovědi; u 429 nese zdroj limitu (worker/upstream) a Retry-After v sekundách */
  function httpError(res) {
    const e = new Error(`HTTP ${res.status}`);
    e.status = res.status;
    e.retryAfter = Number(res.headers.get("Retry-After")) || 0;
    e.source = res.headers.get("X-Limit-Source") || (CFG.proxy ? "worker" : "upstream");
    return e;
  }

  /** srozumitelný text chyby pro kartu */
  function friendlyError(e) {
    if (e?.status === 429) return "PID API je teď chvíli přetížené, zkusím to znovu za pár sekund.";
    return e?.message || "Neznámá chyba.";
  }

  // ---------- API klíč ----------
  // vlastní klíč uživatele má přednost před klíčem vloženým při buildu
  // v režimu proxy (Cloudflare Worker) klíč doplňuje server, prohlížeč žádný nemá ani neposílá
  function getKey() { return CFG.proxy ? null : store.get(KEY_STORAGE) || CFG.apiKey || null; }

  function askKey() {
    return new Promise((resolve) => {
      // klíč vložený při buildu nepředvyplňujeme, jen vlastní klíč uživatele
      $keyInput.value = store.get(KEY_STORAGE) || "";
      $dialog.addEventListener("close", () => {
        const v = $keyInput.value.trim();
        if (v) store.set(KEY_STORAGE, v);
        resolve(getKey());
      }, { once: true });
      $dialog.showModal();
    });
  }

  $changeKey.hidden = !!CFG.proxy;
  $changeKey.addEventListener("click", async () => { await askKey(); refresh(); });

  // ---------- vozidla ----------
  // Výkon: při oddálení se vozidla kreslí jako tečky na jednom canvasu (levné i pro tisíce kusů),
  // HTML štítky s číslem linky jen při přiblížení a jen pro vozidla ve výřezu.
  const LABEL_ZOOM = 14; // od tohoto zoomu štítky s číslem linky
  const ANIM_ZOOM = 12; // pod tímto zoomem se pohyb neanimuje (není vidět), jen se přepíše poloha

  const dotRenderer = L.canvas({ padding: 0.3, tolerance: 6 });

  /**
   * @typedef {{id: string, props: object, pos: L.LatLng, from: L.LatLng, to: L.LatLng, t0: number, dur: number,
   *            dot: L.CircleMarker, label: L.Marker|null, iconKey: string, mode: null|"dot"|"label"}} Vehicle
   * @type {Map<string, Vehicle>}
   */
  const vehicles = new Map();
  let lastOk = null;
  const moving = new Set();
  let viewBounds = map.getBounds().pad(0.1);

  // vozidla přestupních spojů otevřené karty: na mapě vždy vidět (i přes filtr) a zvýrazněná
  /** trip_id → text na štítek ("2 min"); když není prázdná, ostatní vozidla se ztlumí */
  let xferTrips = new Map();
  // málo viditelných vozidel (typicky vybraná linka) → štítky i při oddálení, ať nezapadnou
  const FEW_LIMIT = 60;
  let fewMode = false;

  const matchesFilter = (p) => !!lineFilter && lineFilter.has(String(p.gtfs_route_short_name).toUpperCase());

  function visible(p) {
    if (xferTrips.has(p.gtfs_trip_id)) return true;
    if ((p.vehicle_id || p.gtfs_trip_id) === openId) return true; // otevřená karta → vozidlo vždy na mapě
    if (!enabledTypes.has(p.route_type)) return false;
    if (lineFilter && !lineFilter.has(String(p.gtfs_route_short_name).toUpperCase())) return false;
    return true;
  }

  function colorFor(p) {
    if (p.route_type === "metro" && METRO_COLORS[p.gtfs_route_short_name]) return METRO_COLORS[p.gtfs_route_short_name];
    return COLORS[p.route_type] || "#555";
  }

  function dotRadius() {
    const z = map.getZoom();
    return z < 10 ? 3 : z < 12 ? 4 : 5;
  }

  function dotStyle(p) {
    const late = (p.delay ?? 0) >= 180;
    const dim = xferTrips.size > 0 && !xferTrips.has(p.gtfs_trip_id) && !matchesFilter(p);
    return {
      fillColor: colorFor(p), color: late ? "#ffb000" : "#fff", weight: late ? 2 : 1,
      opacity: dim ? 0.25 : 1, fillOpacity: dim ? 0.25 : 1,
    };
  }

  /** ikona štítku; když se klíč shoduje s prevKey, vrací icon: null (nic nestavíme) */
  function iconFor(p, prevKey) {
    const color = colorFor(p);
    const late = (p.delay ?? 0) >= 180;
    const hasBearing = typeof p.bearing === "number";
    const bearing = hasBearing ? Math.round(p.bearing / 5) * 5 : null;
    const xfer = xferTrips.has(p.gtfs_trip_id);
    const xferText = xfer ? xferTrips.get(p.gtfs_trip_id) : "";
    const sel = (p.vehicle_id || p.gtfs_trip_id) === openId;
    const dim = xferTrips.size > 0 && !xfer && !sel && !matchesFilter(p);
    const key = `${p.gtfs_route_short_name}|${color}|${late}|${bearing}|${xfer}|${xferText}|${sel}|${dim}`;
    if (key === prevKey) return { key, icon: null };

    const root = document.createElement("div");
    root.className = "veh" + (late ? " late" : "") + (xfer ? " xfer" : "") + (dim ? " dim" : "");
    if (hasBearing) {
      const a = document.createElement("div");
      a.className = "arrow";
      a.style.color = color;
      a.style.transform = `rotate(${bearing}deg)`;
      root.append(a);
    }
    const b = document.createElement("div");
    b.className = "badge";
    b.style.background = color;
    b.textContent = p.gtfs_route_short_name;
    if (xferText) b.append(h("span", { class: "xt" }, ` · ${xferText}`));
    root.append(b);

    return { key, icon: L.divIcon({ html: root, className: "", iconSize: [0, 0] }) };
  }

  function desiredMode(v) {
    if (!visible(v.props)) return null;
    if (!viewBounds.contains(v.pos)) return "dot";
    const big = map.getZoom() >= LABEL_ZOOM || fewMode || v.id === openId || xferTrips.has(v.props.gtfs_trip_id);
    return big ? "label" : "dot";
  }

  function computeFewMode() {
    let n = 0;
    for (const v of vehicles.values()) if (visible(v.props) && ++n > FEW_LIMIT) return false;
    return n > 0;
  }

  /** přepne vozidlo mezi tečkou / štítkem / skrytím podle zoomu, výřezu a filtrů */
  function sync(v) {
    const mode = desiredMode(v);
    if (mode === v.mode) return;
    if (v.mode === "dot") v.dot.remove();
    if (v.mode === "label") v.label.remove();
    if (mode === "dot") v.dot.setLatLng(v.pos).addTo(map);
    if (mode === "label") {
      if (!v.label) {
        const { key, icon } = iconFor(v.props);
        v.label = L.marker(v.pos, { icon, keyboard: false }).on("click", () => openCard(v.id));
        v.iconKey = key;
      }
      v.label.setLatLng(v.pos).addTo(map);
    }
    if (v.label) v.label.setZIndexOffset(xferTrips.has(v.props.gtfs_trip_id) || v.id === openId ? 1000 : 0);
    v.mode = mode;
    if (mode === "label") requestShape(v);
  }

  function syncAll() {
    viewBounds = map.getBounds().pad(0.1);
    fewMode = computeFewMode();
    for (const v of vehicles.values()) {
      if (v.label) {
        const { key, icon } = iconFor(v.props, v.iconKey);
        if (icon) { v.label.setIcon(icon); v.iconKey = key; }
        v.label.setZIndexOffset(xferTrips.has(v.props.gtfs_trip_id) || v.id === openId ? 1000 : 0);
      }
      if (focusChanged) v.dot.setStyle(dotStyle(v.props));
      sync(v);
    }
    focusChanged = false;
    updateCount();
  }

  let focusChanged = false;
  /** nastaví přestupní spoje otevřené karty: [trip_id, "2 min"][]; ostatní vozidla se ztlumí */
  function setXferTrips(entries) {
    const next = new Map(entries);
    if (next.size === xferTrips.size && [...next].every(([k, t]) => xferTrips.get(k) === t)) return;
    focusChanged = true;
    xferTrips = next;
    syncAll();
  }

  function applyFilter() { syncAll(); }

  function setPos(v, latlng) {
    v.pos = latlng;
    if (v.mode === "dot") v.dot.setLatLng(latlng);
    else if (v.mode === "label") v.label.setLatLng(latlng);
    if (openId === v.id) selRing.setLatLng(latlng);
  }

  function removeVehicle(v) {
    v.dot.remove();
    v.label?.remove();
    vehicles.delete(v.id);
    moving.delete(v.id);
    details.delete(v.id);
  }

  // ---------- karta vybraného vozidla (pevný panel, mapa se kvůli ní neposouvá) ----------
  const $card = document.getElementById("card");
  let openId = null;
  // zvýraznění vybraného vozidla na mapě (SVG kvůli CSS animaci)
  const selRing = L.circleMarker([0, 0], { radius: 15, weight: 3, fill: false, interactive: false, className: "sel-ring" });

  function openCard(id) {
    const v = vehicles.get(id);
    if (!v) return;
    stopPanel = null;
    if (openId !== id) {
      showAllStops = false; stopView = null; transferSeq = null; clearTrip();
      const prev = vehicles.get(openId);
      openId = id;
      setXferTrips([]);
      syncAll(); // vybrané vozidlo vždy jako štítek, předchozí zpět
    }
    if (!$alerts.hidden) closeAlerts();
    openId = id;
    $card.hidden = false;
    $card.scrollTop = 0;
    $card.replaceChildren(renderCard(id));
    selRing.setLatLng(v.pos).setStyle({ color: colorFor(v.props) }).addTo(map);
    revealVehicle(v);
    loadDetail(id);
  }

  /** posune mapu (jen jednou, při otevření), pokud vozidlo není vidět nebo ho zakrývá karta */
  function revealVehicle(v) {
    const size = map.getSize();
    const pt = map.latLngToContainerPoint(v.pos);
    const mapBox = map.getContainer().getBoundingClientRect();
    const c = $card.getBoundingClientRect();
    const card = { left: c.left - mapBox.left, right: c.right - mapBox.left, top: c.top - mapBox.top, bottom: c.bottom - mapBox.top };
    const pad = 40;
    const covered = pt.x > card.left - pad && pt.x < card.right + pad && pt.y > card.top - pad && pt.y < card.bottom + pad;
    const outside = pt.x < pad || pt.y < pad || pt.x > size.x - pad || pt.y > size.y - pad;
    if (!covered && !outside) return;
    // cíl: střed volné části mapy (vpravo od karty na desktopu, nad kartou na mobilu)
    const bottomSheet = card.left <= 1 && card.right >= size.x - 1;
    const target = bottomSheet
      ? L.point(size.x / 2, Math.max(pad, card.top / 2))
      : L.point(card.right + (size.x - card.right) / 2, size.y / 2);
    map.panBy(pt.subtract(target), { animate: true });
  }

  function closeCard() {
    const prev = vehicles.get(openId);
    openId = null;
    stopView = null;
    clearTrip();
    setXferTrips([]);
    if (prev) syncAll();
    $card.hidden = true;
    $card.replaceChildren();
    selRing.remove();
  }

  function refreshCard(id) {
    if (openId !== id) return;
    // rozbalený výběr (Odkud/Kam) by překreslení zavřelo – počkáme na další obnovu
    if (document.activeElement?.tagName === "SELECT" && $card.contains(document.activeElement)) return;
    const v = vehicles.get(id);
    if (v) selRing.setStyle({ color: colorFor(v.props) });
    $card.replaceChildren(renderCard(id));
    drawTrip(id);
    drawXferRoutes();
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openId) closeCard(); });

  // ---------- karta vozidla (popup) ----------
  const STATES = {
    at_stop: "Ve stanici",
    on_track: "Na trase",
    off_track: "Mimo trasu",
    before_track: "Čeká na odjezd",
    before_track_delayed: "Čeká na odjezd",
    canceled: "Spoj zrušen",
  };

  /** malý helper na DOM: h("div", {class: "x"}, "text", child) — text vždy přes textContent */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** kulaté zavírací tlačítko s křížkem jako SVG (znak × se v různých fontech nevycentruje) */
  function closeButton() {
    const btn = h("button", { class: "vc-close", type: "button", "aria-label": "Zavřít" });
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "14");
    svg.setAttribute("height", "14");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", "M3.5 3.5l9 9M12.5 3.5l-9 9");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
    btn.append(svg);
    return btn;
  }

  function delayInfo(sec) {
    if (sec == null) return { label: "Bez dat", cls: "unknown", hint: "zpoždění neznámé" };
    const m = Math.round(sec / 60);
    if (Math.abs(sec) < 60) return { label: "Včas", cls: "ok", hint: "jede podle jízdního řádu" };
    if (sec < 0) return { label: `${Math.abs(m)} min napřed`, cls: "early", hint: "jede před jízdním řádem" };
    if (sec < 180) return { label: `+${m} min`, cls: "minor", hint: "mírné zpoždění" };
    return { label: `+${m} min`, cls: "major", hint: "zpoždění" };
  }

  function hhmm(t) { return t ? t.slice(0, 5) : ""; }

  function ago(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `před ${s} s`;
    return `před ${Math.round(s / 60)} min`;
  }

  /** @type {Map<string, {data: object|null, error: string|null, loading: boolean}>} */
  const details = new Map();

  async function loadDetail(id) {
    const v = vehicles.get(id);
    if (!v) return;
    const d = details.get(id) || { data: null, error: null, loading: false };
    if (d.loading) return;
    d.loading = true;
    details.set(id, d);
    try {
      const url = new URL(`/v2/public/vehiclepositions/${encodeURIComponent(id)}`, CFG.apiBase);
      requestShape(v, true); // trasa otevřeného spoje (podle trip_id)
      loadTripStops(v.props.gtfs_trip_id); // typy zastávek (na znamení) a jejich ID
      for (const s of ["info", "stop_times", "vehicle_descriptor"]) url.searchParams.append("scopes", s);
      const key = getKey();
      const res = await fetch(url, { headers: { Accept: "application/json", ...(key ? { "X-Access-Token": key } : {}) }, cache: "no-store" });
      if (!res.ok) throw httpError(res);
      d.data = await res.json();
      d.error = null;
    } catch (e) {
      d.error = friendlyError(e);
      d.limited = e.status === 429;
      // přetížení: zkusit znovu, dokud je karta otevřená
      if (e.status === 429) setTimeout(() => { if (openId === id) loadDetail(id); }, Math.max(5, e.retryAfter || 10) * 1000);
    } finally {
      d.loading = false;
      refreshCard(id);
      if (d.data && !stopView) loadTransfers(id);
    }
  }

  /** seřazené zastávky spoje a index poslední projeté / aktuální zastávky */
  function stopContext(info, stopTimes) {
    const feats = (stopTimes?.features || [])
      .map((f) => f.properties)
      .filter(Boolean)
      .sort((a, b) => a.stop_sequence - b.stop_sequence);
    const last = info?.last_stop_sequence ?? null;
    const idx = last == null ? -1 : feats.findIndex((s) => s.stop_sequence === last);
    return { feats, idx };
  }

  /** kde vozidlo právě je: "Ve stanici X" / "Příští zastávka Y" */
  function whereText(state, info, stopTimes) {
    const { feats, idx } = stopContext(info, stopTimes);
    if (!feats.length) return null;
    const cur = feats[idx], next = feats[idx + 1];
    if (state === "at_stop" && cur) return [null, cur.stop_name, cur.stop_sequence]; // "Ve stanici" už je ve stavu vedle
    if ((state === "before_track" || state === "before_track_delayed") && feats[0]) return ["Odjíždí z", feats[0].stop_name, feats[0].stop_sequence];
    if (next) return ["Příští zastávka", next.stop_name, next.stop_sequence];
    if (cur) return ["Poslední zastávka", cur.stop_name, cur.stop_sequence];
    return null;
  }

  // ---------- tarifní pásma (#16): zone_id "P", "0", "B", "1"… nebo víc na hranici ("2,3") ----------
  const zonesOf = (s) => String(s?.zone_id ?? "").split(",").map((z) => z.trim()).filter(Boolean);
  const zoneLabel = (s) => zonesOf(s).join("/");
  /** mezi dvěma po sobě jdoucími zastávkami je hranice pásma, když nemají žádné pásmo společné */
  function zoneBoundary(a, b) {
    const za = zonesOf(a), zb = zonesOf(b);
    if (!za.length || !zb.length) return null;
    return za.some((z) => zb.includes(z)) ? null : [za.join("/"), zb.join("/")];
  }
  function zoneChip(s) {
    const z = zoneLabel(s);
    return z ? h("span", { class: "zone", title: `Tarifní pásmo ${z}` }, z) : null;
  }
  /** pásma, kterými spoj ještě pojede (od příští zastávky do konečné), v pořadí */
  function upcomingZones(feats, idx) {
    const out = [];
    for (const s of feats.slice(Math.max(0, idx))) {
      const zs = zonesOf(s);
      const last = out[out.length - 1];
      if (!zs.length || zs.includes(last)) continue; // hraniční zastávka (např. "2,3") pásmo nemění
      out.push(zs[0]);
    }
    return out;
  }

  function renderStops(info, stopTimes, state) {
    const { feats, idx } = stopContext(info, stopTimes);
    if (!feats.length) return null;
    const atStop = state === "at_stop";
    if (showAllStops) return renderAllStops(feats, idx, atStop);

    // poslední projetá/aktuální zastávka, 3 příští a konečná
    const pick = [];
    if (idx >= 0) pick.push({ s: feats[idx], role: atStop ? "here" : "passed" });
    const upcoming = feats.slice(idx + 1, idx + 4);
    upcoming.forEach((s, i) => pick.push({ s, role: i === 0 && !atStop ? "next" : "upcoming" }));
    const final = feats[feats.length - 1];
    if (!pick.some((p) => p.s === final)) {
      if (idx + 4 < feats.length - 1) pick.push({ gap: feats.length - 1 - (idx + 4) });
      pick.push({ s: final, role: "final" });
    } else {
      pick[pick.length - 1].role = pick[pick.length - 1].role === "here" ? "here" : "final";
    }

    const rows = pick.map((p) => {
      if (p.gap) return h("li", { class: "gap" }, `… ${p.gap} ${p.gap === 1 ? "zastávka" : p.gap < 5 ? "zastávky" : "zastávek"}`);
      const s = p.s;
      const passed = p.role === "passed";
      const sched = hhmm(passed ? s.departure_time : s.arrival_time);
      const rt = hhmm(passed ? s.realtime_departure_time : s.realtime_arrival_time);
      const late = rt && rt !== sched;
      const tag = { here: "zde", next: "příští", final: "konečná" }[p.role];
      const li = h("li", { class: `stop ${p.role}`, title: "Odjezdy ze zastávky" },
        h("span", { class: "dot" }),
        h("span", { class: "name" }, h("span", { class: "nt", title: s.stop_name }, s.stop_name), tag && h("span", { class: "tag" }, tag), kindChip(stopKind(openId, s.stop_sequence))),
        zoneChip(s),
        h("span", { class: "time" },
          late ? h("s", null, sched) : null,
          h("b", { class: late ? "rt" : null }, rt || sched)),
      );
      li.addEventListener("click", () => openStop(s.stop_sequence, s.stop_name));
      return li;
    });
    const all = h("button", { class: "vc-more", type: "button" }, `Celý jízdní řád spoje (${feats.length} zastávek)`);
    all.addEventListener("click", () => { showAllStops = true; refreshCard(openId); });
    const zones = upcomingZones(feats, atStop ? idx : idx + 1);
    const zoneSum = zones.length > 1
      ? h("div", { class: "zone-sum" }, "Pásma do konečné: ", zones.map((z, i) => [i ? " → " : null, h("b", null, z)]).flat())
      : null;
    return h("div", null, h("ol", { class: "vc-stops" }, rows), zoneSum, all);
  }

  function renderAllStops(feats, idx, atStop) {
    const rows = feats.map((s, i) => {
      const role = i < idx || (i === idx && !atStop) ? "passed"
        : i === idx ? "here" : i === idx + 1 && !atStop ? "next" : i === feats.length - 1 ? "final" : "upcoming";
      const passed = role === "passed";
      const sched = hhmm(passed ? s.departure_time : s.arrival_time);
      const rt = hhmm(passed ? s.realtime_departure_time : s.realtime_arrival_time);
      const late = rt && rt !== sched;
      const tag = { here: "zde", next: "příští", final: "konečná" }[role];
      const li = h("li", { class: `stop ${role}`, title: "Odjezdy ze zastávky" },
        h("span", { class: "dot" }),
        h("span", { class: "name" }, h("span", { class: "nt", title: s.stop_name }, s.stop_name), tag && h("span", { class: "tag" }, tag), kindChip(stopKind(openId, s.stop_sequence))),
        zoneChip(s),
        h("span", { class: "time" }, late ? h("s", null, sched) : null, h("b", { class: late ? "rt" : null }, rt || sched)));
      li.addEventListener("click", () => openStop(s.stop_sequence, s.stop_name));
      // hranice pásma před touto zastávkou
      const zb = i > 0 ? zoneBoundary(feats[i - 1], s) : null;
      return zb ? [h("li", { class: "zone-sep" }, h("span", null, `pásmo ${zb[0]} → ${zb[1]}`)), li] : li;
    }).flat();
    const less = h("button", { class: "vc-more", type: "button" }, "Zobrazit méně");
    less.addEventListener("click", () => { showAllStops = false; refreshCard(openId); });
    return h("div", null, h("ol", { class: "vc-stops all" }, rows), less);
  }

  // ---------- vybraný spoj na mapě: trasa + zastávky, odjezdy ze zastávky ----------
  map.createPane("trip").style.zIndex = 390; // pod tečkami vozidel
  map.createPane("tripStops").style.zIndex = 450; // nad tečkami, ať jdou zastávky rozkliknout
  const tripLayer = L.layerGroup().addTo(map);
  let tripKey = "";
  let showAllStops = false;
  /** @type {null | {seq: number, name: string, data: object[]|null, error: string|null, loading: boolean}} */
  let stopView = null;
  /** trip → Map(stop_sequence → stop_id) */
  const tripStops = new Map();
  /** trip → Map(stop_sequence → {stop_id, pickup, dropoff}) – už načtené */
  const tripStopsData = new Map();

  /** typ zastávky podle GTFS pickup_type/drop_off_type: 3 = na znamení, 1 = nelze nastoupit/vystoupit */
  const isReq = (st) => st.pickup === 3 || st.dropoff === 3;

  /** skutečný typ zastávky z dat (výchozí a konečnou za "na znamení" nepovažujeme – tam vystupují/nastupují všichni) */
  function rawStopKind(id, seq) {
    const trip = vehicles.get(id)?.props.gtfs_trip_id;
    const m = tripStopsData.get(trip);
    const st = m?.get(Number(seq));
    if (!st) return null;
    const seqs = [...m.keys()];
    const terminal = Number(seq) === Math.min(...seqs) || Number(seq) === Math.max(...seqs);
    if (isReq(st) && !terminal) return "request";
    if (st.pickup === 1 && st.dropoff !== 1) return "exit";
    if (st.dropoff === 1 && st.pickup !== 1) return "board";
    return null;
  }

  /**
   * Většina zastávek spoje na znamení? (pražské autobusy: prakticky všechny)
   * Pak se × u každé zastávky nevyplatí – zvýrazníme naopak zastávky, kde vozidlo staví vždy (#15).
   */
  function mostlyRequest(id) {
    const trip = vehicles.get(id)?.props.gtfs_trip_id;
    const m = tripStopsData.get(trip);
    if (!m || m.size < 3) return false;
    const seqs = [...m.keys()].sort((a, b) => a - b).slice(1, -1); // bez výchozí a konečné
    return seqs.filter((q) => isReq(m.get(q))).length > seqs.length / 2;
  }

  /** typ zastávky k zobrazení: v režimu "většina na znamení" se ukazují výjimky ("staví vždy") */
  function stopKind(id, seq) {
    const kind = rawStopKind(id, seq);
    if (!mostlyRequest(id)) return kind;
    if (kind === "request") return null;
    if (kind) return kind; // jen výstup / jen nástup
    const m = tripStopsData.get(vehicles.get(id)?.props.gtfs_trip_id);
    const seqs = [...m.keys()];
    const terminal = Number(seq) === Math.min(...seqs) || Number(seq) === Math.max(...seqs);
    return terminal ? null : "always";
  }

  function kindChip(kind, long = false) {
    if (kind === "request") return h("span", { class: "kind rq", title: "Zastávka na znamení" }, long ? "× na znamení" : "×");
    if (kind === "exit") return h("span", { class: "kind ex", title: "Jen pro výstup" }, "↓ jen výstup");
    if (kind === "board") return h("span", { class: "kind bd", title: "Jen pro nástup" }, "↑ jen nástup");
    if (kind === "always") return h("span", { class: "kind al", title: "Vozidlo tu staví vždy, i bez znamení" }, "staví vždy");
    return null;
  }

  function apiFetch(path, params) {
    const url = new URL(path, CFG.apiBase);
    for (const [k, v] of params || []) url.searchParams.append(k, v);
    const key = getKey();
    return fetch(url, { headers: { Accept: "application/json", ...(key ? { "X-Access-Token": key } : {}) } })
      .then((r) => (r.ok ? r.json() : Promise.reject(httpError(r))));
  }

  async function loadTripStops(trip) {
    if (!trip || tripStops.has(trip)) return tripStops.get(trip);
    const p = apiFetch(`/v2/gtfs/trips/${encodeURIComponent(trip)}`, [["includeStopTimes", "true"]])
      .then((d) => {
        const m = new Map((d?.stop_times || []).map((st) => [Number(st.stop_sequence), {
          stop_id: st.stop_id, pickup: Number(st.pickup_type ?? 0), dropoff: Number(st.drop_off_type ?? 0),
        }]));
        tripStopsData.set(trip, m);
        if (openId && vehicles.get(openId)?.props.gtfs_trip_id === trip) { tripKey = ""; refreshCard(openId); }
        return m;
      })
      .catch(() => { tripStops.delete(trip); return null; });
    tripStops.set(trip, p);
    return p;
  }

  function stopFeatures(id) {
    const st = details.get(id)?.data?.stop_times?.features || [];
    return st.filter((f) => f.properties && f.geometry?.coordinates)
      .sort((a, b) => a.properties.stop_sequence - b.properties.stop_sequence);
  }

  function drawTrip(id) {
    const v = vehicles.get(id);
    const d = details.get(id)?.data;
    if (!v || !d) return;
    const trip = v.props.gtfs_trip_id;
    const info = d.info || d;
    const sh = shapes.get(trip);
    const xferSeq = stopView ? null : transferContext(id)?.stop.stop_sequence;
    const key = `${trip}|${info.last_stop_sequence}|${stopView?.seq}|${xferSeq}|${typeof sh === "object"}|${tripStopsData.has(trip)}`;
    if (key === tripKey) {
      nextStopMarker?.getTooltip()?.update();
      return;
    }
    tripKey = key;
    tripLayer.clearLayers();
    const color = colorFor(v.props);
    if (sh && typeof sh === "object") {
      L.polyline(sh.coords.map(([lng, lat]) => [lat, lng]), { pane: "trip", color, weight: 6, opacity: 0.55, interactive: false }).addTo(tripLayer);
    }
    const last = info.last_stop_sequence ?? -1;
    const atStop = v.props.state_position === "at_stop";
    nextStopMarker = null;
    for (const f of stopFeatures(id)) {
      const s = f.properties;
      const seq = s.stop_sequence;
      const [lng, lat] = f.geometry.coordinates;
      const passed = seq < last || (seq === last && !atStop);
      const isNext = atStop ? seq === last : seq === nextSeq(id);
      const sel = stopView?.seq === seq || xferSeq === seq;
      // zastávka na znamení: kosočtverec, ostatní kolečko
      const m = stopKind(id, seq) === "request"
        ? L.marker([lat, lng], {
          pane: "tripStops", keyboard: false,
          icon: L.divIcon({
            className: "", iconSize: [0, 0],
            html: `<div class="rqm${passed ? " passed" : ""}${isNext ? " next" : ""}${sel ? " sel" : ""}" style="--c:${color}"></div>`,
          }),
        })
        : L.circleMarker([lat, lng], {
          pane: "tripStops", radius: sel ? 8 : isNext ? 7 : 5, weight: sel ? 4 : isNext ? 3 : 2.5,
          color: passed ? "#9ca3af" : color, fillColor: isNext ? color : "#fff", fillOpacity: 1,
        });
      m
        // obsah jako funkce → při každém zobrazení aktuální časy a "za X min"
        .bindTooltip(() => stopTip(id, seq, false), { direction: "top", offset: [0, -8], className: "stop-tip-wrap" })
        .on("click", () => openStop(seq, s.stop_name))
        .addTo(tripLayer);
      if (isNext) {
        // příští zastávka: trvalý štítek s časem příjezdu
        m.unbindTooltip().bindTooltip(() => stopTip(id, seq, true), {
          permanent: true, direction: "right", offset: [10, 0], className: "stop-tip-wrap next",
        });
        nextStopMarker = m;
      }
    }
    // hranice tarifních pásem na trase: štítek "1 | B" mezi zastávkami, kde se pásmo mění
    const sf = stopFeatures(id);
    for (let i = 1; i < sf.length; i++) {
      const zb = zoneBoundary(sf[i - 1].properties, sf[i].properties);
      if (!zb) continue;
      const [aLng, aLat] = sf[i - 1].geometry.coordinates, [bLng, bLat] = sf[i].geometry.coordinates;
      let at = L.latLng((aLat + bLat) / 2, (aLng + bLng) / 2);
      if (sh && typeof sh === "object") at = snapToShape(trip, at);
      L.marker(at, {
        pane: "tripStops", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<div class="zone-flag"><span>${zb[0]}</span><span>${zb[1]}</span></div>` }),
      }).addTo(tripLayer);
    }
  }

  let nextStopMarker = null;
  // štítek příští zastávky přepočítáváme, ať "za X min" odpovídá
  setInterval(() => { if (nextStopMarker && map.hasLayer(nextStopMarker)) nextStopMarker.getTooltip()?.update(); }, 15000);

  function nextSeq(id) {
    const info = details.get(id)?.data?.info || details.get(id)?.data;
    const feats = stopFeatures(id).map((f) => f.properties.stop_sequence);
    const last = info?.last_stop_sequence;
    if (last == null) return feats[0];
    return feats.find((q) => q > last);
  }

  /** "HH:MM:SS" z GTFS (může být i 24:10:00) → Date nejblíž k teď */
  function gtfsTime(t) {
    const m = /^(\d+):(\d\d)(?::(\d\d))?/.exec(t || "");
    if (!m) return null;
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    let ms = d.getTime() + ((+m[1] * 60 + +m[2]) * 60 + +(m[3] || 0)) * 1000;
    const now = Date.now();
    if (ms - now > 12 * 3600e3) ms -= 86400e3;
    if (now - ms > 12 * 3600e3) ms += 86400e3;
    return ms;
  }

  function relTime(ms) {
    const diff = ms - Date.now();
    const min = Math.round(Math.abs(diff) / 60000);
    if (min === 0) return "teď";
    const txt = min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
    return diff > 0 ? `za ${txt}` : `před ${txt}`;
  }

  function stopTip(id, seq, compact) {
    const f = stopFeatures(id).find((x) => x.properties.stop_sequence === seq);
    const v = vehicles.get(id);
    if (!f || !v) return "";
    const s = f.properties;
    const info = details.get(id)?.data?.info || details.get(id)?.data || {};
    const last = info.last_stop_sequence ?? -1;
    const atStop = v.props.state_position === "at_stop";
    const here = atStop && seq === last;
    const passed = seq < last || (seq === last && !atStop);
    // projeté zastávky → odjezd, ostatní → příjezd (ve stanici → odjezd)
    const useDep = passed || here;
    const sched = useDep ? s.departure_time : s.arrival_time;
    const rt = (useDep ? s.realtime_departure_time : s.realtime_arrival_time) || sched;
    const rtMs = gtfsTime(rt), schedMs = gtfsTime(sched);
    const delayMin = rtMs != null && schedMs != null ? Math.round((rtMs - schedMs) / 60000) : 0;
    // budoucí zastávka s časem v minulosti = predikce ještě nedohnala zpoždění
    const when = rtMs == null ? "" : !passed && rtMs < Date.now() ? "každou chvíli" : relTime(rtMs);

    const kind = rawStopKind(id, seq);
    if (compact) {
      return h("div", { class: "stop-tip compact" },
        h("b", null, s.stop_name), " · ", h("span", { class: "eta" }, here ? `odjíždí ${when}` : when),
        kind ? " " : null, kindChip(kind, true));
    }
    const status = here ? "Vozidlo je ve stanici" : passed ? "Projeto" : seq === nextSeq(id) ? "Příští zastávka" : null;
    return h("div", { class: "stop-tip" },
      status || kind ? h("div", { class: "st" }, status, status && kind ? " " : null, kindChip(kind, true)) : null,
      h("div", { class: "nm" }, s.stop_name),
      zoneLabel(s) ? h("div", { class: "zn" }, `tarifní pásmo ${zoneLabel(s)}`) : null,
      h("div", { class: "big" }, passed ? `odjel ${when}` : here ? `odjíždí ${when}` : `přijede ${when}`),
      h("div", { class: "sm" },
        `${useDep ? "odjezd" : "příjezd"} ${hhmm(rt)}`,
        delayMin ? h("span", { class: delayMin > 0 ? "late" : "early" }, ` (jízdní řád ${hhmm(sched)}, ${delayMin > 0 ? "+" : ""}${delayMin} min)`) : " · podle jízdního řádu"),
      kind === "request" && !passed ? h("div", { class: "rqh" }, "Chceš-li vystoupit, zmáčkni tlačítko.") : null,
      h("div", { class: "hint" }, "Klikni pro odjezdy ze zastávky"));
  }

  function clearTrip() { tripLayer.clearLayers(); tripKey = ""; nextStopMarker = null; clearXferRoutes(); }

  function openStop(seq, name) {
    stopView = { seq, name, data: null, error: null, loading: false };
    $card.scrollTop = 0;
    refreshCard(openId);
    loadDepartures();
  }

  function closeStop() {
    stopView = null;
    refreshCard(openId);
  }

  async function loadDepartures() {
    const sv = stopView;
    const v = vehicles.get(openId);
    if (!sv || !v || sv.loading) return;
    sv.loading = true;
    try {
      const ids = await loadTripStops(v.props.gtfs_trip_id);
      const stopId = ids?.get(sv.seq)?.stop_id;
      if (!stopId) throw new Error("Zastávku se nepodařilo dohledat.");
      const groups = await apiFetch("/v2/public/departureboards", [
        ["stopIds[]", JSON.stringify({ 0: [stopId] })], ["limit", "12"], ["minutesAfter", "90"],
      ]);
      sv.data = (groups || []).flat();
      sv.error = null;
    } catch (e) {
      sv.error = friendlyError(e);
    } finally {
      sv.loading = false;
      if (stopView === sv) refreshCard(openId);
    }
  }

  function renderDepartures(p) {
    const sv = stopView;
    const back = h("button", { class: "vc-back", type: "button" }, `← spoj ${p.gtfs_route_short_name}`);
    back.addEventListener("click", closeStop);
    const head = h("div", { class: "vc-sub" }, back,
      h("div", { class: "vc-subtitle" }, h("span", { class: "lbl" }, "Odjezdy ze zastávky"), h("b", null, sv.name)));

    let list;
    if (sv.error && !sv.data) list = h("div", { class: "vc-msg" }, `Odjezdy se nepodařilo načíst. ${sv.error}`);
    else if (!sv.data) list = h("div", { class: "vc-stops-sk" }, h("span", { class: "sk" }), h("span", { class: "sk" }), h("span", { class: "sk sk-w60" }));
    else if (!sv.data.length) list = h("div", { class: "vc-msg" }, "V příštích 90 minutách odsud nic neodjíždí.");
    else {
      list = h("ul", { class: "vc-deps" }, sv.data.map((dep) => {
        const route = dep.route || {}, trip = dep.trip || {}, de = dep.departure || {};
        const c = colorFor({ route_type: route.type, gtfs_route_short_name: route.short_name });
        const delay = de.delay_seconds ?? null;
        const mins = de.minutes;
        const when = mins == null ? "" : mins <= 0 ? "teď" : mins < 60 ? `${mins} min` : hhmm(new Date(de.timestamp_predicted).toTimeString());
        const sched = de.timestamp_scheduled ? new Date(de.timestamp_scheduled).toTimeString().slice(0, 5) : "";
        const veh = dep.vehicle?.id && vehicles.get(dep.vehicle.id);
        const li = h("li", { class: `${trip.is_canceled ? "canceled" : ""} ${veh ? "has-veh" : ""}`, title: veh ? "Ukázat vozidlo" : null },
          h("span", { class: "dl", style: `background:${c}` }, route.short_name),
          h("span", { class: "dh" }, trip.headsign, dep.vehicle?.is_wheelchair_accessible ? h("span", { class: "acc", title: "bezbariérové" }, " ♿") : null,
            trip.is_canceled ? h("span", { class: "tag" }, "odřeknuto") : null),
          h("span", { class: "dt" },
            h("b", null, when),
            h("small", { class: delay >= 60 ? "late" : null }, delay >= 60 ? `${sched} +${Math.round(delay / 60)}` : sched)),
        );
        if (veh) li.addEventListener("click", () => { stopView = null; openCard(veh.id); });
        return li;
      }));
    }
    return h("div", { class: "vc-depview" }, head, list);
  }

  // ---------- přestupy: přestupní tablo PID pro zastávky před vozidlem ----------
  // /v4/pid/transferboards vrací odjezdy ze všech nástupišť uzlu (vč. navazujícího metra/vlaku)
  // bez vlastního vozidla. Ptáme se k času předpokládaného příjezdu, takže minuty jsou "po příjezdu".
  const RT_NUM = { tram: 0, metro: 1, train: 2, bus: 3, ferry: 4, funicular: 7, trolleybus: 11 };
  const NUM_RT = Object.fromEntries(Object.entries(RT_NUM).map(([k, n]) => [n, k]));
  const TRANSFER_TTL = 30_000;
  let transferSeq = null; // zvolená zastávka (null = příští)
  /** key → {data, error, loading, at} */
  const transfers = new Map();

  const aswFromStopId = (id) => { const m = /^U(\d+)Z(\d+)/.exec(id || ""); return m ? `${m[1]}_${m[2]}` : null; };
  function localIso(ms) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
  }

  /** zastávky, kde se dá ještě přestoupit (aktuální ve stanici + všechny před vozidlem) */
  function transferStops(id) {
    const v = vehicles.get(id);
    const info = details.get(id)?.data?.info || details.get(id)?.data || {};
    const last = info.last_stop_sequence ?? -1;
    const atStop = v?.props.state_position === "at_stop";
    return stopFeatures(id).map((f) => f.properties)
      .filter((s) => s.stop_sequence > last || (atStop && s.stop_sequence === last));
  }

  function transferContext(id) {
    const stops = transferStops(id);
    if (!stops.length) return null;
    const stop = stops.find((s) => s.stop_sequence === transferSeq) || stops[0];
    const v = vehicles.get(id);
    const desc = details.get(id)?.data?.vehicle_descriptor;
    const reg = desc?.vehicle_registration_number || (String(v?.props.vehicle_id || "").match(/(\d+)$/) || [])[1];
    const arr = gtfsTime(stop.realtime_arrival_time || stop.arrival_time);
    const timeFrom = arr && arr > Date.now() + 30_000 ? localIso(arr) : null;
    return { stops, stop, reg, arr, timeFrom, routeType: RT_NUM[v?.props.route_type] };
  }

  async function loadTransfers(id) {
    const ctx = transferContext(id);
    const v = vehicles.get(id);
    if (!ctx || !v || !ctx.reg || ctx.routeType == null) return;
    const ids = await loadTripStops(v.props.gtfs_trip_id);
    const asw = aswFromStopId(ids?.get(ctx.stop.stop_sequence)?.stop_id);
    if (!asw) return;
    const key = `${asw}|${ctx.timeFrom || "now"}|${ctx.reg}|${ctx.routeType}`;
    const t = transfers.get(key) || {};
    ctx.key = key;
    if (t.loading || (t.at && Date.now() - t.at < TRANSFER_TTL)) { transferKeyFor.set(id, key); return; }
    transfers.set(key, { ...t, loading: true });
    transferKeyFor.set(id, key);
    const params = [["aswId", asw], ["vehicleRegistrationNumber", ctx.reg], ["routeType", String(ctx.routeType)], ["limit", "12"]];
    if (ctx.timeFrom) params.push(["timeFrom", ctx.timeFrom]);
    try {
      const data = await apiFetch("/v4/pid/transferboards", params);
      transfers.set(key, { data, error: null, loading: false, at: Date.now() });
    } catch (e) {
      // při přetížení zkusit dřív než za běžných 30 s
      transfers.set(key, { data: t.data || null, error: friendlyError(e), loading: false, at: Date.now() - (e.status === 429 ? TRANSFER_TTL - 10_000 : 0) });
    }
    if (transfers.size > 60) transfers.delete(transfers.keys().next().value);
    refreshCard(id);
  }
  const transferKeyFor = new Map();

  function minutesLabel(m) {
    if (m == null) return { txt: "", cls: "" };
    if (m === "<1" || m === "0") return { txt: "hned", cls: "tight" };
    const n = Number(m);
    return { txt: `${m} min`, cls: n <= 1 ? "tight" : "" };
  }

  // ---------- trasy přestupních spojů (#23): stahují se jen na vyžádání ----------
  const xferRouteLayer = L.layerGroup().addTo(map);
  const XFER_PIN_ALL = 5; // "Ukázat trasy přestupů" připne prvních N
  let xferPinned = new Set(); // trip_id připnutých tras
  let xferHover = null; // trip_id trasy pod myší
  let xferHoverTimer = null;
  /** trip_id → {color, headsign, label} pro vykreslení */
  const xferInfo = new Map();
  let xferRouteKey = "";

  /** trasa spoje na vyžádání (sdílí cache a časový rozpočet s ostatními trasami) */
  function requestTripShape(trip) {
    if (!trip || shapes.has(trip)) return;
    shapes.set(trip, "pending");
    shapeQueue.unshift({ trip, vehicleId: null, force: true });
    pumpShapes();
  }

  /** souřadnice trasy od bodu (projekce na trasu) do konce */
  function shapeFrom(sh, latlng) {
    const pr = project(sh, latlng);
    if (pr.off > 400) return sh.coords.map(([lng, lat]) => [lat, lng]); // zastávka mimo trasu (jiný uzel): celá trasa
    const start = pointAt(sh, pr.d);
    const out = [[start.lat, start.lng]];
    for (let i = 0; i < sh.coords.length; i++) if (sh.cum[i] > pr.d) out.push([sh.coords[i][1], sh.coords[i][0]]);
    return out;
  }

  function clearXferRoutes() {
    xferPinned = new Set();
    xferHover = null;
    clearTimeout(xferHoverTimer);
    xferRouteLayer.clearLayers();
    xferRouteKey = "";
  }

  function setXferHover(trip) {
    clearTimeout(xferHoverTimer);
    if (!trip) { xferHover = null; drawXferRoutes(); return; }
    // krátká prodleva: projetí myší přes seznam nespustí stahování všech tras
    xferHoverTimer = setTimeout(() => { xferHover = trip; requestTripShape(trip); drawXferRoutes(); }, 250);
  }

  function toggleXferPin(trip) {
    const next = new Set(xferPinned);
    if (next.has(trip)) next.delete(trip); else { next.add(trip); requestTripShape(trip); }
    xferPinned = next;
    drawXferRoutes();
    if (openId) refreshCard(openId);
  }

  function drawXferRoutes() {
    const id = openId;
    const ctx = id && !stopView ? transferContext(id) : null;
    const trips = ctx ? [...new Set([...xferPinned, ...(xferHover ? [xferHover] : [])])] : [];
    const stopF = ctx ? stopFeatures(id).find((f) => f.properties.stop_sequence === ctx.stop.stop_sequence) : null;
    const key = trips.map((t) => `${t}:${typeof shapes.get(t) === "object"}:${t === xferHover}`).join("|") + `|${ctx?.stop.stop_sequence}`;
    if (key === xferRouteKey) return;
    xferRouteKey = key;
    xferRouteLayer.clearLayers();
    if (!stopF) return;
    const from = L.latLng(stopF.geometry.coordinates[1], stopF.geometry.coordinates[0]);
    for (const trip of trips) {
      const sh = shapes.get(trip);
      const info = xferInfo.get(trip);
      if (!sh || typeof sh !== "object" || !info) continue;
      const pts = shapeFrom(sh, from);
      if (pts.length < 2) continue;
      const hot = trip === xferHover;
      L.polyline(pts, { pane: "trip", color: "#fff", weight: hot ? 9 : 7, opacity: 0.9, interactive: false }).addTo(xferRouteLayer);
      L.polyline(pts, { pane: "trip", color: info.color, weight: hot ? 5 : 4, opacity: 0.95, dashArray: "8 6", interactive: false }).addTo(xferRouteLayer);
      L.marker(pts[pts.length - 1], { pane: "tripStops", interactive: false, icon: L.divIcon({ className: "", iconSize: [0, 0] }) })
        .bindTooltip(`${info.label} → ${info.headsign}`, { permanent: true, direction: "right", offset: [6, 0], className: "xfer-end" })
        .addTo(xferRouteLayer);
    }
  }

  function renderTransfers(id) {
    const ctx = transferContext(id);
    if (!ctx) return null;
    const t = transfers.get(transferKeyFor.get(id)) || null;
    const chips = h("div", { class: "tr-stops" }, ctx.stops.slice(0, 10).map((s) => {
      const b = h("button", { type: "button", class: s === ctx.stop ? "on" : null }, s.stop_name);
      b.addEventListener("click", () => { transferSeq = s.stop_sequence; clearXferRoutes(); refreshCard(id); loadTransfers(id); });
      return b;
    }));
    const when = !ctx.arr ? "" : ctx.arr < Date.now() ? "každou chvíli" : relTime(ctx.arr);
    const head = h("div", { class: "tr-head" },
      h("h3", null, "Přestupy"),
      h("div", { class: "tr-sub" }, `${ctx.stop.stop_name} · příjezd ${hhmm(ctx.stop.realtime_arrival_time || ctx.stop.arrival_time)}`,
        when ? ` (${when})` : "", ctx.timeFrom ? " · minuty po příjezdu" : ""));

    let list;
    const data = t?.data;
    if (!ctx.reg) list = h("div", { class: "vc-msg" }, "Pro tento spoj přestupy nelze dohledat.");
    else if (!data && t?.error) list = h("div", { class: "vc-msg" }, `Přestupy se nepodařilo načíst. ${t.error}`);
    else if (!data) list = h("div", { class: "vc-stops-sk" }, h("span", { class: "sk" }), h("span", { class: "sk sk-w60" }));
    else if (!data.departures?.length) list = h("div", { class: "vc-msg" }, "V příští hodině odsud nic nenavazuje.");
    else {
      list = h("ul", { class: "vc-deps tr-list" }, data.departures.map((dep) => {
        const type = NUM_RT[dep.route?.type] || "bus";
        const c = colorFor({ route_type: type, gtfs_route_short_name: dep.route?.short_name });
        const [m1, m2] = dep.departure_timestamp?.minutes || [];
        const a = minutesLabel(m1), b = m2 != null ? minutesLabel(m2) : null;
        const veh = [...vehicles.values()].find((x) => x.props.gtfs_trip_id === dep.trip?.id);
        const trip = dep.trip?.id;
        if (trip) xferInfo.set(trip, { color: c, headsign: dep.trip?.headsign || "", label: dep.route?.short_name || "" });
        const pinned = trip && xferPinned.has(trip);
        const pin = trip ? h("button", { type: "button", class: `tr-pin${pinned ? " on" : ""}`, "aria-pressed": pinned ? "true" : "false",
          "aria-label": pinned ? `Skrýt trasu linky ${dep.route?.short_name}` : `Ukázat trasu linky ${dep.route?.short_name}`,
          title: pinned ? "Skrýt trasu" : "Ukázat trasu na mapě" }, "⤳") : null;
        pin?.addEventListener("click", (ev) => { ev.stopPropagation(); toggleXferPin(trip); });
        const li = h("li", { class: veh ? "has-veh" : null, title: veh ? "Ukázat vozidlo" : null },
          h("span", { class: "dl", style: `background:${c}` }, dep.route?.short_name),
          h("span", { class: "dh" },
            dep.trip?.headsign,
            veh ? h("span", { class: "onmap", title: "Vozidlo je na mapě (čárkovaný rámeček)" }, " ◉") : null,
            dep.trip?.is_wheelchair_accessible ? h("span", { class: "acc", title: "bezbariérové" }, " ♿") : null,
            dep.trip?.is_guaranteed_transfer ? h("span", { class: "tag ok", title: "Garantovaný přestup: spoj počká" }, "počká") : null,
            dep.stop?.platform_code ? h("small", { class: "pl" }, ` · nást. ${dep.stop.platform_code}`) : null,
            dep.substitution_text?.cs ? h("small", { class: "sub" }, dep.substitution_text.cs) : null),
          h("span", { class: "dt" },
            h("b", { class: a.cls || null }, a.txt),
            b ? h("small", null, `pak ${b.txt}`) : null),
          pin);
        if (trip) {
          li.addEventListener("mouseenter", () => setXferHover(trip));
          li.addEventListener("mouseleave", () => setXferHover(null));
        }
        if (veh) {
          li.addEventListener("click", () => openCard(veh.id));
          // najetí na řádek zvýrazní vozidlo na mapě
          li.addEventListener("mouseenter", () => veh.label?.getElement()?.classList.add("hot"));
          li.addEventListener("mouseleave", () => veh.label?.getElement()?.classList.remove("hot"));
        }
        return li;
      }));
    }
    const notes = (data?.infotexts || []).map((it) => h("div", { class: "tr-info" }, "ℹ ", it.text?.cs || ""));
    const xfers = (data?.departures || []).filter((dep) => dep.trip?.id)
      .map((dep) => [dep.trip.id, minutesLabel((dep.departure_timestamp?.minutes || [])[0]).txt]);
    queueMicrotask(() => { if (openId === id && !stopView) setXferTrips(xfers); });
    const firstTrips = (data?.departures || []).map((dep) => dep.trip?.id).filter(Boolean).slice(0, XFER_PIN_ALL);
    let allBtn = null;
    if (firstTrips.length) {
      const allOn = firstTrips.every((t) => xferPinned.has(t));
      allBtn = h("button", { type: "button", class: "vc-more tr-all" }, allOn ? "Skrýt trasy přestupů" : `Ukázat trasy přestupů na mapě (${firstTrips.length})`);
      allBtn.addEventListener("click", () => {
        xferPinned = allOn ? new Set() : new Set([...xferPinned, ...firstTrips]);
        if (!allOn) firstTrips.forEach(requestTripShape);
        drawXferRoutes();
        refreshCard(id);
      });
    }
    queueMicrotask(drawXferRoutes);
    return h("section", { class: "vc-tr" }, head, chips, ...notes, list, allBtn);
  }

  function renderCard(id) {
    const v = vehicles.get(id);
    const p = v ? v.props : {};
    const d = details.get(id);
    const data = d?.data || null;
    const info = data?.info || data || null; // scope info může být vnořený i plochý
    const desc = data?.vehicle_descriptor || null;
    const color = colorFor(p);
    const delay = delayInfo(p.delay ?? info?.delay);
    const state = p.state_position || info?.state_position;
    const headsign = info?.trip_headsign;
    const regNo = desc?.vehicle_registration_number || (String(p.vehicle_id || "").match(/(\d+)$/) || [])[1];

    const head = h("header", { class: "vc-head" },
      h("div", { class: "vc-line" }, p.gtfs_route_short_name),
      h("div", { class: "vc-title" },
        h("div", { class: "vc-kind" }, TYPES[p.route_type] || p.route_type),
        h("div", { class: "vc-dest", title: headsign || null }, headsign ? ["→ ", headsign] : (d?.loading || !d ? h("span", { class: "sk sk-w60" }) : `linka ${p.gtfs_route_short_name}`)),
      ),
    );
    const close = closeButton();
    close.addEventListener("click", closeCard);
    head.append(close);
    if (stopView) return h("div", { class: "vc", style: `--c:${color}` }, head, renderDepartures(p));

    const age = info?.origin_timestamp ? ago(info.origin_timestamp) : null;
    const status = h("div", { class: "vc-status" },
      h("div", { class: `vc-delay ${delay.cls}` },
        h("div", { class: "big" }, delay.label),
        h("div", { class: "small" }, delay.hint)),
      h("div", { class: "vc-state" },
        h("div", null, STATES[state] || "—"),
        age ? h("div", { class: "small" }, `poloha ${age}`) : null),
    );
    const where = data ? whereText(state, info, data.stop_times) : null;
    if (where) {
      const kind = rawStopKind(id, where[2]);
      status.append(h("div", { class: `vc-where ${state === "at_stop" ? "at" : ""}` },
        h("span", { class: "pin" }),
        where[0] ? h("span", { class: "lbl" }, where[0]) : null,
        h("b", { title: where[1] }, where[1]),
        kind ? h("span", { class: "push" }, kindChip(kind, true)) : null));
      if (kind === "request" && where[0] === "Příští zastávka") {
        // u spojů, kde je na znamení skoro všechno, stačí krátká nápověda místo velkého boxu
        status.append(mostlyRequest(id)
          ? h("div", { class: "vc-rq-hint small" }, "Chceš-li vystoupit, zmáčkni tlačítko.")
          : h("div", { class: "vc-rq-hint" }, h("b", null, "Zastávka na znamení. "),
            "Chceš-li vystoupit, zmáčkni tlačítko. Na zastávce dej řidiči znamení rukou."));
      }
    }

    const lineAlerts = renderLineAlerts(p.gtfs_route_short_name);
    if (lineAlerts) status.append(lineAlerts);

    let body;
    if (d?.error && !data) body = h("div", { class: "vc-msg" }, d.limited ? "Detail spoje se načte za chvíli – PID API je teď přetížené." : "Detail spoje se nepodařilo načíst.");
    else if (!data) body = h("div", { class: "vc-stops-sk" }, h("span", { class: "sk" }), h("span", { class: "sk" }), h("span", { class: "sk sk-w60" }));
    else body = renderStops(info, data.stop_times, state) || h("div", { class: "vc-msg" }, "Jízdní řád spoje není k dispozici.");
    if (data && mostlyRequest(id) && !showAllStops) {
      body = h("div", null, h("div", { class: "vc-mostly" }, h("span", { class: "kind rq" }, "×"),
        " Téměř všechny zastávky jsou na znamení. Označené jsou ty, kde vozidlo staví vždy."), body);
    } else if (data && mostlyRequest(id)) {
      body = h("div", null, h("div", { class: "vc-mostly" }, h("span", { class: "kind rq" }, "×"),
        " Téměř všechny zastávky jsou na znamení."), body);
    }

    const feats = [];
    if (desc?.is_wheelchair_accessible) feats.push(h("span", { class: "feat", title: "Bezbariérové vozidlo" }, "♿ bezbariérové"));
    if (desc?.is_air_conditioned) feats.push(h("span", { class: "feat", title: "Klimatizace" }, "❄ klimatizace"));
    if (desc?.has_usb_chargers) feats.push(h("span", { class: "feat", title: "USB nabíječky" }, "⚡ USB"));

    const model = desc?.vehicle_type || null;
    const veh = h("div", { class: "vc-veh" },
      h("div", { class: "model" }, model || "Vozidlo"),
      h("div", { class: "meta" },
        regNo ? h("span", null, `ev. č. ${regNo}`) : null,
        desc?.operator ? h("span", null, desc.operator) : null),
      feats.length ? h("div", { class: "feats" }, feats) : null,
    );

    const tr = data ? renderTransfers(id) : null;
    return h("div", { class: "vc", style: `--c:${color}` }, head, status, body, tr, veh,
      h("footer", { class: "vc-foot" }, `spoj ${p.gtfs_trip_id || "?"}`));
  }

  // ---------- trasy spojů (aby vozidla jezdila po silnici/kolejích, ne vzduchem) ----------
  // Trasa se stahuje jen pro vozidla viditelná při přiblížení (štítky), cachuje se podle spoje
  // a stahování je omezené kvůli limitu API klíče.
  const SHAPE_CONCURRENCY = 2;
  // nejvýš SHAPE_RATE tras za SHAPE_WINDOW_MS (rovnoměrně, ne v nárazech po posunu mapy)
  const SHAPE_RATE = 6;
  const SHAPE_WINDOW_MS = 10_000;
  const SHAPE_MAX_OFFSET = 60; // m — dál od trasy už polohu na trasu nepřichytáváme
  /** @type {Map<string, object|"pending"|"none">} */
  const shapes = new Map();
  const shapeQueue = [];
  let shapeInflight = 0;
  let shapeTokens = SHAPE_RATE;
  let shapeTokensAt = Date.now();
  let shapePauseUntil = 0; // po 429 chvíli trasy nestahovat
  let shapePumpTimer = null;

  /** vezme token z rozpočtu, nebo vrátí, za kolik ms bude další */
  function shapeToken() {
    const now = Date.now();
    shapeTokens = Math.min(SHAPE_RATE, shapeTokens + ((now - shapeTokensAt) * SHAPE_RATE) / SHAPE_WINDOW_MS);
    shapeTokensAt = now;
    if (now < shapePauseUntil) return shapePauseUntil - now;
    if (shapeTokens >= 1) { shapeTokens -= 1; return 0; }
    return Math.ceil(((1 - shapeTokens) * SHAPE_WINDOW_MS) / SHAPE_RATE);
  }

  const M_PER_DEG_LAT = 110540;
  function toXY(lat, lng, kx) { return [lng * kx, lat * M_PER_DEG_LAT]; }

  function buildShape(features) {
    const coords = (features || []).map((f) => f.geometry?.coordinates).filter((c) => Array.isArray(c) && c.length >= 2);
    if (coords.length < 2) return null;
    const kx = 111320 * Math.cos((coords[0][1] * Math.PI) / 180);
    const xy = coords.map(([lng, lat]) => toXY(lat, lng, kx));
    const cum = [0];
    for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
    return { coords, xy, cum, kx };
  }

  /** nejbližší bod trasy: vzdálenost od začátku trasy (d) a od trasy (off), v metrech */
  function project(sh, latlng) {
    const [px, py] = toXY(latlng.lat, latlng.lng, sh.kx);
    let best = { d: 0, off: Infinity };
    for (let i = 1; i < sh.xy.length; i++) {
      const [ax, ay] = sh.xy[i - 1], [bx, by] = sh.xy[i];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      const off = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
      if (off < best.off) best = { d: sh.cum[i - 1] + (sh.cum[i] - sh.cum[i - 1]) * t, off };
    }
    return best;
  }

  function pointAt(sh, d) {
    const c = sh.cum;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= d) lo = mid; else hi = mid; }
    const seg = c[hi] - c[lo];
    const t = seg ? Math.max(0, Math.min(1, (d - c[lo]) / seg)) : 0;
    const [aLng, aLat] = sh.coords[lo], [bLng, bLat] = sh.coords[hi];
    return L.latLng(aLat + (bLat - aLat) * t, aLng + (bLng - aLng) * t);
  }

  /** GPS poloha bývá o desítky metrů vedle; je-li blízko trasy spoje, přichytíme ji na trasu */
  function snapToShape(trip, latlng) {
    const sh = shapes.get(trip);
    if (!sh || typeof sh !== "object") return latlng;
    const pr = project(sh, latlng);
    return pr.off < SHAPE_MAX_OFFSET ? pointAt(sh, pr.d) : latlng;
  }

  /** po načtení trasy hned přichytit stojící vozidla toho spoje */
  function onShapeLoaded(trip) {
    for (const v of vehicles.values()) {
      if (v.props.gtfs_trip_id === trip && !moving.has(v.id)) setPos(v, snapToShape(trip, v.raw));
    }
  }

  /** force = trasa otevřeného spoje: přednostně a bez ohledu na rozpočet */
  function requestShape(v, force = false) {
    const trip = v.props.gtfs_trip_id;
    if (!trip || shapes.has(trip)) return;
    if (shapes.size > 600) for (const [k, s] of shapes) if (s !== "pending") shapes.delete(k);
    shapes.set(trip, "pending");
    const item = { trip, vehicleId: v.id, force };
    if (force) shapeQueue.unshift(item); else shapeQueue.push(item);
    pumpShapes();
  }

  function pumpShapes() {
    clearTimeout(shapePumpTimer);
    while (shapeInflight < SHAPE_CONCURRENCY && shapeQueue.length) {
      const { trip, vehicleId, force } = shapeQueue[0];
      const v = vehicles.get(vehicleId);
      // vozidlo mezitím zmizelo z výřezu nebo přejelo na jiný spoj → trasu teď nepotřebujeme
      if (!force && (!v || v.mode !== "label" || v.props.gtfs_trip_id !== trip)) { shapeQueue.shift(); shapes.delete(trip); continue; }
      const wait = shapeToken();
      if (wait > 0) { shapePumpTimer = setTimeout(pumpShapes, wait); return; }
      shapeQueue.shift();
      shapeInflight++;
      // trasa podle spoje (ne podle vozidla: to během dne přejíždí mezi spoji)
      apiFetch(`/v2/public/gtfs/trips/${encodeURIComponent(trip)}`, [["scopes", "shapes"]])
        .then((data) => { shapes.set(trip, buildShape(data?.shapes?.features) || "none"); onShapeLoaded(trip); if (openId) refreshCard(openId); drawXferRoutes(); })
        .catch((e) => {
          if (e.status === 429) {
            shapes.delete(trip); // zkusíme později
            shapePauseUntil = Date.now() + Math.max(5, e.retryAfter || 10) * 1000;
          } else shapes.set(trip, "none");
        })
        .finally(() => { shapeInflight--; pumpShapes(); });
    }
  }

  function upsert(feature, now) {
    const g = feature.geometry;
    const p = feature.properties || {};
    if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) return null;
    const id = p.vehicle_id || p.gtfs_trip_id;
    if (!id) return null;
    const latlng = L.latLng(g.coordinates[1], g.coordinates[0]);
    noteLineTrip(p);

    let v = vehicles.get(id);
    if (!v) {
      const dot = L.circleMarker(latlng, { renderer: dotRenderer, radius: dotRadius(), fillOpacity: 1, ...dotStyle(p) })
        .on("click", () => openCard(id));
      v = { id, props: p, pos: latlng, raw: latlng, from: latlng, to: latlng, path: null, t0: now, dur: 0,
        lastChange: 0, interval: 0, dot, label: null, iconKey: "", mode: null };
      vehicles.set(id, v);
      sync(v);
      return id;
    }

    const prev = v.props;
    v.props = p;
    if (colorFor(prev) !== colorFor(p) || (prev.delay ?? 0) >= 180 !== (p.delay ?? 0) >= 180) v.dot.setStyle(dotStyle(p));
    if (v.label) {
      const { key, icon } = iconFor(p, v.iconKey);
      if (icon) { v.label.setIcon(icon); v.iconKey = key; }
    }

    // Poloha se nezměnila = vozidlo zatím neposlalo novou polohu (nebo stojí). Rozjetou animaci necháme doběhnout.
    const changed = !v.raw.equals(latlng);
    if (changed) {
      // jak často tohle vozidlo reálně hlásí polohu (klouzavý průměr, dlouhé stání nepočítáme)
      const gap = v.lastChange ? now - v.lastChange : 0;
      // (kratší mezery než interval stahování jsou jen extra načtení po posunu mapy → ignorovat)
      if (gap >= POLL_MS * 0.8 && gap < 45000) v.interval = v.interval ? 0.5 * v.interval + 0.5 * gap : gap;
      v.lastChange = now;
      v.raw = latlng;

      const animate = map.getZoom() >= ANIM_ZOOM && v.mode !== null &&
        (viewBounds.contains(v.pos) || viewBounds.contains(latlng)) && v.pos.distanceTo(latlng) <= SNAP_METERS;
      if (animate) {
        v.from = v.pos;
        v.to = snapToShape(p.gtfs_trip_id, latlng);
        v.t0 = now;
        // animace trvá tak dlouho, jak často vozidlo hlásí polohu → plynule navazuje na další hlášení
        // (+15 %, aby další poloha přišla ještě během pohybu a vozidlo se nezastavovalo)
        v.dur = Math.max(currentPollMs(), Math.min(35000, (v.interval || currentPollMs() * 1.5) * 1.15));
        v.path = null;
        const sh = shapes.get(p.gtfs_trip_id);
        if (sh && typeof sh === "object") {
          const a = project(sh, v.from), b = project(sh, latlng);
          if (a.off < SHAPE_MAX_OFFSET && b.off < SHAPE_MAX_OFFSET && b.d >= a.d - 5 && b.d - a.d < SNAP_METERS) {
            v.path = { sh, d0: a.d, d1: b.d };
          }
        }
        moving.add(id);
      } else {
        moving.delete(id);
        v.path = null;
        setPos(v, snapToShape(p.gtfs_trip_id, latlng));
      }
    }
    sync(v);

    if (openId === id) { refreshCard(id); loadDetail(id); if (stopView) loadDepartures(); }
    return id;
  }

  // plynulý pohyb: po trase spoje, pokud ji známe, jinak přímo; smyčka běží jen když se něco hýbe
  let rafId = 0;
  function startAnimation() {
    if (!rafId && moving.size) rafId = requestAnimationFrame(animate);
  }
  function positionAt(v, t) {
    if (v.path) return pointAt(v.path.sh, v.path.d0 + (v.path.d1 - v.path.d0) * t);
    if (t >= 1) return v.to;
    return L.latLng(v.from.lat + (v.to.lat - v.from.lat) * t, v.from.lng + (v.to.lng - v.from.lng) * t);
  }
  function animate(now) {
    rafId = 0;
    for (const id of moving) {
      const v = vehicles.get(id);
      if (!v) { moving.delete(id); continue; }
      const t = Math.min(1, (now - v.t0) / v.dur);
      setPos(v, positionAt(v, t));
      if (t >= 1) moving.delete(id);
    }
    startAnimation();
  }

  function finishAnimations() {
    for (const id of moving) { const v = vehicles.get(id); if (v) setPos(v, positionAt(v, 1)); }
    moving.clear();
  }

  function updateCount(extra = lastOk ? ` · ${lastOk.toLocaleTimeString("cs-CZ")}` : "") {
    let shown = 0;
    for (const v of vehicles.values()) if (v.mode) shown++;
    const f = lineFilter ? ` · filtr: ${[...lineFilter].join(", ")}` : "";
    setStatus(`${shown} / ${vehicles.size} vozidel${f}${extra}${pollNote()}`);
  }

  // ---------- vrstva tarifních pásem (#18): oficiální polygony IPR Praha, zjednodušené v scripts/fetch_zones.py ----------
  const ZONES_STORAGE = "emhadecko.layer.zones";
  const $layerZones = document.getElementById("layer-zones");
  const $zonesLegend = document.getElementById("zones-legend");
  map.createPane("zones").style.zIndex = 250; // nad dlaždicemi, pod trasami a vozidly
  map.getPane("zones").style.pointerEvents = "none"; // nebere kliky vozidlům ani zastávkám
  let zonesLayer = null;
  let zonesAttribution = "";

  async function buildZonesLayer() {
    const res = await fetch("zones.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    zonesAttribution = data.attribution || "";
    const group = L.layerGroup();
    zonesFeatures = data.features;
    zoneLabels = L.layerGroup();
    data.features.forEach((f, i) => {
      const prague = f.properties.prague;
      L.geoJSON(f, {
        pane: "zones", interactive: false,
        style: {
          color: prague ? "#1d4ed8" : "#475569", weight: prague ? 2 : 1.2, opacity: 0.7, dashArray: prague ? null : "5 5",
          fillColor: prague ? "#2563eb" : i % 2 ? "#0891b2" : "#7c3aed", fillOpacity: prague ? 0.1 : 0.06,
        },
      }).addTo(group);
      const [lng, lat] = f.properties.label;
      L.marker([lat, lng], {
        pane: "zones", interactive: false, keyboard: false,
        icon: L.divIcon({ className: "", iconSize: [0, 0], html: `<div class="zone-label${prague ? " p" : ""}">${prague ? "P · 0 · B" : `pásmo ${f.properties.zone}`}</div>` }),
      }).addTo(zoneLabels);
    });
    return group;
  }

  // Popisky pásem dávají smysl jen při oddálení (je vidět víc pásem). Při přiblížení by jeden bod
  // "P · 0 · B" ležel náhodně mezi vozidly – místo něj legenda ukáže pásmo středu mapy.
  const ZONE_LABEL_MAX_ZOOM = 11;
  let zonesFeatures = null;
  let zoneLabels = null;
  const $zonesHere = document.getElementById("zones-here");

  function inRing(x, y, r) {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  function zoneAt(latlng) {
    for (const f of zonesFeatures || []) {
      for (const poly of f.geometry.coordinates) {
        if (inRing(latlng.lng, latlng.lat, poly[0]) && !poly.slice(1).some((hole) => inRing(latlng.lng, latlng.lat, hole))) return f.properties;
      }
    }
    return null;
  }

  function updateZoneView() {
    if (!zonesLayer || !map.hasLayer(zonesLayer)) return;
    const showLabels = map.getZoom() <= ZONE_LABEL_MAX_ZOOM;
    if (showLabels && !map.hasLayer(zoneLabels)) zoneLabels.addTo(map);
    if (!showLabels && map.hasLayer(zoneLabels)) zoneLabels.remove();
    const z = zoneAt(map.getCenter());
    $zonesHere.textContent = z ? `Střed mapy: ${z.prague ? "Praha (P, 0, B)" : `pásmo ${z.zone}`}` : "Střed mapy: mimo pásma PID";
  }
  map.on("zoomend moveend", updateZoneView);

  async function setZonesLayer(on) {
    store.set(ZONES_STORAGE, on ? "1" : "0");
    $layerZones.checked = on;
    if (!on) {
      zonesLayer?.remove();
      zoneLabels?.remove();
      if (zonesAttribution) map.attributionControl.removeAttribution(zonesAttribution);
      $zonesLegend.hidden = true;
      return;
    }
    try {
      zonesLayer ??= await buildZonesLayer();
      if (!$layerZones.checked) return; // mezitím vypnuto
      zonesLayer.addTo(map);
      if (zonesAttribution) map.attributionControl.addAttribution(zonesAttribution);
      $zonesLegend.hidden = false;
      updateZoneView();
    } catch (e) {
      console.error(e);
      $layerZones.checked = false;
      setStatus("Vrstvu tarifních pásem se nepodařilo načíst.", false, true);
    }
  }
  $layerZones.addEventListener("change", () => setZonesLayer($layerZones.checked));
  if (store.get(ZONES_STORAGE) === "1") setZonesLayer(true);

  // ---------- výluky a mimořádnosti (RSS pid.cz → alerts.json, generuje workflow) ----------
  const $alerts = document.getElementById("alerts");
  const $alertsBtn = document.getElementById("alerts-btn");
  let alerts = [];
  let alertsGenerated = null;
  let alertsIncomplete = false;

  const isActive = (a, now = Date.now()) => (!a.from || a.from * 1000 <= now) && (!a.to || a.to * 1000 >= now);
  const lineKey = (l) => String(l).trim().toUpperCase();

  function alertsForLine(line) {
    const k = lineKey(line);
    return alerts.filter((a) => isActive(a) && a.lines.some((l) => lineKey(l) === k))
      .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "mimoradnost" ? -1 : 1));
  }

  async function loadAlerts() {
    try {
      const res = await fetch("alerts.json", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      alerts = Array.isArray(data.items) ? data.items : [];
      alertsIncomplete = Array.isArray(data.errors) && data.errors.length > 0;
      alertsGenerated = data.generated ? new Date(data.generated * 1000) : null;
    } catch { return; }
    const active = alerts.filter((a) => isActive(a));
    const incidents = active.filter((a) => a.kind === "mimoradnost").length;
    $alertsBtn.hidden = !alerts.length && !alertsIncomplete;
    $alertsBtn.classList.toggle("has-incident", incidents > 0);
    const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n > 1 && n < 5 ? few : many}`;
    const closures = active.length - incidents;
    $alertsBtn.replaceChildren(
      h("span", { class: "t" }, h("span", { class: "ic" }, "⚠"), alertsIncomplete ? " Omezení provozu · neúplná data" : " Omezení provozu"),
      h("span", { class: "pills" },
        incidents ? h("span", { class: "inc" }, plural(incidents, "mimořádnost", "mimořádnosti", "mimořádností")) : null,
        h("span", { class: "vy" }, plural(closures, "výluka", "výluky", "výluk"))));
    if (!$alerts.hidden) renderAlerts();
    if (openId) refreshCard(openId);
  }

  function alertItem(a, compact = false) {
    return h("li", { class: `al ${a.kind}` },
      h("div", { class: "al-top" },
        h("span", { class: "al-kind" }, a.kind === "mimoradnost" ? "Mimořádnost" : "Výluka"),
        h("span", { class: "al-when" }, a.when)),
      h("a", { class: "al-title", href: a.link, target: "_blank", rel: "noopener" }, a.title, " ↗"),
      !compact && a.lines.length ? h("div", { class: "al-lines" }, a.lines.slice(0, 24).map((l) => h("span", null, l)),
        a.lines.length > 24 ? h("span", null, `+${a.lines.length - 24}`) : null) : null,
      !compact && a.summary ? h("p", { class: "al-sum" }, a.summary) : null);
  }

  function renderAlerts() {
    const now = Date.now();
    const match = (a) => !lineFilter || a.lines.some((l) => lineFilter.has(lineKey(l)));
    const shown = alerts.filter(match);
    const incidents = shown.filter((a) => a.kind === "mimoradnost" && isActive(a, now));
    const current = shown.filter((a) => a.kind === "vyluka" && isActive(a, now));
    const upcoming = shown.filter((a) => a.from && a.from * 1000 > now).sort((a, b) => a.from - b.from);

    const close = closeButton();
    close.addEventListener("click", closeAlerts);
    const section = (title, items, cls = "") => items.length
      ? [h("h3", { class: `al-h ${cls}` }, `${title} (${items.length})`), h("ul", { class: "al-list" }, items.map((a) => alertItem(a)))]
      : [];

    $alerts.replaceChildren(h("div", { class: "vc", style: "--c:#b45309" },
      h("header", { class: "vc-head" },
        h("div", { class: "vc-line" }, "⚠"),
        h("div", { class: "vc-title" },
          h("div", { class: "vc-kind" }, "PID"),
          h("div", { class: "vc-dest" }, "Výluky a mimořádnosti")),
        close),
      h("div", { class: "al-note" },
        lineFilter ? `Jen pro linky: ${[...lineFilter].join(", ")} (podle filtru linek)` : "Tip: filtrem linek v panelu zúžíš výpis na své linky.",
        alertsGenerated ? h("span", null, ` · ${alertsIncomplete ? "poslední kontrola" : "aktualizováno"} ${alertsGenerated.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`) : null),
      alertsIncomplete ? h("div", { class: "vc-msg" }, "Některé údaje se nepodařilo obnovit. Zobrazené informace mohou být zastaralé nebo neúplné.") : null,
      ...section("Mimořádnosti", incidents, "inc"),
      ...section("Aktuální výluky", current),
      ...section("Připravované (7 dní)", upcoming, "up"),
      !alertsIncomplete && !incidents.length && !current.length && !upcoming.length ? h("div", { class: "vc-msg" }, "Nic nenalezeno.") : null,
      h("footer", { class: "vc-foot" }, "Zdroj: RSS pid.cz")));
  }

  function openAlerts() {
    if (openId) closeCard();
    $alerts.hidden = false;
    $alerts.scrollTop = 0;
    renderAlerts();
  }
  function closeAlerts() { $alerts.hidden = true; $alerts.replaceChildren(); }

  $alertsBtn.addEventListener("click", () => ($alerts.hidden ? openAlerts() : closeAlerts()));
  $lines.addEventListener("input", () => { if (!$alerts.hidden) renderAlerts(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$alerts.hidden) closeAlerts(); });
  loadAlerts();
  setInterval(loadAlerts, 5 * 60 * 1000);

  /** upozornění v kartě vozidla */
  function renderLineAlerts(line) {
    const list = alertsForLine(line);
    if (!list.length) return null;
    const inc = list.some((a) => a.kind === "mimoradnost");
    return h("details", { class: `vc-alerts ${inc ? "inc" : ""}` },
      h("summary", null, h("span", { class: "ic" }, "⚠"),
        ` Na lince ${line} ${list.length === 1 ? "platí 1 omezení" : `platí ${list.length} ${list.length < 5 ? "omezení" : "omezení"}`}`),
      h("ul", { class: "al-list" }, list.map((a) => alertItem(a, true))));
  }

  // ---------- zastávky hledaných linek + panel zastávky s odjezdy/příjezdy (#25) ----------
  const LINE_STOPS_STORAGE = "emhadecko.layer.linestops";
  const $layerLineStops = document.getElementById("layer-linestops");
  map.createPane("lines").style.zIndex = 380; // trasy hledaných linek: pod trasou otevřeného spoje
  map.createPane("lineStops").style.zIndex = 420; // zastávky: nad tečkami vozidel, ať jdou rozkliknout
  const lineStopsLayer = L.layerGroup().addTo(map);
  let lineStopsOn = store.get(LINE_STOPS_STORAGE) !== "0";
  $layerLineStops.checked = lineStopsOn;
  const MAX_TRIPS_PER_LINE = 4; // kolik spojů nejvýš zkusíme, než najdeme oba směry

  /** linka → spoje, které jsme viděli v polohách (z nich bereme jízdní řád) */
  const lineTrips = new Map();
  /** linka → {state, loading, trips: [{shape, stops}], sigs, tried, color} */
  const lineData = new Map();

  const routeKey = (p) => String(p.gtfs_route_short_name).toUpperCase();
  function noteLineTrip(p) {
    if (!p?.gtfs_trip_id) return;
    const l = routeKey(p);
    if (!lineTrips.has(l)) lineTrips.set(l, new Set());
    lineTrips.get(l).add(p.gtfs_trip_id);
  }

  /** počká na token ze společného rozpočtu (stejný jako pro trasy), ať nevznikají nárazy */
  async function waitToken() {
    for (;;) {
      const w = shapeToken();
      if (!w) return;
      await new Promise((r) => setTimeout(r, w));
    }
  }

  // linky, které právě nejedou: zastávky a trasa z jízdního řádu (lines/*.json, generuje scripts/build_lines.py)
  let linesIndexP = null;
  function linesIndex() {
    linesIndexP ??= fetch("lines/index.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    return linesIndexP;
  }

  async function loadStaticLine(line, d) {
    const idx = await linesIndex();
    const file = idx?.lines?.[line];
    if (!file) return false;
    const data = await fetch(`lines/${file}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!data?.directions?.length) return false;
    d.static = true;
    d.attribution = idx.attribution;
    d.trips = data.directions.map((dir) => ({
      trip: null,
      headsign: dir.headsign,
      shape: buildShape((dir.shape || []).map(([lat, lon]) => ({ geometry: { coordinates: [lon, lat] } }))),
      stops: dir.stops.map((st) => ({ name: st.name, node: st.node, zone: st.zone, lat: st.lat, lng: st.lon })),
    }));
    d.color = colorFor({ route_type: data.directions[0].type || data.type, gtfs_route_short_name: line });
    if (d.attribution) map.attributionControl.addAttribution(d.attribution);
    return true;
  }

  /** souběžná volání pro tutéž linku sdílí jeden běh (hledání čeká na načtení zastávek) */
  const linePromises = new Map();
  function ensureLine(line) {
    if (linePromises.has(line)) return linePromises.get(line);
    const pr = loadLine(line).finally(() => linePromises.delete(line));
    linePromises.set(line, pr);
    return pr;
  }

  async function loadLine(line) {
    let d = lineData.get(line);
    if (d && (d.loading || d.state === "ready")) return;
    d = d || { state: "loading", loading: false, trips: [], sigs: new Set(), tried: new Set(), color: null };
    lineData.set(line, d);
    const candidates = [...(lineTrips.get(line) || [])].filter((t) => !d.tried.has(t));
    if (!candidates.length && !d.trips.length) {
      // nic nejede → jízdní řád
      d.loading = true;
      const ok = await loadStaticLine(line, d);
      d.loading = false;
      d.state = ok ? "ready" : "notrips";
      renderChips();
      drawLineStops();
      return;
    }
    if (!candidates.length) { d.state = "ready"; drawLineStops(); return; }
    d.loading = true;
    for (const trip of candidates) {
      if (d.trips.length >= 2 || d.tried.size >= MAX_TRIPS_PER_LINE || !chips.includes(line)) break;
      d.tried.add(trip);
      await waitToken();
      try {
        const [st, ids] = await Promise.all([
          // trasu už můžeme mít z vozidla na mapě – pak ji znovu nestahovat
          apiFetch(`/v2/public/gtfs/trips/${encodeURIComponent(trip)}`,
            [["scopes", "info"], ["scopes", "stop_times"], ...(typeof shapes.get(trip) === "object" ? [] : [["scopes", "shapes"]])]),
          loadTripStops(trip),
        ]);
        const stops = (st?.stop_times?.features || [])
          .filter((f) => f.geometry?.coordinates && f.properties)
          .sort((a, b) => a.properties.stop_sequence - b.properties.stop_sequence)
          .map((f) => {
            const sid = ids?.get(Number(f.properties.stop_sequence))?.stop_id;
            const node = /^U(\d+)Z/.exec(sid || "")?.[1] || null;
            return { name: f.properties.stop_name, node, zone: f.properties.zone_id, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
          });
        if (stops.length < 2) continue;
        const info = st.info || st;
        d.color = d.color || colorFor({ route_type: info.route_type, gtfs_route_short_name: line });
        const sig = `${stops[0].name}→${stops[stops.length - 1].name}`;
        const rev = `${stops[stops.length - 1].name}→${stops[0].name}`;
        if (d.sigs.has(sig)) continue; // stejný směr už máme
        const known = shapes.get(trip);
        const sh = typeof known === "object" ? known : buildShape(st.shapes?.features);
        if (sh) shapes.set(trip, sh);
        d.sigs.add(sig);
        d.trips.push({ trip, shape: sh, stops, reverseOf: d.sigs.has(rev) });
        drawLineStops();
      } catch (e) {
        if (e.status === 429) break; // přetížení: zkusíme při další obnově
      }
    }
    if (!d.trips.length && (await loadStaticLine(line, d))) renderChips();
    d.loading = false;
    d.state = d.trips.length ? "ready" : "none";
    drawLineStops();
  }

  function drawLineStops() {
    lineStopsLayer.clearLayers();
    if (!lineStopsOn) return;
    /** uzel zastávky → sloučená značka (oba směry, víc linek) */
    const nodes = new Map();
    for (const line of chips) {
      const d = lineData.get(line);
      if (!d) continue;
      for (const t of d.trips) {
        if (t.shape) {
          L.polyline(t.shape.coords.map(([lng, lat]) => [lat, lng]), {
            pane: "lines", color: d.color, weight: 4, opacity: 0.45, interactive: false, dashArray: d.static ? "8 7" : null,
          })
            .addTo(lineStopsLayer);
        }
        for (const s of t.stops) {
          const key = s.node || s.name;
          const n = nodes.get(key) || { name: s.name, node: s.node, zone: s.zone, lat: 0, lng: 0, count: 0, lines: new Map() };
          n.lat += s.lat; n.lng += s.lng; n.count++;
          n.lines.set(line, d.color);
          nodes.set(key, n);
        }
      }
    }
    for (const n of nodes.values()) {
      const lines = [...n.lines.keys()];
      const color = lines.length === 1 ? n.lines.get(lines[0]) : "#334155";
      L.circleMarker([n.lat / n.count, n.lng / n.count], {
        pane: "lineStops", radius: 5, weight: 2.5, color, fillColor: "#fff", fillOpacity: 1,
      })
        .bindTooltip(`${n.name} · ${lines.join(", ")}`, { direction: "top", offset: [0, -6] })
        .on("click", () => openStopPanel({ name: n.name, node: n.node, zone: n.zone, lines }))
        .addTo(lineStopsLayer);
    }
  }

  function syncLineStops() {
    for (const line of chips) {
      let d = lineData.get(line);
      if (d?.static && !d.loading && (lineTrips.get(line)?.size || 0) > 0) {
        lineData.delete(line); // linka se rozjela → raději živá data
        d = null;
      }
      if (!d || ((d.state === "notrips" || d.state === "none") && [...(lineTrips.get(line) || [])].some((t) => !d.tried.has(t)))) {
        if (d) d.state = "loading";
        ensureLine(line);
      }
    }
    drawLineStops();
  }

  $layerLineStops.addEventListener("change", () => {
    lineStopsOn = $layerLineStops.checked;
    store.set(LINE_STOPS_STORAGE, lineStopsOn ? "1" : "0");
    if (lineStopsOn) syncLineStops(); else drawLineStops();
  });

  // ---------- panel zastávky ----------
  /** @type {null | {name, node, zone, lines: string[], mode: "departures"|"arrivals", all: boolean, data, error, loading, at}} */
  let stopPanel = null;

  function openStopPanel(stop) {
    if (openId) closeCard();
    if (!$alerts.hidden) closeAlerts();
    stopPanel = { ...stop, mode: "departures", all: !stop.lines?.length, data: null, error: null, loading: false, at: 0 };
    $card.hidden = false;
    $card.scrollTop = 0;
    renderStopPanel();
    loadStopBoard(true);
  }

  function closeStopPanel() {
    stopPanel = null;
    if (!openId) { $card.hidden = true; $card.replaceChildren(); }
  }

  async function loadStopBoard(force = false) {
    const sp = stopPanel;
    if (!sp || !sp.node || sp.loading) return;
    if (!force && Date.now() - sp.at < 15_000) return;
    sp.loading = true;
    const mode = sp.mode;
    try {
      const data = await apiFetch("/v2/pid/departureboards", [["aswIds[]", sp.node], ["mode", mode], ["limit", "40"], ["minutesAfter", "90"]]);
      if (stopPanel !== sp || sp.mode !== mode) return;
      sp.data = data;
      sp.error = null;
      sp.next = undefined;
      const wanted = (dep) => sp.lines?.includes(String(dep.route?.short_name).toUpperCase());
      if (mode === "departures" && sp.lines?.length && !(data.departures || []).some(wanted)) {
        // hledaná linka v příštích 90 min neodjíždí → nejbližší spoj v příštích 6 h
        const later = await apiFetch("/v2/pid/departureboards", [["aswIds[]", sp.node], ["mode", "departures"], ["limit", "40"], ["minutesAfter", "360"]]).catch(() => null);
        if (stopPanel === sp) sp.next = (later?.departures || []).find(wanted) || null;
      }
    } catch (e) {
      if (stopPanel === sp) sp.error = friendlyError(e);
    } finally {
      sp.loading = false;
      sp.at = Date.now();
      if (stopPanel === sp) renderStopPanel();
    }
  }

  function boardRow(dep, mode) {
    const route = dep.route || {}, trip = dep.trip || {};
    const ts = (mode === "arrivals" ? dep.arrival_timestamp : dep.departure_timestamp) || dep.departure_timestamp || dep.arrival_timestamp || {};
    const c = colorFor({ route_type: NUM_RT[route.type] || "bus", gtfs_route_short_name: route.short_name });
    const sched = ts.scheduled ? new Date(ts.scheduled).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }) : "";
    const m = ts.minutes;
    const when = m == null ? "" : m === "<1" || m === "0" ? "teď" : `${m} min`;
    const delayMin = dep.delay?.is_available ? dep.delay.minutes : null;
    const veh = [...vehicles.values()].find((x) => x.props.gtfs_trip_id === trip.id);
    const li = h("li", { class: `${trip.is_canceled ? "canceled" : ""} ${veh ? "has-veh" : ""}`, title: veh ? "Ukázat vozidlo" : null },
      h("span", { class: "dl", style: `background:${c}` }, route.short_name),
      h("span", { class: "dh" }, trip.headsign,
        trip.is_wheelchair_accessible ? h("span", { class: "acc", title: "bezbariérové" }, " ♿") : null,
        trip.is_canceled ? h("span", { class: "tag" }, "odřeknuto") : null,
        dep.stop?.platform_code ? h("small", { class: "pl" }, ` · nást. ${dep.stop.platform_code}`) : null),
      h("span", { class: "dt" },
        h("b", null, when),
        h("small", { class: delayMin >= 1 ? "late" : null }, delayMin >= 1 ? `${sched} +${delayMin}` : sched)));
    if (veh) li.addEventListener("click", () => openCard(veh.id));
    return li;
  }

  function renderStopPanel() {
    const sp = stopPanel;
    if (!sp) return;
    if (document.activeElement?.tagName === "SELECT" && $card.contains(document.activeElement)) return;
    const close = closeButton();
    close.addEventListener("click", closeStopPanel);
    const tab = (mode, label) => {
      const b = h("button", { type: "button", role: "tab", "aria-selected": sp.mode === mode ? "true" : "false", class: sp.mode === mode ? "on" : null }, label);
      b.addEventListener("click", () => { if (sp.mode === mode) return; sp.mode = mode; sp.data = null; renderStopPanel(); loadStopBoard(true); });
      return b;
    };
    let toggle = null;
    if (sp.lines?.length) {
      toggle = h("label", { class: "sp-all" }, h("input", { type: "checkbox", checked: sp.all ? "checked" : null }), " všechny linky");
      toggle.querySelector("input").addEventListener("change", (e) => { sp.all = e.target.checked; renderStopPanel(); });
    }

    let list;
    const deps = (sp.data?.departures || []).filter((dep) => sp.all || !sp.lines?.length || sp.lines.includes(String(dep.route?.short_name).toUpperCase()));
    if (!sp.node) list = h("div", { class: "vc-msg" }, "U této zastávky chybí identifikátor, odjezdy nelze načíst.");
    else if (sp.error && !sp.data) list = h("div", { class: "vc-msg" }, `Nepodařilo se načíst. ${sp.error}`);
    else if (!sp.data) list = h("div", { class: "vc-stops-sk" }, h("span", { class: "sk" }), h("span", { class: "sk" }), h("span", { class: "sk sk-w60" }));
    else if (!deps.length) {
      const nx = sp.next, ts = nx?.departure_timestamp?.predicted || nx?.departure_timestamp?.scheduled;
      list = h("div", { class: "vc-msg" },
        sp.mode === "arrivals" ? "V příštích 90 minutách sem nic nepřijede." : "V příštích 90 minutách odsud nic neodjede.",
        nx && ts ? h("div", { class: "sp-next" }, "Nejbližší spoj linky ", h("b", null, nx.route?.short_name), " odjíždí ",
          h("b", null, new Date(ts).toLocaleString("cs-CZ", { weekday: "short", hour: "2-digit", minute: "2-digit" })), ` (směr ${nx.trip?.headsign || "?"}).`) : null,
        nx === null ? h("div", { class: "sp-next" }, `Linka ${sp.lines.join(", ")} odsud v příštích 6 hodinách nejede.`) : null,
        !sp.all && sp.lines?.length ? " Zkus „všechny linky“." : "");
    }
    else list = h("ul", { class: "vc-deps" }, deps.slice(0, 25).map((dep) => boardRow(dep, sp.mode)));

    $card.replaceChildren(h("div", { class: "vc", style: "--c:#334155" },
      h("header", { class: "vc-head" },
        h("div", { class: "vc-line sp-ic", "aria-hidden": "true" }, "●"),
        h("div", { class: "vc-title" },
          h("div", { class: "vc-kind" }, sp.zone ? `Zastávka · pásmo ${String(sp.zone).replace(",", "/")}` : "Zastávka"),
          h("div", { class: "vc-dest", title: sp.name }, sp.name)),
        close),
      h("div", { class: "sp-bar" },
        h("div", { class: "sp-tabs", role: "tablist", "aria-label": "Odjezdy nebo příjezdy" }, tab("departures", "Odjezdy"), tab("arrivals", "Příjezdy")),
        toggle),
      sp.lines?.length && !sp.all ? h("div", { class: "sp-lines" }, "Jen linky: ", sp.lines.join(", ")) : null,
      list,
      h("footer", { class: "vc-foot" }, "Všechna nástupiště zastávky · obnova à 15 s")));
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && stopPanel && !openId) closeStopPanel(); });

  // ---------- hledání linky ve filtru ----------
  // Filtr je nový záměr: karta jiné linky se zavře (a s ní zvýraznění přestupů). Mapa se během psaní
  // nehýbe; až po dopsání (0,8 s) nebo Enteru najdeme vozidla v celé síti a ukážeme je.
  const LOCATE_DELAY_MS = 800;
  let locateTimer = null;
  let locateSeq = 0;
  let locateAbort = null;
  const located = new Map(); // klíč filtru → body vozidel (cache pro tutéž hodnotu)

  /**
   * commit = filtr je hotový (Enter, čárka, odebrání chipu): hned zavřít kartu jiné linky a případně najít vozidla.
   * Při psaní se obojí odloží o LOCATE_DELAY_MS, ať "2" na cestě k "22" nic nezavře ani neposune mapu.
   * locate = false: jen filtrovat (odebrání chipu, Esc) – mapou nehýbat.
   */
  function onLineFilter(commit, locate = true) {
    const parts = [...new Set([...chips, ...typedLines()])];
    lineFilter = parts.length ? new Set(parts) : null;
    applyFilter();
    clearTimeout(locateTimer);
    locateAbort?.abort();
    const settle = () => {
      const open = openId && vehicles.get(openId);
      if (open && lineFilter && !matchesFilter(open.props)) closeCard();
      if (lineFilter && locate) locateMatches(commit);
    };
    if (commit) settle();
    else locateTimer = setTimeout(settle, LOCATE_DELAY_MS);
  }

  async function locateMatches(force) {
    const key = [...lineFilter].sort().join(", ");
    const view = map.getBounds();
    const inView = [...vehicles.values()].filter((v) => matchesFilter(v.props) && view.contains(v.pos));
    if (!force && inView.length) return; // něco je vidět → mapou nehýbat
    const seq = ++locateSeq;
    let pts = located.get(key);
    if (!pts) {
      if (backoffMs) return; // po 429 nepřidávat požadavky
      locateAbort = new AbortController();
      try {
        const types = [...enabledTypes];
        const params = types.length === 1 ? [["routeType", types[0]]] : [];
        const url = new URL("/v2/public/vehiclepositions", CFG.apiBase);
        params.forEach(([k, v]) => url.searchParams.append(k, v));
        const key2 = getKey();
        const res = await fetch(url, { headers: { Accept: "application/json", ...(key2 ? { "X-Access-Token": key2 } : {}) }, signal: locateAbort.signal });
        if (!res.ok) throw httpError(res);
        const data = await res.json();
        pts = (data.features || [])
          .filter((f) => f.geometry?.type === "Point" && matchesFilter(f.properties || {}) && enabledTypes.has(f.properties.route_type))
          .map((f) => { noteLineTrip(f.properties); return f; })
          .map((f) => L.latLng(f.geometry.coordinates[1], f.geometry.coordinates[0]));
        located.set(key, pts);
        if (lineStopsOn) syncLineStops();
        if (located.size > 30) located.delete(located.keys().next().value);
      } catch (e) {
        if (e.name !== "AbortError" && e.status === 429) setStatus("PID API je teď přetížené, linku zkus najít za chvíli.", false, true);
        return;
      }
    }
    if (seq !== locateSeq || [...lineFilter].sort().join(", ") !== key) return; // mezitím jiný filtr
    if (!pts.length) {
      // nejede → zkusit jízdní řád (zastávky a trasa linky)
      const lines = [...lineFilter];
      await Promise.all(lines.map((l) => ensureLine(l)));
      if (seq !== locateSeq) return;
      const stat = lines.flatMap((l) => (lineData.get(l)?.static ? lineData.get(l).trips.flatMap((t) => t.stops) : []));
      if (stat.length) {
        map.fitBounds(L.latLngBounds(stat.map((x) => [x.lat, x.lng])), { maxZoom: 15, padding: [40, 40] });
        setStatus(`Linka ${key} teď nejede – zastávky a trasa podle jízdního řádu.`, false, true);
      } else {
        setStatus(`Linka ${key} teď v datech není (nejede, nebo je to překlep).`, false, true);
      }
      return;
    }
    const bounds = L.latLngBounds(pts);
    // levá karta (desktop) nebo spodní panel (mobil) by zakryly část mapy
    const c = $card.hidden ? null : $card.getBoundingClientRect();
    const sheet = c && c.left <= 1;
    const opts = { maxZoom: 15, paddingTopLeft: [c && !sheet ? c.right + 20 : 40, 40], paddingBottomRight: [40, sheet ? c.height + 20 : 40] };
    if (map.getBoundsZoom(bounds, false, L.point(80, 80)) < 10) {
      // linka přes celý kraj: neoddalovat na nečitelnou úroveň, ukázat nejbližší vozidlo
      const center = map.getCenter();
      const nearest = pts.reduce((a, b) => (a.distanceTo(center) <= b.distanceTo(center) ? a : b));
      map.setView(nearest, 13);
    } else {
      map.fitBounds(bounds, opts);
    }
    setStatus(`Linka ${key}: ${pts.length} ${pts.length === 1 ? "vozidlo" : pts.length < 5 ? "vozidla" : "vozidel"}`);
  }

  // ---------- fetch ----------
  function bboxParam() {
    const b = map.getBounds().pad(0.2);
    const f = (n) => n.toFixed(5);
    // oříznutí na oblast PID a okolí (Worker jiný výřez odmítne a stejně tam nic nejezdí)
    const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
    const north = clamp(b.getNorth(), 48, 52), south = clamp(b.getSouth(), 48, 52);
    const west = clamp(b.getWest(), 11, 20), east = clamp(b.getEast(), 11, 20);
    // formát: topLeft.lat,topLeft.lon,bottomRight.lat,bottomRight.lon
    return [f(north), f(west), f(south), f(east)].join(",");
  }

  let inflight = null;

  async function fetchPositions() {
    const url = new URL("/v2/public/vehiclepositions", CFG.apiBase);
    url.searchParams.set("boundingBox", bboxParam());
    const headers = { Accept: "application/json" };
    if (!CFG.proxy) {
      let key = getKey();
      if (!key) key = await askKey();
      if (!key) throw new Error("Chybí API klíč.");
      headers["X-Access-Token"] = key;
    }

    inflight?.abort();
    inflight = new AbortController();
    const res = await fetch(url, { headers, signal: inflight.signal, cache: "no-store" });
    if (!CFG.proxy && (res.status === 401 || res.status === 403)) {
      setStatus("Neplatný API klíč.", true);
      await askKey();
      throw new Error(`HTTP ${res.status}: neautorizováno`);
    }
    if (!res.ok) throw httpError(res);
    lastFetchBounds = map.getBounds().pad(0.2);
    return res.json();
  }

  let backoffMs = 0; // po 429 prodlužujeme interval (20 → 40 → 60 s)
  let lastFetchBounds = null; // výřez, který pokrývají naposledy stažená data

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
        if (!seen.has(id) && openId !== id) removeVehicle(v);
      }
      pumpShapes();
      if (computeFewMode() !== fewMode) syncAll();
      if (chips.length && $chips.querySelector("li:not([style])")) renderChips(); // doplnit barvy linek
      if (chips.length && lineStopsOn) syncLineStops();
      if (stopPanel) loadStopBoard();
      backoffMs = 0;
      lastOk = new Date();
      updateCount();
      startAnimation();
    } catch (e) {
      if (e.name === "AbortError") {
        // zrušeno novějším požadavkem
      } else if (e.status === 429) {
        backoffMs = Math.min(60_000, Math.max(backoffMs * 2, (e.retryAfter || 0) * 1000, 20_000));
        const at = lastOk ? ` · data z ${lastOk.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}` : "";
        const why = e.source === "worker" ? "Moc požadavků z tohoto zařízení" : "PID API je teď přetížené";
        setStatus(`${why}${at} · další pokus za ${Math.round(backoffMs / 1000)} s`, false, true);
      } else {
        console.error(e);
        setStatus(`Chyba: ${e.message}`, true);
      }
    } finally {
      schedule();
    }
  }

  // ---------- šetření požadavků: nečinnost a oddálená mapa ----------
  // Nejvíc požadavků dělají zapomenuté otevřené záložky, ne lidé, co se dívají.
  const IDLE_SLOW_MS = 10 * 60_000; // po 10 min bez aktivity stahovat jen každých 30 s
  const IDLE_PAUSE_MS = 60 * 60_000; // po hodině bez aktivity stahování pozastavit
  const IDLE_POLL_MS = 30_000;
  const FAR_ZOOM = 12; // při oddálení (celý kraj) stačí obnova à 20 s, pohyb tam není vidět
  const FAR_POLL_MS = 20_000;
  let lastActivity = Date.now();
  let paused = false;
  const $paused = document.getElementById("paused");

  function currentPollMs() {
    if (Date.now() - lastActivity >= IDLE_SLOW_MS) return Math.max(POLL_MS, IDLE_POLL_MS);
    if (map.getZoom() < FAR_ZOOM) return Math.max(POLL_MS, FAR_POLL_MS);
    return POLL_MS;
  }

  function pollNote() {
    if (paused) return "";
    if (Date.now() - lastActivity >= IDLE_SLOW_MS) return " · úsporný režim";
    return "";
  }

  // ---------- upozornění: úsporný režim (toast) a pozastavení (karta) ----------
  const $toast = document.getElementById("toast");
  const $live = document.getElementById("live");
  let slowNotified = false;
  let toastTimer = null;

  function setLive(mode) {
    $live.textContent = { live: "● live", slow: "● úspora", paused: "❙❙ pauza" }[mode];
    $live.className = `live ${mode}`;
  }

  function hideToast() { clearTimeout(toastTimer); $toast.hidden = true; $toast.replaceChildren(); }

  function showSlowToast() {
    const btn = h("button", { type: "button" }, "Obnovit hned");
    btn.addEventListener("click", activity);
    $toast.replaceChildren(
      h("span", { class: "ic", "aria-hidden": "true" }, "◷"),
      h("div", { class: "tx" }, h("b", null, "Úsporný režim"),
        h("div", null, "Chvíli tu nic neděláš, polohy obnovujeme jen každých 30 s.")),
      btn);
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 8000);
  }

  function showPaused() {
    const btn = h("button", { type: "button" }, "Pokračovat v živém sledování");
    btn.addEventListener("click", activity);
    const at = lastOk ? lastOk.toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" }) : null;
    $paused.replaceChildren(
      h("div", { class: "pt" }, h("span", { class: "ic", "aria-hidden": "true" }, "❙❙"), h("b", null, "Načítání pozastaveno")),
      h("div", { class: "px" }, "Hodinu tu nikdo nic nedělal, tak jsme stahování dat zastavili. ",
        at ? `Polohy vozidel jsou z ${at} a neaktualizují se.` : "Polohy vozidel se neaktualizují."),
      btn);
    $paused.hidden = false;
    map.getContainer().classList.add("is-paused");
    setLive("paused");
    hideToast();
  }

  function activity() {
    const wasSlow = Date.now() - lastActivity >= IDLE_SLOW_MS;
    lastActivity = Date.now();
    slowNotified = false;
    if (paused) {
      paused = false;
      $paused.hidden = true;
      map.getContainer().classList.remove("is-paused");
      setLive("live");
      refresh();
    } else if (wasSlow) {
      hideToast();
      setLive("live");
      refresh(); // z úsporného režimu hned zpátky na normální obnovu
    }
  }
  let lastMoveEvent = 0;
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(ev, activity, { passive: true, capture: true });
  }
  document.addEventListener("pointermove", () => {
    const now = Date.now();
    if (now - lastMoveEvent > 5000) { lastMoveEvent = now; activity(); }
  }, { passive: true });

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    if (document.hidden) return;
    const idle = Date.now() - lastActivity;
    if (idle >= IDLE_PAUSE_MS) {
      paused = true;
      finishAnimations();
      showPaused();
      setStatus("Pozastaveno kvůli nečinnosti");
      return;
    }
    if (idle >= IDLE_SLOW_MS && !slowNotified) {
      slowNotified = true;
      setLive("slow");
      showSlowToast();
    }
    timer = setTimeout(refresh, Math.max(currentPollMs(), backoffMs));
  }

  map.on("zoomend", () => {
    if (map.getZoom() < ANIM_ZOOM) finishAnimations();
    const r = dotRadius();
    for (const v of vehicles.values()) if (v.dot.options.radius !== r) v.dot.setRadius(r);
  });

  let moveTimer = null;
  let lastMoveRefresh = 0;
  const MOVE_REFRESH_MIN_MS = 3000;
  map.on("moveend", () => {
    syncAll();
    clearTimeout(moveTimer);
    // stažená data (výřez + 20 % rezerva) nový pohled pokrývají → počkat na běžnou obnovu
    if (lastFetchBounds && lastFetchBounds.contains(map.getBounds())) return;
    if (backoffMs) return; // po 429 nepřidávat další požadavky
    const wait = Math.max(400, lastMoveRefresh + MOVE_REFRESH_MIN_MS - Date.now());
    moveTimer = setTimeout(() => { lastMoveRefresh = Date.now(); refresh(); }, wait);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else activity(), refresh();
  });

  // uložené chipy z minula: jen filtrovat, mapou nehýbat
  renderChips();
  if (chips.length) onLineFilter(true, false);

  refresh();
})();
