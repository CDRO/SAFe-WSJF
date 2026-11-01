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
const rankKeys = page => page.$$eval('.sw-rank-body tr', trs => trs.map(t => t.dataset.key));

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
  await page.waitForSelector('.sw-rank-body tr');
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
  await page.waitForSelector('.sw-rank-body tr');
  await saved(page);
  assert.deepEqual(await rankKeys(page), ['ART-104', 'ART-103', 'ART-101', 'ART-110', 'ART-105']);
  assert.match(await page.textContent('.sw-rank-body tr[data-key="ART-104"]'), /Erforderlich/);
  assert.equal(await page.textContent('.sw-hidden-count'), '(1)');
  assert.equal(await page.isVisible('.sw-grid[data-grid="1"] .sw-cell[data-x="8"][data-y="3"] .sw-card[data-key="ART-101"]'), true);
  assert.equal(await page.isVisible('.sw-pool[data-pool="2"] .sw-card[data-key="ART-105"]'), true);
  assert.match(await page.textContent('#csvStatus'), /aktuell/);
  step('Zug anlegen, CSV mit Zuordnung einlesen, Rangfolge');

  // Ziehen ins Raster, Dialog, Rückgängig.
  await page.dragAndDrop('.sw-pool[data-pool="2"] .sw-card[data-key="ART-105"]', '.sw-grid[data-grid="2"] .sw-cell[data-x="8"][data-y="3"]');
  await page.waitForSelector('.sw-grid[data-grid="2"] .sw-cell[data-x="8"][data-y="3"] .sw-card[data-key="ART-105"]');
  await page.click('.sw-grid[data-grid="1"] .sw-card[data-key="ART-105"]').catch(() => {}); // steht im Raster 1 noch nicht
  await page.click('.sw-pool[data-pool="1"] .sw-card[data-key="ART-105"]');
  await page.waitForSelector('.sw-dialog[open] select[data-field="rroe"]');
  await page.selectOption('.sw-dialog select[data-field="rroe"]', '2');
  assert.match(await page.textContent('.sw-dialog .sw-item-score'), /4\.33/);
  assert.match(await page.textContent('.sw-dialog'), /in der CSV: –/);
  await page.click('.sw-dialog .sw-close');
  assert.equal(await page.textContent('.sw-rank-body tr[data-key="ART-105"] td.sw-score'), '4.33');
  assert.deepEqual((await rankKeys(page)).slice(0, 2), ['ART-104', 'ART-105']);
  await page.keyboard.press('Control+z');
  assert.equal((await page.textContent('.sw-rank-body tr[data-key="ART-105"] td.sw-score')).startsWith('–'), true);
  await page.keyboard.press('Control+z');
  assert.equal(await page.isVisible('.sw-pool[data-pool="2"] .sw-card[data-key="ART-105"]'), true);
  await page.dragAndDrop('.sw-pool[data-pool="2"] .sw-card[data-key="ART-105"]', '.sw-grid[data-grid="2"] .sw-cell[data-x="8"][data-y="3"]');
  await page.dragAndDrop('.sw-pool[data-pool="1"] .sw-card[data-key="ART-105"]', '.sw-grid[data-grid="1"] .sw-cell[data-x="3"][data-y="2"]');
  await saved(page);
  assert.match(await page.textContent('#csvStatus'), /1 Änderung zurückschreiben/);
  step('Ziehen ins Raster, Ticket-Dialog, Rückgängig');

  // Beschreibung als Jira-Wiki-Markup: formatiert (offen), umschaltbar auf Quelltext; Skripte werden nicht ausgeführt.
  await page.evaluate(() => {
    WsjfSession.db.run('UPDATE items SET description = ? WHERE issue_key = ?',
      ['h3. Ziel\n* Bullet 1\n** Bullet 2\n[Link][https://www.google.com/]\n* KeyUser:\n** [~U0398261]\n<img src=x onerror="window.__xss=1">', 'ART-103']);
    WsjfApp.refresh();
  });
  await page.click('.sw-rank-body tr[data-key="ART-103"]');
  await page.waitForSelector('.sw-dialog[open] .sw-item-desc[open] .sw-desc.sw-wiki');
  assert.equal(await page.textContent('.sw-dialog .sw-wiki h3'), 'Ziel');
  assert.equal(await page.$$eval('.sw-dialog .sw-wiki ul ul li', l => l.map(x => x.textContent).join('|')), 'Bullet 2|@U0398261');
  assert.equal(await page.getAttribute('.sw-dialog .sw-wiki a', 'href'), 'https://www.google.com/');
  assert.equal(await page.$('.sw-dialog .sw-wiki img'), null);
  await page.click('.sw-dialog [data-mode="raw"]');
  assert.match(await page.textContent('.sw-dialog .sw-desc-raw'), /^h3\. Ziel\n\* Bullet 1/);
  await page.click('.sw-dialog [data-mode="wiki"]');
  await page.click('.sw-dialog .sw-close');
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  step('Beschreibung: Jira-Wiki-Markup, Quelltext');

  // Ablagefelder: erforderlich, ausblenden, Werte löschen; Label-Schalter.
  await page.evaluate(() => WsjfApp.dropOn('ART-110', '.sw-drop-zone[data-zone="required"]'));
  assert.equal((await rankKeys(page)).indexOf('ART-110') < 2, true);
  await page.evaluate(() => WsjfApp.dropOn('ART-110', '.sw-drop-zone[data-zone="hidden"]'));
  assert.equal(await page.textContent('.sw-hidden-count'), '(2)');
  await page.click('.sw-hidden-box summary');
  await page.click('.sw-hidden-list li[data-key="ART-110"] button');
  assert.equal(await page.textContent('.sw-hidden-count'), '(1)');
  await page.click('#labelToggles button');
  assert.equal(await page.textContent('.sw-hidden-count'), '(0)');
  await page.click('#labelToggles button');
  assert.equal(await page.textContent('.sw-hidden-count'), '(1)');
  await page.evaluate(() => WsjfApp.dropOn('ART-110', '.sw-drop-zone[data-zone="clear"]'));
  assert.equal(await page.isVisible('.sw-pool[data-pool="1"] .sw-card[data-key="ART-110"]'), true);
  await page.keyboard.press('Control+z');
  assert.equal(await page.isVisible('.sw-grid[data-grid="1"] .sw-card[data-key="ART-110"]'), true);
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
  await page.click('.sw-rank-body tr[data-key="ART-103"]');
  await page.selectOption('.sw-dialog select[data-field="ubv"]', '13');
  await page.click('.sw-dialog .sw-close');
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
  await page.dragAndDrop('.sw-grid[data-grid="1"] .sw-card[data-key="ART-120"]', '.sw-pool[data-pool="1"]');
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
  await page.waitForFunction(() => document.querySelector('.sw-rank-body tr[data-key="ART-101"] td:nth-child(8)').textContent === '13');
  step('Datenbankdatei anlegen, schreiben, Änderung von aussen laden');

  // Einstellungen: Skala und Name.
  await page.click('#settingsBtn');
  await page.fill('#setScale', '1, 2, 3, 5, 8, 13, 21');
  await page.fill('#setName', 'ART Plattform Süd');
  await page.click('#dialog button[type=submit]');
  await page.waitForFunction(() => [...document.querySelectorAll('.sw-grid[data-grid="1"] .sw-head-x')].map(h => h.textContent).join(',') === '1,2,3,5,8,13,21');
  assert.equal(await page.textContent('#trainName'), 'ART Plattform Süd');
  step('Einstellungen: Skala, Name');

  // Farben: hell oben links, dunkel unten rechts (beide Raster); Präferenzen je Raster, gleiche Farbe erlaubt, bleibt nach Neuladen.
  const light = sel => page.$eval(sel, e => {
    const [r, g, b] = getComputedStyle(e).backgroundColor.match(/\d+/g).map(Number);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
  for (const n of [1, 2]) {
    const tl = await light(`.sw-grid[data-grid="${n}"] .sw-cell[data-x="1"][data-y="1"]`);
    const tr = await light(`.sw-grid[data-grid="${n}"] .sw-cell[data-x="21"][data-y="1"]`);
    const bl = await light(`.sw-grid[data-grid="${n}"] .sw-cell[data-x="1"][data-y="21"]`);
    const br = await light(`.sw-grid[data-grid="${n}"] .sw-cell[data-x="21"][data-y="21"]`);
    assert.ok(tl > tr && tl > bl && tr > br && bl > br, `Raster ${n}: ${tl} ${tr} ${bl} ${br}`);
  }
  assert.deepEqual(await page.$$eval('.sw-grid', gs => gs.map(g => g.dataset.color)), ['himmelblau', 'koralle']);
  await page.click('#prefsBtn');
  await page.waitForSelector('#dialog[open] #colors1');
  assert.equal(await page.$$eval('#colors1 .swatch', b => b.length), 32);
  assert.equal(await page.$$eval('#colors2 .swatch', b => b.length), 32);
  await page.click('#colors2 [data-color="smaragd"]');
  assert.equal(await page.$eval('.sw-grid[data-grid="2"]', g => g.dataset.color), 'smaragd', 'Vorschau');
  await page.click('#dialog button:not(.primary):not(.danger-link):text("Abbrechen")');
  assert.equal(await page.$eval('.sw-grid[data-grid="2"]', g => g.dataset.color), 'koralle', 'Abbrechen setzt zurück');
  await page.click('#prefsBtn');
  await page.click('#colors1 [data-color="smaragd"]');
  await page.focus('#colors2 [data-color="koralle"]');
  await page.keyboard.press('ArrowLeft');
  await page.click('#colors2 [data-color="smaragd"]');
  await page.click('#prefsOk');
  assert.deepEqual(await page.$$eval('.sw-grid', gs => gs.map(g => g.dataset.color)), ['smaragd', 'smaragd']);
  await page.reload();
  await page.waitForSelector(READY);
  assert.deepEqual(await page.$$eval('.sw-grid', gs => gs.map(g => g.dataset.color)), ['smaragd', 'smaragd']);
  assert.equal(await page.$eval('.sw-grid[data-grid="1"] .sw-cell[data-x="1"][data-y="1"]', e => getComputedStyle(e).backgroundColor),
    await page.$eval('.sw-grid[data-grid="2"] .sw-cell[data-x="1"][data-y="1"]', e => getComputedStyle(e).backgroundColor));
  await page.click('#prefsBtn');
  await page.click('#prefsReset');
  await page.click('#prefsOk');
  assert.deepEqual(await page.$$eval('.sw-grid', gs => gs.map(g => g.dataset.color)), ['himmelblau', 'koralle']);
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
  await page.waitForSelector('.sw-rank-body tr[data-key="KL-1"]');
  await saved(page);
  await page.keyboard.press('Alt+1');
  await page.waitForFunction(() => document.querySelector('#trainName').textContent === 'ART Plattform Süd');
  assert.match(page.url(), /#zug=art-plattform$/);
  await page.reload();
  await page.waitForSelector(READY);
  assert.equal(await page.textContent('#trainName'), 'ART Plattform Süd');
  assert.equal(await page.isVisible('.sw-rank-body tr[data-key="ART-120"]'), true);
  await page.goto(APP_URL + '#zug=2');
  await page.waitForSelector(READY);
  await page.waitForSelector('.sw-rank-body tr[data-key="KL-1"]');
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
  await page.waitForSelector('.sw-rank-body tr');
  assert.match(await page.textContent('#fileStatus'), /Kopie regelmässig herunterladen/);
  await page.dragAndDrop('.sw-pool[data-pool="2"] .sw-card[data-key="ART-105"]', '.sw-grid[data-grid="2"] .sw-cell[data-x="1"][data-y="1"]');
  await page.dragAndDrop('.sw-pool[data-pool="1"] .sw-card[data-key="ART-105"]', '.sw-grid[data-grid="1"] .sw-cell[data-x="3"][data-y="1"]');
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

/** Ziehen mit der Maus (für Ziele, die erst beim Ziehen erscheinen, wie die Leisten neben dem Ticket). */
async function dragToStrip(page, cardSel, zoneSel) {
  const card = page.locator(cardSel);
  await card.scrollIntoViewIfNeeded();
  const b = await card.boundingBox();
  await page.mouse.move(b.x + 20, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + 16, { steps: 3 });
  await page.waitForSelector('.sw-strip-y:not([hidden])');
  const z = await page.locator(zoneSel).boundingBox();
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector('.sw-strip-y[hidden]', { state: 'attached' });
}

async function runPresentation(browser) {
  const { page, errors, ctx } = await newApp(browser, { context: { viewport: { width: 1600, height: 1000 } } });
  await createTrain(page, 'Workshop');
  await importFirst(page);
  const values = k => page.evaluate(key => { const i = WsjfSession.db.item(key); return [i.ubv, i.rroe, i.tc, i.jobSize]; }, k);

  // Lesbarkeit: Spalten breit genug für 50 Zeichen, Raster scrollt seitlich.
  const colW = await page.$eval('.sw-grid[data-grid="1"] .sw-cell', c => c.getBoundingClientRect().width);
  assert.ok(colW >= 220, 'Spaltenbreite ' + colW);
  assert.ok(await page.$eval('.sw-grid[data-grid="1"]', g => g.parentElement.scrollWidth > g.parentElement.clientWidth), 'Raster scrollt seitlich');
  assert.equal(await page.$eval('.sw-grid[data-grid="1"] .sw-card[data-key="ART-101"] .sw-card-summary', e => e.scrollHeight <= e.clientHeight + 1), true, '«Self-Service Portal für Kunden» ganz lesbar');

  // Präsentationsmodus: P, Raster untereinander, Kopf- und Statusleiste weg, Grösse, Esc.
  await page.keyboard.press('p');
  assert.equal(await page.evaluate(() => document.body.classList.contains('presenting')), true);
  assert.equal(await page.isVisible('.sw-present-bar'), true);
  assert.equal(await page.isVisible('.topbar'), false);
  assert.equal(await page.isVisible('.statusbar'), false);
  assert.equal(await page.textContent('.sw-present-title'), 'Workshop');
  const [p1, p2] = await page.$$eval('.sw-pair', ps => ps.map(p => p.getBoundingClientRect()));
  assert.ok(p2.top >= p1.bottom && Math.abs(p1.left - p2.left) < 1, 'untereinander');
  assert.equal(await page.textContent('.sw-zoom-value'), '100 %');
  await page.click('.sw-zoom-in');
  await page.keyboard.press('+');
  assert.equal(await page.textContent('.sw-zoom-value'), '120 %');
  assert.equal(await page.$eval('.sw-pairs', e => e.style.zoom), '1.2');
  await page.keyboard.press('-');
  assert.equal(await page.textContent('.sw-zoom-value'), '110 %');
  step('Präsentationsmodus: untereinander, Grösse, Lesbarkeit');

  // Leisten neben dem gezogenen Ticket: rechts nur die Zeile, darunter nur die Spalte; aktueller Wert gesperrt.
  await dragToStrip(page, '.sw-grid[data-grid="1"] .sw-card[data-key="ART-101"]', '.sw-strip-y .sw-strip-zone[data-value="13"]');
  assert.deepEqual((await values('ART-101')).slice(0, 2), [8, 13]);
  await dragToStrip(page, '.sw-grid[data-grid="1"] .sw-card[data-key="ART-101"]', '.sw-strip-x .sw-strip-zone[data-value="2"]');
  assert.deepEqual((await values('ART-101')).slice(0, 2), [2, 13]);
  assert.equal(await page.isVisible('.sw-grid[data-grid="1"] .sw-cell[data-x="2"][data-y="13"] .sw-card[data-key="ART-101"]'), true);
  // Aus der Liste wie in der WSJF-App: fehlender Wert wird 1 (vorhandener bleibt).
  await dragToStrip(page, '.sw-pool[data-pool="2"] .sw-card[data-key="ART-105"]', '.sw-strip-x .sw-strip-zone[data-value="8"]');
  assert.deepEqual((await values('ART-105')).slice(2), [8, 1]);
  await dragToStrip(page, '.sw-pool[data-pool="1"] .sw-card[data-key="ART-105"]', '.sw-strip-y .sw-strip-zone[data-value="5"]');
  assert.deepEqual((await values('ART-105')).slice(0, 2), [3, 5]);
  // Gesperrter aktueller Wert nimmt nichts an.
  const card = page.locator('.sw-grid[data-grid="2"] .sw-card[data-key="ART-105"]');
  await card.scrollIntoViewIfNeeded();
  const b = await card.boundingBox();
  await page.mouse.move(b.x + 20, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + 30, b.y + 16, { steps: 3 });
  await page.waitForSelector('.sw-strip-y:not([hidden])');
  assert.equal(await page.$eval('.sw-strip-y .sw-strip-zone.sw-current', z => z.dataset.value), '1');
  assert.equal(await page.$eval('.sw-strip-x .sw-strip-zone.sw-current', z => z.dataset.value), '8');
  await page.mouse.up();
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.body.classList.contains('presenting')), false);
  assert.equal(await page.isVisible('.topbar'), true);
  assert.equal(await page.$eval('.sw-pairs', e => e.style.zoom), '');
  await page.click('#presentBtn');
  assert.equal(await page.textContent('.sw-zoom-value'), '110 %', 'Grösse bleibt gemerkt');
  await page.click('.sw-present-exit');
  assert.deepEqual(errors, []);
  await ctx.close();
  step('Leisten neben dem Ticket: Zeile, Spalte, aus der Liste, gesperrter Wert');
}

async function runEnglish(browser) {
  const { page, errors, ctx } = await newApp(browser, { context: { locale: 'en-US' } });
  assert.equal(await page.textContent('#welcome h1'), 'SAFe WSJF');
  assert.equal(await page.textContent('#welcomeForm button'), 'Create');
  await createTrain(page, 'Train');
  await importFirst(page);
  assert.match(await page.textContent('.sw-ranking h2'), /^Prioritised list\s*\(5\)$/);
  assert.match(await page.textContent('.sw-rank-body tr[data-key="ART-104"]'), /Required/);
  assert.equal(await page.textContent('.sw-rank-body tr[data-key="ART-101"] td.sw-score'), '3.20');
  await menu(page, '#dbMenuBtn', 'Deutsch');
  await page.waitForSelector(READY);
  assert.equal(await page.textContent('#csvMenuBtn'), 'CSV');
  assert.equal(await page.textContent('#settingsBtn'), 'Einstellungen');
  assert.deepEqual(errors, []);
  await ctx.close();
  step('Englisch und Sprachwechsel');
}

// ---------- Eingebettet: grid.js auf einer fremden Seite mit Quelle im Speicher ----------

/** Seite eines Gastgebers aus der Liste «files» in package.json: nur diese Dateien, in dieser Reihenfolge. */
function writeEmbedPage() {
  const files = require(path.join(ROOT, 'package.json')).files.filter(f => f.startsWith('src/'));
  const rel = f => path.relative(path.join(ROOT, 'dist', 'embed-test'), path.join(DIST, f.replace(/^src\//, ''))).split(path.sep).join('/');
  for (const f of files) assert.ok(fs.existsSync(path.join(DIST, f.replace(/^src\//, ''))), 'im Paket: ' + f);
  const html = `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><title>Gastgeber</title>
${files.filter(f => f.endsWith('.css')).map(f => `<link rel="stylesheet" href="${rel(f)}">`).join('\n')}
<style>body { margin: 0; font: 14px sans-serif; } #host { padding: 8px; }</style></head>
<body>
<div class="host-bar"><button type="button" id="hostBtn">Host</button><input id="hostInput"></div>
<div id="host"></div>
${files.filter(f => f.endsWith('.js')).map(f => `<script src="${rel(f)}"></script>`).join('\n')}
<script>
  /** Quelle im Speicher wie bei einem Gastgeber: list, setValues, setState, subscribe; undo nur auf Wunsch. */
  window.memorySource = function (items, withUndo) {
    const data = items.map(i => Object.assign({ status: '', type: '', team: '', labels: [], description: '', ubv: null, rroe: null, tc: null, jobSize: null, state: 'open' }, i));
    const subs = new Set();
    const log = [];
    const find = key => data.find(d => d.key === key);
    const src = {
      data, log,
      async list() { return JSON.parse(JSON.stringify(data)); },
      async setValues(key, patch) { log.push(['setValues', key, patch]); Object.assign(find(key), patch); },
      async setState(key, state) { log.push(['setState', key, state]); find(key).state = state; },
      subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
      emit() { subs.forEach(cb => cb()); },
      subscribers: () => subs.size,
    };
    if (withUndo) src.undo = async () => { log.push(['undo']); };
    return src;
  };
  window.mount = function (src, extra) {
    window.__events = [];
    const ev = name => (...a) => window.__events.push([name, ...a]);
    window.__src = src;
    window.__grid = SafeWsjf.create(document.getElementById('host'), Object.assign({
      source: src, scale: [1, 2, 3, 5, 8, 13, 20], required: { ubv: 100, rroe: 100, tc: 100, jobSize: 1 }, hide: true,
      prefs: { colors: { 1: 'smaragd', 2: 'gold' }, zoom: 1 }, onPrefs: ev('prefs'), onPresent: ev('present'), notify: ev('notify'), onError: ev('error'),
    }, extra || {}));
    return window.__grid.refresh();
  };
</script>
</body></html>
`;
  fs.mkdirSync(path.join(ROOT, 'dist', 'embed-test'), { recursive: true });
  const file = path.join(ROOT, 'dist', 'embed-test', 'index.html');
  fs.writeFileSync(file, html);
  return 'file://' + file;
}

const EMBED_ITEMS = [
  { key: 'E-1', summary: 'Eins', team: 'Rot', ubv: 8, rroe: 3, tc: 5, jobSize: 5, description: '**fett**' },
  { key: 'E-2', summary: 'Zwei', team: 'Blau' },
  { key: 'E-3', summary: 'Drei', state: 'hidden', labels: ['informell'] },
  { key: 'E-4', summary: 'Vier', state: 'required' },
  { key: 'E-5', summary: 'Fünf', ubv: 13, rroe: 8, tc: 8, jobSize: 3 },
];

async function runEmbed(browser) {
  const url = writeEmbedPage();
  const ctx = await browser.newContext({ locale: 'de-CH', viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const errors = watchErrors(page);
  await page.goto(url);
  const data = key => page.evaluate(k => { const d = window.__src.data.find(x => x.key === k); return [d.ubv, d.rroe, d.tc, d.jobSize, d.state]; }, key);
  const events = name => page.evaluate(n => window.__events.filter(e => e[0] === n).map(e => e.slice(1)), name);

  // Standard: eigene Texte (Deutsch), eigener Dialog mit Wiki-Darstellung, Rückgängig über den eigenen Stapel.
  await page.evaluate(items => mount(memorySource(items, false), {
    renderDescription: it => '<b class="host-md">' + it.description.replace(/\*/g, '') + '</b>',
    labels: { title: 'PI 26.4' },
  }), EMBED_ITEMS);
  assert.equal(await page.$$eval('#host > .safe-wsjf', r => r.length), 1);
  assert.equal(await page.isVisible('.sw-grid[data-grid="1"] .sw-cell[data-x="8"][data-y="3"] .sw-card[data-key="E-1"]'), true);
  assert.equal(await page.isVisible('.sw-pool[data-pool="1"] .sw-card[data-key="E-2"]'), true);
  assert.deepEqual(await page.$$eval('.sw-grid', gs => gs.map(g => g.dataset.color)), ['smaragd', 'gold']);
  assert.deepEqual(await rankKeys(page), ['E-4', 'E-5', 'E-1', 'E-2']);
  assert.match(await page.textContent('.sw-rank-body tr[data-key="E-4"]'), /Erforderlich/);
  assert.equal(await page.textContent('.sw-rank-body tr[data-key="E-5"] td.sw-score'), '9.67');
  assert.equal(await page.textContent('.sw-hidden-count'), '(1)');
  assert.equal(await page.textContent('.sw-ranking th:nth-child(2)'), 'Schlüssel');
  assert.equal(await page.evaluate(() => window.__src.subscribers()), 1);
  step('Eingebettet: Raster, Farben, priorisierte Liste aus der Quelle');

  // Ziehen ins Raster und auf die Leisten.
  await page.dragAndDrop('.sw-pool[data-pool="1"] .sw-card[data-key="E-2"]', '.sw-grid[data-grid="1"] .sw-cell[data-x="5"][data-y="2"]');
  await page.waitForSelector('.sw-grid[data-grid="1"] .sw-cell[data-x="5"][data-y="2"] .sw-card[data-key="E-2"]');
  assert.deepEqual(await data('E-2'), [5, 2, null, null, 'open']);
  await dragToStrip(page, '.sw-grid[data-grid="1"] .sw-card[data-key="E-1"]', '.sw-strip-y .sw-strip-zone[data-value="13"]');
  assert.deepEqual((await data('E-1')).slice(0, 2), [8, 13]);
  await dragToStrip(page, '.sw-pool[data-pool="2"] .sw-card[data-key="E-2"]', '.sw-strip-x .sw-strip-zone[data-value="8"]');
  assert.deepEqual((await data('E-2')).slice(2, 4), [8, 1]);
  step('Eingebettet: Ziehen ins Raster, Leisten neben dem Ticket');

  // Ablagefelder: erforderlich, ausblenden, wieder einblenden; Ctrl+Z über den eigenen Stapel.
  await page.evaluate(() => __grid.drop('E-2', document.querySelector('.sw-drop-zone[data-zone="required"]')));
  assert.deepEqual((await rankKeys(page)).slice(0, 2), ['E-2', 'E-4']);
  assert.equal((await events('notify'))[0][0], 'E-2 ist erforderlich und steht oben in der Liste.');
  await page.evaluate(() => __grid.drop('E-1', document.querySelector('.sw-drop-zone[data-zone="hidden"]')));
  assert.equal(await page.textContent('.sw-hidden-count'), '(2)');
  assert.equal((await data('E-1'))[4], 'hidden');
  await page.click('.sw-hidden-box summary');
  await page.click('.sw-hidden-list li[data-key="E-3"] button');
  assert.equal(await page.textContent('.sw-hidden-count'), '(1)');
  await page.keyboard.press('Control+z');
  assert.equal(await page.textContent('.sw-hidden-count'), '(2)');
  await page.keyboard.press('Control+z');
  assert.equal(await page.textContent('.sw-hidden-count'), '(1)');
  assert.equal((await data('E-1'))[4], 'open');
  await page.keyboard.press('Control+z');
  assert.equal((await data('E-2'))[4], 'open');
  await page.evaluate(() => __grid.drop('E-5', document.querySelector('.sw-drop-zone[data-zone="clear"]')));
  assert.deepEqual(await data('E-5'), [null, null, null, null, 'open']);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await data('E-5'), [13, 8, 8, 3, 'open']);
  step('Eingebettet: Erforderlich, Ausblenden, Einblenden, Werte löschen, Ctrl+Z');

  // Eigener Dialog: Werte wählen, Beschreibung vom Gastgeber, Zustand.
  await page.click('.sw-rank-body tr[data-key="E-1"]');
  await page.waitForSelector('.sw-dialog[open] select[data-field="tc"]');
  assert.equal(await page.textContent('.sw-dialog .sw-wiki .host-md'), 'fett');
  await page.selectOption('.sw-dialog select[data-field="tc"]', '20');
  assert.match(await page.textContent('.sw-dialog .sw-item-score'), /8\.20/);
  assert.equal((await data('E-1'))[2], 20);
  await page.click('.sw-dialog [data-state="required"]');
  assert.equal(await page.$eval('.sw-dialog select[data-field="tc"]', s => s.disabled), true);
  assert.match(await page.textContent('.sw-dialog .sw-item-score'), /300\.00/);
  await page.click('.sw-dialog [data-state="open"]');
  await page.click('.sw-dialog .sw-close');
  assert.equal(await page.isVisible('.sw-dialog'), false);
  step('Eingebettet: Ticket-Dialog, Beschreibung vom Gastgeber');

  // Änderung von aussen: subscribe.
  await page.evaluate(() => { window.__src.data.find(d => d.key === 'E-2').ubv = 20; window.__src.emit(); });
  await page.waitForFunction(() => document.querySelector('.sw-rank-body tr[data-key="E-2"] td:nth-child(5)').textContent === '20');
  step('Eingebettet: Änderung der Quelle über subscribe');

  // Präsentationsmodus: Vollbild des Containers, Grösse, onPrefs; Tasten nicht in Feldern des Gastgebers.
  await page.focus('#hostInput');
  await page.keyboard.press('p');
  assert.equal(await page.evaluate(() => document.querySelector('.safe-wsjf').classList.contains('sw-presenting')), false, 'P im Feld des Gastgebers');
  await page.click('#hostBtn');
  await page.keyboard.press('p');
  assert.equal(await page.evaluate(() => document.querySelector('.safe-wsjf').classList.contains('sw-presenting')), true);
  assert.equal(await page.isVisible('.sw-present-bar'), true);
  assert.equal(await page.textContent('.sw-present-title'), 'PI 26.4');
  assert.deepEqual(await events('present'), [[true]]);
  await page.keyboard.press('+');
  assert.equal(await page.textContent('.sw-zoom-value'), '110 %');
  assert.equal(await page.$eval('.sw-pairs', e => e.style.zoom), '1.1');
  assert.deepEqual((await events('prefs')).pop()[0].zoom, 1.1);
  await page.evaluate(() => __grid.setZoom(5));
  assert.equal(await page.textContent('.sw-zoom-value'), '200 %');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.querySelector('.safe-wsjf').classList.contains('sw-presenting')), false);
  assert.equal(await page.$eval('.sw-pairs', e => e.style.zoom), '');
  await page.evaluate(() => __grid.present(true));
  assert.equal(await page.isVisible('.sw-present-bar'), true);
  await page.click('.sw-present-exit');
  assert.deepEqual(await events('present'), [[true], [false], [true], [false]]);
  step('Eingebettet: Präsentationsmodus, Grösse, Tasten nur ausserhalb von Feldern');

  // Abbauen: nichts bleibt zurück.
  await page.evaluate(() => __grid.destroy());
  assert.equal(await page.$('#host .safe-wsjf'), null);
  assert.equal(await page.evaluate(() => window.__src.subscribers()), 0);
  await page.keyboard.press('p');
  assert.deepEqual(errors, []);

  // Gastgeber mit eigener Übersetzung, eigenem Dialog, undo in der Quelle, ohne «Erforderlich» und «Ausblenden».
  await page.evaluate(items => mount(memorySource(items, true), {
    required: false, hide: false, labels: { keyLabel: 'ID' },
    i18n: { lang: 'en', t: (key, p) => (key === 'Offen' ? 'Open (host)' : key.replace(/\{(\w+)\}/g, (m, k) => (p && k in p ? p[k] : m))) },
    onOpen: key => window.__events.push(['open', key]),
  }), EMBED_ITEMS);
  assert.match(await page.textContent('.sw-pool[data-pool="1"] h2'), /^Open \(host\)/);
  assert.match(await page.textContent('.sw-ranking h2'), /^Prioritised list/, 'Text aus dem Sprachpaket des Bausteins');
  assert.equal(await page.textContent('.sw-ranking th:nth-child(2)'), 'ID');
  assert.equal(await page.textContent('.sw-rank-body tr[data-key="E-5"] td.sw-score'), '9.67');
  assert.equal(await page.$eval('.sw-drop-zone[data-zone="required"]', z => z.hidden), true);
  assert.equal(await page.$eval('.sw-drop-zone[data-zone="hidden"]', z => z.hidden), true);
  assert.equal(await page.$eval('.sw-hidden-box', z => z.hidden), false, 'ausgeblendete Tickets der Quelle bleiben erreichbar');
  await page.evaluate(() => __grid.drop('E-2', document.querySelector('.sw-drop-zone[data-zone="required"]')));
  assert.equal((await data('E-2'))[4], 'open', 'ohne «Erforderlich» kein Ablegen');
  await page.click('.sw-pool[data-pool="1"] .sw-card[data-key="E-2"]');
  assert.deepEqual(await events('open'), [['E-2']]);
  assert.equal(await page.$('.sw-dialog[open]'), null);
  await page.dragAndDrop('.sw-pool[data-pool="1"] .sw-card[data-key="E-2"]', '.sw-grid[data-grid="1"] .sw-cell[data-x="1"][data-y="1"]');
  await page.waitForSelector('.sw-grid[data-grid="1"] .sw-cell[data-x="1"][data-y="1"] .sw-card[data-key="E-2"]');
  await page.click('#hostBtn');
  await page.keyboard.press('Control+z');
  assert.deepEqual(await page.evaluate(() => window.__src.log.pop()), ['undo']);
  assert.deepEqual(errors, []);
  await ctx.close();
  step('Eingebettet: eigene Übersetzung, eigener Dialog, undo der Quelle, ohne Erforderlich und Ausblenden');
}

(async () => {
  let browser = null;
  const started = Date.now();
  try {
    if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('Erst bauen: node tools/build.cjs');
    browser = await loadPlaywright().chromium.launch();
    await runMain(browser);
    await runNoFsa(browser);
    await runPresentation(browser);
    await runEnglish(browser);
    await runEmbed(browser);
    console.log(`\nApp-Test bestanden (${Math.round((Date.now() - started) / 1000)} s).`);
  } catch (e) {
    console.error('\nApp-Test FEHLGESCHLAGEN');
    console.error(e);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
  }
})();
