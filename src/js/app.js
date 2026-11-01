/* SAFe WSJF – Oberfläche der App: Menüs, Dialoge, Einstellungen, Präferenzen, Hilfe, Einlesen und Zurückschreiben der CSV.
   Die Raster, die priorisierte Liste und der Präsentationsmodus kommen aus grid.js (SafeWsjf); app.js ist dessen
   Gastgeber und gibt ihm eine Quelle über WsjfSession.db (SQLite). Jede Änderung ruft WsjfSession.changed(). */
(function (global) {
  'use strict';

  const I18n = global.WsjfI18n;
  const { t, tn } = I18n;
  const Core = global.WsjfCore;
  const Csv = global.WsjfCsv;
  const Session = global.WsjfSession;
  const Palette = global.WsjfPalette;
  const { download, sameStamp } = global.WsjfStorage;

  const $ = sel => document.querySelector(sel);
  const el = (tag, attrs, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  };

  const FIELD_SHORT = { ubv: 'UBV', rroe: 'RROE', tc: 'TC', jobSize: 'Job Size' };

  const state = {
    items: [],
    settings: null,
    search: '',
    undo: [],
    presenting: false,
  };

  const db = () => Session.db;

  // ---------- Hilfen ----------

  function jiraLink(key) {
    const base = (state.settings && state.settings.jiraUrl || '').trim().replace(/\/+$/, '');
    if (!base || !/^https?:\/\//i.test(base)) return null;
    return `${base}/browse/${encodeURIComponent(key)}`;
  }

  function matches(item) {
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return [item.key, item.summary, item.team, item.assignee, item.status, (item.labels || []).join(' ')]
      .some(s => String(s || '').toLowerCase().includes(q));
  }

  function toast(text, kind) {
    const box = el('div', { class: 'toast' + (kind ? ' toast-' + kind : ''), role: kind === 'error' ? 'alert' : 'status' }, text);
    $('#toasts').append(box);
    setTimeout(() => box.classList.add('out'), kind === 'error' ? 8000 : 4500);
    setTimeout(() => box.remove(), kind === 'error' ? 8500 : 5000);
  }

  function fail(e) {
    if (e && e.name === 'AbortError') return;
    console.error(e);
    toast(e && e.message ? e.message : String(e), 'error');
  }

  // ---------- Dialoge ----------

  /** Allgemeiner Dialog. build(body, close) füllt den Inhalt; Rückgabe: Promise mit dem Wert aus close(). */
  function openDialog(build, opts) {
    const dlg = $('#dialog');
    if (dlg.open) dlg.close();
    dlg.innerHTML = '';
    dlg.className = 'dialog' + (opts && opts.wide ? ' wide' : '');
    return new Promise(resolve => {
      let done = false;
      const close = value => {
        if (done) return;
        done = true;
        if (dlg.open) dlg.close();
        resolve(value === undefined ? null : value);
      };
      dlg.onclose = () => close(null);
      dlg.oncancel = () => close(null);
      build(dlg, close);
      dlg.showModal();
      const first = dlg.querySelector('[autofocus]') || dlg.querySelector('input, select, button.primary, button');
      if (first) first.focus();
    });
  }

  /** Frage mit Knöpfen: ask({ title, text, buttons: [{ id, label, primary }] }) → id oder null. */
  function ask(o) {
    return openDialog((dlg, close) => {
      dlg.append(el('h2', { text: o.title }));
      if (o.text) dlg.append(el('p', { class: 'dialog-text', text: o.text }));
      const bar = el('div', { class: 'dialog-buttons' });
      for (const b of o.buttons) bar.append(el('button', { type: 'button', class: b.primary ? 'primary' : null, dataset: { id: b.id }, onclick: () => close(b.id) }, b.label));
      if (!o.noCancel) bar.append(el('button', { type: 'button', onclick: () => close(null) }, t('Abbrechen')));
      dlg.append(bar);
    });
  }

  function prompt(title, label, value) {
    return openDialog((dlg, close) => {
      const input = el('input', { id: 'promptInput', value: value || '', maxlength: '60', autofocus: true, required: true });
      const form = el('form', { method: 'dialog', onsubmit: e => { e.preventDefault(); const v = input.value.trim(); if (v) close(v); } },
        el('h2', { text: title }),
        el('label', { for: 'promptInput', text: label }),
        input,
        el('div', { class: 'dialog-buttons' },
          el('button', { type: 'submit', class: 'primary' }, t('OK')),
          el('button', { type: 'button', onclick: () => close(null) }, t('Abbrechen'))));
      dlg.append(form);
    });
  }

  // ---------- Menüs ----------

  function showMenu(anchor, entries) {
    const menu = $('#menu');
    menu.innerHTML = '';
    for (const e of entries) {
      if (e === '-') { menu.append(el('div', { class: 'menu-sep', role: 'separator' })); continue; }
      if (e.heading) { menu.append(el('div', { class: 'menu-heading', text: e.heading })); continue; }
      const b = el('button', { type: 'button', role: 'menuitem', class: (e.checked ? 'checked' : '') + (e.danger ? ' danger' : ''), disabled: e.disabled || null },
        el('span', { text: e.label }), e.hint ? el('kbd', { text: e.hint }) : null);
      b.addEventListener('click', () => { hideMenu(); Promise.resolve().then(e.run).catch(fail); });
      menu.append(b);
    }
    const r = anchor.getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = (r.bottom + 4) + 'px';
    const first = menu.querySelector('button:not([disabled])');
    if (first) first.focus();
  }

  function hideMenu() { $('#menu').hidden = true; }

  document.addEventListener('mousedown', e => { if (!$('#menu').hidden && !e.target.closest('#menu')) hideMenu(); });
  $('#menu').addEventListener('keydown', e => {
    const items = [...$('#menu').querySelectorAll('button:not([disabled])')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { hideMenu(); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { (items[i + 1] || items[0]).focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { (items[i - 1] || items[items.length - 1]).focus(); e.preventDefault(); }
  });

  function trainMenu() {
    const info = Session.info();
    const entries = [{ heading: t('Züge und Portfolios') }];
    info.trains.forEach((tr, i) => entries.push({
      label: tr.name, checked: tr.id === info.trainId, hint: i < 9 ? `Alt+${i + 1}` : null, run: () => Session.switchTrain(tr.id),
    }));
    entries.push('-',
      { label: t('Neuer Zug oder Portfolio…'), run: newTrain },
      { label: t('Datenbankdatei als Zug öffnen…'), run: () => Session.trainFromDbFile() },
      '-',
      { label: t('Umbenennen…'), disabled: !info.trainId, run: renameTrain },
      { label: t('Adresse kopieren'), disabled: !info.trainId, run: copyAddress },
      { label: t('Zug aus der Liste entfernen…'), disabled: !info.trainId, danger: true, run: removeTrain });
    showMenu($('#trainBtn'), entries);
  }

  function csvMenu() {
    const has = db() && db().hasCsv();
    const info = Session.info();
    showMenu($('#csvMenuBtn'), [
      { label: t('CSV einlesen…'), run: () => importCsv(false) },
      { label: info.csvFile ? t('CSV neu einlesen ({datei})', { datei: info.csvFile.name }) : t('CSV neu einlesen'), disabled: !has, run: () => importCsv(true) },
      { label: t('Spaltenzuordnung…'), disabled: !has, run: editMapping },
      '-',
      { label: t('In CSV zurückschreiben'), disabled: !has, run: writeCsv },
      { label: t('CSV herunterladen'), disabled: !has, run: downloadCsv },
    ]);
  }

  function dbMenu() {
    const info = Session.info();
    const langs = I18n.available();
    const entries = [
      { label: t('Datenbankdatei anlegen…'), disabled: !info.fileSupported, run: () => Session.createDbFile() },
      { label: t('Datenbankdatei öffnen…'), run: openDbFile },
    ];
    if (info.file && !info.file.granted) entries.push({ label: t('Mit Datei verbinden'), run: () => Session.connectFile() });
    entries.push(
      { label: t('Dateiverbindung trennen'), disabled: !info.file, run: () => Session.disconnectFile() },
      '-',
      { label: t('Kopie herunterladen'), run: () => Session.downloadCopy() },
      { label: t('Aus Kopie importieren…'), run: importCopy },
      '-',
      { heading: t('Sprache') });
    for (const l of langs) entries.push({ label: l.name, checked: I18n.language() === l.code, run: () => setLanguage(l.code) });
    showMenu($('#dbMenuBtn'), entries);
  }

  async function setLanguage(code) {
    await Session.flush();
    I18n.setLanguage(code, true);
    location.reload();
  }

  // ---------- Züge ----------

  async function newTrain() {
    const name = await prompt(t('Neuer Zug oder Portfolio'), t('Name'), '');
    if (name) await Session.createTrain(name);
  }

  async function renameTrain() {
    const name = await prompt(t('Umbenennen'), t('Name'), Session.info().trainName);
    if (name) await Session.renameTrain(name);
  }

  async function removeTrain() {
    const info = Session.info();
    const ok = await ask({
      title: t('Zug entfernen?'),
      text: t('«{name}» wird aus der Liste entfernt und seine Browser-Kopie gelöscht. Die Datenbankdatei und die CSV auf der Platte bleiben erhalten.', { name: info.trainName }),
      buttons: [{ id: 'yes', label: t('Entfernen'), primary: true }],
    });
    if (ok === 'yes') await Session.removeTrain(info.trainId);
  }

  async function copyAddress() {
    const url = location.href.split('#')[0] + '#zug=' + encodeURIComponent(Session.info().trainId);
    try { await navigator.clipboard.writeText(url); toast(t('Adresse kopiert.')); }
    catch (e) {
      await ask({ title: t('Adresse des Zugs'), text: url, buttons: [], noCancel: false });
    }
  }

  async function openDbFile() {
    const ok = await ask({
      title: t('Datenbankdatei öffnen'),
      text: t('Der Stand dieses Zugs im Browser wird durch die Datei ersetzt. Um sie als zusätzlichen Zug zu öffnen, das Menü der Züge verwenden.'),
      buttons: [{ id: 'yes', label: t('Datei wählen…'), primary: true }],
    });
    if (ok === 'yes') await Session.openDbFile();
  }

  async function importCopy() {
    const ok = await ask({
      title: t('Aus Kopie importieren'),
      text: t('Der Stand dieses Zugs wird durch die Kopie ersetzt.'),
      buttons: [{ id: 'yes', label: t('Datei wählen…'), primary: true }],
    });
    if (ok === 'yes' && await Session.importCopy()) toast(t('Kopie importiert.'));
  }

  // ---------- Quelle für das Raster (grid.js) mit Rückgängig ----------

  /* Das Raster ruft setValues und setState einzeln auf; was im selben Durchgang der Ereignisschleife kommt (z. B. Werte
     und Zustand beim Ablegen), ist ein Schritt für Ctrl+Z. */
  let group = null;

  function snapshot(key) {
    const it = db().item(key);
    return it ? { key, values: { ubv: it.ubv, rroe: it.rroe, tc: it.tc, jobSize: it.jobSize }, state: it.state } : null;
  }

  function pushUndo(snaps, always) {
    if (!snaps.length && !always) return;
    state.undo.push(snaps);
    if (state.undo.length > 50) state.undo.shift();
  }

  function record(key) {
    const s = snapshot(key);
    if (!s) return;
    if (!group) {
      group = [];
      pushUndo(group, true);
      const mine = group;
      setTimeout(() => { if (group === mine) group = null; }, 0);
    }
    if (!group.some(x => x.key === key)) group.push(s);
  }

  /** Änderung an mehreren Tickets als ein Schritt (Label-Schalter). */
  function mutate(keys, fn) {
    group = null;
    pushUndo(keys.map(snapshot).filter(Boolean));
    fn();
    Session.changed();
    refresh();
  }

  function undo() {
    group = null;
    const snaps = state.undo.pop();
    if (!snaps || !db()) return;
    db().transaction(() => {
      for (const s of snaps) {
        if (!db().item(s.key)) continue;
        db().setValues(s.key, s.values);
        db().setState(s.key, s.state);
      }
    });
    Session.changed();
    refresh();
    toast(t('Rückgängig gemacht.'));
  }

  const subscribers = new Set();

  const source = {
    async list() {
      const d = db();
      if (!d) return [];
      const s = d.settings();
      return d.items().filter(i => i.inCsv).map(i => ({
        key: i.key, summary: i.summary, status: i.status, type: i.issueType, team: i.team, assignee: i.assignee,
        labels: i.labels, description: i.description, ubv: i.ubv, rroe: i.rroe, tc: i.tc, jobSize: i.jobSize, state: i.state,
        base: i.base, conflict: i.conflict, dirty: Core.isDirty(i, s.required), href: jiraLink(i.key),
      }));
    },
    async setValues(key, patch) {
      if (!db() || !db().item(key)) return;
      record(key);
      db().setValues(key, patch);
      changedByGrid();
    },
    async setState(key, st) {
      if (!db() || !db().item(key)) return;
      record(key);
      db().setState(key, st);
      changedByGrid();
    },
    async undo() { undo(); },
    subscribe(cb) { subscribers.add(cb); return () => subscribers.delete(cb); },
  };

  /** Nach einer Änderung im Raster: speichern und die Teile der App neu zeichnen (das Raster zeichnet sich selbst). */
  function changedByGrid() {
    Session.changed();
    state.items = db().items();
    renderExtras();
    renderStatus();
  }

  let grid = null;
  const gridOptions = {
    source,
    scale: Core.DEFAULT_SCALE,
    required: Core.DEFAULT_REQUIRED,
    hide: true,
    prefs: { colors: Object.assign({}, Palette.DEFAULTS), zoom: 1 },
    onPrefs: p => {
      const prefs = loadPrefs();
      prefs.presentZoom = p.zoom;
      savePrefs(prefs);
    },
    renderDescription: it => global.WsjfWiki.render(it.description, { jiraUrl: state.settings ? state.settings.jiraUrl : '' }),
    labels: { title: '' },
    matches: it => matches(it),
    notify: (text, kind) => toast(text, kind),
    onError: e => fail(e),
    onPresent: on => {
      state.presenting = on;
      document.body.classList.toggle('presenting', on);
      if (on) hideMenu();
      // Im Vollbild des Rasters sind nur seine Kinder sichtbar: die Meldungen kommen mit.
      (on ? $('#wsjf') : document.body).append($('#toasts'));
    },
  };

  function syncGridOptions() {
    const prefs = loadPrefs();
    gridOptions.scale = state.settings.scale;
    gridOptions.required = state.settings.required;
    gridOptions.labels.title = Session.info().trainName || '';
    gridOptions.prefs = { colors: prefs.gridColors, zoom: presentZoom() };
  }

  // ---------- Zeichnen ----------

  function refresh() {
    const d = db();
    const info = Session.info();
    $('#trainName').textContent = info.trainName || t('Kein Zug');
    if (!d) {
      if (state.presenting) grid.present(false);
      $('#welcome').hidden = false;
      $('#board').hidden = true;
      $('#banner').hidden = true;
      renderStatus();
      return;
    }
    $('#welcome').hidden = true;
    $('#board').hidden = false;
    state.items = d.items();
    state.settings = d.settings();
    const hasCsv = d.hasCsv();
    $('#emptyState').hidden = hasCsv || state.items.length > 0;
    $('#wsjf').hidden = !hasCsv && !state.items.length;
    syncGridOptions();
    renderExtras();
    renderStatus();
    for (const cb of subscribers) cb();
  }

  /** Teile der App in der Liste des Rasters: Label-Schalter und Tickets, die nicht mehr in der CSV stehen. */
  function renderExtras() {
    const gone = state.items.filter(i => !i.inCsv).sort((a, b) => Core.naturalCompare(a.key, b.key));
    $('#goneBox').hidden = !gone.length;
    $('#goneCount').textContent = `(${gone.length})`;
    const gl = $('#goneList');
    gl.innerHTML = '';
    for (const it of gone) {
      gl.append(el('li', { dataset: { key: it.key } },
        el('button', { type: 'button', class: 'sw-btn sw-small', onclick: () => { db().removeItem(it.key); Session.changed(); refresh(); } }, t('Entfernen')),
        el('span', { class: 'sw-key', text: it.key }), ' ', el('span', { text: it.summary })));
    }

    // Labels zum Ausblenden: je Label ein Schalter, wenn es Tickets damit gibt.
    const box = $('#labelToggles');
    box.innerHTML = '';
    for (const label of state.settings.hideLabels) {
      const withLabel = state.items.filter(i => i.inCsv && i.labels.some(l => l.toLowerCase() === label.toLowerCase()));
      if (!withLabel.length) continue;
      const anyVisible = withLabel.some(i => i.state === 'open');
      box.append(el('button', {
        type: 'button', class: 'small', dataset: { label },
        onclick: () => {
          const keys = withLabel.filter(i => i.state !== 'required').map(i => i.key);
          mutate(keys, () => db().setStates(keys, anyVisible ? 'hidden' : 'open'));
        },
      }, anyVisible ? t('«{label}» ausblenden', { label }) : t('«{label}» einblenden', { label })));
    }
  }

  function renderStatus() {
    const info = Session.info();
    const st = $('#status');
    const busy = info.pending || info.saving;
    st.dataset.state = busy ? 'pending' : 'saved';
    st.textContent = busy ? t('Speichert…') : t('Gespeichert ({speicher})', { speicher: info.storage });
    const fs = $('#fileStatus');
    fs.innerHTML = '';
    const banner = $('#banner');
    banner.hidden = true;
    if (!info.trainId) { $('#csvStatus').textContent = ''; return; }
    if (info.file && info.file.granted) {
      fs.append(el('span', { class: 'ok', text: t('Datei: {name}', { name: info.file.name }) }));
    } else if (info.file) {
      fs.append(el('span', { class: 'warn', text: t('Datei: {name} – nicht verbunden', { name: info.file.name }) }));
      banner.hidden = false;
      $('#bannerText').textContent = t('Die Datenbankdatei «{name}» ist gemerkt, der Browser braucht nach dem Neustart deine Erlaubnis. Bis dahin arbeitest du auf der Browser-Kopie.', { name: info.file.name });
      $('#bannerBtn').textContent = t('Mit Datei verbinden');
      $('#bannerBtn').onclick = () => Session.connectFile().catch(fail);
    } else if (info.fileSupported) {
      fs.append(el('button', { type: 'button', class: 'link', onclick: () => Session.createDbFile().catch(fail) }, t('Nur im Browser – Datenbankdatei anlegen…')));
    } else {
      fs.append(el('span', { text: t('Nur im Browser – Kopie regelmässig herunterladen') }));
    }
    const d = db();
    const csv = $('#csvStatus');
    csv.innerHTML = '';
    if (d && d.hasCsv()) {
      const dirty = state.items.filter(i => i.inCsv && Core.isDirty(i, state.settings.required)).length;
      const name = d.getMeta('csv_file_name') || 'CSV';
      csv.append(el('span', { text: `CSV: ${name}` }));
      if (dirty) {
        csv.append(' · ', el('button', { type: 'button', class: 'link', onclick: () => writeCsv().catch(fail) },
          tn('{n} Änderung zurückschreiben', '{n} Änderungen zurückschreiben', dirty)));
      } else csv.append(el('span', { class: 'ok', text: ' · ' + t('aktuell') }));
      $('#writeCsvBtn').disabled = !dirty;
    }
  }

  // ---------- Präsentationsmodus (im Raster) ----------

  const ZOOM_MIN = 0.75;
  const ZOOM_MAX = 2;

  function presentZoom() {
    const z = Number(loadPrefs().presentZoom);
    return Number.isFinite(z) && z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 1;
  }

  // ---------- CSV ----------

  /** Einlesen: Datei wählen (oder die gemerkte erneut lesen), Zuordnung prüfen oder erfragen, zusammenführen. */
  async function importCsv(reread) {
    await Session.flush();
    let picked = null;
    if (reread) {
      try { picked = await Session.rereadCsv(); }
      catch (e) { fail(e); }
    }
    if (!picked) picked = await Session.pickCsv();
    if (!picked) return false;
    const decoded = Csv.decode(picked.bytes);
    let parsed = Csv.parse(decoded.text);
    if (!parsed.rows.length || !parsed.rows[0].length) throw new Error(t('Die CSV-Datei ist leer.'));
    const d = db();
    let mapping = d.settings().mapping;
    const usable = m => {
      if (!m) return false;
      const r = Core.resolveMapping(parsed.rows[0], m);
      return typeof r.key === 'number' && !r.missing.length;
    };
    if (!usable(mapping)) {
      const res = await mappingDialog({ parsed, decoded, name: picked.name, mapping });
      if (!res) return false;
      ({ parsed, mapping } = res);
    }
    const stats = d.importCsv(parsed, { encoding: decoded.encoding, bom: decoded.bom, fileName: picked.name, stamp: picked.stamp }, mapping);
    if (picked.handle) await Session.rememberCsv(picked.handle);
    else await Session.rememberCsv(null);
    state.undo = [];
    group = null;
    Session.changed();
    refresh();
    const parts = [
      tn('{n} neu', '{n} neu', stats.added),
      tn('{n} aktualisiert', '{n} aktualisiert', stats.updated),
    ];
    if (stats.removed) parts.push(tn('{n} nicht mehr in der CSV', '{n} nicht mehr in der CSV', stats.removed));
    toast(t('CSV eingelesen: {teile}.', { teile: parts.join(', ') }));
    if (stats.conflicts.length) {
      await ask({
        title: t('Konflikte beim Einlesen'),
        text: t('Bei diesen Tickets wurden die Werte hier und in Jira geändert. Dein Wert wurde behalten und wird beim Zurückschreiben übernommen: {keys}', { keys: stats.conflicts.join(', ') }),
        buttons: [{ id: 'ok', label: t('OK'), primary: true }],
        noCancel: true,
      });
    }
    return true;
  }

  /** Zuordnung bearbeiten (mit dem gespeicherten Kopf der CSV). */
  async function editMapping() {
    const csv = db().csv();
    if (!csv) return;
    const parsed = { rows: [csv.headers].concat(csv.rows), raw: null, delimiter: csv.format.delimiter };
    const res = await mappingDialog({ parsed, decoded: { encoding: csv.format.encoding, bom: csv.format.bom }, name: csv.fileName, mapping: db().settings().mapping, editOnly: true });
    if (!res) return;
    db().saveSettings({ mapping: res.mapping });
    // Werte aus der gespeicherten CSV neu lesen: wie ein erneutes Einlesen desselben Stands.
    const again = Csv.parse(Csv.stringify(parsed.rows, csv.format), csv.format.delimiter);
    db().importCsv(again, { encoding: csv.format.encoding, bom: csv.format.bom, fileName: csv.fileName, stamp: csv.stamp }, res.mapping);
    Session.changed();
    refresh();
  }

  /** Dialog für die Spaltenzuordnung. Rückgabe { parsed, mapping } oder null. */
  function mappingDialog(o) {
    let parsed = o.parsed;
    let decoded = o.decoded;
    const start = Object.assign({}, Core.suggestMapping(parsed.rows[0]), validPart(parsed.rows[0], o.mapping));
    const mapping = Object.assign({}, start);
    return openDialog((dlg, close) => {
      const draw = () => {
        dlg.innerHTML = '';
        const headers = parsed.rows[0];
        const cols = Core.columns(headers);
        const sample = parsed.rows.slice(1).filter(r => r.length > 1);
        dlg.append(el('h2', { text: t('Spalten zuordnen') }));
        dlg.append(el('p', { class: 'dialog-text', text: t('Welche Spalte des Jira-Exports enthält welchen Wert? Die Zuordnung wird für diesen Zug gespeichert und bei jedem weiteren Export wiederverwendet.') }));
        const info = el('div', { class: 'mapping-info' },
          el('span', { text: t('Datei: {name}', { name: o.name || '–' }) }),
          el('span', { text: tn('{n} Zeile', '{n} Zeilen', sample.length) }),
          el('span', { text: t('Zeichensatz: {zs}', { zs: decoded.encoding + (decoded.bom ? ' (BOM)' : '') }) }));
        if (!o.editOnly) {
          const delim = el('select', { id: 'mapDelimiter', 'aria-label': t('Trennzeichen') },
            [[',', t('Komma')], [';', t('Semikolon')], ['\t', t('Tabulator')]].map(([v, l]) => el('option', { value: v, text: l, selected: parsed.delimiter === v ? true : null })));
          delim.addEventListener('change', () => {
            parsed = Csv.parse(decoded.text, delim.value);
            for (const k of Object.keys(mapping)) delete mapping[k];
            Object.assign(mapping, Core.suggestMapping(parsed.rows[0]));
            draw();
          });
          info.append(el('label', {}, t('Trennzeichen'), ' ', delim));
        }
        dlg.append(info);

        const table = el('table', { class: 'mapping' }, el('thead', {}, el('tr', {}, el('th', { text: t('Feld') }), el('th', { text: t('Spalte') }), el('th', { text: t('Beispiel') }))));
        const tbody = el('tbody');
        for (const f of Core.FIELDS) {
          const sel = el('select', { id: 'map-' + f.id, dataset: { field: f.id } });
          sel.append(el('option', { value: '', text: f.required ? t('– bitte wählen –') : t('– keine –') }));
          if (f.kind === 'multi') {
            for (const name of [...new Set(cols.map(c => c.header))]) {
              const n = cols.filter(c => c.header === name).length;
              sel.append(el('option', { value: JSON.stringify({ header: name }), text: n > 1 ? `${name} (×${n})` : name }));
            }
          } else {
            const dup = new Map();
            cols.forEach(c => dup.set(c.header, (dup.get(c.header) || 0) + 1));
            for (const c of cols) sel.append(el('option', { value: JSON.stringify({ header: c.header, occ: c.occ }), text: dup.get(c.header) > 1 ? `${c.header} (${c.occ + 1})` : c.header }));
          }
          if (f.kind === 'value' || f.kind === 'output') {
            const name = f.kind === 'output' ? 'WSJF' : FIELD_SHORT[f.id];
            sel.append(el('option', { value: JSON.stringify({ append: name }), text: t('Neue Spalte «{name}» anhängen', { name }) }));
          }
          const cur = mapping[f.id];
          if (cur) {
            const want = cur.append ? JSON.stringify({ append: cur.append }) : JSON.stringify(f.kind === 'multi' ? { header: cur.header } : { header: cur.header, occ: cur.occ || 0 });
            for (const op of sel.options) if (op.value === want) op.selected = true;
          }
          const sampleCell = el('td', { class: 'sample' });
          const showSample = () => {
            const m = sel.value ? JSON.parse(sel.value) : null;
            if (!m || m.append) { sampleCell.textContent = m ? t('(wird beim Zurückschreiben angelegt)') : ''; return; }
            const r = Core.resolveMapping(headers, { [f.id]: m });
            const idx = r[f.id];
            const vals = [];
            for (const row of sample) {
              const v = Array.isArray(idx) ? idx.map(i => row[i]).filter(Boolean).join(', ') : row[idx];
              if (v && String(v).trim()) vals.push(String(v).trim().slice(0, 40));
              if (vals.length >= 3) break;
            }
            sampleCell.textContent = vals.join(' | ');
          };
          sel.addEventListener('change', () => {
            if (sel.value) mapping[f.id] = JSON.parse(sel.value); else delete mapping[f.id];
            showSample();
          });
          showSample();
          tbody.append(el('tr', {}, el('th', { scope: 'row' }, el('label', { for: 'map-' + f.id, text: t(f.label) }), f.required ? ' *' : ''), el('td', {}, sel), sampleCell));
        }
        table.append(tbody);
        dlg.append(el('div', { class: 'mapping-scroll' }, table));
        const err = el('p', { class: 'error', role: 'alert' });
        dlg.append(err);
        dlg.append(el('div', { class: 'dialog-buttons' },
          el('button', { type: 'button', class: 'primary', id: 'mapOk', onclick: () => {
            if (!mapping.key) { err.textContent = t('Bitte die Spalte mit dem Schlüssel (z. B. «Issue key») wählen.'); return; }
            if (!Core.VALUE_FIELDS.some(f => mapping[f])) { err.textContent = t('Bitte mindestens eine Spalte für die WSJF-Werte wählen.'); return; }
            close({ parsed, mapping: Object.assign({}, mapping) });
          } }, o.editOnly ? t('Übernehmen') : t('Einlesen')),
          el('button', { type: 'button', onclick: () => close(null) }, t('Abbrechen'))));
      };
      draw();
    }, { wide: true });
  }

  /** Die Teile einer gespeicherten Zuordnung, die zu diesen Spalten passen. */
  function validPart(headers, mapping) {
    const out = {};
    if (!mapping) return out;
    const r = Core.resolveMapping(headers, mapping);
    for (const [k, v] of Object.entries(mapping)) if (v && (v.append || (r[k] != null && r[k] !== undefined))) out[k] = v;
    return out;
  }

  /** In die CSV zurückschreiben: direkt in die gemerkte Datei, sonst als Download mit gleichem Aufbau. */
  async function writeCsv() {
    await Session.flush();
    const d = db();
    if (!d || !d.hasCsv()) { toast(t('Es wurde noch keine CSV-Datei eingelesen.'), 'error'); return; }
    const info = Session.info();
    if (info.csvFile && info.fileSupported) {
      const now = await Session.csvStamp();
      const known = d.csv().stamp;
      if (now && known && !sameStamp(now, known)) {
        const choice = await ask({
          title: t('CSV wurde verändert'),
          text: t('Die CSV-Datei wurde seit dem Einlesen geändert (zum Beispiel durch einen neuen Export aus Jira). Erst neu einlesen und zusammenführen?'),
          buttons: [{ id: 'reread', label: t('Erst neu einlesen'), primary: true }, { id: 'overwrite', label: t('Trotzdem überschreiben') }],
        });
        if (!choice) return;
        if (choice === 'reread') { if (!await importCsv(true)) return; }
      }
      const built = d.buildCsv(Csv);
      let stamp;
      try { stamp = await Session.writeCsvFile(built.bytes); }
      catch (e) {
        const alt = await ask({
          title: t('Schreiben nicht möglich'),
          text: t('Die CSV-Datei konnte nicht geschrieben werden ({fehler}). Stattdessen herunterladen?', { fehler: e.message }),
          buttons: [{ id: 'dl', label: t('Herunterladen'), primary: true }],
        });
        if (alt === 'dl') finishDownload(built);
        return;
      }
      d.markWritten(Csv.parse(built.text, built.format.delimiter), { encoding: built.format.encoding, bom: built.format.bom, fileName: built.fileName, stamp });
      Session.changed();
      refresh();
      toast(t('Werte in «{name}» geschrieben.', { name: built.fileName }));
      return;
    }
    finishDownload(d.buildCsv(Csv));
  }

  function finishDownload(built) {
    download(built.bytes, built.fileName || 'wsjf.csv', 'text/csv');
    db().markWritten(Csv.parse(built.text, built.format.delimiter), { encoding: built.format.encoding, bom: built.format.bom, fileName: built.fileName, stamp: null });
    Session.changed();
    refresh();
    toast(t('CSV heruntergeladen. Sie hat denselben Aufbau wie der Export und lässt sich wieder in Jira importieren.'));
  }

  function downloadCsv() {
    const built = db().buildCsv(Csv);
    const name = (built.fileName || 'wsjf.csv').replace(/\.csv$/i, '') + '-wsjf.csv';
    download(built.bytes, name, 'text/csv');
  }

  // ---------- Einstellungen und Hilfe ----------

  function openSettings() {
    const s = db().settings();
    openDialog((dlg, close) => {
      const name = el('input', { id: 'setName', value: Session.info().trainName, maxlength: '60', required: true });
      const scale = el('input', { id: 'setScale', value: s.scale.join(', ') });
      const req = {};
      const reqBox = el('div', { class: 'inline-fields' });
      for (const f of Core.VALUE_FIELDS) {
        req[f] = el('input', { id: 'setReq-' + f, type: 'number', step: 'any', value: String(s.required[f]) });
        reqBox.append(el('label', { for: 'setReq-' + f }, FIELD_SHORT[f], req[f]));
      }
      const labels = el('input', { id: 'setLabels', value: s.hideLabels.join(', ') });
      const jira = el('input', { id: 'setJira', type: 'url', value: s.jiraUrl, placeholder: 'https://jira.example.com' });
      const err = el('p', { class: 'error', role: 'alert' });
      dlg.append(el('form', { onsubmit: async e => {
        e.preventDefault();
        const sc = Core.parseScale(scale.value);
        if (!sc) { err.textContent = t('Die Skala braucht mindestens zwei positive Zahlen.'); return; }
        const required = {};
        for (const f of Core.VALUE_FIELDS) {
          const v = Number(req[f].value);
          if (!Number.isFinite(v)) { err.textContent = t('Die Werte für «Erforderlich» müssen Zahlen sein.'); return; }
          required[f] = v;
        }
        if (!(required.jobSize > 0)) { err.textContent = t('Job Size für «Erforderlich» muss grösser als 0 sein.'); return; }
        const nm = name.value.trim();
        db().saveSettings({
          scale: sc, required,
          hideLabels: labels.value.split(',').map(x => x.trim()).filter(Boolean),
          jiraUrl: jira.value.trim(),
        });
        if (nm && nm !== Session.info().trainName) await Session.renameTrain(nm);
        Session.changed();
        refresh();
        close(true);
      } },
      el('h2', { text: t('Einstellungen des Zugs') }),
      el('label', { for: 'setName', text: t('Name') }), name,
      el('label', { for: 'setScale', text: t('Skala der Raster') }), scale,
      el('small', { class: 'hint', text: t('Werte der Spalten und Zeilen, z. B. 1, 2, 3, 5, 8, 13, 20. Andere Werte aus der CSV bleiben erhalten, die Tickets stehen dann neben dem Raster.') }),
      el('fieldset', {}, el('legend', { text: t('Werte für «Erforderlich»') }), reqBox,
        el('small', { class: 'hint', text: t('Diese Werte schreibt die App für erforderliche Tickets in die CSV.') })),
      el('label', { for: 'setLabels', text: t('Labels zum Ausblenden') }), labels,
      el('small', { class: 'hint', text: t('Kommagetrennt. Neue Tickets mit diesen Labels werden beim Einlesen ausgeblendet; über der Liste gibt es je Label einen Schalter.') }),
      el('label', { for: 'setJira', text: t('Jira-Adresse für Links (optional)') }), jira,
      err,
      el('div', { class: 'dialog-buttons' },
        el('button', { type: 'submit', class: 'primary' }, t('Speichern')),
        el('button', { type: 'button', onclick: () => close(null) }, t('Abbrechen')))));
    }, { wide: true });
  }

  // ---------- Präferenzen (je Browser, für alle Züge) ----------

  const PREFS_KEY = 'safe-wsjf.prefs';

  function loadPrefs() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch (e) { p = null; }
    const colors = Object.assign({}, Palette.DEFAULTS);
    if (p && p.gridColors) for (const n of [1, 2]) if (Palette.byId(p.gridColors[n])) colors[n] = p.gridColors[n];
    return Object.assign({}, p && typeof p === 'object' ? p : {}, { gridColors: colors });
  }

  function savePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* nur für diese Sitzung */ }
  }

  /** Farbe je Raster: an das Raster geben (es setzt die CSS-Variablen --hue und --sat). */
  function applyGridColors(colors) {
    gridOptions.prefs = Object.assign({}, gridOptions.prefs, { colors: Object.assign({}, colors || loadPrefs().gridColors) });
    grid.refresh();
  }

  function openPreferences() {
    const prefs = loadPrefs();
    const chosen = Object.assign({}, prefs.gridColors);
    openDialog((dlg, close) => {
      const pickers = [1, 2].map(n => {
        const group = el('div', { class: 'swatches', role: 'radiogroup', id: 'colors' + n, 'aria-labelledby': 'colorsLabel' + n });
        const draw = () => {
          for (const b of group.children) {
            const on = b.dataset.color === chosen[n];
            b.setAttribute('aria-checked', String(on));
            b.tabIndex = on ? 0 : -1;
          }
          applyGridColors(chosen);
        };
        for (const c of Palette.COLORS) {
          const b = el('button', { type: 'button', role: 'radio', class: 'swatch', title: t(c.name), 'aria-label': t(c.name), dataset: { color: c.id } });
          b.style.setProperty('--hue', c.h);
          b.style.setProperty('--sat', c.s + '%');
          b.addEventListener('click', () => { chosen[n] = c.id; draw(); });
          group.append(b);
        }
        group.addEventListener('keydown', e => {
          const dir = { ArrowRight: 1, ArrowDown: 8, ArrowLeft: -1, ArrowUp: -8 }[e.key];
          if (!dir) return;
          e.preventDefault();
          const i = Palette.COLORS.findIndex(c => c.id === chosen[n]);
          const next = Palette.COLORS[(i + dir + Palette.COLORS.length) % Palette.COLORS.length];
          chosen[n] = next.id;
          draw();
          group.querySelector(`[data-color="${next.id}"]`).focus();
        });
        group.addEventListener('redraw', draw);
        draw();
        const title = n === 1 ? t('Raster oben: Direkter Nutzen × Zukünftiger Nutzen') : t('Raster unten: Dringlichkeit × Dauer');
        return el('fieldset', { class: 'color-field' }, el('legend', { id: 'colorsLabel' + n, text: title }), group);
      });
      const finish = ok => {
        if (ok) savePrefs(Object.assign(prefs, { gridColors: chosen }));
        applyGridColors();
        close(ok || null);
      };
      dlg.append(
        el('h2', { text: t('Präferenzen') }),
        el('p', { class: 'hint', text: t('Farbe der Raster, für alle Züge in diesem Browser. Hell oben links, dunkel unten rechts: dort liegen die wichtigeren Werte. Beide Raster dürfen dieselbe Farbe haben.') }),
        ...pickers,
        el('div', { class: 'dialog-buttons' },
          el('button', { type: 'button', class: 'danger-link', id: 'prefsReset', onclick: () => { Object.assign(chosen, Palette.DEFAULTS); dlg.querySelectorAll('.swatches').forEach(g => g.dispatchEvent(new Event('redraw'))); } }, t('Vorgabe wiederherstellen')),
          el('button', { type: 'button', class: 'primary', id: 'prefsOk', onclick: () => finish(true) }, t('Speichern')),
          el('button', { type: 'button', onclick: () => finish(false) }, t('Abbrechen'))));
      dlg.addEventListener('close', () => applyGridColors(), { once: true });
    }, { wide: true });
  }

  function openHelp() {
    openDialog((dlg, close) => {
      const content = $('#helpTemplate').content.cloneNode(true);
      const wrap = el('div', { class: 'help' });
      wrap.append(content);
      I18n.translateDom(wrap);
      dlg.append(wrap, el('div', { class: 'dialog-buttons' }, el('button', { type: 'button', class: 'primary', onclick: () => close(true) }, t('Schliessen'))));
    }, { wide: true });
  }

  // ---------- Verdrahtung ----------

  function wire() {
    $('#trainBtn').addEventListener('click', trainMenu);
    $('#csvMenuBtn').addEventListener('click', () => { if (db()) csvMenu(); });
    $('#dbMenuBtn').addEventListener('click', () => { if (db()) dbMenu(); });
    $('#settingsBtn').addEventListener('click', () => { if (db()) openSettings(); });
    $('#prefsBtn').addEventListener('click', openPreferences);
    $('#helpBtn').addEventListener('click', openHelp);
    $('#emptyImportBtn').addEventListener('click', () => importCsv(false).catch(fail));
    $('#writeCsvBtn').addEventListener('click', () => writeCsv().catch(fail));
    $('#removeGoneBtn').addEventListener('click', async () => {
      const gone = state.items.filter(i => !i.inCsv);
      const ok = await ask({ title: t('Entfernen?'), text: tn('{n} Ticket, das nicht mehr in der CSV steht, wird entfernt.', '{n} Tickets, die nicht mehr in der CSV stehen, werden entfernt.', gone.length), buttons: [{ id: 'yes', label: t('Entfernen'), primary: true }] });
      if (ok !== 'yes') return;
      db().transaction(() => gone.forEach(i => db().removeItem(i.key)));
      Session.changed();
      refresh();
    });
    $('#search').addEventListener('input', e => { state.search = e.target.value; grid.refresh(); });
    $('#welcomeForm').addEventListener('submit', e => {
      e.preventDefault();
      const name = $('#welcomeName').value.trim();
      if (name) Session.createTrain(name).catch(fail);
    });
    $('#welcomeOpenBtn').addEventListener('click', () => Session.trainFromDbFile().catch(fail));

    // Das Raster mit Liste und Präsentationsmodus (grid.js); die Teile der App kommen in seine Plätze.
    grid = global.SafeWsjf.create($('#wsjf'), gridOptions);
    $('#wsjf [data-slot="rank-actions"]').append($('#labelToggles'), $('#writeCsvBtn'));
    $('#wsjf [data-slot="rank-after"]').append($('#goneBox'));
    $('#appSlots').remove();
    $('#presentBtn').addEventListener('click', () => { if (db()) grid.present(true); });

    // P, +, −, Esc und Ctrl+Z behandelt das Raster.
    document.addEventListener('keydown', e => {
      const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
      if (document.querySelector('dialog[open]')) return;
      if (e.altKey && !e.ctrlKey && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        if (e.key === '0') { trainMenu(); return; }
        const tr = Session.info().trains[Number(e.key) - 1];
        if (tr) Session.switchTrain(tr.id).catch(fail);
        return;
      }
      if (e.key === '/' && !inField) { e.preventDefault(); $('#search').focus(); }
    });
  }

  async function main() {
    I18n.init();
    I18n.translateDom(document.body);
    document.title = 'SAFe WSJF';
    $('#version').textContent = global.WSJF_VERSION ? 'v' + String(global.WSJF_VERSION).replace(/^v/, '') : '';
    wire();
    try {
      await Session.start({
        ask,
        toast,
        changed: () => { state.undo = []; group = null; refresh(); },
        status: renderStatus,
      });
    } catch (e) { fail(e); }
    refresh();
    document.body.dataset.ready = 'true';
  }

  global.WsjfApp = { refresh, importCsv, writeCsv, undo, dropOn: (key, sel) => grid.drop(key, document.querySelector(sel)), get grid() { return grid; } };
  main();
})(window);
