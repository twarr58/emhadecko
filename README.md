# emhadecko

Realtime mapa vozidel PID (Pražská integrovaná doprava) na OpenStreetMap.
Běží čistě na GitHub Pages, bez vlastního backendu.
Data jsou z [Golemio API – PID Realtime Positions](https://api.golemio.cz/pid/docs/openapi/).

## Jak to funguje

`web/` je statická stránka (Leaflet + OSM). Prohlížeč každých 10 s volá přímo
`GET https://api.golemio.cz/v2/public/vehiclepositions?boundingBox=…`, a to jen pro
aktuální výřez mapy. Golemio posílá `Access-Control-Allow-Origin: *`, takže
to z GitHub Pages projde. Mezi dvěma polohami se vozidla plynule animují.
Filtrovat jde podle druhu dopravy a čísla linky a zpoždění nad 3 minuty je zvýrazněné.

## Výluky a mimořádnosti

RSS kanály [pid.cz](https://pid.cz/rss-kanal/) nemají CORS, takže je prohlížeč přímo nenačte.
Workflow `pages.yml` je proto každých 15 minut (a při každém deployi) stáhne skriptem
`scripts/fetch_alerts.py`, převede na `alerts.json` a nasadí spolu se stránkou.
Mimořádnosti tak mohou být až ~15 minut pozadu.
GitHub plánované běhy pozastaví po 60 dnech bez aktivity v repu; pak stačí workflow ručně spustit.

```bash
python3 scripts/fetch_alerts.py web/alerts.json
```

## API klíč

Golemio vyžaduje [API klíč zdarma](https://api.golemio.cz/api-keys) (`X-Access-Token`).
Návštěvník ho zadá při prvním otevření stránky a klíč zůstane jen v jeho prohlížeči
(`localStorage`). Změnit ho jde tlačítkem „Změnit API klíč“.

Pokud je v repu nastavený secret **`GOLEMIO_API_KEY`** (Settings → Secrets and variables → Actions),
workflow ho při deployi vloží do `web/config.js` a stránka funguje všem bez zadávání klíče.
Klíč je tím ale **veřejně čitelný** ve zdrojáku stránky a všichni návštěvníci sdílí jeho rate limit.

## Nasazení na GitHub Pages

1. Settings → Pages → Source: **GitHub Actions**.
2. Push do `main` spustí `.github/workflows/pages.yml`, který nasadí `web/`.

## Lokální vývoj

```bash
cd web && python3 -m http.server 8000
```

## Přispívání

Commity a názvy PR se řídí [Conventional Commits](https://www.conventionalcommits.org/)
a kontroluje je CI (`commitlint.config.mjs`). Šablonu commit zprávy zapneš takhle:

```bash
git config commit.template .gitmessage
```

Příklady: `feat(web): …`, `fix(web): …`, `ci: …`, `docs: …`.
Verze GitHub Actions hlídá Dependabot (`.github/dependabot.yml`).
