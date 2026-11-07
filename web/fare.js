/* emhadecko — orientační výpočet jízdného PID (#19).
 * Čistá logika bez DOM, aby šla testovat v Node (tests/fare.test.js).
 * Tarif je v tariff.json (ceník pid.cz platný od 1. 1. 2026).
 */
(function (root) {
  "use strict";

  /** "P", "0,B", " 2 " → ["P"], ["0","B"], ["2"] */
  function parseZones(zoneId) {
    return String(zoneId ?? "").split(",").map((z) => z.trim()).filter(Boolean);
  }

  /**
   * Nejmenší souvislý rozsah pásem (v pořadí P, 0, B, 1, 2, …), který pokryje všechny zastávky cesty.
   * Hraniční zastávka (víc pásem) se přiřadí tak, aby to bylo pro cestujícího výhodnější.
   */
  function zoneRange(stopsZones, order) {
    const idx = stopsZones.map((zs) => zs.map((z) => order.indexOf(z)).filter((i) => i >= 0));
    if (!idx.length || idx.some((a) => !a.length)) return null; // neznámé pásmo
    let best = null;
    for (let lo = 0; lo < order.length; lo++) {
      for (let hi = lo; hi < order.length; hi++) {
        if (best && hi - lo >= best[1] - best[0]) break;
        if (idx.every((a) => a.some((i) => i >= lo && i <= hi))) { best = [lo, hi]; break; }
      }
    }
    return best;
  }

  /**
   * @param {{zones: string[]}[]} stops zastávky cesty od nástupu po výstup (včetně)
   * @param {number} minutes doba jízdy v minutách
   * @param {object} tariff obsah tariff.json
   * @returns {{kind:"prague"|"region", zones:string[], count:number, minutes:number, ticket:object} | {error:string, zones?:string[]}}
   */
  function computeFare(stops, minutes, tariff) {
    const order = tariff.zone_order;
    const range = zoneRange(stops.map((s) => s.zones), order);
    if (!range) return { error: "U některé zastávky chybí tarifní pásmo." };
    const zones = order.slice(range[0], range[1] + 1);
    const count = zones.length;
    // rezerva na zpoždění: jízdenka musí platit celou cestu
    const need = Math.ceil(minutes + Math.max(2, minutes * 0.1));
    const prague = zones.every((z) => tariff.prague.zones.includes(z));

    if (prague) {
      const ticket = tariff.prague.tickets.find((t) => t.minutes >= need);
      return ticket ? { kind: "prague", zones, count, minutes: need, ticket } : { error: "Cesta je delší, než pokryje jednotlivá jízdenka.", zones };
    }
    const ticket = tariff.region.tickets.find((t) =>
      t.zones >= count && t.minutes >= need && !(t.not_in || []).some((z) => zones.includes(z)));
    return ticket
      ? { kind: "region", zones, count, minutes: need, ticket }
      : { error: need > 180 ? "Cesta je delší než 180 minut – potřebuješ časovou jízdenku." : "Pro tolik pásem jednotlivá jízdenka neexistuje.", zones };
  }

  const api = { parseZones, zoneRange, computeFare };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PidFare = api;
})(typeof window !== "undefined" ? window : globalThis);
