/* SAFe WSJF – Oberfläche: Raster, Listen, Menüs, Dialoge, Einlesen und Zurückschreiben der CSV.
   Reines DOM ohne Bibliotheken. Die Daten liegen in WsjfSession.db (SQLite), jede Änderung ruft WsjfSession.changed(). */
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

  /** Werte je Raster: x und y. */
  const GRIDS = {
    1: { x: 'ubv', y: 'rroe' },
    2: { x: 'tc', y: 'jobSize' },
  };
  const FIELD_SHORT = { ubv: 'UBV', rroe: 'RROE', tc: 'TC', jobSize: 'Job Size' };

  const state = {
    items: [],
    settings: null,
    search: '',
    undo: [],
    dragKey: null,
  };

  const db = () => Session.db;

  // ---------- Hilfen ----------

  function fmtScore(v) {
    if (v == null) return '–';
    return v.toLocaleString(I18n.locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function fmtValue(v) {
    return v == null ? '–' : Number(v).toLocaleString(I18n.locale(), { maximumFractionDigits: 2 });
  }

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

  // ---------- Änderungen mit Rückgängig ----------

  function snapshot(key) {
    const it = state.items.find(i => i.key === key);
    return it ? { key, values: { ubv: it.ubv, rroe: it.rroe, tc: it.tc, jobSize: it.jobSize }, state: it.state } : null;
  }

  function mutate(keys, fn) {
    const snaps = keys.map(snapshot).filter(Boolean);
    if (snaps.length) { state.undo.push(snaps); if (state.undo.length > 50) state.undo.shift(); }
    fn();
    Session.changed();
    refresh();
  }

  function undo() {
    const snaps = state.undo.pop();
    if (!snaps) return;
    db().transaction(() => {
      for (const s of snaps) {
        if (!state.items.some(i => i.key === s.key)) continue;
        db().setValues(s.key, s.values);
        db().setState(s.key, s.state);
      }
    });
    Session.changed();
    refresh();
    toast(t('Rückgängig gemacht.'));
  }

  function setValues(key, patch) { mutate([key], () => db().setValues(key, patch)); }
  function setItemState(key, st) { mutate([key], () => db().setState(key, st)); }

  // ---------- Zeichnen ----------

  function refresh() {
    const d = db();
    const info = Session.info();
    $('#trainName').textContent = info.trainName || t('Kein Zug');
    if (!d) {
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
    $('#pairs').hidden = !hasCsv && !state.items.length;
    document.querySelector('.ranking').hidden = !hasCsv && !state.items.length;
    renderGrids();
    renderRanking();
    renderStatus();
  }

  function renderGrids() {
    const scale = state.settings.scale;
    const min = scale[0];
    const max = scale[scale.length - 1];
    const norm = v => (max > min ? (Number(v) - min) / (max - min) : 0);
    applyGridColors();
    const active = state.items.filter(i => i.state === 'open' && i.inCsv);
    for (const n of [1, 2]) {
      const g = GRIDS[n];
      const grid = $('#grid' + n);
      grid.innerHTML = '';
      grid.style.setProperty('--cols', scale.length);
      grid.append(el('div', { class: 'corner' }));
      for (const x of scale) grid.append(el('div', { class: 'head head-x', text: fmtValue(x) }));
      const placed = new Map();
      const pool = [];
      for (const it of active) {
        const x = it[g.x];
        const y = it[g.y];
        if (x != null && y != null && scale.includes(Number(x)) && scale.includes(Number(y))) {
          const k = `${Number(x)}|${Number(y)}`;
          if (!placed.has(k)) placed.set(k, []);
          placed.get(k).push(it);
        } else pool.push(it);
      }
      scale.forEach(y => {
        grid.append(el('div', { class: 'head head-y', text: fmtValue(y) }));
        scale.forEach(x => {
          const cell = el('div', {
            class: 'cell', dataset: { grid: String(n), x: String(x), y: String(y) },
            title: `${t(Core.FIELDS.find(f => f.id === g.x).label)}: ${fmtValue(x)} · ${t(Core.FIELDS.find(f => f.id === g.y).label)}: ${fmtValue(y)}`,
          });
          // Wie in der WSJF-App: hell oben links, dunkel unten rechts, nach dem Wert (nicht der Stelle) der Zeile und Spalte.
          cell.style.setProperty('--nx', norm(x).toFixed(3));
          cell.style.setProperty('--ny', norm(y).toFixed(3));
          for (const it of (placed.get(`${x}|${y}`) || []).sort((a, b) => Core.naturalCompare(a.key, b.key))) cell.append(card(it, 'cell'));
          grid.append(cell);
        });
      });
      const list = $('#pool' + n);
      list.innerHTML = '';
      pool.sort((a, b) => Core.naturalCompare(a.key, b.key));
      for (const it of pool) list.append(card(it, 'pool', n));
      $(`#pool${n}Count`).textContent = `(${pool.length})`;
      if (!pool.length) list.append(el('p', { class: 'pool-empty', text: active.length ? t('Alle Tickets sind eingeordnet.') : t('Keine offenen Tickets.') }));
    }
  }

  function card(it, where, gridNo) {
    const dirty = Core.isDirty(it, state.settings.required);
    const c = el('div', {
      class: `card card-${where}` + (matches(it) ? '' : ' dim') + (dirty ? ' dirty' : '') + (it.conflict ? ' conflict' : ''),
      draggable: 'true', tabindex: '0', role: 'button', dataset: { key: it.key },
      title: `${it.key}: ${it.summary}` + (it.team ? `\n${t('Team')}: ${it.team}` : '') + (it.status ? `\n${t('Status')}: ${it.status}` : ''),
    },
    el('span', { class: 'card-key', text: it.key }),
    el('span', { class: 'card-summary', text: it.summary || '' }));
    if (where === 'pool') {
      const g = GRIDS[gridNo];
      const known = [g.x, g.y].filter(f => it[f] != null).map(f => `${FIELD_SHORT[f]} ${fmtValue(it[f])}`);
      if (known.length) c.append(el('span', { class: 'card-values', text: known.join(' · ') }));
      if (it.team) c.append(el('span', { class: 'card-team', text: it.team }));
    }
    return c;
  }

  function renderRanking() {
    const req = state.settings.required;
    const visible = state.items.filter(i => i.state !== 'hidden' && i.inCsv);
    const ranked = Core.rank(visible);
    const body = $('#rankBody');
    body.innerHTML = '';
    let n = 0;
    for (const it of ranked) {
      const s = Core.score(it);
      const required = it.state === 'required';
      if (required || s != null) n++;
      const link = jiraLink(it.key);
      const dirty = Core.isDirty(it, req);
      const tr = el('tr', { class: (matches(it) ? '' : 'dim') + (required ? ' required' : '') + (dirty ? ' dirty' : '') + (it.conflict ? ' conflict' : ''), dataset: { key: it.key }, tabindex: '0' },
        el('td', { class: 'num', text: required || s != null ? String(n) : '' }),
        el('td', { class: 'key' }, link ? el('a', { href: link, target: '_blank', rel: 'noopener', text: it.key }) : it.key),
        el('td', { class: 'summary', text: it.summary }),
        el('td', { text: it.team || it.assignee || '' }),
        ...Core.VALUE_FIELDS.map(f => el('td', { class: 'num', text: fmtValue(it[f]) })),
        el('td', { class: 'num score' }, required ? el('span', { class: 'badge badge-required', text: t('Erforderlich') }) : fmtScore(s),
          dirty ? el('span', { class: 'dirty-dot', title: t('Noch nicht in die CSV geschrieben') }) : null,
          it.conflict ? el('span', { class: 'conflict-mark', title: t('Konflikt beim letzten Einlesen: dein Wert wurde behalten'), text: '!' }) : null));
      body.append(tr);
    }
    $('#rankCount').textContent = `(${ranked.length})`;

    const hidden = state.items.filter(i => i.state === 'hidden' && i.inCsv).sort((a, b) => Core.naturalCompare(a.key, b.key));
    $('#hiddenCount').textContent = `(${hidden.length})`;
    const hl = $('#hiddenList');
    hl.innerHTML = '';
    for (const it of hidden) {
      hl.append(el('li', { class: matches(it) ? '' : 'dim', dataset: { key: it.key } },
        el('button', { type: 'button', class: 'small', onclick: () => setItemState(it.key, 'open') }, t('Einblenden')),
        el('span', { class: 'key', text: it.key }), ' ', el('span', { text: it.summary }),
        it.labels.length ? el('span', { class: 'labels', text: it.labels.join(', ') }) : null));
    }

    const gone = state.items.filter(i => !i.inCsv).sort((a, b) => Core.naturalCompare(a.key, b.key));
    $('#goneBox').hidden = !gone.length;
    $('#goneCount').textContent = `(${gone.length})`;
    const gl = $('#goneList');
    gl.innerHTML = '';
    for (const it of gone) {
      gl.append(el('li', { dataset: { key: it.key } },
        el('button', { type: 'button', class: 'small', onclick: () => { db().removeItem(it.key); Session.changed(); refresh(); } }, t('Entfernen')),
        el('span', { class: 'key', text: it.key }), ' ', el('span', { text: it.summary })));
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

  // ---------- Ticket-Dialog ----------

  function openItem(key) {
    const it = state.items.find(i => i.key === key);
    if (!it) return;
    const scale = state.settings.scale;
    openDialog((dlg, close) => {
      const draw = () => {
        const cur = state.items.find(i => i.key === key) || it;
        dlg.innerHTML = '';
        const link = jiraLink(cur.key);
        dlg.append(el('h2', { class: 'item-title' }, link ? el('a', { href: link, target: '_blank', rel: 'noopener', text: cur.key }) : cur.key, ' ', el('span', { text: cur.summary })));
        const meta = [
          cur.issueType && [t('Typ'), cur.issueType], cur.status && [t('Status'), cur.status], cur.team && [t('Team'), cur.team],
          cur.assignee && [t('Zuständig'), cur.assignee], cur.labels.length && [t('Labels'), cur.labels.join(', ')],
        ].filter(Boolean);
        if (meta.length) dlg.append(el('dl', { class: 'item-meta' }, meta.map(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })])));

        const values = el('div', { class: 'item-values' });
        for (const f of Core.VALUE_FIELDS) {
          const field = Core.FIELDS.find(x => x.id === f);
          const id = 'val-' + f;
          const sel = el('select', { id, disabled: cur.state === 'required' || null });
          sel.append(el('option', { value: '', text: '–' }));
          const opts = scale.slice();
          if (cur[f] != null && !opts.includes(Number(cur[f]))) opts.push(Number(cur[f]));
          for (const v of opts.sort((a, b) => a - b)) sel.append(el('option', { value: String(v), text: fmtValue(v), selected: cur[f] != null && Number(cur[f]) === v ? true : null }));
          sel.addEventListener('change', () => { setValues(key, { [f]: sel.value === '' ? null : Number(sel.value) }); draw(); });
          const base = cur.base[f];
          const eff = Core.effectiveValues(cur, state.settings.required)[f];
          const changedHint = (base == null ? null : Number(base)) !== (eff == null ? null : Number(eff))
            ? el('small', { class: 'was', text: t('in der CSV: {wert}', { wert: fmtValue(base) }) }) : null;
          values.append(el('label', { for: id }, el('span', { text: t(field.label) }), sel, changedHint));
        }
        dlg.append(values);
        const s = Core.score(Core.effectiveValues(cur, state.settings.required));
        dlg.append(el('p', { class: 'item-score' }, t('WSJF'), ': ', el('b', { text: fmtScore(s) }),
          cur.state === 'required' ? el('span', { class: 'hint', text: ' ' + t('(Erforderlich: feste Werte aus den Einstellungen)') }) : null));

        const states = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('Zustand') });
        for (const [id, label] of [['open', t('Offen')], ['required', t('Erforderlich')], ['hidden', t('Ausgeblendet')]]) {
          states.append(el('button', { type: 'button', role: 'radio', 'aria-checked': String(cur.state === id), class: cur.state === id ? 'on' : '', dataset: { state: id },
            onclick: () => { setItemState(key, id); draw(); } }, label));
        }
        dlg.append(states);
        if (cur.description) {
          dlg.append(el('details', { class: 'item-desc' }, el('summary', { text: t('Beschreibung') }), el('div', { class: 'desc', text: cur.description })));
        }
        dlg.append(el('div', { class: 'dialog-buttons' },
          el('button', { type: 'button', class: 'danger-link', onclick: () => { mutate([key], () => db().setValues(key, { ubv: null, rroe: null, tc: null, jobSize: null })); draw(); } }, t('Werte löschen')),
          el('button', { type: 'button', class: 'primary', onclick: () => close(true) }, t('Schliessen'))));
      };
      draw();
    }, { wide: true });
  }

  // ---------- Ziehen und Ablegen ----------

  function setupDnd() {
    const board = $('#board');
    board.addEventListener('dragstart', e => {
      const c = e.target.closest('.card');
      if (!c) return;
      state.dragKey = c.dataset.key;
      e.dataTransfer.setData('text/plain', c.dataset.key);
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('dragging');
      c.classList.add('drag-source');
    });
    board.addEventListener('dragend', e => {
      state.dragKey = null;
      document.body.classList.remove('dragging');
      document.querySelectorAll('.drag-source, .drop-over').forEach(x => x.classList.remove('drag-source', 'drop-over'));
    });
    const target = e => e.target.closest('.cell, .pool, .drop-zone');
    board.addEventListener('dragover', e => {
      const tg = target(e);
      if (!tg) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      document.querySelectorAll('.drop-over').forEach(x => { if (x !== tg) x.classList.remove('drop-over'); });
      tg.classList.add('drop-over');
    });
    board.addEventListener('dragleave', e => {
      const tg = target(e);
      if (tg && !tg.contains(e.relatedTarget)) tg.classList.remove('drop-over');
    });
    board.addEventListener('drop', e => {
      const tg = target(e);
      if (!tg) return;
      e.preventDefault();
      const key = e.dataTransfer.getData('text/plain') || state.dragKey;
      document.body.classList.remove('dragging');
      if (!key || !state.items.some(i => i.key === key)) return;
      dropOn(key, tg);
    });
  }

  function dropOn(key, tg) {
    if (tg.classList.contains('cell')) {
      const g = GRIDS[tg.dataset.grid];
      const it = state.items.find(i => i.key === key);
      mutate([key], () => {
        db().setValues(key, { [g.x]: Number(tg.dataset.x), [g.y]: Number(tg.dataset.y) });
        if (it && it.state !== 'open') db().setState(key, 'open');
      });
    } else if (tg.classList.contains('pool')) {
      const g = GRIDS[tg.dataset.pool];
      setValues(key, { [g.x]: null, [g.y]: null });
    } else if (tg.dataset.zone === 'required') {
      setItemState(key, 'required');
      toast(t('{key} ist erforderlich und steht oben in der Liste.', { key }));
    } else if (tg.dataset.zone === 'hidden') {
      setItemState(key, 'hidden');
    } else if (tg.dataset.zone === 'clear') {
      setValues(key, { ubv: null, rroe: null, tc: null, jobSize: null });
      toast(t('Werte von {key} gelöscht. Ctrl+Z macht es rückgängig.', { key }));
    }
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
    return { gridColors: colors };
  }

  function savePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* nur für diese Sitzung */ }
  }

  /** Farbe je Raster auf die Seite legen (CSS-Variablen --hue und --sat). */
  function applyGridColors(colors) {
    const c = colors || loadPrefs().gridColors;
    for (const n of [1, 2]) {
      const col = Palette.byId(c[n]);
      const grid = $('#grid' + n);
      grid.style.setProperty('--hue', col.h);
      grid.style.setProperty('--sat', col.s + '%');
      grid.dataset.color = col.id;
    }
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
    $('#showAllBtn').addEventListener('click', () => {
      const keys = state.items.filter(i => i.state === 'hidden').map(i => i.key);
      mutate(keys, () => db().setStates(keys, 'open'));
    });
    $('#removeGoneBtn').addEventListener('click', async () => {
      const gone = state.items.filter(i => !i.inCsv);
      const ok = await ask({ title: t('Entfernen?'), text: tn('{n} Ticket, das nicht mehr in der CSV steht, wird entfernt.', '{n} Tickets, die nicht mehr in der CSV stehen, werden entfernt.', gone.length), buttons: [{ id: 'yes', label: t('Entfernen'), primary: true }] });
      if (ok !== 'yes') return;
      db().transaction(() => gone.forEach(i => db().removeItem(i.key)));
      Session.changed();
      refresh();
    });
    $('#search').addEventListener('input', e => { state.search = e.target.value; renderGrids(); renderRanking(); });
    $('#welcomeForm').addEventListener('submit', e => {
      e.preventDefault();
      const name = $('#welcomeName').value.trim();
      if (name) Session.createTrain(name).catch(fail);
    });
    $('#welcomeOpenBtn').addEventListener('click', () => Session.trainFromDbFile().catch(fail));

    const board = $('#board');
    board.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      const c = e.target.closest('.card, #rankBody tr');
      if (c && c.dataset.key) openItem(c.dataset.key);
    });
    board.addEventListener('keydown', e => {
      const c = e.target.closest('.card, #rankBody tr');
      if (c && c.dataset.key && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openItem(c.dataset.key); }
    });
    setupDnd();

    document.addEventListener('keydown', e => {
      const inField = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
      if ($('#dialog').open) return;
      if (e.altKey && !e.ctrlKey && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        if (e.key === '0') { trainMenu(); return; }
        const tr = Session.info().trains[Number(e.key) - 1];
        if (tr) Session.switchTrain(tr.id).catch(fail);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !inField && db()) { e.preventDefault(); undo(); return; }
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
        changed: () => { state.undo = []; refresh(); },
        status: renderStatus,
      });
    } catch (e) { fail(e); }
    refresh();
    document.body.dataset.ready = 'true';
  }

  global.WsjfApp = { refresh, importCsv, writeCsv, openItem, dropOn: (key, sel) => dropOn(key, document.querySelector(sel)), undo };
  main();
})(window);
