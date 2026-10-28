/* SAFe WSJF – Sitzung: Züge laden und wechseln, speichern (Browser-Kopie und Datenbankdatei), Änderungen von aussen erkennen.
   Angelehnt an local-shell.js von NoNotes, ohne Zusammenführen einzelner Einträge: Hat die Datei sich von aussen geändert
   und gibt es zugleich ungespeicherte eigene Änderungen, wird gefragt.

   Die Oberfläche übergibt bei start() ihre Rückrufe:
     ask({ title, text, buttons: [{ id, label, primary? }] }) → Promise<id | null>
     toast(text, kind?)
     changed(reason)     die Daten oder der Zug haben sich geändert (neu zeichnen)
     status()            Speicherzustand hat sich geändert (Statusleiste) */
(function (global) {
  'use strict';

  const { t } = global.WsjfI18n;
  const { browserStore, fileAccess, download, chooseFile, bytesEqual, sameStamp, newTrainId, findTrain, slug } = global.WsjfStorage;
  const { WsjfDatabase } = global.WsjfDb;

  const SAVE_DELAY = 300;
  const CHECK_INTERVAL = 30000;

  const S = {
    SQL: null,
    ui: null,
    reg: { list: [], last: null },
    trainId: null,
    db: null,
    dbHandle: null,
    dbGranted: false,
    csvHandle: null,
    sync: { fileStamp: null, pending: false },
    saveTimer: null,
    saving: null,
    channel: null,
    tabId: Math.random().toString(36).slice(2),
  };

  // ---------- Start ----------

  async function start(ui) {
    S.ui = ui;
    await browserStore.detect();
    if (typeof global.initSqlJs !== 'function') throw new Error(t('sql.js konnte nicht geladen werden.'));
    S.SQL = await global.initSqlJs();
    S.reg = (await browserStore.loadTrains()) || { list: [], last: null };
    try {
      S.channel = new BroadcastChannel('safe-wsjf');
      S.channel.onmessage = e => onBroadcast(e.data);
    } catch (e) { S.channel = null; }
    global.addEventListener('hashchange', () => {
      const tr = findTrain(S.reg.list, hashTrain());
      if (tr && tr.id !== S.trainId) switchTrain(tr.id);
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkExternal(); });
    global.addEventListener('focus', () => checkExternal());
    setInterval(() => { if (!document.hidden) checkExternal(); }, CHECK_INTERVAL);
    global.addEventListener('pagehide', () => { if (S.saveTimer) flushSync(); });
    if (!S.reg.list.length) return false;
    const wanted = findTrain(S.reg.list, hashTrain()) || S.reg.list.find(a => a.id === S.reg.last) || S.reg.list[0];
    await openTrain(wanted.id);
    return true;
  }

  function hashTrain() {
    const m = /[#&?]zug=([^&]*)/.exec(global.location.hash || '') || /[?&]zug=([^&]*)/.exec(global.location.search || '');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setHash(id) {
    const want = '#zug=' + encodeURIComponent(id);
    if (global.location.hash !== want) {
      try { history.replaceState(null, '', want); } catch (e) { global.location.hash = want; }
    }
  }

  // ---------- Züge ----------

  const train = () => S.reg.list.find(a => a.id === S.trainId) || null;

  async function openTrain(id) {
    const entry = S.reg.list.find(a => a.id === id);
    if (!entry) throw new Error(t('Zug nicht gefunden.'));
    const bytes = await browserStore.loadDb(id);
    let db = null;
    if (bytes) {
      try { db = WsjfDatabase.open(S.SQL, bytes); }
      catch (e) { S.ui.toast(t('Browser-Kopie unlesbar: {fehler}', { fehler: e.message }), 'error'); }
    }
    if (!db) db = WsjfDatabase.create(S.SQL, entry.name);
    if (S.db) S.db.close();
    S.db = db;
    S.trainId = id;
    S.dbHandle = await browserStore.loadHandle(id, 'handle');
    S.csvHandle = await browserStore.loadHandle(id, 'csv');
    S.sync = Object.assign({ fileStamp: null, pending: false }, await browserStore.loadSync(id));
    S.dbGranted = false;
    if (S.dbHandle) {
      try { S.dbGranted = (await fileAccess.permission(S.dbHandle, false)) === 'granted'; } catch (e) { S.dbGranted = false; }
    }
    S.reg.last = id;
    await browserStore.saveTrains(S.reg);
    setHash(id);
    document.title = `${entry.name} – SAFe WSJF`;
    if (S.dbGranted) await syncWithFile();
    S.ui.changed('train');
    S.ui.status();
  }

  async function switchTrain(id) {
    if (id === S.trainId) return;
    await flush();
    await openTrain(id);
  }

  async function createTrain(name, db) {
    const id = newTrainId(name, S.reg.list);
    S.reg.list.push({ id, name, createdAt: new Date().toISOString() });
    const d = db || WsjfDatabase.create(S.SQL, name);
    if (!db) d.setMeta('name', name);
    await browserStore.saveDb(d.export(), id);
    d.close();
    await browserStore.saveTrains(S.reg);
    await flush();
    await openTrain(id);
    return id;
  }

  async function renameTrain(name) {
    const entry = train();
    if (!entry || !name) return;
    entry.name = name;
    S.db.setMeta('name', name);
    await browserStore.saveTrains(S.reg);
    document.title = `${name} – SAFe WSJF`;
    changed();
    S.ui.status();
  }

  /** Entfernt den Zug aus der Liste samt Browser-Kopie; Dateien auf der Platte bleiben. Rückgabe: ob noch ein Zug offen ist. */
  async function removeTrain(id) {
    if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; }
    await browserStore.removeTrain(id);
    S.reg.list = S.reg.list.filter(a => a.id !== id);
    if (S.reg.last === id) S.reg.last = null;
    await browserStore.saveTrains(S.reg);
    if (id !== S.trainId) { S.ui.status(); return true; }
    if (S.db) S.db.close();
    S.db = null; S.trainId = null; S.dbHandle = null; S.csvHandle = null;
    if (S.reg.list.length) { await openTrain(S.reg.list[0].id); return true; }
    try { history.replaceState(null, '', global.location.pathname + global.location.search); } catch (e) { /* egal */ }
    S.ui.changed('empty');
    return false;
  }

  /** Vorhandene Datenbankdatei als (weiteren) Zug öffnen. Ist sie schon offen, wird dorthin gewechselt. */
  async function trainFromDbFile() {
    const picked = await pickDbFile();
    if (!picked) return;
    if (picked.handle) {
      for (const a of S.reg.list) {
        const h = await browserStore.loadHandle(a.id, 'handle');
        try {
          if (h && await h.isSameEntry(picked.handle)) {
            S.ui.toast(t('Diese Datei ist schon als «{name}» offen.', { name: a.name }));
            await switchTrain(a.id);
            return;
          }
        } catch (e) { /* nicht vergleichbar */ }
      }
    }
    const db = WsjfDatabase.open(S.SQL, picked.bytes);
    const name = db.getMeta('name') || picked.name.replace(/\.(sqlite3?|db)$/i, '');
    if (!db.getMeta('name')) db.setMeta('name', name);
    const id = await createTrain(name, db);
    if (picked.handle) await attachDbHandle(id, picked.handle, picked.stamp);
  }

  async function pickDbFile() {
    if (fileAccess.supported) {
      let handle;
      try { handle = await fileAccess.pickExisting(fileAccess.DB_TYPES); }
      catch (e) { if (e.name === 'AbortError') return null; throw e; }
      if ((await fileAccess.permission(handle, true)) !== 'granted') throw new Error(t('Kein Zugriff auf die Datei erlaubt.'));
      const r = await fileAccess.read(handle);
      return Object.assign(r, { handle });
    }
    return chooseFile('.sqlite,.sqlite3,.db');
  }

  async function attachDbHandle(id, handle, stamp) {
    await browserStore.saveHandle(id, 'handle', handle);
    S.sync = { fileStamp: stamp, pending: false };
    await browserStore.saveSync(id, S.sync);
    if (id === S.trainId) { S.dbHandle = handle; S.dbGranted = true; }
    S.ui.status();
  }

  // ---------- Datenbankdatei des aktiven Zugs ----------

  async function createDbFile() {
    const handle = await fileAccess.pickNew(`${slug(train().name)}.sqlite`, fileAccess.DB_TYPES);
    if ((await fileAccess.permission(handle, true)) !== 'granted') throw new Error(t('Kein Zugriff auf die Datei erlaubt.'));
    const stamp = await fileAccess.write(handle, S.db.export());
    await attachDbHandle(S.trainId, handle, stamp);
    S.ui.toast(t('Datenbankdatei angelegt. Jede Änderung wird jetzt direkt hineingeschrieben.'));
  }

  /** Bestehende Datei in den aktiven Zug laden (ersetzt den Stand im Browser). */
  async function openDbFile() {
    const picked = await pickDbFile();
    if (!picked) return;
    const db = WsjfDatabase.open(S.SQL, picked.bytes);
    replaceDb(db);
    await browserStore.saveDb(S.db.export(), S.trainId);
    if (picked.handle) await attachDbHandle(S.trainId, picked.handle, picked.stamp);
    else { await browserStore.clearHandle(S.trainId, 'handle'); S.dbHandle = null; }
    S.ui.changed('data');
  }

  function replaceDb(db) {
    if (S.db) S.db.close();
    S.db = db;
    const entry = train();
    const name = db.getMeta('name');
    if (entry && name && name !== entry.name) { entry.name = name; browserStore.saveTrains(S.reg); }
    else if (entry && !name) db.setMeta('name', entry.name);
    if (entry) document.title = `${entry.name} – SAFe WSJF`;
  }

  /** Nach einem Neustart des Browsers: Freigabe der gemerkten Datei erbitten (braucht einen Klick) und abgleichen. */
  async function connectFile() {
    if (!S.dbHandle) return;
    const p = await fileAccess.permission(S.dbHandle, true);
    if (p !== 'granted') { S.ui.toast(t('Kein Zugriff auf die Datei erlaubt.'), 'error'); return; }
    S.dbGranted = true;
    await syncWithFile();
    S.ui.status();
  }

  async function disconnectFile() {
    await flush();
    await browserStore.clearHandle(S.trainId, 'handle');
    S.dbHandle = null;
    S.dbGranted = false;
    S.sync = { fileStamp: null, pending: false };
    await browserStore.saveSync(S.trainId, S.sync);
    S.ui.status();
  }

  function downloadCopy() {
    const d = new Date().toISOString().slice(0, 10);
    download(S.db.export(), `${slug(train().name)}-${d}.sqlite`);
  }

  async function importCopy() {
    const picked = await chooseFile('.sqlite,.sqlite3,.db');
    if (!picked) return false;
    const db = WsjfDatabase.open(S.SQL, picked.bytes);
    replaceDb(db);
    changed();
    S.ui.changed('data');
    return true;
  }

  /** Gleicht Browser-Stand und Datei ab. Von aussen geändert und zugleich eigene Änderungen offen → fragen. */
  async function syncWithFile() {
    if (!S.dbHandle || !S.dbGranted) return;
    let file;
    try { file = await fileAccess.read(S.dbHandle); }
    catch (e) {
      S.dbGranted = false;
      S.ui.toast(t('Datenbankdatei nicht lesbar: {fehler}', { fehler: e.message }), 'error');
      S.ui.status();
      return;
    }
    const mine = S.db.export();
    if (sameStamp(file.stamp, S.sync.fileStamp)) {
      if (S.sync.pending) await writeFile(mine);
      return;
    }
    if (bytesEqual(file.bytes, mine)) {
      S.sync = { fileStamp: file.stamp, pending: false };
      await browserStore.saveSync(S.trainId, S.sync);
      return;
    }
    let choice = 'file';
    if (S.sync.pending) {
      choice = await S.ui.ask({
        title: t('Datei wurde von aussen geändert'),
        text: t('Die Datenbankdatei wurde geändert, während hier ungespeicherte Änderungen offen sind. Welche Fassung gilt?'),
        buttons: [{ id: 'file', label: t('Datei laden') }, { id: 'mine', label: t('Meine Fassung behalten'), primary: true }],
      });
    }
    if (choice === null) return; // offen lassen: nichts wird geschrieben, beim nächsten Speichern wird erneut gefragt
    if (choice === 'mine') { await writeFile(mine); return; }
    let db;
    try { db = WsjfDatabase.open(S.SQL, file.bytes); }
    catch (e) { S.ui.toast(e.message, 'error'); return; }
    replaceDb(db);
    await browserStore.saveDb(file.bytes, S.trainId);
    S.sync = { fileStamp: file.stamp, pending: false };
    await browserStore.saveSync(S.trainId, S.sync);
    S.ui.toast(t('Neuer Stand aus der Datenbankdatei geladen.'));
    S.ui.changed('data');
  }

  async function writeFile(bytes) {
    const stamp = await fileAccess.write(S.dbHandle, bytes);
    S.sync = { fileStamp: stamp, pending: false };
    await browserStore.saveSync(S.trainId, S.sync);
  }

  async function checkExternal() {
    if (!S.db || !S.dbHandle || !S.dbGranted || S.saveTimer || S.saving) return;
    try {
      const stamp = await fileAccess.stamp(S.dbHandle);
      if (!sameStamp(stamp, S.sync.fileStamp)) await syncWithFile();
    } catch (e) { /* Datei gerade nicht erreichbar */ }
  }

  // ---------- Speichern ----------

  /** Nach jeder Änderung: in Kürze speichern. */
  function changed() {
    S.sync.pending = true;
    if (S.saveTimer) clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(() => { S.saveTimer = null; save(); }, SAVE_DELAY);
    S.ui.status();
  }

  async function save() {
    if (S.saving) { await S.saving; }
    S.saving = (async () => {
      const bytes = S.db.export();
      const id = S.trainId;
      try {
        await browserStore.saveDb(bytes, id);
        if (S.dbHandle && S.dbGranted) {
          const stamp = await fileAccess.stamp(S.dbHandle);
          if (S.sync.fileStamp && !sameStamp(stamp, S.sync.fileStamp)) await syncWithFile();
          else await writeFile(bytes);
        } else {
          await browserStore.saveSync(id, S.sync);
        }
        if (S.channel) S.channel.postMessage({ type: 'saved', train: id, tab: S.tabId });
      } catch (e) {
        S.ui.toast(t('Speichern fehlgeschlagen: {fehler}', { fehler: e.message }), 'error');
      }
    })();
    try { await S.saving; } finally { S.saving = null; S.ui.status(); }
  }

  /** Offene Speicherung sofort ausführen (vor Zugwechsel und Dateiaktionen). */
  async function flush() {
    if (S.saveTimer) { clearTimeout(S.saveTimer); S.saveTimer = null; await save(); }
    else if (S.saving) await S.saving;
  }

  /** Beim Schliessen: wenigstens die Browser-Kopie anstossen. */
  function flushSync() {
    clearTimeout(S.saveTimer);
    S.saveTimer = null;
    try { browserStore.saveDb(S.db.export(), S.trainId); } catch (e) { /* zu spät */ }
  }

  async function onBroadcast(msg) {
    if (!msg || msg.tab === S.tabId || msg.type !== 'saved' || msg.train !== S.trainId) return;
    if (S.saveTimer || S.saving) return; // eigene Änderung folgt, sie gewinnt
    const bytes = await browserStore.loadDb(S.trainId);
    if (!bytes) return;
    try { replaceDb(WsjfDatabase.open(S.SQL, bytes)); } catch (e) { return; }
    S.sync = Object.assign({ fileStamp: null, pending: false }, await browserStore.loadSync(S.trainId));
    S.ui.changed('data');
  }

  // ---------- CSV-Datei des Zugs ----------

  /** CSV wählen: mit File System Access API als Handle (für das Zurückschreiben), sonst über ein Dateifeld. */
  async function pickCsv() {
    if (fileAccess.supported) {
      let handle;
      try { handle = await fileAccess.pickExisting(fileAccess.CSV_TYPES); }
      catch (e) { if (e.name === 'AbortError') return null; throw e; }
      const r = await fileAccess.read(handle);
      return Object.assign(r, { handle });
    }
    return chooseFile('.csv,text/csv');
  }

  /** Die gemerkte CSV erneut lesen (fragt bei Bedarf um Erlaubnis); ohne gemerkte Datei → null. */
  async function rereadCsv() {
    if (!S.csvHandle) return null;
    const p = await fileAccess.permission(S.csvHandle, true, 'read');
    if (p !== 'granted') throw new Error(t('Kein Zugriff auf die Datei erlaubt.'));
    const r = await fileAccess.read(S.csvHandle);
    return Object.assign(r, { handle: S.csvHandle });
  }

  async function rememberCsv(handle) {
    S.csvHandle = handle || null;
    if (handle) await browserStore.saveHandle(S.trainId, 'csv', handle);
    else await browserStore.clearHandle(S.trainId, 'csv');
  }

  /** In die gemerkte CSV schreiben. Rückgabe: neuer Stempel. Wirft, wenn keine Datei oder kein Zugriff. */
  async function writeCsvFile(bytes) {
    const p = await fileAccess.permission(S.csvHandle, true, 'readwrite');
    if (p !== 'granted') throw new Error(t('Kein Zugriff auf die Datei erlaubt.'));
    return fileAccess.write(S.csvHandle, bytes);
  }

  async function csvStamp() {
    if (!S.csvHandle) return null;
    try {
      if ((await fileAccess.permission(S.csvHandle, false, 'read')) !== 'granted') return null;
      return await fileAccess.stamp(S.csvHandle);
    } catch (e) { return null; }
  }

  // ---------- Zustand für die Oberfläche ----------

  function info() {
    const entry = train();
    return {
      trains: S.reg.list.slice(),
      trainId: S.trainId,
      trainName: entry ? entry.name : '',
      storage: browserStore.label(),
      fileSupported: fileAccess.supported,
      file: S.dbHandle ? { name: S.dbHandle.name, granted: S.dbGranted } : null,
      csvFile: S.csvHandle ? { name: S.csvHandle.name } : null,
      pending: !!S.saveTimer,
      saving: !!S.saving,
    };
  }

  global.WsjfSession = {
    start, info, changed, flush,
    get db() { return S.db; },
    switchTrain, createTrain, renameTrain, removeTrain, trainFromDbFile,
    createDbFile, openDbFile, connectFile, disconnectFile, downloadCopy, importCopy,
    pickCsv, rereadCsv, rememberCsv, writeCsvFile, csvStamp,
  };
})(window);
