/* Kerntest ohne Browser: CSV, Fachlogik, Datenbank. Ausführen: node test/core.cjs */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');
const Csv = require(path.join(ROOT, 'src/js/csv.js'));
const Core = require(path.join(ROOT, 'src/js/wsjf.js'));
const { WsjfDatabase } = require(path.join(ROOT, 'src/js/db.js'));
const Wiki = require(path.join(ROOT, 'src/js/wiki.js'));
const initSqlJs = require(path.join(ROOT, 'src/vendor/sql.js/sql-asm.js'));
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures/jira-export.csv'));

const step = name => console.log('  ✓ ' + name);

function load(bytes) {
  const d = Csv.decode(bytes);
  const parsed = Csv.parse(d.text);
  return { d, parsed, info: { encoding: d.encoding, bom: d.bom, fileName: 'jira-export.csv', stamp: { lastModified: 1, size: bytes.length } } };
}

function testCsv() {
  // Felder mit Trennzeichen, Anführungszeichen und Zeilenumbrüchen; CRLF; leere Felder am Ende.
  const text = 'a,b,c\r\n"x, y","he said ""hi""","line1\r\nline2"\r\n1,,\r\n';
  const p = Csv.parse(text);
  assert.equal(p.delimiter, ',');
  assert.equal(p.lineEnding, '\r\n');
  assert.equal(p.trailingNewline, true);
  assert.deepEqual(p.rows, [['a', 'b', 'c'], ['x, y', 'he said "hi"', 'line1\r\nline2'], ['1', '', '']]);
  assert.equal(Csv.stringify(p.raw, p), text, 'Originaltext der Zeilen ergibt die Datei');
  assert.equal(Csv.stringify(p.rows, p), text, 'neu geschrieben ebenfalls gleich');

  // Semikolon (Excel), LF, ohne Zeilenumbruch am Ende.
  const semi = Csv.parse('Schlüssel;Wert\nA-1;5');
  assert.equal(semi.delimiter, ';');
  assert.equal(semi.lineEnding, '\n');
  assert.equal(semi.trailingNewline, false);
  assert.deepEqual(semi.rows, [['Schlüssel', 'Wert'], ['A-1', '5']]);
  assert.equal(Csv.stringify(semi.rows, semi), 'Schlüssel;Wert\nA-1;5');

  // Alles in Anführungszeichen bleibt so.
  const qa = Csv.parse('"a","b"\n"1","2"\n');
  assert.equal(qa.quoteAll, true);
  assert.equal(Csv.stringify([['a', 'b'], ['3', '4']], qa), '"a","b"\n"3","4"\n');

  // Zeichensätze: UTF-8 mit BOM, Windows-1252 (Excel), Rundweg Byte für Byte.
  const bom = Csv.decode(Csv.encode('Grösse,€\n', 'utf-8', true));
  assert.deepEqual([bom.encoding, bom.bom, bom.text], ['utf-8', true, 'Grösse,€\n']);
  const ansi = Uint8Array.from([0x47, 0x72, 0xF6, 0x73, 0x73, 0x65, 0x2C, 0x80, 0x0A]);
  const dec = Csv.decode(ansi);
  assert.deepEqual([dec.encoding, dec.text], ['windows-1252', 'Grösse,€\n']);
  assert.deepEqual(Array.from(Csv.encode(dec.text, 'windows-1252')), Array.from(ansi));
  assert.equal(Csv.encode('→', 'windows-1252')[0], 0x3F, 'nicht darstellbar wird «?»');
}

function testCore() {
  assert.equal(Core.score({ ubv: 8, rroe: 3, tc: 5, jobSize: 5 }), 3.2);
  assert.equal(Core.score({ ubv: 8, rroe: 3, tc: null, jobSize: 5 }), null);
  assert.equal(Core.score({ ubv: 8, rroe: 3, tc: 5, jobSize: 0 }), null);
  assert.equal(Core.parseValue(' 13 - hoch'), 13);
  assert.equal(Core.parseValue('8.0'), 8);
  assert.equal(Core.parseValue('2,5'), 2.5);
  assert.equal(Core.parseValue(''), null);
  assert.equal(Core.formatValue(8), '8');
  assert.equal(Core.formatValue(3.2), '3.2');
  assert.deepEqual(Core.parseScale('20, 1;2 3 3'), [1, 2, 3, 20]);
  assert.equal(Core.parseScale('5'), null);

  // Rangfolge: erforderlich zuerst, dann WSJF absteigend, ohne Wert ans Ende, sonst natürlich nach Schlüssel.
  const items = [
    { key: 'A-10', ubv: 1, rroe: 1, tc: 1, jobSize: 1, state: 'open' },
    { key: 'A-9', ubv: 1, rroe: 1, tc: 1, jobSize: 1, state: 'open' },
    { key: 'A-1', ubv: null, state: 'open' },
    { key: 'A-2', ubv: 20, rroe: 20, tc: 20, jobSize: 1, state: 'open' },
    { key: 'A-3', state: 'required' },
  ];
  assert.deepEqual(Core.rank(items).map(i => i.key), ['A-3', 'A-2', 'A-9', 'A-10', 'A-1']);

  // Zuordnung aus Jira-Spalten (englisch und deutsch), gleichnamige Spalten.
  const { parsed } = load(FIXTURE);
  const m = Core.suggestMapping(parsed.rows[0]);
  assert.deepEqual(m.key, { header: 'Issue key', occ: 0 });
  assert.deepEqual(m.labels, { header: 'Labels' });
  assert.equal(m.ubv.header, 'Custom field (User Business Value)');
  assert.equal(m.rroe.header, 'Custom field (Risk Reduction-Opportunity Enablement Value)');
  assert.equal(m.tc.header, 'Custom field (Time Criticality)');
  assert.equal(m.jobSize.header, 'Custom field (Job Size)');
  assert.equal(m.wsjf.header, 'Custom field (WSJF)');
  assert.equal(m.team.header, 'Custom field (Team)');
  const de = Core.suggestMapping(['Zusammenfassung', 'Vorgangsschlüssel', 'Stichwörter', 'Benutzerdefiniertes Feld (Geschäftswert)', 'Benutzerdefiniertes Feld (Job Size)']);
  assert.equal(de.key.header, 'Vorgangsschlüssel');
  assert.equal(de.summary.header, 'Zusammenfassung');
  assert.equal(de.ubv.header, 'Benutzerdefiniertes Feld (Geschäftswert)');
  const r = Core.resolveMapping(parsed.rows[0], m);
  assert.deepEqual(r.labels, [8, 9]);
  assert.deepEqual(Core.resolveMapping(['X'], m).missing.includes('key'), true);

  // Dreiwegevergleich beim erneuten Einlesen.
  const ex = [{ key: 'K', ubv: 5, rroe: 3, tc: 2, jobSize: 1, base: { ubv: 8, rroe: 3, tc: 2, jobSize: 1 } }];
  const inc = [{ key: 'K', values: { ubv: 13, rroe: 5, tc: 2, jobSize: 1 } }, { key: 'N', values: { ubv: 1, rroe: null, tc: null, jobSize: null } }];
  const { result, stats } = Core.mergeValues(ex, inc);
  const k = result.get('K');
  assert.deepEqual(k.values, { ubv: 5, rroe: 5, tc: 2, jobSize: 1 }, 'lokal geänderter UBV bleibt, RROE aus Jira');
  assert.deepEqual(k.base, inc[0].values);
  assert.equal(k.conflict, true, 'UBV hier und in Jira geändert');
  assert.deepEqual(stats.conflicts, ['K']);
  assert.equal(stats.added, 1);
}

async function testDb() {
  const SQL = await initSqlJs();
  const { parsed, info } = load(FIXTURE);
  const db = WsjfDatabase.create(SQL, 'ART Plattform');
  const mapping = Core.suggestMapping(parsed.rows[0]);
  const stats = db.importCsv(parsed, info, mapping);
  assert.deepEqual([stats.added, stats.updated, stats.removed, stats.conflicts.length], [6, 0, 0, 0]);
  const byKey = k => db.item(k);
  assert.equal(byKey('ART-101').ubv, 8);
  assert.deepEqual(byKey('ART-101').labels, ['portal', 'kunden']);
  assert.equal(byKey('ART-101').description, 'Kunden sollen Termine selbst buchen.\nMit Bestätigung per Mail, "sofort".');
  assert.equal(byKey('ART-102').state, 'hidden', 'Label «informell» blendet beim ersten Einlesen aus');
  assert.equal(byKey('ART-104').state, 'required', 'Werte 100/100/100/1 gelten als erforderlich');
  assert.equal(byKey('ART-101').team, 'Team Blau');

  // Unverändert zurückgeschrieben: Byte für Byte gleich.
  assert.deepEqual(Buffer.from(db.buildCsv(Csv).bytes), FIXTURE, 'Rundweg ohne Änderung ist identisch');

  // Werte ändern: nur diese Zellen und der WSJF ändern sich.
  db.setValues('ART-105', { rroe: 2, tc: 8, jobSize: 3 });
  db.setValues('ART-101', { jobSize: 8 });
  assert.equal(Core.isDirty(byKey('ART-105'), db.settings().required), true);
  const out = db.buildCsv(Csv);
  const lines = out.text.split('\r\n');
  const orig = FIXTURE.toString('utf8').replace(/^﻿/, '').split('\r\n');
  const row = (ls, k) => ls.find(l => l.includes(',' + k + ','));
  assert.equal(row(lines, 'ART-105'), 'Dashboard für Leitung,ART-105,10105,Feature,Funnel,ART,Clara Test,05/Sep/26 9:00 AM,,,"Kennzahlen, Grafiken; Export",Team Rot,3,2,8,3,4.33,,');
  assert.ok(row(lines, 'ART-101').endsWith(',Team Blau,8,3,5,8,2,PI 26.4 S1,PI 26.4 S2'));
  assert.equal(row(lines, 'ART-103'), row(orig, 'ART-103'), 'andere Zeilen bleiben gleich');
  assert.equal(lines[0], orig[0]);
  assert.equal(out.bytes[0], 0xEF, 'BOM bleibt');

  // Nach dem Schreiben ist alles «aktuell» und ein zweiter Rundweg gleich.
  db.markWritten(Csv.parse(out.text, ','), { encoding: 'utf-8', bom: true, fileName: 'jira-export.csv', stamp: null });
  assert.equal(db.items().filter(i => Core.isDirty(i, db.settings().required)).length, 0);
  assert.equal(db.buildCsv(Csv).text, out.text);

  // Erforderlich schreibt die festen Werte.
  db.setState('ART-110', 'required');
  assert.ok(row(db.buildCsv(Csv).text.split('\r\n'), 'ART-110').includes(',Team Grün,100,100,100,1,300,'));
  db.setState('ART-110', 'open');

  // Erneut einlesen: neuer Export mit geänderten Werten, einem neuen und einem fehlenden Ticket.
  db.setValues('ART-103', { ubv: 13 }); // lokal geändert
  const next = Csv.parse(out.text, ',');
  next.rows = next.rows.filter(r => r[1] !== 'ART-110');
  next.rows.find(r => r[1] === 'ART-103').splice(12, 2, '20', '13'); // Jira: UBV und RROE geändert
  next.rows.find(r => r[1] === 'ART-101')[14] = '8'; // Jira: TC geändert
  next.rows.push(['Neu', 'ART-120', '10120', 'Feature', 'Funnel', 'ART', '', '', '', '', '', 'Team Blau', '2', '2', '2', '2', '', '', '']);
  next.raw = null;
  const s2 = db.importCsv(next, { encoding: 'utf-8', bom: true, fileName: 'jira-export.csv' }, db.settings().mapping);
  assert.deepEqual([s2.added, s2.removed], [1, 1]);
  assert.deepEqual(s2.conflicts, ['ART-103']);
  assert.equal(byKey('ART-103').ubv, 13, 'eigener Wert gewinnt im Konflikt');
  assert.equal(byKey('ART-103').rroe, 13, 'nur in Jira geändert → aus der CSV');
  assert.equal(byKey('ART-101').tc, 8);
  assert.equal(byKey('ART-110').inCsv, false);
  assert.equal(byKey('ART-120').ubv, 2);
  assert.ok(!db.buildCsv(Csv).text.includes('ART-110'), 'fehlendes Ticket wird nicht geschrieben');

  // Angehängte Spalte: wird hinten angelegt und danach zu einer normalen Spalte.
  const plain = Csv.parse('Key,Title\nA-1,One\nA-2,Two\n');
  const db2 = WsjfDatabase.create(SQL, 'Portfolio');
  const m2 = { key: { header: 'Key', occ: 0 }, summary: { header: 'Title', occ: 0 }, ubv: { append: 'UBV' }, rroe: { append: 'RROE' }, tc: { append: 'TC' }, jobSize: { append: 'Job Size' }, wsjf: { append: 'WSJF' } };
  db2.importCsv(plain, { encoding: 'utf-8', bom: false, fileName: 'p.csv' }, m2);
  db2.setValues('A-1', { ubv: 3, rroe: 2, tc: 1, jobSize: 2 });
  const w2 = db2.buildCsv(Csv);
  assert.equal(w2.text, 'Key,Title,UBV,RROE,TC,Job Size,WSJF\nA-1,One,3,2,1,2,3\nA-2,Two,,,,,\n');
  db2.markWritten(Csv.parse(w2.text, ','), { encoding: 'utf-8', bom: false, fileName: 'p.csv' });
  assert.deepEqual(db2.settings().mapping.ubv, { header: 'UBV', occ: 0 });
  assert.equal(db2.buildCsv(Csv).text, w2.text);

  // Speichern und Öffnen; fremde Dateien werden abgelehnt.
  const reopened = WsjfDatabase.open(SQL, db.export());
  assert.equal(reopened.items().length, 7);
  assert.equal(reopened.getMeta('name'), 'ART Plattform');
  const foreign = new SQL.Database();
  foreign.run('CREATE TABLE notes (id INTEGER)');
  assert.throws(() => WsjfDatabase.open(SQL, foreign.export()), /nicht von SAFe WSJF/);
  assert.throws(() => WsjfDatabase.open(SQL, Uint8Array.from([1, 2, 3])), /SQLite/);
  const newer = WsjfDatabase.create(SQL, 'x');
  newer.setMeta('schema_version', '99');
  assert.throws(() => WsjfDatabase.open(SQL, newer.export()), /Schema-Version 99/);

  // Ältere Datei ohne neuere Spalten wird angeglichen.
  const old = new SQL.Database();
  old.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('app', 'safe-wsjf'), ('schema_version', '1');");
  old.run("CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_key TEXT NOT NULL UNIQUE, summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL); INSERT INTO items (issue_key, created_at, updated_at) VALUES ('X-1', 'a', 'a')");
  const upgraded = WsjfDatabase.open(SQL, old.export());
  assert.equal(upgraded.item('X-1').state, 'open');
}

function testWiki() {
  const r = (s, ctx) => Wiki.render(s, ctx);
  // Beispiel aus einem echten Export: verschachtelte Liste, nachsichtiger Link, Erwähnung (Data Center).
  assert.equal(r('Dies ist ein Test\n* Bullet 1\n** Bullet 2\n[Link][https://www.google.com/]\n* KeyUser:\n** [~U0398261]'),
    '<p>Dies ist ein Test</p><ul><li>Bullet 1<ul><li>Bullet 2</li></ul></li></ul>'
    + '<p><a href="https://www.google.com/" target="_blank" rel="noopener noreferrer">Link</a></p>'
    + '<ul><li>KeyUser:<ul><li><span class="wiki-mention">@U0398261</span></li></ul></li></ul>');
  assert.equal(r('[~accountid:5b10ac8d82e05b22cc7d4ef5]'), '<p><span class="wiki-mention">@Benutzer</span></p>');
  // Überschriften und Auszeichnungen; Bindestriche und Unterstriche in Wörtern bleiben Text.
  assert.equal(r('h2. Ziel *fett* _kursiv_ -weg- +unter+ ^hoch^ ~tief~ ??Quelle?? {{a*b*}} Self-Service foo_bar_baz 3 - 2 - 1'),
    '<h2>Ziel <strong>fett</strong> <em>kursiv</em> <del>weg</del> <ins>unter</ins> <sup>hoch</sup> <sub>tief</sub> <cite>Quelle</cite> <code>a*b*</code> Self-Service foo_bar_baz 3 - 2 - 1</h2>');
  assert.equal(r('*fett mit _kursiv_ darin*'), '<p><strong>fett mit <em>kursiv</em> darin</strong></p>');
  // Nummeriert, gemischt verschachtelt, «-» als Aufzählung, Wechsel der Art.
  assert.equal(r('# eins\n# zwei\n#* sub\n- strich\n* stern'),
    '<ol><li>eins</li><li>zwei<ul><li>sub</li></ul></li></ol><ul><li>strich</li><li>stern</li></ul>');
  assert.equal(r('----'), '<hr>');
  assert.equal(r('bq. Zitat'), '<blockquote><p>Zitat</p></blockquote>');
  // Tabelle mit Kopf, Link und | in {{…}}.
  assert.equal(r('||A||B||\n|[x|https://a.b/c]|{{a|b}}|'),
    '<table class="wiki-table"><tbody><tr><th>A</th><th>B</th></tr><tr><td><a href="https://a.b/c" target="_blank" rel="noopener noreferrer">x</a></td><td><code>a|b</code></td></tr></tbody></table>');
  // Code wörtlich, auch einzeilig; Panels mit Titel; Vorgangsschlüssel und Adressen als Links.
  assert.equal(r('{code:java}\nif (a<b) { *x* }\n{code}'), '<pre class="wiki-code"><code>if (a&lt;b) { *x* }</code></pre>');
  assert.equal(r('{noformat}a_b_{noformat}'), '<pre class="wiki-noformat"><code>a_b_</code></pre>');
  assert.equal(r('{warning:title=Achtung}\nSiehe ART-12 und https://x.y/z.\n{warning}', { jiraUrl: 'https://jira.example.com/' }),
    '<div class="wiki-panel wiki-warning"><div class="wiki-panel-title">Achtung</div><p>Siehe '
    + '<a href="https://jira.example.com/browse/ART-12" target="_blank" rel="noopener noreferrer">ART-12</a> und '
    + '<a href="https://x.y/z" target="_blank" rel="noopener noreferrer">https://x.y/z</a>.</p></div>');
  assert.equal(r('ART-12'), '<p>ART-12</p>', 'ohne Jira-Adresse kein Link');
  assert.equal(r('{quote}\n* a\n{quote}'), '<blockquote><ul><li>a</li></ul></blockquote>');
  assert.equal(r('{color:#ff0000}rot{color}'), '<p><span style="color:#ff0000">rot</span></p>');
  assert.equal(r('Zeile\\\\Umbruch \\*kein*'), '<p>Zeile<br>Umbruch *kein*</p>');
  assert.equal(r('!screen shot.png|thumbnail!'), '<p><span class="wiki-image" title="Bild aus Jira, nicht im CSV-Export enthalten">🖼 screen shot.png</span></p>');
  // Sicherheit: kein HTML, keine fremden Schemata, keine Styles ausser Farben.
  const evil = r('<img src=x onerror=alert(1)> [a|javascript:alert(1)] [javascript:alert(1)] {color:red;background:url(x)}x{color} "\'');
  assert.ok(!/<img|javascript:"|href="javascript|background/.test(evil), evil);
  assert.ok(evil.includes('&lt;img src=x onerror=alert(1)&gt;') && evil.includes('&quot;&#39;'));
}

(async () => {
  try {
    testWiki(); step('Jira-Wiki-Markup: Blöcke, Auszeichnungen, Links, Erwähnungen, Sicherheit');
    testCsv(); step('CSV: Felder, Zeilenenden, Zeichensätze, Rundweg');
    testCore(); step('WSJF, Rangfolge, Spaltenzuordnung, Dreiwegevergleich');
    await testDb(); step('Datenbank: Einlesen, Zurückschreiben, erneut Einlesen, angehängte Spalten, Öffnen');
    console.log('\nKerntest bestanden.');
  } catch (e) {
    console.error('\nKerntest FEHLGESCHLAGEN');
    console.error(e);
    process.exitCode = 1;
  }
})();
