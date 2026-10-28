#!/usr/bin/env node
/* Rendert docs/social/banner.html als Social-Preview (1280 × 640 px, wie GitHub sie empfiehlt).
   Aufruf: node docs/social/render.cjs   (braucht Playwright mit Chromium, wie die Tests) */
'use strict';

const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
    await page.goto('file://' + path.join(__dirname, 'banner.html'));
    await page.evaluate(() => document.fonts.ready);
    const out = path.join(__dirname, 'safe-wsjf-social-preview.png');
    await page.screenshot({ path: out });
    console.log('Geschrieben: ' + path.relative(process.cwd(), out));
  } finally {
    await browser.close();
  }
})();
