/* SAFe WSJF – die zwei Raster, die priorisierte Liste und der Präsentationsmodus als einbettbarer Baustein.
   Reines DOM ohne Bibliotheken. Alles hängt am übergebenen Container; der Baustein kennt weder die Datenbank noch die
   Sitzung noch feste ids der Seite. Die Daten kommen aus einer Quelle (source), deren Methoden Promises liefern.

     const grid = SafeWsjf.create(container, {
       source: { list, setValues, setState, undo?, subscribe? },
       scale, required, hide, i18n: { t, lang }, prefs: { colors, zoom }, onPrefs, onOpen, renderDescription,
       labels: { keyLabel, title }, readOnly, matches, notify, onError, onPresent,
     });
     grid.refresh(); grid.present(true); grid.setZoom(1.2); grid.destroy();

   Die Optionen werden bei jedem refresh() neu gelesen: Ein Gastgeber darf scale, required, prefs oder labels ändern und
   danach refresh() aufrufen. Beschreibung im README unter «Einbetten».
   Braucht vorher: wsjf.js (WsjfCore), palette.js (WsjfPalette); optional i18n.js mit lang/*.js und wiki.js. */
(function (global) {
  'use strict';

  const Core = global.WsjfCore;
  const Palette = global.WsjfPalette;

  /** Werte je Raster: x und y. */
  const GRIDS = {
    1: { x: 'ubv', y: 'rroe' },
    2: { x: 'tc', y: 'jobSize' },
  };
  const FIELD_SHORT = { ubv: 'UBV', rroe: 'RROE', tc: 'TC', jobSize: 'Job Size' };
  const ZOOM_MIN = 0.75;
  const ZOOM_MAX = 2;
  const STATES = ['open', 'required', 'hidden'];

  function format(text, params) {
    if (!params) return text;
    return String(text).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  }

  /** Übersetzen: zuerst die Funktion des Gastgebers; kennt sie einen Text nicht (gibt den Schlüssel zurück), gilt das
   *  Sprachpaket des Bausteins für diese Sprache. Ohne Gastgeber die Sprache von WsjfI18n, ohne dieses Deutsch. */
  function translator(opt) {
    const I = global.WsjfI18n;
    if (opt && typeof opt.t === 'function') {
      const lang = String(opt.lang || 'de');
      const short = lang.toLowerCase().split('-')[0];
      return {
        t(key, params) {
          let out = opt.t(key, params);
          if (out == null || out === key || out === format(key, params)) {
            const v = short !== 'de' && I && I.lookup ? I.lookup(short, key) : null;
            out = typeof v === 'string' && v !== '' ? format(v, params) : format(key, params);
          }
          return String(out);
        },
        locale: () => lang,
      };
    }
    if (I) return { t: I.t, locale: () => I.locale() };
    return { t: format, locale: () => 'de-CH' };
  }

  function el(tag, attrs, ...children) {
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
  }

  function normalize(it) {
    const out = Object.assign({}, it);
    out.key = String(it.key);
    out.summary = it.summary == null ? '' : String(it.summary);
    out.labels = Array.isArray(it.labels) ? it.labels.map(String) : [];
    out.state = STATES.includes(it.state) ? it.state : 'open';
    for (const f of Core.VALUE_FIELDS) out[f] = it[f] == null || it[f] === '' || !Number.isFinite(Number(it[f])) ? null : Number(it[f]);
    return out;
  }

  function create(container, options) {
    if (!container || !container.appendChild) throw new Error('SafeWsjf.create: container fehlt');
    const opts = options || {};
    if (!opts.source || typeof opts.source.list !== 'function') throw new Error('SafeWsjf.create: source.list fehlt');
    const src = opts.source;
    const tr = translator(opts.i18n);
    const t = (key, params) => tr.t(key, params);

    const S = { items: [], undo: [], dragKey: null, descRaw: false, presenting: false, destroyed: false, draw: null };
    const listeners = [];
    const on = (target, type, fn, o) => { target.addEventListener(type, fn, o); listeners.push(() => target.removeEventListener(type, fn, o)); };

    // ---------- Optionen ----------

    const scale = () => {
      const s = Array.isArray(opts.scale) ? opts.scale.map(Number).filter(v => Number.isFinite(v)) : [];
      return s.length >= 2 ? [...new Set(s)].sort((a, b) => a - b) : Core.DEFAULT_SCALE.slice();
    };
    const requiredOn = () => opts.required !== false;
    /** Feste Werte für «Erforderlich» nur zur Anzeige (Dialog); geschrieben werden sie nie vom Raster, sondern von der Quelle. */
    const requiredValues = () => (opts.required && typeof opts.required === 'object' ? opts.required : null);
    const readOnly = () => opts.readOnly === true;
    const hideOn = () => opts.hide !== false;
    const matches = it => { try { return typeof opts.matches === 'function' ? opts.matches(it) !== false : true; } catch (e) { return true; } };
    const notify = (text, kind) => { if (typeof opts.notify === 'function') opts.notify(text, kind); };
    const error = e => {
      if (typeof opts.onError === 'function') opts.onError(e);
      else console.error(e);
    };
    const keyLabel = () => (opts.labels && opts.labels.keyLabel) || t('Schlüssel');
    const label = f => t(Core.FIELDS.find(x => x.id === f).label);

    function fmtScore(v) {
      if (v == null) return '–';
      return v.toLocaleString(tr.locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    function fmtValue(v) {
      return v == null ? '–' : Number(v).toLocaleString(tr.locale(), { maximumFractionDigits: 2 });
    }

    // ---------- Gerüst ----------

    const q = sel => root.querySelector(sel);
    // Texte kommen aus t(); das Übersetzen des festen Markups (WsjfI18n.translateDom) lässt den Baustein aus.
    const root = el('div', { class: 'safe-wsjf', 'data-i18n-skip': true });

    const presentBar = el('div', { class: 'sw-present-bar' },
      el('b', { class: 'sw-present-title' }),
      el('span', { class: 'sw-spacer' }),
      el('button', { type: 'button', class: 'sw-btn sw-zoom-out', title: t('Verkleinern (−)'), 'aria-label': t('Verkleinern'), onclick: () => setZoom(zoom() - 0.1) }, '−'),
      el('span', { class: 'sw-zoom-value' }),
      el('button', { type: 'button', class: 'sw-btn sw-zoom-in', title: t('Vergrössern (+)'), 'aria-label': t('Vergrössern'), onclick: () => setZoom(zoom() + 0.1) }, '+'),
      el('button', { type: 'button', class: 'sw-btn sw-present-exit', onclick: () => present(false) }, t('Präsentation beenden (Esc)')));

    const zones = el('div', { class: 'sw-drop-zones', 'aria-hidden': 'true' },
      el('div', { class: 'sw-drop-zone sw-zone-required', dataset: { zone: 'required' } }, el('b', { text: t('Erforderlich') }), el('span', { text: t('immer oben, feste Werte') })),
      el('div', { class: 'sw-drop-zone sw-zone-hidden', dataset: { zone: 'hidden' } }, el('b', { text: t('Ausblenden') }), el('span', { text: t('nicht bewerten') })),
      el('div', { class: 'sw-drop-zone sw-zone-trash', dataset: { zone: 'clear' } }, el('b', { text: t('Werte löschen') }), el('span', { text: t('alle vier Werte leeren') })));

    const titles = {
      1: [t('Direkter Nutzen (UBV) →'), t('↓ Zukünftiger Nutzen (RROE)')],
      2: [t('Dringlichkeit (TC) →'), t('↓ Dauer (Job Size)')],
    };
    const pairs = el('div', { class: 'sw-pairs' }, [1, 2].map(n => el('section', { class: 'sw-pair', dataset: { grid: String(n) } },
      el('aside', { class: 'sw-pool', dataset: { pool: String(n) } },
        el('h2', { class: 'sw-h' }, t('Offen'), ' ', el('span', { class: 'sw-count' })),
        el('div', { class: 'sw-pool-list' })),
      el('div', { class: 'sw-grid-wrap' },
        el('div', { class: 'sw-grid-title' }, el('span', { class: 'sw-axis-x', text: titles[n][0] }), el('span', { class: 'sw-axis-y', text: titles[n][1] })),
        el('div', { class: 'sw-grid-scroll' }, el('div', { class: 'sw-grid', dataset: { grid: String(n) } }))))));

    const thead = el('tr');
    const ranking = el('section', { class: 'sw-ranking' },
      el('div', { class: 'sw-ranking-head' },
        el('h2', { class: 'sw-h' }, t('Priorisierte Liste'), ' ', el('span', { class: 'sw-count sw-rank-count' })),
        el('div', { class: 'sw-rank-actions', dataset: { slot: 'rank-actions' } })),
      el('table', { class: 'sw-rank-table' }, el('thead', {}, thead), el('tbody', { class: 'sw-rank-body' })),
      el('details', { class: 'sw-side-box sw-hidden-box' },
        el('summary', {}, t('Ausgeblendet'), ' ', el('span', { class: 'sw-count sw-hidden-count' })),
        el('div', { class: 'sw-side-actions' }, el('button', { type: 'button', class: 'sw-btn sw-show-all', onclick: showAll }, t('Alle wieder einblenden'))),
        el('ul', { class: 'sw-plain-list sw-hidden-list' })),
      el('div', { class: 'sw-rank-after', dataset: { slot: 'rank-after' } }));

    const strip = axis => el('div', { class: `sw-strip sw-strip-${axis}`, hidden: true, 'aria-hidden': 'true' },
      el('div', { class: 'sw-strip-label' }), el('div', { class: 'sw-strip-zones' }));
    const stripY = strip('y');
    const stripX = strip('x');
    const dialog = el('dialog', { class: 'sw-dialog' });

    root.append(presentBar, zones, pairs, ranking, stripY, stripX, dialog);
    container.appendChild(root);

    // ---------- Zeichnen ----------

    let pending = null;
    let again = false;

    /** Liest die Quelle und zeichnet neu. Aufrufe während eines laufenden Lesens werden zu einem weiteren Durchgang. */
    function refresh() {
      if (S.destroyed) return Promise.resolve();
      applyColors();
      applyZoom();
      if (pending) { again = true; return pending; }
      pending = (async () => {
        try {
          do {
            again = false;
            const list = await src.list();
            if (S.destroyed) return;
            S.items = (list || []).map(normalize);
            render();
          } while (again && !S.destroyed);
        } catch (e) { error(e); } finally { pending = null; }
      })();
      return pending;
    }

    function render() {
      q('.sw-present-title').textContent = (opts.labels && opts.labels.title) || '';
      q('.sw-zone-required').hidden = !requiredOn();
      q('.sw-zone-hidden').hidden = !hideOn();
      root.classList.toggle('sw-readonly', readOnly());
      q('.sw-show-all').hidden = readOnly();
      renderGrids();
      renderRanking();
      if (S.draw) S.draw();
    }

    function applyColors() {
      const c = Object.assign({}, Palette.DEFAULTS, opts.prefs && opts.prefs.colors);
      for (const n of [1, 2]) {
        const col = Palette.byId(c[n]) || Palette.byId(Palette.DEFAULTS[n]);
        const grid = q(`.sw-grid[data-grid="${n}"]`);
        grid.style.setProperty('--hue', col.h);
        grid.style.setProperty('--sat', col.s + '%');
        grid.dataset.color = col.id;
      }
    }

    function renderGrids() {
      const sc = scale();
      const min = sc[0];
      const max = sc[sc.length - 1];
      const norm = v => (max > min ? (Number(v) - min) / (max - min) : 0);
      const active = S.items.filter(i => i.state === 'open');
      for (const n of [1, 2]) {
        const g = GRIDS[n];
        const grid = q(`.sw-grid[data-grid="${n}"]`);
        grid.innerHTML = '';
        grid.style.setProperty('--cols', sc.length);
        grid.append(el('div', { class: 'sw-corner' }));
        for (const x of sc) grid.append(el('div', { class: 'sw-head sw-head-x', text: fmtValue(x) }));
        const placed = new Map();
        const pool = [];
        for (const it of active) {
          const x = it[g.x];
          const y = it[g.y];
          if (x != null && y != null && sc.includes(x) && sc.includes(y)) {
            const k = `${x}|${y}`;
            if (!placed.has(k)) placed.set(k, []);
            placed.get(k).push(it);
          } else pool.push(it);
        }
        sc.forEach(y => {
          grid.append(el('div', { class: 'sw-head sw-head-y', text: fmtValue(y) }));
          sc.forEach(x => {
            const cell = el('div', {
              class: 'sw-cell', dataset: { grid: String(n), x: String(x), y: String(y) },
              title: `${label(g.x)}: ${fmtValue(x)} · ${label(g.y)}: ${fmtValue(y)}`,
            });
            // Wie in der WSJF-App: hell oben links, dunkel unten rechts, nach dem Wert (nicht der Stelle) der Zeile und Spalte.
            cell.style.setProperty('--nx', norm(x).toFixed(3));
            cell.style.setProperty('--ny', norm(y).toFixed(3));
            for (const it of (placed.get(`${x}|${y}`) || []).sort((a, b) => Core.naturalCompare(a.key, b.key))) cell.append(card(it, 'cell'));
            grid.append(cell);
          });
        });
        const poolBox = q(`.sw-pool[data-pool="${n}"]`);
        const list = poolBox.querySelector('.sw-pool-list');
        list.innerHTML = '';
        pool.sort((a, b) => Core.naturalCompare(a.key, b.key));
        for (const it of pool) list.append(card(it, 'pool', n));
        poolBox.querySelector('.sw-count').textContent = `(${pool.length})`;
        if (!pool.length) list.append(el('p', { class: 'sw-pool-empty', text: active.length ? t('Alle Tickets sind eingeordnet.') : t('Keine offenen Tickets.') }));
      }
    }

    function card(it, where, gridNo) {
      const c = el('div', {
        class: `sw-card sw-card-${where}` + (matches(it) ? '' : ' sw-dim') + (it.dirty ? ' sw-dirty' : '') + (it.conflict ? ' sw-conflict' : ''),
        draggable: readOnly() ? null : 'true', tabindex: '0', role: 'button', dataset: { key: it.key },
        title: `${it.key}: ${it.summary}` + (it.team ? `\n${t('Team')}: ${it.team}` : '') + (it.status ? `\n${t('Status')}: ${it.status}` : ''),
      },
      el('span', { class: 'sw-card-key', text: it.key }),
      el('span', { class: 'sw-card-summary', text: it.summary }));
      if (where === 'pool') {
        const g = GRIDS[gridNo];
        const known = [g.x, g.y].filter(f => it[f] != null).map(f => `${FIELD_SHORT[f]} ${fmtValue(it[f])}`);
        if (known.length) c.append(el('span', { class: 'sw-card-values', text: known.join(' · ') }));
        if (it.team) c.append(el('span', { class: 'sw-card-team', text: it.team }));
      }
      return c;
    }

    const safeHref = h => (h && /^https?:\/\//i.test(String(h)) ? String(h) : null);
    const keyNode = it => {
      const href = safeHref(it.href);
      return href ? el('a', { href, target: '_blank', rel: 'noopener', text: it.key }) : it.key;
    };

    function renderRanking() {
      thead.innerHTML = '';
      thead.append(el('th', { class: 'sw-num', text: '#' }), el('th', { text: keyLabel() }), el('th', { text: t('Zusammenfassung') }), el('th', { text: t('Team') }),
        el('th', { class: 'sw-num', title: t('Direkter Nutzen'), text: 'UBV' }), el('th', { class: 'sw-num', title: t('Zukünftiger Nutzen'), text: 'RROE' }),
        el('th', { class: 'sw-num', title: t('Dringlichkeit'), text: 'TC' }), el('th', { class: 'sw-num', title: t('Dauer'), text: 'Job Size' }),
        el('th', { class: 'sw-num', text: 'WSJF' }));
      const ranked = Core.rank(S.items.filter(i => i.state !== 'hidden'));
      const body = q('.sw-rank-body');
      body.innerHTML = '';
      let n = 0;
      for (const it of ranked) {
        const s = Core.score(it);
        const required = it.state === 'required';
        if (required || s != null) n++;
        body.append(el('tr', { class: (matches(it) ? '' : 'sw-dim') + (required ? ' sw-required' : '') + (it.dirty ? ' sw-dirty' : '') + (it.conflict ? ' sw-conflict' : ''), dataset: { key: it.key }, tabindex: '0' },
          el('td', { class: 'sw-num', text: required || s != null ? String(n) : '' }),
          el('td', { class: 'sw-key' }, keyNode(it)),
          el('td', { class: 'sw-summary', text: it.summary }),
          el('td', { text: it.team || it.assignee || '' }),
          ...Core.VALUE_FIELDS.map(f => el('td', { class: 'sw-num', text: fmtValue(it[f]) })),
          el('td', { class: 'sw-num sw-score' }, required ? el('span', { class: 'sw-badge sw-badge-required', text: t('Erforderlich') }) : fmtScore(s),
            it.dirty ? el('span', { class: 'sw-dirty-dot', title: t('Noch nicht in die CSV geschrieben') }) : null,
            it.conflict ? el('span', { class: 'sw-conflict-mark', title: t('Konflikt beim letzten Einlesen: dein Wert wurde behalten'), text: '!' }) : null)));
      }
      q('.sw-rank-count').textContent = `(${ranked.length})`;

      const hidden = S.items.filter(i => i.state === 'hidden').sort((a, b) => Core.naturalCompare(a.key, b.key));
      q('.sw-hidden-box').hidden = !hideOn() && !hidden.length;
      q('.sw-hidden-count').textContent = `(${hidden.length})`;
      const hl = q('.sw-hidden-list');
      hl.innerHTML = '';
      for (const it of hidden) {
        hl.append(el('li', { class: matches(it) ? '' : 'sw-dim', dataset: { key: it.key } },
          readOnly() ? null : el('button', { type: 'button', class: 'sw-btn sw-small', onclick: () => act([it.key], () => src.setState(it.key, 'open')) }, t('Einblenden')),
          el('span', { class: 'sw-key', text: it.key }), ' ', el('span', { text: it.summary }),
          it.labels.length ? el('span', { class: 'sw-labels', text: it.labels.join(', ') }) : null));
      }
    }

    // ---------- Änderungen mit Rückgängig ----------

    function snapshot(key) {
      const it = S.items.find(i => i.key === key);
      return it ? { key, values: { ubv: it.ubv, rroe: it.rroe, tc: it.tc, jobSize: it.jobSize }, state: it.state } : null;
    }

    /** Eine Handlung des Benutzers: Ohne source.undo merkt sich der Baustein den Stand davor selbst (bis 50 Schritte). */
    async function act(keys, fn) {
      if (readOnly()) return;
      if (typeof src.undo !== 'function') {
        const snaps = keys.map(snapshot).filter(Boolean);
        if (snaps.length) { S.undo.push(snaps); if (S.undo.length > 50) S.undo.shift(); }
      }
      try { await fn(); } catch (e) { error(e); }
      await refresh();
    }

    async function undo() {
      if (readOnly()) return;
      if (typeof src.undo === 'function') {
        try { await src.undo(); } catch (e) { error(e); }
        await refresh();
        return;
      }
      const snaps = S.undo.pop();
      if (!snaps) return;
      try {
        for (const s of snaps) {
          if (!S.items.some(i => i.key === s.key)) continue;
          await src.setValues(s.key, s.values);
          await src.setState(s.key, s.state);
        }
      } catch (e) { error(e); }
      await refresh();
      notify(t('Rückgängig gemacht.'));
    }

    function showAll() {
      const keys = S.items.filter(i => i.state === 'hidden').map(i => i.key);
      return act(keys, async () => { for (const k of keys) await src.setState(k, 'open'); });
    }

    const clearValues = () => ({ ubv: null, rroe: null, tc: null, jobSize: null });

    /** Ablegen auf einer Zelle, einer Leiste, der Liste «Offen» oder einem Ablagefeld. */
    function dropOn(key, tg) {
      if (!tg || !S.items.some(i => i.key === key)) return Promise.resolve();
      const it = S.items.find(i => i.key === key);
      if (tg.classList.contains('sw-strip-zone') || tg.classList.contains('sw-cell')) {
        const g = GRIDS[tg.dataset.grid];
        return act([key], async () => {
          await src.setValues(key, { [g.x]: Number(tg.dataset.x), [g.y]: Number(tg.dataset.y) });
          if (it.state !== 'open') await src.setState(key, 'open');
        });
      }
      if (tg.classList.contains('sw-pool')) {
        const g = GRIDS[tg.dataset.pool];
        return act([key], () => src.setValues(key, { [g.x]: null, [g.y]: null }));
      }
      if (tg.dataset.zone === 'required' && requiredOn()) {
        return act([key], () => src.setState(key, 'required')).then(() => notify(t('{key} ist erforderlich und steht oben in der Liste.', { key })));
      }
      if (tg.dataset.zone === 'hidden' && hideOn()) return act([key], () => src.setState(key, 'hidden'));
      if (tg.dataset.zone === 'clear') {
        return act([key], () => src.setValues(key, clearValues())).then(() => notify(t('Werte von {key} gelöscht. Ctrl+Z macht es rückgängig.', { key })));
      }
      return Promise.resolve();
    }

    // ---------- Ticket-Dialog ----------

    function openItem(key) {
      if (!S.items.some(i => i.key === key)) return;
      if (typeof opts.onOpen === 'function') { opts.onOpen(key); return; }
      const draw = () => {
        const cur = S.items.find(i => i.key === key);
        if (!cur) { dialog.close(); return; }
        const sc = scale();
        const req = requiredValues();
        dialog.innerHTML = '';
        dialog.append(el('h2', { class: 'sw-item-title' }, keyNode(cur), ' ', el('span', { text: cur.summary })));
        const meta = [
          cur.type && [t('Typ'), cur.type], cur.status && [t('Status'), cur.status], cur.team && [t('Team'), cur.team],
          cur.assignee && [t('Zuständig'), cur.assignee], cur.labels.length && [t('Labels'), cur.labels.join(', ')],
        ].filter(Boolean);
        if (meta.length) dialog.append(el('dl', { class: 'sw-item-meta' }, meta.map(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })])));

        const values = el('div', { class: 'sw-item-values' });
        const fixed = cur.state === 'required' && !!req;
        const eff = fixed ? Core.effectiveValues(cur, req) : { ubv: cur.ubv, rroe: cur.rroe, tc: cur.tc, jobSize: cur.jobSize };
        for (const f of Core.VALUE_FIELDS) {
          const sel = el('select', { dataset: { field: f }, disabled: fixed || readOnly() || null });
          sel.append(el('option', { value: '', text: '–' }));
          const choices = sc.slice();
          if (cur[f] != null && !choices.includes(cur[f])) choices.push(cur[f]);
          for (const v of choices.sort((a, b) => a - b)) sel.append(el('option', { value: String(v), text: fmtValue(v), selected: cur[f] === v ? true : null }));
          sel.addEventListener('change', () => act([key], () => src.setValues(key, { [f]: sel.value === '' ? null : Number(sel.value) })));
          let hint = null;
          if (cur.base && typeof cur.base === 'object') {
            const base = cur.base[f];
            if ((base == null ? null : Number(base)) !== (eff[f] == null ? null : Number(eff[f]))) hint = el('small', { class: 'sw-was', text: t('in der CSV: {wert}', { wert: fmtValue(base) }) });
          }
          values.append(el('label', {}, el('span', { text: label(f) }), sel, hint));
        }
        dialog.append(values);
        dialog.append(el('p', { class: 'sw-item-score' }, t('WSJF'), ': ', el('b', { text: fmtScore(Core.score(eff)) }),
          fixed ? el('span', { class: 'sw-hint', text: ' ' + t('(Erforderlich: feste Werte aus den Einstellungen)') }) : null));

        const states = el('div', { class: 'sw-segmented', role: 'radiogroup', 'aria-label': t('Zustand') });
        for (const [id, text] of [['open', t('Offen')], ['required', t('Erforderlich')], ['hidden', t('Ausgeblendet')]]) {
          if (id === 'required' && !requiredOn() && cur.state !== id) continue;
          if (id === 'hidden' && !hideOn() && cur.state !== id) continue;
          states.append(el('button', { type: 'button', role: 'radio', 'aria-checked': String(cur.state === id), class: 'sw-btn' + (cur.state === id ? ' sw-on' : ''), dataset: { state: id }, disabled: readOnly() || null,
            onclick: () => act([key], () => src.setState(key, id)) }, text));
        }
        dialog.append(states);
        if (cur.description) {
          // Formatiert (Gastgeber oder Jira-Wiki-Markup über WsjfWiki, das allen Text escaped) oder als Quelltext.
          const body = el('div', { class: 'sw-desc' });
          const mode = el('div', { class: 'sw-segmented sw-small', role: 'radiogroup', 'aria-label': t('Darstellung der Beschreibung') });
          const show = () => {
            const raw = S.descRaw;
            body.className = raw ? 'sw-desc sw-desc-raw' : 'sw-desc sw-wiki';
            if (raw) body.textContent = cur.description;
            else {
              let html = null;
              try {
                if (typeof opts.renderDescription === 'function') html = opts.renderDescription(cur);
                else if (global.WsjfWiki) html = global.WsjfWiki.render(cur.description);
              } catch (e) { error(e); }
              if (html == null) body.textContent = cur.description;
              else body.innerHTML = String(html);
            }
            for (const b of mode.children) b.setAttribute('aria-checked', String((b.dataset.mode === 'raw') === raw));
          };
          mode.append(
            el('button', { type: 'button', class: 'sw-btn', role: 'radio', dataset: { mode: 'wiki' }, onclick: () => { S.descRaw = false; show(); } }, t('Formatiert')),
            el('button', { type: 'button', class: 'sw-btn', role: 'radio', dataset: { mode: 'raw' }, onclick: () => { S.descRaw = true; show(); } }, t('Quelltext')));
          dialog.append(el('details', { class: 'sw-item-desc', open: true }, el('summary', {}, el('span', { text: t('Beschreibung') }), mode), body));
          show();
        }
        dialog.append(el('div', { class: 'sw-dialog-buttons' },
          readOnly() ? null : el('button', { type: 'button', class: 'sw-btn sw-danger-link', onclick: () => act([key], () => src.setValues(key, clearValues())) }, t('Werte löschen')),
          el('button', { type: 'button', class: 'sw-btn sw-primary sw-close', onclick: () => dialog.close() }, t('Schliessen'))));
      };
      S.draw = draw;
      draw();
      if (!dialog.open) dialog.showModal();
      const first = dialog.querySelector('select:not([disabled]), .sw-close');
      if (first) first.focus();
    }
    on(dialog, 'close', () => { S.draw = null; dialog.innerHTML = ''; });

    // ---------- Ziehen und Ablegen ----------

    const target = e => (e.target.closest ? e.target.closest('.sw-cell, .sw-pool, .sw-drop-zone:not([hidden]), .sw-strip-zone:not(.sw-current)') : null);
    const endDrag = () => {
      S.dragKey = null;
      root.classList.remove('sw-dragging');
      hideStrips();
      root.querySelectorAll('.sw-drag-source, .sw-drop-over').forEach(x => x.classList.remove('sw-drag-source', 'sw-drop-over'));
    };
    on(root, 'dragstart', e => {
      const c = e.target.closest && e.target.closest('.sw-card');
      if (!c) return;
      if (readOnly()) { e.preventDefault(); return; }
      S.dragKey = c.dataset.key;
      e.dataTransfer.setData('text/plain', c.dataset.key);
      e.dataTransfer.effectAllowed = 'move';
      root.classList.add('sw-dragging');
      c.classList.add('sw-drag-source');
      showStrips(c);
    });
    on(root, 'dragend', endDrag);
    on(root, 'dragover', e => {
      if (!S.dragKey) return;
      edgeScroll(e);
      const tg = target(e);
      if (!tg) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      root.querySelectorAll('.sw-drop-over').forEach(x => { if (x !== tg) x.classList.remove('sw-drop-over'); });
      tg.classList.add('sw-drop-over');
    });
    on(root, 'dragleave', e => {
      const tg = target(e);
      if (tg && !tg.contains(e.relatedTarget)) tg.classList.remove('sw-drop-over');
    });
    on(root, 'drop', e => {
      const tg = target(e);
      if (!tg || !S.dragKey) return;
      e.preventDefault();
      const key = e.dataTransfer.getData('text/plain') || S.dragKey;
      endDrag();
      dropOn(key, tg);
    });

    /** Leisten neben dem gezogenen Ticket (wie in der WSJF-App): rechts die Werte der Zeilen (Spalte bleibt), darunter die
     *  Werte der Spalten (Zeile bleibt). Ohne Platz im Raster gilt der vorhandene Wert, sonst der kleinste der Skala. */
    function showStrips(c) {
      const cell = c.closest('.sw-cell');
      const pool = c.closest('.sw-pool');
      const n = cell ? cell.dataset.grid : pool ? pool.dataset.pool : null;
      if (!n) return;
      const g = GRIDS[n];
      const sc = scale();
      const it = S.items.find(i => i.key === c.dataset.key);
      const pick = f => (it && it[f] != null && sc.includes(it[f]) ? it[f] : sc[0]);
      const cur = cell ? { x: Number(cell.dataset.x), y: Number(cell.dataset.y) } : { x: pick(g.x), y: pick(g.y) };
      for (const axis of ['y', 'x']) {
        const strip = axis === 'y' ? stripY : stripX;
        strip.querySelector('.sw-strip-label').textContent = label(g[axis]);
        const box = strip.querySelector('.sw-strip-zones');
        box.innerHTML = '';
        for (const v of sc) {
          const isCur = !!cell && v === cur[axis];
          box.append(el('div', {
            class: 'sw-strip-zone' + (isCur ? ' sw-current' : ''),
            dataset: { grid: n, axis, value: String(v), x: String(axis === 'x' ? v : cur.x), y: String(axis === 'y' ? v : cur.y) },
            title: `${label(g.x)}: ${fmtValue(axis === 'x' ? v : cur.x)} · ${label(g.y)}: ${fmtValue(axis === 'y' ? v : cur.y)}`,
          }, fmtValue(v)));
        }
        strip.hidden = false;
      }
      placeStrips(c.getBoundingClientRect());
    }

    function placeStrips(r) {
      const sy = stripY;
      const sx = stripX;
      const W = window.innerWidth;
      const H = window.innerHeight;
      const gap = 6;
      let left = r.right + gap;
      if (left + sy.offsetWidth > W - 4) left = Math.max(4, r.left - sy.offsetWidth - gap);
      sy.style.left = left + 'px';
      sy.style.top = Math.max(4, Math.min(r.top, H - sy.offsetHeight - 4)) + 'px';
      let top = r.bottom + gap;
      if (top + sx.offsetHeight > H - 4) top = Math.max(4, r.top - sx.offsetHeight - gap);
      let sxLeft = Math.max(4, Math.min(r.left, W - sx.offsetWidth - 4));
      // Nicht über die andere Leiste legen: daneben ausweichen, sonst unter sie.
      const ry = { left, right: left + sy.offsetWidth, top: parseFloat(sy.style.top), bottom: parseFloat(sy.style.top) + sy.offsetHeight };
      const overlaps = (l, tp) => l < ry.right && l + sx.offsetWidth > ry.left && tp < ry.bottom && tp + sx.offsetHeight > ry.top;
      if (overlaps(sxLeft, top)) {
        if (ry.left - gap - sx.offsetWidth >= 4) sxLeft = ry.left - gap - sx.offsetWidth;
        else if (ry.right + gap + sx.offsetWidth <= W - 4) sxLeft = ry.right + gap;
        else top = Math.min(ry.bottom + gap, H - sx.offsetHeight - 4);
      }
      sx.style.top = top + 'px';
      sx.style.left = sxLeft + 'px';
    }

    function hideStrips() {
      stripY.hidden = true;
      stripX.hidden = true;
    }

    /** Beim Ziehen nahe am linken oder rechten Rand eines Rasters seitlich weiterscrollen. */
    function edgeScroll(e) {
      const EDGE = 70;
      for (const sc of root.querySelectorAll('.sw-grid-scroll')) {
        const r = sc.getBoundingClientRect();
        if (e.clientY < r.top || e.clientY > r.bottom) continue;
        if (e.clientX < r.left + EDGE && sc.scrollLeft > 0) sc.scrollLeft -= 24;
        else if (e.clientX > r.right - EDGE && sc.scrollLeft + sc.clientWidth < sc.scrollWidth) sc.scrollLeft += 24;
      }
    }

    // ---------- Klicks und Tastatur ----------

    on(root, 'click', e => {
      if (e.target.closest('a') || e.target.closest('.sw-dialog')) return;
      const c = e.target.closest('.sw-card, .sw-rank-body tr');
      if (c && c.dataset.key) openItem(c.dataset.key);
    });
    on(root, 'keydown', e => {
      if (e.target.closest('.sw-dialog')) return;
      const c = e.target.closest('.sw-card, .sw-rank-body tr');
      if (c && c.dataset.key && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openItem(c.dataset.key); }
    });

    const visible = () => root.isConnected && root.getClientRects().length > 0;

    /** Tasten auf der Seite: nur wenn der Baustein sichtbar ist, kein Dialog offen ist, der Fokus nicht in einem Feld steht
     *  und der Gastgeber die Taste nicht schon behandelt hat (preventDefault). */
    on(document, 'keydown', e => {
      if (e.defaultPrevented || !visible()) return;
      if (document.querySelector('dialog[open]')) return;
      const ae = document.activeElement;
      if (ae && (/^(INPUT|SELECT|TEXTAREA)$/.test(ae.tagName) || ae.isContentEditable)) return;
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.key === 'p' || e.key === 'P') { e.preventDefault(); present(!S.presenting); return; }
        if (S.presenting && e.key === 'Escape') { present(false); return; }
        if (S.presenting && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(zoom() + 0.1); return; }
        if (S.presenting && e.key === '-') { e.preventDefault(); setZoom(zoom() - 0.1); return; }
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    });

    // ---------- Präsentationsmodus ----------

    function zoom() {
      const z = Number(opts.prefs && opts.prefs.zoom);
      return Number.isFinite(z) && z >= ZOOM_MIN && z <= ZOOM_MAX ? z : 1;
    }

    /** Grösse im Präsentationsmodus: nach der Breite des Bildschirms (1 bis 1.6) mal der eigenen Wahl (75 % bis 200 %). */
    function applyZoom() {
      const user = zoom();
      const base = Math.min(1.6, Math.max(1, window.innerWidth / 1600));
      pairs.style.zoom = S.presenting ? String(Math.round(base * user * 100) / 100) : '';
      q('.sw-zoom-value').textContent = Math.round(user * 100) + ' %';
    }

    function setZoom(z) {
      const v = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number(z) || 1)) * 100) / 100;
      opts.prefs = Object.assign({}, opts.prefs, { zoom: v });
      applyZoom();
      if (typeof opts.onPrefs === 'function') opts.onPrefs(Object.assign({}, opts.prefs));
    }

    /** Vollbild des Containers mit Grösse; der Gastgeber erfährt es über onPresent. */
    function present(want) {
      const v = !!want;
      if (v === S.presenting || S.destroyed) return;
      S.presenting = v;
      S.fullscreen = false;
      root.classList.toggle('sw-presenting', v);
      if (v) {
        if (container.requestFullscreen && !document.fullscreenElement) container.requestFullscreen().catch(() => {});
      } else if (document.fullscreenElement === container && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
      applyZoom();
      if (typeof opts.onPresent === 'function') opts.onPresent(v);
    }

    // Verlässt der Browser das Vollbild (Esc, F11), endet auch der Präsentationsmodus; nur wenn er es für diesen Container war.
    on(document, 'fullscreenchange', () => {
      if (document.fullscreenElement === container) { S.fullscreen = S.presenting; return; }
      if (S.fullscreen && S.presenting) { S.fullscreen = false; present(false); }
      S.fullscreen = false;
    });
    on(window, 'resize', applyZoom);
    on(document, 'wheel', e => {
      if (!S.presenting || !e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom() + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });

    // ---------- Start und Ende ----------

    const unsubscribe = typeof src.subscribe === 'function' ? src.subscribe(() => refresh()) : null;

    function destroy() {
      if (S.destroyed) return;
      present(false);
      S.destroyed = true;
      if (dialog.open) dialog.close();
      for (const off of listeners.splice(0)) off();
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (e) { error(e); } }
      root.remove();
    }

    refresh();
    return {
      refresh,
      destroy,
      present,
      setZoom,
      /** Für Tests und Automatisierung: Ticket auf ein Element des Bausteins ablegen (Zelle, Leiste, Liste, Ablagefeld). */
      drop: (key, element) => dropOn(String(key), element && element.closest ? element.closest('.sw-cell, .sw-pool, .sw-drop-zone, .sw-strip-zone') : null),
    };
  }

  global.SafeWsjf = { create, version: global.WSJF_VERSION || null };
})(window);
