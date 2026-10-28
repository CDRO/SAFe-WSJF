#!/usr/bin/env node
/* SAFe WSJF – Sprachwerkzeug.
   Sammelt die Texte der Oberfläche (t('…') und tn('…', '…') im Code, die Feldnamen aus wsjf.js und den festen Text von
   index.html, gesammelt im Browser über WsjfI18n.collect) und vergleicht sie mit den Sprachpaketen in src/lang/.

   node tools/i18n.cjs check     fehlende und überzählige Texte melden (Exit-Code 1 bei Fehlern)
   node tools/i18n.cjs missing   fehlende Texte als Gerüst für das Sprachpaket ausgeben */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/** Texte aus dem Code: t('…'), tn('…', '…'); Schlüssel müssen Textliterale sein. */
function codeKeys() {
  const keys = new Set();
  const plurals = new Set();
  const lit = String.raw`'((?:[^'\\]|\\.)*)'`;
  const reT = new RegExp(String.raw`\bt\(\s*` + lit, 'g');
  const reTn = new RegExp(String.raw`\btn\(\s*` + lit + String.raw`\s*,\s*` + lit, 'g');
  for (const f of fs.readdirSync(path.join(SRC, 'js'))) {
    if (!f.endsWith('.js') || f === 'i18n.js') continue;
    const s = fs.readFileSync(path.join(SRC, 'js', f), 'utf8');
    for (const m of s.matchAll(reT)) keys.add(unescape(m[1]));
    for (const m of s.matchAll(reTn)) { plurals.add(unescape(m[1])); keys.delete(unescape(m[1])); }
  }
  const Core = require(path.join(SRC, 'js', 'wsjf.js'));
  for (const f of Core.FIELDS) keys.add(f.label);
  for (const c of require(path.join(SRC, 'js', 'palette.js')).COLORS) keys.add(c.name);
  for (const p of plurals) keys.delete(p);
  return { keys, plurals };
}

function unescape(s) { return s.replace(/\\(.)/g, '$1'); }

/** Fester Text der Seite: im Browser gesammelt (wie ihn translateDom übersetzt), samt Hilfe aus dem <template>. */
async function domKeys() {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { return null; }
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext({ locale: 'de-CH' })).newPage(); // Quelltext: Deutsch
    await page.goto('file://' + path.join(SRC, 'index.html'));
    await page.waitForSelector('body[data-ready="true"]');
    return new Set(await page.evaluate(() => {
      const I = window.WsjfI18n;
      const help = document.createElement('div');
      help.append(document.querySelector('#helpTemplate').content.cloneNode(true));
      const all = I.collect(document.body).concat(I.collect(help));
      for (const id of ['welcome', 'board', 'emptyState']) { const e = document.getElementById(id); if (e) all.push(...I.collect(e)); }
      return all;
    }));
  } finally { await browser.close(); }
}

/** Sprachpaket laden (Datei ruft WsjfI18n.register auf). */
function loadPack(file) {
  let pack = null;
  const sandbox = { window: { WsjfI18n: { register: (code, name, messages, options) => { pack = { code, name, messages, source: !!(options && options.source) }; } } } };
  sandbox.WsjfI18n = sandbox.window.WsjfI18n;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return pack;
}

async function main() {
  const cmd = process.argv[2] || 'check';
  const { keys, plurals } = codeKeys();
  const dom = await domKeys();
  if (!dom) console.warn('Playwright fehlt: fester Text der Seite wird nicht geprüft.');
  const all = new Set([...keys, ...(dom || [])]);
  let bad = false;
  for (const f of fs.readdirSync(path.join(SRC, 'lang'))) {
    const pack = loadPack(path.join(SRC, 'lang', f));
    if (pack.source) continue; // Sprache des Quelltexts
    const have = new Set(Object.keys(pack.messages));
    const missing = [...all].filter(k => !have.has(k) || pack.messages[k] === '');
    const missingPl = [...plurals].filter(k => !pack.messages[k] || typeof pack.messages[k] !== 'object');
    const extra = [...have].filter(k => !all.has(k) && !plurals.has(k));
    if (cmd === 'missing') {
      for (const k of missing) console.log(`  ${JSON.stringify(k)}: '',`);
      for (const k of missingPl) console.log(`  ${JSON.stringify(k)}: { one: '', other: '' },`);
      continue;
    }
    if (missing.length || missingPl.length) {
      bad = true;
      console.error(`${f}: ${missing.length + missingPl.length} fehlende Übersetzungen:`);
      for (const k of missing.concat(missingPl)) console.error('  ' + JSON.stringify(k));
    }
    if (extra.length && dom) {
      bad = true;
      console.error(`${f}: ${extra.length} Texte, die es nicht mehr gibt:`);
      for (const k of extra) console.error('  ' + JSON.stringify(k));
    }
    if (!bad) console.log(`${f}: ${have.size} Texte, vollständig.`);
  }
  if (bad) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
