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

Golemio vyžaduje [API klíč zdarma](https://api.golemio.cz/api-keys) (`X-Access-Token`). Stránka umí tři režimy
(vybírá je workflow `pages.yml` při deployi):

| Režim | Nastavení | Klíč |
|---|---|---|
| **Cloudflare Worker** (doporučeno) | repo proměnná `WORKER_URL` | jen ve Workeru, do prohlížeče se nedostane |
| Klíč vložený do stránky | secret `GOLEMIO_API_KEY`, bez `WORKER_URL` | **veřejně čitelný** v `config.js` |
| Vlastní klíč návštěvníka | nic | každý zadá svůj, uloží se do `localStorage` |

## Cloudflare Worker (`worker/`)

Malá proxy na Cloudflare, která klíč drží na serveru. Ochrana:

1. klíč je jen v secretu Workeru, nevrací se v odpovědích ani v chybách,
2. jen `GET` a jen endpointy, které stránka používá (polohy, detail vozidla, zastávky spoje,
   odjezdy, přestupní tablo), s validací parametrů,
3. odpovídá jen originům z `ALLOWED_ORIGINS` (`worker/wrangler.toml`),
4. polohy stahuje z Golemia max. 1× za 5 s pro všechny návštěvníky a výřez mapy filtruje sám,
   takže zneužití nevyčerpá limit klíče,
5. rate limit 180 požadavků/min na IP,
6. na free tarifu Cloudflare (100 000 požadavků/den) nemůže vzniknout žádný účet.

### Nasazení (přes GitHub Actions)

1. Cloudflare → Workers & Pages: při prvním otevření si zvol subdoménu `*.workers.dev`.
2. Cloudflare → Manage account → Account API tokens → Create token → šablona **Edit Cloudflare Workers**.
3. V repu (Settings → Secrets and variables → Actions) přidej secrets:
   - `CLOUDFLARE_API_TOKEN`: token z kroku 2,
   - `CLOUDFLARE_ACCOUNT_ID`: ID účtu (je v URL dashboardu: `dash.cloudflare.com/<ID>/…`),
   - `GOLEMIO_API_KEY`: **nový** klíč z Golemia (starý je veřejný, zneplatni ho).
4. Spusť workflow **worker** (Actions → worker → Run workflow). Na konci vypíše URL Workeru.
5. Přidej repo proměnnou (záložka Variables) `WORKER_URL` = ta URL, např. `https://emhadecko.<subdoména>.workers.dev`.
6. Spusť workflow **pages**. Stránka pak volá Worker a klíč v ní už není.

Testy Workeru: `cd worker && npm test`.

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
