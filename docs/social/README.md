# Social Preview

`safe-wsjf-social-preview.png` (1280 × 640 px) ist das Bild für *Settings → General → Social preview* des Repositorys.

Quelle ist `banner.html` (reines HTML/CSS, Schriften Inter und JetBrains Mono). Die Raster zeigen die Standardfarben der
App mit derselben Helligkeit wie in `src/css/app.css` (hell oben links, dunkel unten rechts). Nach einer Änderung neu
rendern:

```bash
node docs/social/render.cjs
```

Sind Inter oder JetBrains Mono nicht installiert, nimmt der Browser Ersatzschriften und das Bild sieht anders aus.
