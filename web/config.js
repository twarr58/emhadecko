// Runtime konfigurace. Při deployi na GitHub Pages ji workflow přepíše
// (viz .github/workflows/pages.yml).
//
// apiKey – Golemio X-Access-Token vložený při buildu z GitHub secretu
//          GOLEMIO_API_KEY. Prázdný = uživatel zadá vlastní klíč v prohlížeči.
//          POZOR: klíč vložený sem je veřejně čitelný pro každého návštěvníka.
window.EMHADECKO_CONFIG = {
  apiBase: "https://api.golemio.cz",
  apiKey: "",
  pollSeconds: 10,
};
