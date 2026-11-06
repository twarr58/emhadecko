# emhadecko

Realtime mapa vozidel PID (Pražská integrovaná doprava) na OpenStreetMap.
Data jsou z [Golemio API – PID Realtime Positions](https://api.golemio.cz/pid/docs/openapi/).

```
web/              statický frontend (Leaflet + OSM), nasazuje se na GitHub Pages
proxy/            malá Go proxy, která drží Golemio API klíč na serveru a cachuje feed
deploy/openshift/ kustomize manifesty pro proxy (Deployment, Service, Route)
```

## Jak to funguje

Frontend každých 10 s volá `GET /v2/public/vehiclepositions?boundingBox=…` jen pro
aktuální výřez mapy a mezi dvěma polohami vozidla plynule animuje. Vozidla se dají
filtrovat podle druhu dopravy a čísla linky; zpoždění nad 3 minuty se zvýrazní.

## GitHub Pages: jde to?

Ano, ale je tu jeden problém. Golemio API posílá `Access-Control-Allow-Origin: *`,
takže CORS nevadí. Vyžaduje ale API klíč (`X-Access-Token`) a na GitHub Pages není
kam ho schovat: všechno, co je ve statickém webu, si kdokoli přečte. Proto jsou dva režimy:

| Režim | Jak | Kdy použít |
|---|---|---|
| **Klíč v prohlížeči** (výchozí) | Uživatel zadá svůj [Golemio klíč](https://api.golemio.cz/api-keys) a ten se uloží do `localStorage`. | Osobní použití nebo demo. Nic dalšího se nenasazuje. |
| **Proxy** | Na GitHub Pages poběží frontend, v OpenShiftu `proxy/` s klíčem v Secretu. | Veřejná stránka. Proxy navíc stahuje feed jen jednou za `CACHE_TTL` pro všechny klienty, takže chrání rate limit. |

Na proxy se frontend přepne, když v repu nastavíš proměnnou **`PROXY_URL`**
(Settings → Secrets and variables → Actions → Variables), např. `https://emhadecko-proxy-xyz.apps.cluster.example.com`.
URL má být bez cesty: frontend k ní připojuje `/v2/public/vehiclepositions`.

### Zapnutí GitHub Pages

Settings → Pages → Source: **GitHub Actions**. Workflow `.github/workflows/pages.yml`
nasadí `web/` po každém pushi do `main`.

## Lokální vývoj

```bash
cd web && python3 -m http.server 8000
```

```bash
cd proxy && GOLEMIO_API_KEY=… ALLOWED_ORIGINS=http://localhost:8000 go run .
```

Pokud chceš frontend lokálně pustit proti proxy, nastav v `web/config.js`
`apiBase: "http://localhost:8080"` a `needsKey: false`.

### Konfigurace proxy

| Proměnná | Výchozí | Popis |
|---|---|---|
| `GOLEMIO_API_KEY` | – (povinná) | Golemio `X-Access-Token` |
| `ALLOWED_ORIGINS` | `*` | čárkami oddělené CORS originy, např. `https://twarr58.github.io` |
| `CACHE_TTL` | `5s` | jak často se stahuje feed z Golemia |
| `LISTEN_ADDR` | `:8080` | |
| `GOLEMIO_UPSTREAM` | `https://api.golemio.cz` | |

Proxy zpřístupní jen `GET /v2/public/vehiclepositions` a `GET /healthz`.

## Nasazení proxy na OpenShift

Image se při pushi do `main` publikuje do `ghcr.io/twarr58/emhadecko-proxy`.
Package na GHCR je ve výchozím stavu privátní. Buď ho přepni na public, nebo do projektu přidej pull secret.

```bash
oc new-project emhadecko
```

```bash
oc create secret generic golemio --from-literal=api-key=<GOLEMIO_KLIC>
```

```bash
oc apply -k deploy/openshift
```

```bash
oc get route emhadecko-proxy -o jsonpath='{.spec.host}'
```

Výsledný host pak nastav jako `PROXY_URL` (s `https://`) a v `deploy/openshift/deployment.yaml`
uprav `ALLOWED_ORIGINS` na adresu své GitHub Pages.

## Přispívání

Commity a názvy PR se řídí [Conventional Commits](https://www.conventionalcommits.org/)
a kontroluje je CI (`commitlint.config.mjs`). Šablonu commit zprávy zapneš takhle:

```bash
git config commit.template .gitmessage
```

Příklady: `feat(web): …`, `fix(proxy): …`, `ci: …`, `docs: …`.
Závislosti (Actions, Go moduly, Docker image) hlídá Dependabot (`.github/dependabot.yml`).
