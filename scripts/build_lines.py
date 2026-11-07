#!/usr/bin/env python3
"""Předpočítá zastávky a trasy všech linek PID z jízdního řádu (GTFS) pro linky, které právě nejedou (#27).

Zdroj: PID GTFS (https://data.pid.cz/PID_GTFS.zip), © ROPID, licence CC BY
(https://pid.cz/opendata/). Úpravy: výběr zastávek a nejčastější trasy pro každý směr,
zjednodušení trasy.

Výstup (adresář, např. web/lines):
  index.json        {"generated", "feed": {...}, "attribution", "lines": {"22": "22.json", ...}}
  <linka>.json      {"line", "type", "color", "name", "directions": [{"headsign", "stops": [...], "shape": [[lat, lon], ...]}]}

Použití: python3 scripts/build_lines.py web/lines [cesta/k/PID_GTFS.zip]
Archiv se čte proudově, velké soubory (shapes.txt, stop_times.txt) se nedrží v paměti celé.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import sys
import tempfile
import time
import urllib.request
import zipfile
from collections import Counter, defaultdict

SOURCE = "https://data.pid.cz/PID_GTFS.zip"
ATTRIBUTION = "jízdní řády © ROPID (PID), CC BY – výběr zastávek a tras upraven"
TOLERANCE = 0.00008  # ° ≈ 6–9 m: trasa linky věrně podél ulic, ale výrazně menší
GTFS_TYPES = {"0": "tram", "1": "metro", "2": "train", "3": "bus", "4": "ferry", "7": "funicular", "11": "trolleybus"}


def rows(z: zipfile.ZipFile, name: str):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig", newline=""))


def simplify(points: list[tuple[float, float]], tol: float) -> list[tuple[float, float]]:
    """Douglas–Peucker (iterativně) nad (lat, lon)."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (ay, ax), (by, bx) = points[a], points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            py, px = points[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm if norm else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def safe_name(line: str) -> str:
    """Bezpečný název souboru z čísla linky (A, 22, S9, R10, X-A…)."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", line) or "_"


def build(zip_path: str, out_dir: str) -> int:
    z = zipfile.ZipFile(zip_path)
    feed = next(rows(z, "feed_info.txt"), {})

    routes = {r["route_id"]: r for r in rows(z, "routes.txt")}

    # nejčastější shape_id a headsign pro linku a směr
    shape_count: dict[tuple[str, str], Counter] = defaultdict(Counter)
    headsign_count: dict[tuple[str, str], Counter] = defaultdict(Counter)
    for t in rows(z, "trips.txt"):
        key = (t["route_id"], t.get("direction_id") or "0")
        if t.get("shape_id"):
            shape_count[key][t["shape_id"]] += 1
        if t.get("trip_headsign"):
            headsign_count[key][t["trip_headsign"]] += 1
    best_shape = {k: c.most_common(1)[0][0] for k, c in shape_count.items()}
    wanted_shapes = set(best_shape.values())

    # kanonické pořadí zastávek linky (route_stops.txt je v PID GTFS)
    route_stops: dict[tuple[str, str], list[tuple[int, str]]] = defaultdict(list)
    for r in rows(z, "route_stops.txt"):
        route_stops[(r["route_id"], r.get("direction_id") or "0")].append((int(r["stop_sequence"]), r["stop_id"]))

    stops = {}
    for s in rows(z, "stops.txt"):
        stops[s["stop_id"]] = s

    # body tras: jen vybrané tvary, proudově
    shape_pts: dict[str, list[tuple[int, float, float]]] = defaultdict(list)
    for p in rows(z, "shapes.txt"):
        sid = p["shape_id"]
        if sid in wanted_shapes:
            shape_pts[sid].append((int(p["shape_pt_sequence"]), float(p["shape_pt_lat"]), float(p["shape_pt_lon"])))

    # linky podle čísla (víc route_id se stejným číslem se sloučí)
    lines: dict[str, dict] = {}
    for (route_id, direction), seq in sorted(route_stops.items()):
        r = routes.get(route_id)
        if not r:
            continue
        line = r["route_short_name"].strip().upper()
        if not line:
            continue
        entry = lines.setdefault(line, {
            "line": r["route_short_name"].strip(),
            "type": GTFS_TYPES.get(r.get("route_type", ""), "bus"),
            "color": f"#{r['route_color']}" if r.get("route_color") else None,
            "name": r.get("route_long_name") or "",
            "directions": [],
        })
        out_stops = []
        for _, stop_id in sorted(seq):
            s = stops.get(stop_id)
            if not s:
                continue
            out_stops.append({
                "id": stop_id,
                "name": s["stop_name"],
                "node": s.get("asw_node_id") or None,
                "zone": s.get("zone_id") or None,
                "lat": round(float(s["stop_lat"]), 6),
                "lon": round(float(s["stop_lon"]), 6),
            })
        if len(out_stops) < 2:
            continue
        sid = best_shape.get((route_id, direction))
        pts = [(lat, lon) for _, lat, lon in sorted(shape_pts.get(sid, []))] if sid else []
        shape = [[round(lat, 5), round(lon, 5)] for lat, lon in simplify(pts, TOLERANCE)] if pts else []
        hs = headsign_count.get((route_id, direction))
        entry["directions"].append({
            # stejné číslo může mít víc druhů dopravy (např. P2 vlak i přívoz)
            "type": GTFS_TYPES.get(r.get("route_type", ""), "bus"),
            "headsign": hs.most_common(1)[0][0] if hs else out_stops[-1]["name"],
            "stops": out_stops,
            "shape": shape,
        })

    os.makedirs(out_dir, exist_ok=True)
    index = {}
    for line, entry in lines.items():
        if not entry["directions"]:
            continue
        fname = f"{safe_name(line)}.json"
        with open(os.path.join(out_dir, fname), "w", encoding="utf-8") as f:
            json.dump(entry, f, ensure_ascii=False, separators=(",", ":"))
        index[line] = fname
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump({
            "generated": int(time.time()),
            "feed": {k: feed.get(k) for k in ("feed_publisher_name", "feed_start_date", "feed_end_date")},
            "source": SOURCE,
            "attribution": ATTRIBUTION,
            "lines": index,
        }, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(index)} lines written to {out_dir}")
    return 0


def main() -> int:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "web/lines"
    if len(sys.argv) > 2:
        return build(sys.argv[2], out_dir)
    with tempfile.TemporaryDirectory() as tmp:
        zip_path = os.path.join(tmp, "PID_GTFS.zip")
        req = urllib.request.Request(SOURCE, headers={"User-Agent": "emhadecko-lines/1.0 (+https://github.com/twarr58/emhadecko)"})
        with urllib.request.urlopen(req, timeout=300) as res, open(zip_path, "wb") as f:
            while chunk := res.read(1 << 20):
                f.write(chunk)
        # do dočasného adresáře, cílový se přepíše až po úspěchu
        staging = os.path.join(tmp, "lines")
        build(zip_path, staging)
        os.makedirs(out_dir, exist_ok=True)
        for name in os.listdir(out_dir):
            if name.endswith(".json"):
                os.remove(os.path.join(out_dir, name))
        for name in os.listdir(staging):
            os.replace(os.path.join(staging, name), os.path.join(out_dir, name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
