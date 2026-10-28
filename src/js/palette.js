/* SAFe WSJF – Farben der Raster. 32 Farben als Farbton und Sättigung; die Helligkeit der Zelle ergibt sich aus ihren
   Werten (hell oben links, dunkel unten rechts, wie in der WSJF-App), siehe .cell in app.css.
   Im Browser als window.WsjfPalette, in Node über require() (für das Sprachwerkzeug). */
(function (global) {
  'use strict';

  const COLORS = [
    { id: 'rot', name: 'Rot', h: 0, s: 55 },
    { id: 'koralle', name: 'Koralle', h: 10, s: 50 },
    { id: 'orange', name: 'Orange', h: 25, s: 60 },
    { id: 'bernstein', name: 'Bernstein', h: 38, s: 65 },
    { id: 'gold', name: 'Gold', h: 48, s: 60 },
    { id: 'gelb', name: 'Gelb', h: 58, s: 55 },
    { id: 'oliv', name: 'Oliv', h: 72, s: 40 },
    { id: 'limette', name: 'Limette', h: 88, s: 50 },
    { id: 'hellgruen', name: 'Hellgrün', h: 108, s: 45 },
    { id: 'gruen', name: 'Grün', h: 128, s: 45 },
    { id: 'smaragd', name: 'Smaragd', h: 148, s: 50 },
    { id: 'jade', name: 'Jade', h: 163, s: 45 },
    { id: 'tuerkis', name: 'Türkis', h: 178, s: 50 },
    { id: 'cyan', name: 'Cyan', h: 192, s: 55 },
    { id: 'himmelblau', name: 'Himmelblau', h: 205, s: 50 },
    { id: 'blau', name: 'Blau', h: 218, s: 55 },
    { id: 'koenigsblau', name: 'Königsblau', h: 232, s: 55 },
    { id: 'indigo', name: 'Indigo', h: 246, s: 50 },
    { id: 'violett', name: 'Violett', h: 260, s: 50 },
    { id: 'lila', name: 'Lila', h: 275, s: 45 },
    { id: 'purpur', name: 'Purpur', h: 290, s: 45 },
    { id: 'magenta', name: 'Magenta', h: 308, s: 50 },
    { id: 'pink', name: 'Pink', h: 325, s: 55 },
    { id: 'himbeere', name: 'Himbeere', h: 342, s: 55 },
    { id: 'rose', name: 'Rosé', h: 350, s: 25 },
    { id: 'sand', name: 'Sand', h: 40, s: 30 },
    { id: 'stein', name: 'Stein', h: 30, s: 10 },
    { id: 'salbei', name: 'Salbei', h: 140, s: 15 },
    { id: 'blaugrau', name: 'Blaugrau', h: 200, s: 15 },
    { id: 'schiefer', name: 'Schiefer', h: 220, s: 20 },
    { id: 'mauve', name: 'Mauve', h: 300, s: 12 },
    { id: 'grau', name: 'Grau', h: 0, s: 0 },
  ];

  /** Vorgabe wie in der WSJF-App: oben blau, unten rot. */
  const DEFAULTS = { 1: 'himmelblau', 2: 'koralle' };

  const byId = id => COLORS.find(c => c.id === id) || null;

  const api = { COLORS, DEFAULTS, byId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WsjfPalette = api;
})(typeof window !== 'undefined' ? window : globalThis);
