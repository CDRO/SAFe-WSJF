/* SAFe WSJF – Fachlogik ohne DOM und ohne Datenbank: Spaltenzuordnung, WSJF-Wert, Einlesen, Zusammenführen, Zurückschreiben.
   Im Browser als window.WsjfCore, in Node über require().

   Begriffe
   - Zuordnung (mapping): je Feld eine Spalte des Jira-Exports, als { header, occ } (Name und wievieltes Vorkommen, weil
     Jira gleichnamige Spalten wie «Labels» oder «Sprint» mehrfach schreibt), bei «labels» alle Spalten dieses Namens.
     Wertfelder (ubv, rroe, tc, jobSize, wsjf) dürfen statt einer Spalte { append: 'Name' } haben: die Spalte wird beim
     Zurückschreiben hinten angehängt.
   - Basis (base): die Werte, wie sie zuletzt in der CSV standen (eingelesen oder geschrieben). Lokal abweichende Werte
     sind «ungeschrieben»; beim erneuten Einlesen entscheidet der Vergleich mit der Basis, wer gewinnt. */
(function (global) {
  'use strict';

  const DEFAULT_SCALE = [1, 2, 3, 5, 8, 13, 20];
  /** Wie im bisherigen WSJF-App: «Erforderlich» schreibt diese Werte nach Jira (ergibt WSJF 300). */
  const DEFAULT_REQUIRED = { ubv: 100, rroe: 100, tc: 100, jobSize: 1 };
  const DEFAULT_HIDE_LABELS = ['informell'];

  const VALUE_FIELDS = ['ubv', 'rroe', 'tc', 'jobSize'];

  /** Felder der Zuordnung. kind: text (eine Spalte), multi (alle gleichnamigen), value (Zahl, schreibbar), output (nur schreiben). */
  const FIELDS = [
    { id: 'key', kind: 'text', required: true, label: 'Schlüssel', patterns: [/^issue key$/i, /^schlüssel$/i, /^vorgangsschlüssel$/i, /^key$/i, /^issue[ _-]?key/i] },
    { id: 'summary', kind: 'text', label: 'Zusammenfassung', patterns: [/^summary$/i, /^zusammenfassung$/i, /^titel$/i, /^title$/i] },
    { id: 'status', kind: 'text', label: 'Status', patterns: [/^status$/i] },
    { id: 'issueType', kind: 'text', label: 'Vorgangstyp', patterns: [/^issue type$/i, /^vorgangstyp$/i, /^typ$/i, /^arbeitstyp$/i, /^work type$/i] },
    { id: 'assignee', kind: 'text', label: 'Zuständig', patterns: [/^assignee$/i, /^bearbeiter$/i, /^zugewiesene person$/i, /^verantwortlich/i] },
    { id: 'team', kind: 'text', label: 'Team', patterns: [/^team$/i, /\(team\)$/i, /^custom field \(.*team.*\)$/i, /^benutzerdefiniertes feld \(.*team.*\)$/i] },
    { id: 'labels', kind: 'multi', label: 'Labels', patterns: [/^labels$/i, /^stichwörter$/i, /^etiketten$/i] },
    { id: 'description', kind: 'text', label: 'Beschreibung', patterns: [/^description$/i, /^beschreibung$/i] },
    { id: 'ubv', kind: 'value', label: 'Direkter Nutzen (UBV)', patterns: [/user.?business.?value/i, /business.?value/i, /^ubv$/i, /\(ubv\)/i, /direkter nutzen/i, /geschäftswert/i, /nutzwert/i] },
    { id: 'rroe', kind: 'value', label: 'Zukünftiger Nutzen (RROE)', patterns: [/rr.?\|?.?oe/i, /risk.?reduction/i, /opportunity.?enablement/i, /zukünftiger nutzen/i, /risikoreduktion/i] },
    { id: 'tc', kind: 'value', label: 'Dringlichkeit (TC)', patterns: [/time.?critical/i, /^tc$/i, /\(tc\)/i, /zeitkritikalität/i, /dringlichkeit/i, /zeitkritisch/i] },
    { id: 'jobSize', kind: 'value', label: 'Dauer (Job Size)', patterns: [/job.?size/i, /jobgrösse/i, /jobgröße/i, /^dauer$/i, /\(dauer\)/i, /aufwand/i] },
    { id: 'wsjf', kind: 'output', label: 'WSJF', patterns: [/^wsjf$/i, /\(wsjf\)$/i, /wsjf.?score/i, /wsjf.?wert/i] },
  ];

  // ---------- Werte ----------

  /** Zahl aus einer Zelle: «8», «8.0», «8,5», «13 - hoch». Leer oder ohne Zahl → null. */
  function parseValue(cell) {
    const m = /-?\d+(?:[.,]\d+)?/.exec(String(cell == null ? '' : cell));
    if (!m) return null;
    const v = Number(m[0].replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  }

  /** Zahl für die Zelle: ganze Zahlen ohne Nachkommastellen, sonst mit Punkt. */
  function formatValue(v) {
    if (v == null || v === '') return '';
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  }

  /** WSJF = (UBV + RROE + TC) / Job Size; null, solange ein Wert fehlt oder Job Size nicht positiv ist. */
  function score(v) {
    if (!v) return null;
    const { ubv, rroe, tc, jobSize } = v;
    if ([ubv, rroe, tc, jobSize].some(x => x == null || !Number.isFinite(Number(x)))) return null;
    if (Number(jobSize) <= 0) return null;
    return (Number(ubv) + Number(rroe) + Number(tc)) / Number(jobSize);
  }

  /** Die Werte, die ein Eintrag in die CSV schreibt: bei «Erforderlich» die festen Werte, sonst die eigenen. */
  function effectiveValues(item, required) {
    if (item.state === 'required') return Object.assign({}, DEFAULT_REQUIRED, required || {});
    return { ubv: item.ubv, rroe: item.rroe, tc: item.tc, jobSize: item.jobSize };
  }

  const same = (a, b) => (a == null ? null : Number(a)) === (b == null ? null : Number(b));

  /** Weicht der Eintrag von dem ab, was zuletzt in der CSV stand? */
  function isDirty(item, required) {
    const eff = effectiveValues(item, required);
    return VALUE_FIELDS.some(f => !same(eff[f], item.base ? item.base[f] : null));
  }

  /** Reihenfolge der priorisierten Liste: Erforderliche zuerst, dann WSJF absteigend, ohne WSJF ans Ende; sonst nach Schlüssel. */
  function rank(items) {
    const cmpKey = (a, b) => naturalCompare(a.key, b.key);
    return items.slice().sort((a, b) => {
      const ra = a.state === 'required' ? 0 : 1;
      const rb = b.state === 'required' ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const sa = score(a);
      const sb = score(b);
      if (sa == null && sb == null) return cmpKey(a, b);
      if (sa == null) return 1;
      if (sb == null) return -1;
      if (sb !== sa) return sb - sa;
      return cmpKey(a, b);
    });
  }

  /** «ART-9» vor «ART-10». */
  function naturalCompare(a, b) {
    return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
  }

  /** Skala aus einem Text wie «1, 2, 3, 5, 8, 13, 20»: positive Zahlen, aufsteigend, ohne Doppelte. */
  function parseScale(text) {
    const vals = String(text || '').split(/[\s,;]+/).map(Number).filter(v => Number.isFinite(v) && v > 0);
    const out = [...new Set(vals)].sort((a, b) => a - b);
    return out.length >= 2 ? out : null;
  }

  // ---------- Zuordnung ----------

  /** Spalten mit Name und Vorkommen: [{ index, header, occ }]. */
  function columns(headers) {
    const seen = new Map();
    return headers.map((h, index) => {
      const name = String(h).trim();
      const occ = seen.get(name) || 0;
      seen.set(name, occ + 1);
      return { index, header: name, occ };
    });
  }

  /** Vorschlag für die Zuordnung aus den Spaltennamen eines Jira-Exports (Englisch oder Deutsch). */
  function suggestMapping(headers) {
    const cols = columns(headers);
    const used = new Set();
    const mapping = {};
    for (const f of FIELDS) {
      let found = null;
      for (const p of f.patterns) {
        found = cols.find(c => c.occ === 0 && !used.has(c.header) && p.test(stripCustom(c.header)))
          || cols.find(c => c.occ === 0 && !used.has(c.header) && p.test(c.header));
        if (found) break;
      }
      if (found) {
        used.add(found.header);
        mapping[f.id] = f.kind === 'multi' ? { header: found.header } : { header: found.header, occ: 0 };
      }
    }
    return mapping;
  }

  /** «Custom field (User Business Value)» → «User Business Value». */
  function stripCustom(h) {
    const m = /^(?:custom field|benutzerdefiniertes feld)\s*\((.*)\)\s*$/i.exec(h);
    return m ? m[1].trim() : h;
  }

  /** Zuordnung → Spaltennummern: { key: 3, labels: [7, 8], ubv: 12 | 'append', … }; fehlende Spalten in missing. */
  function resolveMapping(headers, mapping) {
    const cols = columns(headers);
    const out = { missing: [] };
    for (const f of FIELDS) {
      const m = mapping && mapping[f.id];
      if (!m) continue;
      if (m.append) { out[f.id] = 'append'; continue; }
      if (f.kind === 'multi') {
        const idx = cols.filter(c => c.header === m.header).map(c => c.index);
        if (idx.length) out[f.id] = idx; else out.missing.push(f.id);
        continue;
      }
      const c = cols.find(x => x.header === m.header && x.occ === (m.occ || 0));
      if (c) out[f.id] = c.index; else out.missing.push(f.id);
    }
    return out;
  }

  // ---------- Einlesen ----------

  /** Zeilen einer CSV (ohne Kopfzeile) → Einträge. Zeilen ohne Schlüssel kommen in orphans (gehen beim Zurückschreiben unverändert mit). */
  function readRows(headers, rows, mapping) {
    const r = resolveMapping(headers, mapping);
    if (typeof r.key !== 'number') throw new Error('Keine Spalte für den Schlüssel zugeordnet.');
    const cell = (row, idx) => (typeof idx === 'number' && idx < row.length ? String(row[idx]).trim() : '');
    const items = [];
    const orphans = [];
    const seen = new Set();
    rows.forEach((row, i) => {
      if (row.length === 1 && row[0] === '') return; // Leerzeile
      const key = cell(row, r.key);
      if (!key || seen.has(key)) { orphans.push(i); return; }
      seen.add(key);
      const labels = Array.isArray(r.labels) ? r.labels.map(idx => cell(row, idx)).filter(Boolean) : [];
      const values = {};
      for (const f of VALUE_FIELDS) values[f] = typeof r[f] === 'number' ? parseValue(cell(row, r[f])) : null;
      items.push({
        key,
        summary: cell(row, r.summary),
        status: cell(row, r.status),
        issueType: cell(row, r.issueType),
        assignee: cell(row, r.assignee),
        team: cell(row, r.team),
        labels,
        description: typeof r.description === 'number' && r.description < row.length ? String(row[r.description]) : '',
        values,
        row: i,
      });
    });
    return { items, orphans };
  }

  /** Erneutes Einlesen: Dreiwegevergleich je Wert mit der Basis.
   *  - lokal unverändert → Wert aus der CSV
   *  - CSV unverändert → lokaler Wert bleibt
   *  - beide geändert und verschieden → lokaler Wert bleibt (Konflikt, wird gemeldet), Basis = CSV
   *  existing: [{ key, ubv, rroe, tc, jobSize, base: {…} }]. Ergebnis: je Schlüssel { values, base, conflict } und Zähler. */
  function mergeValues(existing, incoming) {
    const byKey = new Map(existing.map(e => [e.key, e]));
    const result = new Map();
    const stats = { added: 0, updated: 0, conflicts: [], removed: 0 };
    for (const inc of incoming) {
      const old = byKey.get(inc.key);
      if (!old) {
        stats.added++;
        result.set(inc.key, { values: Object.assign({}, inc.values), base: Object.assign({}, inc.values), conflict: false });
        continue;
      }
      const values = {};
      const base = {};
      let conflict = false;
      let changed = false;
      for (const f of VALUE_FIELDS) {
        const b = old.base ? old.base[f] : null;
        const l = old[f];
        const c = inc.values[f];
        if (same(l, b)) { values[f] = c; if (!same(c, l)) changed = true; }
        else if (same(c, b) || same(c, l)) values[f] = l;
        else { values[f] = l; conflict = true; }
        base[f] = c;
      }
      if (changed) stats.updated++;
      if (conflict) stats.conflicts.push(inc.key);
      result.set(inc.key, { values, base, conflict });
    }
    const incomingKeys = new Set(incoming.map(i => i.key));
    stats.removed = existing.filter(e => e.inCsv !== false && !incomingKeys.has(e.key)).length;
    return { result, stats };
  }

  // ---------- Zurückschreiben ----------

  /** Baut die Zeilen der CSV neu: Kopf und Reihenfolge wie eingelesen, nur die zugeordneten Wertspalten (und WSJF) ändern sich.
   *  Unveränderte Zeilen gehen mit ihrem Originaltext hinaus (rawRows). Angehängte Spalten kommen hinten dazu.
   *  csv: { headers, rows, rawRows?, rawHeader? }, items: Einträge mit row (Zeilennummer in rows). */
  function buildCsvRows(csv, items, mapping, required) {
    const r = resolveMapping(csv.headers, mapping);
    const appended = [];
    for (const f of VALUE_FIELDS.concat('wsjf')) {
      if (r[f] === 'append') appended.push({ field: f, name: mapping[f].append, index: csv.headers.length + appended.length });
    }
    const target = f => (typeof r[f] === 'number' ? r[f] : (appended.find(a => a.field === f) || {}).index);
    const headerRow = appended.length ? csv.headers.concat(appended.map(a => a.name)) : (csv.rawHeader != null ? csv.rawHeader : csv.headers);
    const byRow = new Map(items.filter(i => i.row != null).map(i => [i.row, i]));
    const out = [headerRow];
    csv.rows.forEach((row, i) => {
      const item = byRow.get(i);
      const cells = row.slice();
      while (appended.length && cells.length < csv.headers.length) cells.push('');
      let changed = false;
      if (item) {
        const eff = effectiveValues(item, required);
        const s = score(eff);
        const vals = Object.assign({}, eff, { wsjf: s == null ? null : Math.round(s * 100) / 100 });
        for (const f of VALUE_FIELDS.concat('wsjf')) {
          const idx = target(f);
          if (idx == null) continue;
          const isAppended = idx >= csv.headers.length;
          const old = isAppended ? '' : (idx < cells.length ? cells[idx] : '');
          // Unveränderte Zahl behält ihre Schreibweise («8.0» bleibt «8.0»).
          const next = same(parseValue(old), vals[f]) && (old.trim() !== '' || vals[f] == null) ? old : formatValue(vals[f]);
          while (cells.length <= idx) cells.push('');
          if (next !== old || isAppended) { cells[idx] = next; changed = changed || next !== old; }
        }
      } else if (appended.length) {
        for (const a of appended) { while (cells.length <= a.index) cells.push(''); }
      }
      const raw = csv.rawRows ? csv.rawRows[i] : null;
      out.push(!changed && !appended.length && raw != null ? raw : cells);
    });
    return out;
  }

  const api = {
    DEFAULT_SCALE, DEFAULT_REQUIRED, DEFAULT_HIDE_LABELS, VALUE_FIELDS, FIELDS,
    parseValue, formatValue, score, effectiveValues, isDirty, rank, naturalCompare, parseScale,
    columns, suggestMapping, resolveMapping, readRows, mergeValues, buildCsvRows,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WsjfCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
