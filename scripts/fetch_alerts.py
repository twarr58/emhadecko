#!/usr/bin/env python3
"""Stáhne RSS výluk a mimořádností z pid.cz a uloží je jako JSON pro frontend.

pid.cz neposílá CORS hlavičky, takže prohlížeč RSS přímo nenačte. Workflow
.github/workflows/pages.yml proto tento skript pouští při každém deployi
a každých 15 minut a výsledek nasadí jako web/alerts.json.

Použití: python3 scripts/fetch_alerts.py web/alerts.json
"""

from __future__ import annotations

import html
import json
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

FEEDS = {
    "mimoradnost": "https://pid.cz/feed/rss-mimoradnosti/",
    "vyluka": "https://pid.cz/feed/rss-vyluky/",
}
CONTENT = "{http://purl.org/rss/1.0/modules/content/}encoded"
UPCOMING_DAYS = 7  # budoucí výluky bereme jen na týden dopředu
SUMMARY_LEN = 280


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "emhadecko-alerts/1.0 (+https://github.com/twarr58/emhadecko)"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read()


def plain(text: str) -> str:
    text = re.sub(r"<br\s*/?>|</p>|</li>|</h\d>", "\n", text or "", flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text).replace("\xa0", " ")
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", text)).strip()


def parse_lines(*texts: str) -> list[str]:
    for t in texts:
        m = re.search(r"(?:Dotčené linky|Linky)\s*:\s*([^\n;<]+)", t or "")
        if m:
            return [x.strip() for x in m.group(1).split(",") if x.strip()]
    return []


def num(el: ET.Element, tag: str) -> int | None:
    v = (el.findtext(tag) or "").strip()
    return int(v) if v.isdigit() else None


def parse(kind: str, xml: bytes, now: int) -> list[dict]:
    out = []
    for it in ET.fromstring(xml).iter("item"):
        content = it.findtext(CONTENT) or ""
        desc = it.findtext("description") or ""
        start, end = num(it, "dateFrom"), num(it, "dateTo")
        if end is not None and end < now:
            continue
        if start is not None and start > now + UPCOMING_DAYS * 86400:
            continue
        body = plain(content)  # mimořádnosti mají v description jen čas a linky, ty máme zvlášť
        # první řádek "Linky: …" je jen výpis linek, do shrnutí nepatří
        body = re.sub(r"^(?:Dotčené linky|Linky)\s*:[^\n]*\n?", "", body).strip()
        out.append({
            "id": (it.findtext("guid") or it.findtext("link") or "").strip(),
            "kind": kind,
            "title": plain(it.findtext("title") or ""),
            "link": (it.findtext("link") or "").strip(),
            "from": start,
            "to": end,
            "when": plain(it.findtext("date") or "") or plain(desc).split(";")[0].strip(),
            "priority": num(it, "priority"),
            "lines": parse_lines(plain(content), plain(desc)),
            "summary": body[:SUMMARY_LEN].rsplit(" ", 1)[0] + "…" if len(body) > SUMMARY_LEN else body,
        })
    return out


def main(path: str) -> int:
    now = int(time.time())
    items, errors = [], []
    for kind, url in FEEDS.items():
        try:
            items += parse(kind, fetch(url), now)
        except Exception as e:  # noqa: BLE001 — jeden rozbitý feed nesmí shodit deploy
            errors.append(f"{kind}: {e}")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"generated": now, "items": items, "errors": errors}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(items)} items, errors: {errors or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "web/alerts.json"))
