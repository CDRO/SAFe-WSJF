/* SAFe WSJF – Datenbank (SQLite über sql.js). Eine Datenbank je Zug oder Portfolio.
   Im Browser als window.WsjfDb, in Node über require() (dann braucht es WsjfCore als Argument von open/create nicht:
   es wird selbst geladen).

   Das Schema steht als Liste unten (wie bei NoNotes): Eine neue Datei bekommt es ganz, eine ältere wird beim Öffnen
   angeglichen (fehlende Tabellen und Spalten kommen dazu). schema_version sagt nur, ob eine Datei von einer neueren App
   stammt. */
(function (global) {
  'use strict';

  const Core = typeof module !== 'undefined' && module.exports ? require('./wsjf.js') : global.WsjfCore;
  const t = (s, p) => (global.WsjfI18n ? global.WsjfI18n.t(s, p) : s.replace(/\{(\w+)\}/g, (m, k) => (p && k in p ? p[k] : m)));

  const APP_ID = 'safe-wsjf';
  const SCHEMA_VERSION = 1;

  const TABLES = [
    {
      name: 'meta',
      sql: 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      columns: [],
    },
    {
      name: 'items',
      sql: `CREATE TABLE items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_key TEXT NOT NULL UNIQUE,
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      columns: [
        ['status', "TEXT NOT NULL DEFAULT ''"],
        ['issue_type', "TEXT NOT NULL DEFAULT ''"],
        ['assignee', "TEXT NOT NULL DEFAULT ''"],
        ['team', "TEXT NOT NULL DEFAULT ''"],
        ['labels', "TEXT NOT NULL DEFAULT '[]'"],
        ['description', "TEXT NOT NULL DEFAULT ''"],
        ['ubv', 'REAL'], ['rroe', 'REAL'], ['tc', 'REAL'], ['job_size', 'REAL'],
        ['base_ubv', 'REAL'], ['base_rroe', 'REAL'], ['base_tc', 'REAL'], ['base_job_size', 'REAL'],
        ['state', "TEXT NOT NULL DEFAULT 'open'"],
        ['in_csv', 'INTEGER NOT NULL DEFAULT 1'],
        ['csv_row', 'INTEGER'],
        ['conflict', 'INTEGER NOT NULL DEFAULT 0'],
      ],
    },
    {
      name: 'csv_rows',
      sql: 'CREATE TABLE csv_rows (row INTEGER PRIMARY KEY, cells TEXT NOT NULL, raw TEXT)',
      columns: [],
    },
  ];

  const COL = { ubv: 'ubv', rroe: 'rroe', tc: 'tc', jobSize: 'job_size' };
  const now = () => new Date().toISOString();

  class WsjfDatabase {
    constructor(SQL, db) {
      this.SQL = SQL;
      this.db = db;
    }

    /** Neue, leere Datenbank. */
    static create(SQL, name) {
      const d = new WsjfDatabase(SQL, new SQL.Database());
      d.ensureSchema();
      d.setMeta('app', APP_ID);
      d.setMeta('created_at', now());
      d.setMeta('name', name || '');
      return d;
    }

    /** Bestehende Datei öffnen; fremde SQLite-Dateien und neuere Schemata werden abgelehnt. */
    static open(SQL, bytes) {
      let db;
      try { db = new SQL.Database(bytes); }
      catch (e) { throw new Error(t('Die Datei ist keine SQLite-Datenbank.')); }
      const d = new WsjfDatabase(SQL, db);
      let app = null;
      try { app = d.getMeta('app'); } catch (e) { /* keine Tabelle meta */ }
      if (app !== APP_ID) { db.close(); throw new Error(t('Diese SQLite-Datei stammt nicht von SAFe WSJF.')); }
      const v = Number(d.getMeta('schema_version') || 0);
      if (v > SCHEMA_VERSION) {
        db.close();
        throw new Error(t('Diese Datenbank hat Schema-Version {version}, diese App versteht nur bis {unterstuetzt}. Bitte App aktualisieren.', { version: v, unterstuetzt: SCHEMA_VERSION }));
      }
      d.ensureSchema();
      return d;
    }

    ensureSchema() {
      for (const tbl of TABLES) {
        const exists = this.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [tbl.name]).length > 0;
        if (!exists) this.db.run(tbl.sql);
        const have = new Set(this.all(`PRAGMA table_info(${tbl.name})`).map(c => c.name));
        for (const [col, type] of tbl.columns) if (!have.has(col)) this.db.run(`ALTER TABLE ${tbl.name} ADD COLUMN ${col} ${type}`);
      }
      this.setMeta('schema_version', String(SCHEMA_VERSION));
    }

    close() { this.db.close(); }

    export() { return this.db.export(); }

    all(sql, params) {
      const st = this.db.prepare(sql);
      try {
        if (params) st.bind(params);
        const out = [];
        while (st.step()) out.push(st.getAsObject());
        return out;
      } finally { st.free(); }
    }

    run(sql, params) { this.db.run(sql, params || []); }

    transaction(fn) {
      this.db.run('BEGIN');
      try { const r = fn(); this.db.run('COMMIT'); return r; }
      catch (e) { this.db.run('ROLLBACK'); throw e; }
    }

    // ---------- meta ----------

    getMeta(key) {
      const r = this.all('SELECT value FROM meta WHERE key = ?', [key]);
      return r.length ? r[0].value : null;
    }

    setMeta(key, value) {
      if (value == null) this.run('DELETE FROM meta WHERE key = ?', [key]);
      else this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
    }

    getJson(key, fallback) {
      const v = this.getMeta(key);
      if (v == null) return fallback;
      try { return JSON.parse(v); } catch (e) { return fallback; }
    }

    setJson(key, value) { this.setMeta(key, value == null ? null : JSON.stringify(value)); }

    /** Einstellungen des Zugs mit Vorgaben. */
    settings() {
      return {
        name: this.getMeta('name') || '',
        scale: this.getJson('scale', null) || Core.DEFAULT_SCALE.slice(),
        required: Object.assign({}, Core.DEFAULT_REQUIRED, this.getJson('required', {})),
        hideLabels: this.getJson('hide_labels', null) || Core.DEFAULT_HIDE_LABELS.slice(),
        jiraUrl: this.getMeta('jira_url') || '',
        mapping: this.getJson('mapping', null),
      };
    }

    saveSettings(s) {
      if ('name' in s) this.setMeta('name', s.name || '');
      if ('scale' in s) this.setJson('scale', s.scale);
      if ('required' in s) this.setJson('required', s.required);
      if ('hideLabels' in s) this.setJson('hide_labels', s.hideLabels);
      if ('jiraUrl' in s) this.setMeta('jira_url', s.jiraUrl || null);
      if ('mapping' in s) this.setJson('mapping', s.mapping);
    }

    // ---------- Einträge ----------

    items() {
      return this.all('SELECT * FROM items').map(r => ({
        id: r.id,
        key: r.issue_key,
        summary: r.summary,
        status: r.status,
        issueType: r.issue_type,
        assignee: r.assignee,
        team: r.team,
        labels: safeJson(r.labels, []),
        description: r.description,
        ubv: r.ubv, rroe: r.rroe, tc: r.tc, jobSize: r.job_size,
        base: { ubv: r.base_ubv, rroe: r.base_rroe, tc: r.base_tc, jobSize: r.base_job_size },
        state: r.state,
        inCsv: !!r.in_csv,
        row: r.csv_row,
        conflict: !!r.conflict,
        updatedAt: r.updated_at,
      }));
    }

    item(key) { return this.items().find(i => i.key === key) || null; }

    /** Werte setzen: patch { ubv?, rroe?, tc?, jobSize? } (null löscht). */
    setValues(key, patch) {
      const sets = [];
      const params = [];
      for (const [f, col] of Object.entries(COL)) {
        if (f in patch) { sets.push(`${col} = ?`); params.push(patch[f] == null ? null : Number(patch[f])); }
      }
      if (!sets.length) return;
      sets.push('conflict = 0', 'updated_at = ?');
      params.push(now(), key);
      this.run(`UPDATE items SET ${sets.join(', ')} WHERE issue_key = ?`, params);
    }

    /** 'open' | 'required' | 'hidden' */
    setState(key, state) {
      if (!['open', 'required', 'hidden'].includes(state)) throw new Error('state');
      this.run('UPDATE items SET state = ?, updated_at = ? WHERE issue_key = ?', [state, now(), key]);
    }

    setStates(keys, state) { this.transaction(() => keys.forEach(k => this.setState(k, state))); }

    removeItem(key) { this.run('DELETE FROM items WHERE issue_key = ?', [key]); }

    // ---------- CSV ----------

    hasCsv() { return this.getMeta('csv_headers') != null; }

    /** Stand der CSV, wie sie zuletzt eingelesen oder geschrieben wurde. */
    csv() {
      if (!this.hasCsv()) return null;
      const rows = this.all('SELECT row, cells, raw FROM csv_rows ORDER BY row');
      return {
        headers: this.getJson('csv_headers', []),
        rawHeader: this.getMeta('csv_raw_header'),
        rows: rows.map(r => safeJson(r.cells, [])),
        rawRows: rows.map(r => r.raw),
        format: this.getJson('csv_format', {}),
        fileName: this.getMeta('csv_file_name') || '',
        stamp: this.getJson('csv_stamp', null),
        importedAt: this.getMeta('csv_imported_at'),
        writtenAt: this.getMeta('csv_written_at'),
      };
    }

    /** Legt den Inhalt einer CSV als Stand ab (Kopf, Zeilen, Format). parsed aus WsjfCsv.parse plus encoding/bom. */
    storeCsv(parsed, info) {
      const [header, ...rows] = parsed.rows;
      this.run('DELETE FROM csv_rows');
      rows.forEach((r, i) => this.run('INSERT INTO csv_rows (row, cells, raw) VALUES (?, ?, ?)', [i, JSON.stringify(r), parsed.raw ? parsed.raw[i + 1] : null]));
      this.setJson('csv_headers', header || []);
      this.setMeta('csv_raw_header', parsed.raw ? parsed.raw[0] : null);
      this.setJson('csv_format', {
        delimiter: parsed.delimiter, lineEnding: parsed.lineEnding, quoteAll: parsed.quoteAll,
        trailingNewline: parsed.trailingNewline, encoding: info.encoding, bom: !!info.bom,
      });
      if (info.fileName) this.setMeta('csv_file_name', info.fileName);
      this.setJson('csv_stamp', info.stamp || null);
    }

    /** CSV einlesen (erstmals oder erneut) und mit den Einträgen zusammenführen.
     *  Rückgabe: { added, updated, conflicts: [keys], removed, orphans }. */
    importCsv(parsed, info, mapping) {
      const [headers, ...rows] = parsed.rows;
      if (!headers) throw new Error(t('Die CSV-Datei ist leer.'));
      const read = Core.readRows(headers, rows, mapping);
      const settings = this.settings();
      return this.transaction(() => {
        const existing = this.items();
        const { result, stats } = Core.mergeValues(existing, read.items);
        const byKey = new Map(existing.map(e => [e.key, e]));
        const stamp = now();
        for (const inc of read.items) {
          const m = result.get(inc.key);
          const params = [inc.summary, inc.status, inc.issueType, inc.assignee, inc.team, JSON.stringify(inc.labels), inc.description,
            m.values.ubv, m.values.rroe, m.values.tc, m.values.jobSize, m.base.ubv, m.base.rroe, m.base.tc, m.base.jobSize,
            inc.row, m.conflict ? 1 : 0, stamp];
          if (byKey.has(inc.key)) {
            this.run(`UPDATE items SET summary = ?, status = ?, issue_type = ?, assignee = ?, team = ?, labels = ?, description = ?,
              ubv = ?, rroe = ?, tc = ?, job_size = ?, base_ubv = ?, base_rroe = ?, base_tc = ?, base_job_size = ?,
              in_csv = 1, csv_row = ?, conflict = ?, updated_at = ? WHERE issue_key = ?`, params.concat(inc.key));
          } else {
            // Neu: trägt er genau die Werte von «Erforderlich», gilt er als erforderlich; ein Label zum Ausblenden blendet ihn aus.
            const req = settings.required;
            const isRequired = Core.VALUE_FIELDS.every(f => m.values[f] != null && Number(m.values[f]) === Number(req[f]));
            const hide = inc.labels.some(l => settings.hideLabels.some(h => h.toLowerCase() === l.toLowerCase()));
            const state = isRequired ? 'required' : hide ? 'hidden' : 'open';
            this.run(`INSERT INTO items (summary, status, issue_type, assignee, team, labels, description,
              ubv, rroe, tc, job_size, base_ubv, base_rroe, base_tc, base_job_size, in_csv, csv_row, conflict, updated_at,
              issue_key, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
            params.concat(inc.key, state, stamp));
          }
        }
        const keys = new Set(read.items.map(i => i.key));
        for (const e of existing) if (!keys.has(e.key)) this.run('UPDATE items SET in_csv = 0, csv_row = NULL WHERE issue_key = ?', [e.key]);
        this.storeCsv(parsed, info);
        this.setJson('mapping', mapping);
        this.setMeta('csv_imported_at', stamp);
        return Object.assign({}, stats, { orphans: read.orphans.length });
      });
    }

    /** Nach dem Zurückschreiben: der geschriebene Text ist der neue Stand, die Basis jedes Eintrags sind seine Werte,
     *  angehängte Spalten werden zu normalen Spalten der Zuordnung. */
    markWritten(parsed, info) {
      this.transaction(() => {
        const settings = this.settings();
        for (const it of this.items()) {
          if (it.row == null) continue;
          const eff = Core.effectiveValues(it, settings.required);
          this.run('UPDATE items SET base_ubv = ?, base_rroe = ?, base_tc = ?, base_job_size = ?, conflict = 0 WHERE issue_key = ?',
            [eff.ubv, eff.rroe, eff.tc, eff.jobSize, it.key]);
        }
        const mapping = Object.assign({}, settings.mapping || {});
        const headers = parsed.rows[0] || [];
        for (const [f, m] of Object.entries(mapping)) {
          if (m && m.append) {
            const idx = headers.lastIndexOf(m.append);
            const occ = headers.slice(0, idx).filter(h => String(h).trim() === m.append).length;
            mapping[f] = { header: m.append, occ };
          }
        }
        this.setJson('mapping', mapping);
        this.storeCsv(parsed, info);
        this.setMeta('csv_written_at', now());
      });
    }

    /** Text der CSV mit den aktuellen Werten (Bytes im Zeichensatz der Vorlage). */
    buildCsv(CsvLib) {
      const csv = this.csv();
      if (!csv) throw new Error(t('Es wurde noch keine CSV-Datei eingelesen.'));
      const s = this.settings();
      const rows = Core.buildCsvRows(csv, this.items(), s.mapping, s.required);
      const text = CsvLib.stringify(rows, csv.format);
      return { text, bytes: CsvLib.encode(text, csv.format.encoding, csv.format.bom), format: csv.format, fileName: csv.fileName };
    }
  }

  function safeJson(s, fallback) {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  }

  const api = { WsjfDatabase, APP_ID, SCHEMA_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WsjfDb = api;
})(typeof window !== 'undefined' ? window : globalThis);
