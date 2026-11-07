#!/usr/bin/env python3
"""Stáhne oficiální polygony tarifních pásem PID a zjednoduší je pro mapu.

Zdroj: IPR Praha, datová sada „Pražská integrovaná doprava – tarifní pásma“
(Národní katalog otevřených dat), licence CC BY 4.0, „datový podklad © IPR Praha“.
Praha je v datech jeden polygon „P, 0, B“ (bez vnitřního dělení), pásma 1–N okolo.

Použití: python3 scripts/fetch_zones.py web/zones.json
Při chybě stažení skončí nenulovým kódem a cílový soubor nepřepíše.
"""

from __future__ import annotations

import json
import sys
import urllib.request

SOURCE = "https://lkod-iprpraha.hub.arcgis.com/api/download/v1/items/6391e7e27ff042a690617195a457f5a8/geojson?layers=0"
ATTRIBUTION = "datový podklad © IPR Praha (CC BY 4.0)"
TOLERANCE = 0.0004  # ° ≈ 30–45 m: na mapě nepoznat, soubor výrazně menší
DECIMALS = 5


def simplify(points: list[list[float]], tol: float) -> list[list[float]]:
    """Douglas–Peucker (iterativně), uzavřený prstenec zůstane uzavřený."""
    if len(points) < 5:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = points[a], points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm if norm else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    out = [p for p, k in zip(points, keep) if k]
    return out if len(out) >= 4 else points


def ring(points: list[list[float]]) -> list[list[float]]:
    return [[round(x, DECIMALS), round(y, DECIMALS)] for x, y in simplify(points, TOLERANCE)]


def _inside(x: float, y: float, r: list) -> bool:
    c = False
    for i in range(len(r) - 1):
        (x1, y1), (x2, y2) = r[i], r[i + 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def _seg_dist(px: float, py: float, a: list, b: list) -> float:
    (ax, ay), (bx, by) = a, b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
    return ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) ** 0.5


def label_point(polys: list) -> list[float]:
    """Bod pro popisek: uvnitř pásma (ne v díře) a co nejdál od hranic – pásma jsou prstence kolem Prahy."""
    best, best_d = None, -1.0
    for poly in polys:
        xs = [p[0] for p in poly[0]]
        ys = [p[1] for p in poly[0]]
        n = 40
        for i in range(1, n):
            for j in range(1, n):
                x = min(xs) + (max(xs) - min(xs)) * i / n
                y = min(ys) + (max(ys) - min(ys)) * j / n
                if not _inside(x, y, poly[0]) or any(_inside(x, y, h) for h in poly[1:]):
                    continue
                d = min(_seg_dist(x, y, r[k], r[k + 1]) for r in poly for k in range(len(r) - 1))
                if d > best_d:
                    best, best_d = [x, y], d
    if best is None:  # malý kousek: první bod hranice
        best = polys[0][0][0]
    return [round(best[0], DECIMALS), round(best[1], DECIMALS)]


def main(path: str) -> int:
    req = urllib.request.Request(SOURCE, headers={"User-Agent": "emhadecko-zones/1.0 (+https://github.com/twarr58/emhadecko)"})
    with urllib.request.urlopen(req, timeout=120) as res:
        src = json.load(res)

    by_zone: dict[str, list] = {}
    for f in src.get("features", []):
        name = str(f["properties"].get("popis", "")).strip()
        g = f.get("geometry") or {}
        polys = g["coordinates"] if g.get("type") == "MultiPolygon" else [g["coordinates"]] if g.get("type") == "Polygon" else []
        by_zone.setdefault(name, []).extend(polys)
    if len(by_zone) < 5:
        raise SystemExit(f"unexpected source content: {len(by_zone)} zones")

    features = []
    for name, polys in sorted(by_zone.items(), key=lambda kv: (kv[0] != "P, 0, B", int(kv[0]) if kv[0].isdigit() else 0)):
        simple = [[ring(r) for r in poly] for poly in polys]
        features.append({
            "type": "Feature",
            "properties": {"zone": name, "prague": name.startswith("P"), "label": label_point(simple)},
            "geometry": {"type": "MultiPolygon", "coordinates": simple},
        })
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"type": "FeatureCollection", "attribution": ATTRIBUTION, "source": SOURCE, "features": features},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(features)} zones written to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "web/zones.json"))
