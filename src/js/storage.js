/* SAFe WSJF – Persistenz (übernommen aus NoNotes, für Züge angepasst).
   1. Browser-Speicher (IndexedDB, ersatzweise localStorage): immer aktiv, Sicherheitsnetz.
   2. Dateien auf der Platte über die File System Access API (Chromium-Browser wie Edge): die .sqlite-Datei des Zugs und
      die CSV-Datei, in die zurückgeschrieben wird. Die Handles merkt sich IndexedDB.
   Dazu Download/Import für Browser ohne File System Access API (Firefox).

   Züge: Jeder Zug (oder jedes Portfolio) ist eine eigene Datenbank mit eigener Browser-Kopie und eigenen Dateien.
   Schlüssel: train:<id>:db, train:<id>:handle (SQLite), train:<id>:csv (CSV), train:<id>:sync; Verzeichnis unter «trains». */
(function (global) {
  'use strict';

  const { t } = global.WsjfI18n;

  const IDB_NAME = 'safe-wsjf';
  const IDB_STORE = 'kv';
  const LS_PREFIX = 'safe-wsjf.';
  const KEY_TRAINS = 'trains';
  const key = (train, what) => `train:${train}:${what}`;

  // ---------- IndexedDB als einfacher Key-Value-Speicher ----------

  function idbOpen() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) { reject(new Error(t('IndexedDB nicht verfügbar'))); return; }
      let req;
      try { req = indexedDB.open(IDB_NAME, 1); }
      catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error(t('IndexedDB konnte nicht geöffnet werden')));
      req.onblocked = () => reject(new Error(t('IndexedDB ist blockiert')));
    });
  }

  async function idbRun(mode, fn) {
    const db = await idbOpen();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, mode);
        const store = tx.objectStore(IDB_STORE);
        let result;
        const req = fn(store);
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error(t('IndexedDB-Transaktion fehlgeschlagen')));
        tx.onabort = () => reject(tx.error || new Error(t('IndexedDB-Transaktion abgebrochen')));
      });
    } finally {
      db.close();
    }
  }

  const idbGet = k => idbRun('readonly', store => store.get(k));
  const idbSet = (k, value) => idbRun('readwrite', store => store.put(value, k));
  const idbDel = k => idbRun('readwrite', store => store.delete(k));

  // ---------- Base64 für den localStorage-Ersatz ----------

  function bytesToB64(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return btoa(s);
  }

  function b64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------- Browser-Speicher mit Rückfallebene ----------

  const browserStore = {
    backend: null, // 'indexeddb' | 'localstorage' | null

    async detect() {
      try {
        await idbGet('__probe');
        this.backend = 'indexeddb';
      } catch (e) {
        try {
          localStorage.setItem('__probe', '1');
          localStorage.removeItem('__probe');
          this.backend = 'localstorage';
        } catch (e2) {
          this.backend = null;
        }
      }
      return this.backend;
    },

    label() {
      return this.backend === 'indexeddb' ? 'IndexedDB'
        : this.backend === 'localstorage' ? 'localStorage'
        : t('kein Browser-Speicher');
    },

    async loadDb(train) {
      if (this.backend === 'indexeddb') {
        const v = await idbGet(key(train, 'db'));
        return v ? new Uint8Array(v) : null;
      }
      if (this.backend === 'localstorage') {
        const s = localStorage.getItem(LS_PREFIX + key(train, 'db'));
        return s ? b64ToBytes(s) : null;
      }
      return null;
    },

    async saveDb(bytes, train) {
      if (this.backend === 'indexeddb') { await idbSet(key(train, 'db'), bytes); return; }
      if (this.backend === 'localstorage') { localStorage.setItem(LS_PREFIX + key(train, 'db'), bytesToB64(bytes)); return; }
      throw new Error(t('Kein Browser-Speicher verfügbar'));
    },

    /** Browser-Kopie und gemerkte Dateien eines Zugs löschen (die Dateien auf der Platte bleiben). */
    async removeTrain(train) {
      for (const what of ['db', 'handle', 'csv', 'sync']) {
        try {
          if (this.backend === 'indexeddb') await idbDel(key(train, what));
          else if (this.backend === 'localstorage') localStorage.removeItem(LS_PREFIX + key(train, what));
        } catch (e) { /* nichts zu tun */ }
      }
    },

    /** Gemerkte Datei (what: 'handle' für die Datenbank, 'csv' für die CSV). Nur mit IndexedDB. */
    async loadHandle(train, what) {
      if (this.backend !== 'indexeddb') return null;
      try { return (await idbGet(key(train, what))) || null; }
      catch (e) { return null; }
    },

    /** Merkt sich eine Datei; false, wenn das nicht geht (ohne IndexedDB oder bei nachgebauten Handles im Test). */
    async saveHandle(train, what, handle) {
      if (this.backend !== 'indexeddb') return false;
      try { await idbSet(key(train, what), handle); return true; }
      catch (e) { return false; }
    },

    async clearHandle(train, what) {
      if (this.backend === 'indexeddb') {
        try { await idbDel(key(train, what)); } catch (e) { /* nichts zu tun */ }
      }
    },

    /** Kleine JSON-Werte (Verzeichnis der Züge, Abgleichstand der Datei). */
    async loadValue(k) {
      try {
        if (this.backend === 'indexeddb') { const v = await idbGet(k); return v == null ? null : v; }
        if (this.backend === 'localstorage') { const s = localStorage.getItem(LS_PREFIX + k); return s ? JSON.parse(s) : null; }
      } catch (e) { /* nichts gemerkt */ }
      return null;
    },

    async saveValue(k, value) {
      if (this.backend === 'indexeddb') { await idbSet(k, value); return; }
      if (this.backend === 'localstorage') { localStorage.setItem(LS_PREFIX + k, JSON.stringify(value)); return; }
      throw new Error(t('Kein Browser-Speicher verfügbar'));
    },

    loadSync(train) { return this.loadValue(key(train, 'sync')); },
    saveSync(train, v) { return this.saveValue(key(train, 'sync'), v); },

    /** Verzeichnis der Züge: { list: [{ id, name, createdAt }], last } oder null. */
    async loadTrains() {
      const v = await this.loadValue(KEY_TRAINS);
      return v && Array.isArray(v.list) ? v : null;
    },

    async saveTrains(reg) {
      const v = { list: reg.list.map(a => ({ id: a.id, name: a.name, createdAt: a.createdAt || null })), last: reg.last || null };
      await this.saveValue(KEY_TRAINS, v);
    },
  };

  // ---------- Dateien auf der Platte (File System Access API) ----------

  const DB_TYPES = [{ description: t('SAFe-WSJF-Datenbank'), accept: { 'application/vnd.sqlite3': ['.sqlite', '.sqlite3', '.db'] } }];
  const CSV_TYPES = [{ description: t('CSV-Datei (Jira-Export)'), accept: { 'text/csv': ['.csv'] } }];

  const fileAccess = {
    supported: typeof global.showSaveFilePicker === 'function' && typeof global.showOpenFilePicker === 'function',
    DB_TYPES,
    CSV_TYPES,

    async pickNew(suggestedName, types) {
      return global.showSaveFilePicker({ suggestedName, types: types || DB_TYPES });
    },

    async pickExisting(types) {
      const handles = await global.showOpenFilePicker({ multiple: false, types: types || DB_TYPES });
      return handles[0];
    },

    /** 'granted' | 'prompt' | 'denied'. Mit request=true wird der Benutzer gefragt (braucht einen Klick). */
    async permission(handle, request, mode) {
      const opts = { mode: mode || 'readwrite' };
      if (typeof handle.queryPermission !== 'function') return 'granted';
      let p = await handle.queryPermission(opts);
      if (p !== 'granted' && request) p = await handle.requestPermission(opts);
      return p;
    },

    /** Inhalt und Stempel (Änderungszeit und Grösse) einer Datei. */
    async read(handle) {
      const file = await handle.getFile();
      return { bytes: new Uint8Array(await file.arrayBuffer()), stamp: stampOf(file), name: file.name };
    },

    async stamp(handle) { return stampOf(await handle.getFile()); },

    /** Schreibt atomar: der Browser schreibt in eine Zwischendatei und tauscht bei close() aus. Gibt den neuen Stempel zurück. */
    async write(handle, bytes) {
      const writable = await handle.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (e) {
        try { await writable.abort(); } catch (e2) { /* bereits geschlossen */ }
        throw e;
      }
      try { return await this.stamp(handle); } catch (e) { return null; }
    },
  };

  function stampOf(file) { return { lastModified: file.lastModified, size: file.size }; }

  function sameStamp(a, b) { return !!a && !!b && a.lastModified === b.lastModified && a.size === b.size; }

  // ---------- Download / Import (funktioniert überall) ----------

  function download(bytes, filename, type) {
    const blob = new Blob([bytes], { type: type || 'application/vnd.sqlite3' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /** Datei über ein unsichtbares <input type=file> wählen (für Browser ohne File System Access API). */
  function chooseFile(accept) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) { resolve(null); return; }
        resolve({ bytes: new Uint8Array(await file.arrayBuffer()), stamp: stampOf(file), name: file.name });
      });
      input.addEventListener('cancel', () => { input.remove(); resolve(null); });
      document.body.appendChild(input);
      input.click();
    });
  }

  function bytesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ---------- Züge: Kennung, Suche über die Adresse ----------

  /** Kennung aus einem Namen: klein, ohne Umlaute und Sonderzeichen, höchstens 30 Zeichen («ART Plattform» → «art-plattform»). */
  function slug(name) {
    const s = String(name || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
    return s || 'zug';
  }

  function newTrainId(name, list) {
    const taken = new Set((list || []).map(a => a.id));
    const base = slug(name);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  /** Zug zu einem Wert aus der Adresse (#zug=…): Kennung, Name, oder 1 … 9 für die Stelle in der Liste. */
  function findTrain(list, value) {
    const v = String(value == null ? '' : value).trim().toLowerCase();
    if (!v) return null;
    return list.find(a => a.id === v) || list.find(a => slug(a.name) === slug(v))
      || (/^[1-9]$/.test(v) ? list[Number(v) - 1] || null : null);
  }

  global.WsjfStorage = { browserStore, fileAccess, download, chooseFile, bytesEqual, sameStamp, slug, newTrainId, findTrain };
})(window);
