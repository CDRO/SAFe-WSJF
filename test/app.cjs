/* App-Test: öffnet das Gebaute (dist/SAFe-WSJF) wie ein Benutzer per file:// in Chromium.
   Die File System Access API wird nachgebaut (Dateien im Speicher der Seite); ein Lauf ohne sie prüft den Weg über
   Dateifeld und Download (Firefox). Ausführen: node test/app.cjs (nach tools/build.cjs) */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'SAFe-WSJF');
const APP_URL = 'file://' + path.join(DIST, 'index.html');
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/jira-export.csv'));
const READY = 'body[data-ready="true"]';

function loadPlaywright() {
  try { return require('playwright'); }
  catch (e) { if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE); throw e; }
}

const step = name => console.log('  ✓ ' + name);

/** Nachbau der File System Access API: window.__files[name] ist der Inhalt, showOpenFilePicker liefert window.__next. */
function mockFsa(csvBytes) {
  let tick = 1000;
  class MockHandle {
    constructor(name, data) { this.kind = 'file'; this.name = name; this.data = new Uint8Array(data || []); this.lm = ++tick; }
    async getFile() { return new File([this.data], this.name, { lastModified: this.lm }); }
    async createWritable() {
      const chunks = [];
      return {
        write: async d => { chunks.push(typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d)); },
        close: async () => {
          const n = chunks.reduce((s, c) => s + c.length, 0);
          const out = new Uint8Array(n);
          let i = 0;
          for (const c of chunks) { out.set(c, i); i += c.length; }
          this.data = out;
          this.lm = ++tick;
          window.__writes = (window.__writes || 0) + 1;
        },
        abort: async () => {},
      };
    }
    async queryPermission() { return 'granted'; }
    async requestPermission() { return 'granted'; }
    async isSameEntry(o) { return o === this; }
    /** Änderung von aussen (anderes Programm). */
    replace(bytes) { this.data = new Uint8Array(bytes); this.lm = ++tick; }
  }
  window.__MockHandle = MockHandle;
  window.__csv = new MockHandle('jira-export.csv', csvBytes);
  window.__next = window.__csv;
  window.showOpenFilePicker = async () => [window.__next];
  window.showSaveFilePicker = async o => (window.__saved = new MockHandle(o.suggestedName));
}

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  return errors;
}

async function newApp(browser, opts) {
  const ctx = await browser.newContext(Object.assign({ locale: 'de-CH', viewport: { width: 1400, height: 1000 } }, opts && opts.context));
  if (!opts || opts.fsa !== false) await ctx.addInitScript(mockFsa, Array.from(FIXTURE));
  else await ctx.addInitScript(() => { delete window.showOpenFilePicker; delete window.showSaveFilePicker; });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(APP_URL);
  await page.waitForSelector(READY);
  return { ctx, page, errors };
}

const saved = page => page.waitForFunction(() => document.querySelector('#status').dataset.state === 'saved');
const csvText = page => page.evaluate(() => new TextDecoder().decode(window.__csv.data));
const rowOf = (text, key) => text.split('\r\n').find(l => l.includes(',' + key + ','));
const rankKeys = page => page.$$eval('#rankBody tr', trs => trs.map(t => t.dataset.key));

async function menu(page, button, label) {
  await page.click(button);
  await page.locator('#menu button', { hasText: label }).first().click();
}

async function createTrain(page, name) {
  await page.fill('#welcomeName', name);
  await page.click('#welcomeForm button[type=submit]');
  await page.waitForSelector('#emptyState:not([hidden])');
}

async function importFirst(page) {
  await page.click('#emptyImportBtn');
  await page.waitForSelector('#mapOk');
  await page.click('#mapOk');
  await page.waitForSelector('#rankBody tr');
  await saved(page);
}

async function runMain(browser) {
  const { page, errors, ctx } = await newApp(browser);

  // Willkommen, Zug anlegen, Adresse.
  assert.equal(await page.isVisible('#welcome'), true);
  await createTrain(page, 'ART Plattform');
  assert.match(page.url(), /#zug=art-plattform$/);
  assert.equal(await page.textContent('#trainName'), 'ART Plattform');

  // Einlesen mit Zuordnung: Vorschläge stimmen, Pflichtfeld wird geprüft.
  await page.click('#emptyImportBtn');
  await page.waitForSelector('#mapOk');
  const selected = await page.$$eval('.mapping select', ss => Object.fromEntries(ss.map(s => [s.dataset.field, s.selectedOptions[0].textContent])));
  assert.equal(selected.key, 'Issue key');
  assert.equal(selected.labels, 'Labels (×2)');
  assert.equal(selected.jobSize, 'Custom field (Job Size)');
  assert.match(await page.textContent('.mapping tr:has(#map-ubv) .sample'), /^8 \| 5 \| 100/);
  await page.selectOption('#map-key', '');
  await page.click('#mapOk');
  assert.match(await page.textContent('#dialog .error'), /Schlüssel/);
  await page.selectOption('#map-key', { label: 'Issue key' });
  await page.click('#mapOk');
  await page.waitForSelector('#rankBody tr');
  await saved(page);
  assert.deepEqual(await rankKeys(page), ['ART-104', 'ART-103', 'ART-101', 'ART-110', 'ART-105']);
  assert.match(await page.textContent('#rankBody tr[data-key="ART-104"]'), /Erforderlich/);
  assert.equal(await page.textContent('#hiddenCount'), '(1)');
  assert.equal(await page.isVisible('#grid1 .cell[data-x="8"][data-y="3"] .card[data-key="ART-101"]'), true);
  assert.equal(await page.isVisible('#pool2 .card[data-key="ART-105"]'), true);
  assert.match(await page.textContent('#csvStatus'), /aktuell/);
  step('Zug anlegen, CSV mit Zuordnung einlesen, Rangfolge');

  // Ziehen ins Raster, Dialog, Rückgängig.
  await page.dragAndDrop('#pool2 .card[data-key="ART-105"]', '#grid2 .cell[data-x="8"][data-y="3"]');
  await page.waitForSelector('#grid2 .cell[data-x="8"][data-y="3"] .card[data-key="ART-105"]');
  await page.click('#grid1 .card[data-key="ART-105"]').catch(() => {}); // steht im Raster 1 noch nicht
  await page.click('#pool1 .card[data-key="ART-105"]');
  await page.waitForSelector('#dialog[open] #val-rroe');
  await page.selectOption('#val-rroe', '2');
  assert.match(await page.textContent('#dialog .item-score'), /4\.33/);
  assert.match(await page.textContent('#dialog'), /in der CSV: –/);
  await page.click('#dialog button.primary');
  assert.equal(await page.textContent('#rankBody tr[data-key="ART-105"] td.score'), '4.33');
  assert.deepEqual((await rankKeys(page)).slice(0, 2), ['ART-104', 'ART-105']);
  await page.keyboard.press('Control+z');
  assert.equal((await page.textContent('#rankBody tr[data-key="ART-105"] td.score')).startsWith('–'), true);
  await page.keyboard.press('Control+z');
  assert.equal(await page.isVisible('#pool2 .card[data-key="ART-105"]'), true);
  await page.dragAndDrop('#pool2 .card[data-key="ART-105"]', '#grid2 .cell[data-x="8"][data-y="3"]');
  await page.dragAndDrop('#pool1 .card[data-key="ART-105"]', '#grid1 .cell[data-x="3"][data-y="2"]');
  await saved(page);
  assert.match(await page.textContent('#csvStatus'), /1 Änderung zurückschreiben/);
  step('Ziehen ins Raster, Ticket-Dialog, Rückgängig');

  // Beschreibung als Jira-Wiki-Markup: formatiert (offen), umschaltbar auf Quelltext; Skripte werden nicht ausgeführt.
  await page.evaluate(() => {
    WsjfSession.db.run('UPDATE items SET description = ? WHERE issue_key = ?',
      ['h3. Ziel\n* Bullet 1\n** Bullet 2\n[Link][https://www.google.com/]\n* KeyUser:\n** [~U0398261]\n<img src=x onerror="window.__xss=1">', 'ART-103']);
    WsjfApp.refresh();
  });
  await page.click('#rankBody tr[data-key="ART-103"]');
  await page.waitForSelector('#dialog[open] .item-desc[open] .desc.wiki');
  assert.equal(await page.textContent('#dialog .wiki h3'), 'Ziel');
  assert.equal(await page.$$eval('#dialog .wiki ul ul li', l => l.map(x => x.textContent).join('|')), 'Bullet 2|@U0398261');
  assert.equal(await page.getAttribute('#dialog .wiki a', 'href'), 'https://www.google.com/');
  assert.equal(await page.$('#dialog .wiki img'), null);
  await page.click('#dialog [data-mode="raw"]');
  assert.match(await page.textContent('#dialog .desc-raw'), /^h3\. Ziel\n\* Bullet 1/);
  await page.click('#dialog [data-mode="wiki"]');
  await page.click('#dialog button.primary');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  step('Beschreibung: Jira-Wiki-Markup, Quelltext');

  // Ablagefelder: erforderlich, ausblenden, Werte löschen; Label-Schalter.
  await page.evaluate(() => WsjfApp.dropOn('ART-110', '.drop-zone[data-zone="required"]'));
  assert.equal((await rankKeys(page)).indexOf('ART-110') < 2, true);
  await page.evaluate(() => WsjfApp.dropOn('ART-110', '.drop-zone[data-zone="hidden"]'));
  assert.equal(await page.textContent('#hiddenCount'), '(2)');
  await page.click('#hiddenBox summary');
  await page.click('#hiddenList li[data-key="ART-110"] button');
  assert.equal(await page.textContent('#hiddenCount'), '(1)');
  await page.click('#labelToggles button');
  assert.equal(await page.textContent('#hiddenCount'), '(0)');
  await page.click('#labelToggles button');
  assert.equal(await page.textContent('#hiddenCount'), '(1)');
  await page.evaluate(() => WsjfApp.dropOn('ART-110', '.drop-zone[data-zone="clear"]'));
  assert.equal(await page.isVisible('#pool1 .card[data-key="ART-110"]'), true);
  await page.keyboard.press('Control+z');
  assert.equal(await page.isVisible('#grid1 .card[data-key="ART-110"]'), true);
  step('Erforderlich, Ausblenden, Label-Schalter, Werte löschen');

  // Zurückschreiben in die eingelesene Datei: nur geänderte Zellen, Rest Byte für Byte.
  await page.click('#writeCsvBtn');
  await page.waitForFunction(() => /aktuell/.test(document.querySelector('#csvStatus').textContent));
  let text = await csvText(page);
  assert.equal(rowOf(text, 'ART-105'), 'Dashboard für Leitung,ART-105,10105,Feature,Funnel,ART,Clara Test,05/Sep/26 9:00 AM,,,"Kennzahlen, Grafiken; Export",Team Rot,3,2,8,3,4.33,,');
  const orig = FIXTURE.toString('utf8');
  for (const k of ['ART-101', 'ART-102', 'ART-103', 'ART-104', 'ART-110']) assert.equal(rowOf(text, k), rowOf(orig, k), k);
  assert.equal(await page.evaluate(() => window.__csv.data[0]), 0xEF, 'BOM bleibt');
  step('In die CSV zurückschreiben');

  // Neuer Export an derselben Stelle: Schreiben fragt; erneut einlesen führt zusammen.
  await page.click('#rankBody tr[data-key="ART-103"]');
  await page.selectOption('#val-ubv', '13');
  await page.click('#dialog button.primary');
  await page.evaluate(() => {
    const t = new TextDecoder().decode(window.__csv.data)
      .replace('Login mit SSO,ART-103,10103,Enabler,Backlog,ART,Ben Beispiel,03/Sep/26 9:00 AM,,,SSO über Entra ID,Team Blau,5,8,13,8,3.25',
        'Login mit SSO,ART-103,10103,Enabler,Backlog,ART,Ben Beispiel,03/Sep/26 9:00 AM,,,SSO über Entra ID,Team Blau,20,13,13,8,5.75')
      .replace(/Schnittstelle Labor,ART-110[^\r]*\r\n/, '')
      + 'Neu,ART-120,10120,Feature,Funnel,ART,,,,,,Team Blau,2,2,2,2,,,\r\n';
    window.__csv.replace(new TextEncoder().encode('﻿' + t));
  });
  await page.click('#writeCsvBtn');
  await page.waitForSelector('#dialog[open] [data-id="reread"]');
  await page.click('#dialog [data-id="reread"]');
  await page.waitForSelector('#dialog[open] h2:has-text("Konflikte")');
  assert.match(await page.textContent('#dialog'), /ART-103/);
  await page.click('#dialog button.primary');
  await page.waitForFunction(() => /aktuell/.test(document.querySelector('#csvStatus').textContent));
  text = await csvText(page);
  assert.ok(rowOf(text, 'ART-103').includes(',Team Blau,13,13,13,8,4.88,'), rowOf(text, 'ART-103'));
  assert.ok(rowOf(text, 'ART-120'));
  assert.ok(!rowOf(text, 'ART-110'));
  assert.equal(await page.isVisible('#goneBox'), true);
  await page.click('#goneBox summary');
  await page.click('#removeGoneBtn');
  await page.click('#dialog [data-id="yes"]');
  assert.equal(await page.isVisible('#goneBox'), false);
  step('Geänderte CSV: erst neu einlesen, Konflikt, neues und fehlendes Ticket');

  // Datenbankdatei anlegen; jede Änderung landet darin.
  await menu(page, '#dbMenuBtn', 'Datenbankdatei anlegen');
  await page.waitForFunction(() => window.__saved && window.__saved.data.length > 0 && /art-plattform\.sqlite/.test(document.querySelector('#fileStatus').textContent));
  const before = await page.evaluate(() => window.__writes);
  await page.dragAndDrop('#grid1 .card[data-key="ART-120"]', '#pool1');
  await saved(page);
  assert.ok(await page.evaluate(() => window.__writes) > before);
  // Von aussen geändert (kein eigener Stand offen): die App lädt still nach.
  await page.evaluate(() => {
    const SQL = window.WsjfSession.db.SQL;
    const db = WsjfDb.WsjfDatabase.open(SQL, window.__saved.data);
    db.setValues('ART-101', { jobSize: 13 });
    window.__saved.replace(db.export());
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForFunction(() => document.querySelector('#rankBody tr[data-key="ART-101"] td:nth-child(8)').textContent === '13');
  step('Datenbankdatei anlegen, schreiben, Änderung von aussen laden');

  // Einstellungen: Skala und Name.
  await page.click('#settingsBtn');
  await page.fill('#setScale', '1, 2, 3, 5, 8, 13, 21');
  await page.fill('#setName', 'ART Plattform Süd');
  await page.click('#dialog button[type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('#grid1 .head-x')].map(h => h.textContent).join(',') === '1,2,3,5,8,13,21');
  assert.equal(await page.textContent('#trainName'), 'ART Plattform Süd');
  step('Einstellungen: Skala, Name');

  // Farben: hell oben links, dunkel unten rechts (beide Raster); Präferenzen je Raster, gleiche Farbe erlaubt, bleibt nach Neuladen.
  const light = sel => page.$eval(sel, e => {
    const [r, g, b] = getComputedStyle(e).backgroundColor.match(/\d+/g).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
  for (const n of [1, 2]) {
    const tl = await light(`#grid${n} .cell[data-x="1"][data-y="1"]`);
    const tr = await light(`#grid${n} .cell[data-x="21"][data-y="1"]`);
    const bl = await light(`#grid${n} .cell[data-x="1"][data-y="21"]`);
    const br = await light(`#grid${n} .cell[data-x="21"][data-y="21"]`);
    assert.ok(tl > tr && tl > bl && tr > br && bl > br, `Raster ${n}: ${tl} ${tr} ${bl} ${br}`);
  }
  assert.deepEqual(await page.$$eval('.grid', gs => gs.map(g => g.dataset.color)), ['himmelblau', 'koralle']);
  await page.click('#prefsBtn');
  await page.waitForSelector('#dialog[open] #colors1');
  assert.equal(await page.$$eval('#colors1 .swatch', b => b.length), 32);
  assert.equal(await page.$$eval('#colors2 .swatch', b => b.length), 32);
  await page.click('#colors2 [data-color="smaragd"]');
  assert.equal(await page.$eval('#grid2', g => g.dataset.color), 'smaragd', 'Vorschau');
  await page.click('#dialog button:not(.primary):not(.danger-link):text("Abbrechen")');
  assert.equal(await page.$eval('#grid2', g => g.dataset.color), 'koralle', 'Abbrechen setzt zurück');
  await page.click('#prefsBtn');
  await page.click('#colors1 [data-color="smaragd"]');
  await page.focus('#colors2 [data-color="koralle"]');
  await page.keyboard.press('ArrowLeft');
  await page.click('#colors2 [data-color="smaragd"]');
  await page.click('#prefsOk');
  assert.deepEqual(await page.$$eval('.grid', gs => gs.map(g => g.dataset.color)), ['smaragd', 'smaragd']);
  await page.reload();
  await page.waitForSelector(READY);
  assert.deepEqual(await page.$$eval('.grid', gs => gs.map(g => g.dataset.color)), ['smaragd', 'smaragd']);
  assert.equal(await page.$eval('#grid1 .cell[data-x="1"][data-y="1"]', e => getComputedStyle(e).backgroundColor),
    await page.$eval('#grid2 .cell[data-x="1"][data-y="1"]', e => getComputedStyle(e).backgroundColor));
  await page.click('#prefsBtn');
  await page.click('#prefsReset');
  await page.click('#prefsOk');
  assert.deepEqual(await page.$$eval('.grid', gs => gs.map(g => g.dataset.color)), ['himmelblau', 'koralle']);
  step('Rasterfarben: Verlauf, 32 Farben je Raster, gleiche Farbe, Vorschau, Neuladen, Vorgabe');

  // Zweiter Zug mit eigener Zuordnung; Wechsel über Alt+1 und die Adresse; Stand bleibt nach Neuladen.
  await page.click('#trainBtn');
  await page.locator('#menu button', { hasText: 'Neuer Zug' }).click();
  await page.fill('#promptInput', 'Portfolio Klinik');
  await page.click('#dialog button[type=submit]');
  await page.waitForSelector('#emptyState:not([hidden])');
  assert.match(page.url(), /#zug=portfolio-klinik$/);
  await page.evaluate(() => {
    window.__next = new window.__MockHandle('klinik.csv', new TextEncoder().encode('Schlüssel;Titel;Nutzen\nKL-1;Eins;5\nKL-2;Zwei;\n'));
  });
  await page.click('#emptyImportBtn');
  await page.waitForSelector('#mapOk');
  assert.equal(await page.$eval('#mapDelimiter', s => s.value), ';');
  await page.selectOption('#map-ubv', { label: 'Nutzen' });
  await page.selectOption('#map-jobSize', { label: 'Neue Spalte «Job Size» anhängen' });
  await page.click('#mapOk');
  await page.waitForSelector('#rankBody tr[data-key="KL-1"]');
  await saved(page);
  await page.keyboard.press('Alt+1');
  await page.waitForFunction(() => document.querySelector('#trainName').textContent === 'ART Plattform Süd');
  assert.match(page.url(), /#zug=art-plattform$/);
  await page.reload();
  await page.waitForSelector(READY);
  assert.equal(await page.textContent('#trainName'), 'ART Plattform Süd');
  assert.equal(await page.isVisible('#rankBody tr[data-key="ART-120"]'), true);
  await page.goto(APP_URL + '#zug=2');
  await page.waitForSelector(READY);
  await page.waitForSelector('#rankBody tr[data-key="KL-1"]');
  assert.equal(await page.textContent('#trainName'), 'Portfolio Klinik');
  step('Mehrere Züge: eigene Zuordnung, Alt+1, Adresse, Neuladen');

  // Zug entfernen.
  await menu(page, '#trainBtn', 'Zug aus der Liste entfernen');
  await page.click('#dialog [data-id="yes"]');
  await page.waitForFunction(() => document.querySelector('#trainName').textContent === 'ART Plattform Süd');
  step('Zug entfernen');

  assert.deepEqual(errors, []);
  await ctx.close();
}

async function runNoFsa(browser) {
  // Firefox-Weg: Einlesen über das Dateifeld, Zurückschreiben als Download.
  const { page, errors, ctx } = await newApp(browser, { fsa: false, context: { acceptDownloads: true } });
  await createTrain(page, 'Zug Firefox');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#emptyImportBtn')]);
  await chooser.setFiles({ name: 'jira-export.csv', mimeType: 'text/csv', buffer: FIXTURE });
  await page.waitForSelector('#mapOk');
  await page.click('#mapOk');
  await page.waitForSelector('#rankBody tr');
  assert.match(await page.textContent('#fileStatus'), /Kopie regelmässig herunterladen/);
  await page.dragAndDrop('#pool2 .card[data-key="ART-105"]', '#grid2 .cell[data-x="1"][data-y="1"]');
  await page.dragAndDrop('#pool1 .card[data-key="ART-105"]', '#grid1 .cell[data-x="3"][data-y="1"]');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#writeCsvBtn')]);
  assert.equal(dl.suggestedFilename(), 'jira-export.csv');
  const bytes = fs.readFileSync(await dl.path());
  assert.equal(rowOf(bytes.toString('utf8'), 'ART-105').includes(',Team Rot,3,1,1,1,5,'), true);
  await page.waitForFunction(() => /aktuell/.test(document.querySelector('#csvStatus').textContent));
  const [copy] = await Promise.all([page.waitForEvent('download'), menu(page, '#dbMenuBtn', 'Kopie herunterladen')]);
  assert.match(copy.suggestedFilename(), /^zug-firefox-\d{4}-\d\d-\d\d\.sqlite$/);
  assert.deepEqual(errors, []);
  await ctx.close();
  step('Ohne File System Access API: Dateifeld und Download');
}

async function runEnglish(browser) {
  const { page, errors, ctx } = await newApp(browser, { context: { locale: 'en-US' } });
  assert.equal(await page.textContent('#welcome h1'), 'SAFe WSJF');
  assert.equal(await page.textContent('#welcomeForm button'), 'Create');
  await createTrain(page, 'Train');
  await importFirst(page);
  assert.match(await page.textContent('.ranking h2'), /^Prioritised list\s*\(5\)$/);
  assert.match(await page.textContent('#rankBody tr[data-key="ART-104"]'), /Required/);
  assert.equal(await page.textContent('#rankBody tr[data-key="ART-101"] td.score'), '3.20');
  await menu(page, '#dbMenuBtn', 'Deutsch');
  await page.waitForSelector(READY);
  assert.equal(await page.textContent('#csvMenuBtn'), 'CSV');
  assert.equal(await page.textContent('#settingsBtn'), 'Einstellungen');
  assert.deepEqual(errors, []);
  await ctx.close();
  step('Englisch und Sprachwechsel');
}

(async () => {
  let browser = null;
  const started = Date.now();
  try {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('Erst bauen: node tools/build.cjs');
    browser = await loadPlaywright().chromium.launch();
    await runMain(browser);
    await runNoFsa(browser);
    await runEnglish(browser);
    console.log(`\nApp-Test bestanden (${Math.round((Date.now() - started) / 1000)} s).`);
  } catch (e) {
    console.error('\nApp-Test FEHLGESCHLAGEN');
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
