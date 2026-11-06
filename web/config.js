// Runtime konfigurace. Při deployi na GitHub Pages se soubor přepíše
// z repo proměnné PROXY_URL (viz .github/workflows/pages.yml).
//
// apiBase   – základ URL API. Buď přímo Golemio, nebo vlastní proxy.
// needsKey  – true = API klíč zadává uživatel v prohlížeči (uloží se do localStorage),
//             false = klíč doplňuje proxy na serveru.
window.EMHADECKO_CONFIG = {
  apiBase: "https://api.golemio.cz",
  needsKey: true,
  pollSeconds: 10,
};
