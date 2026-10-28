# sql.js (vendored)

- Paket: `sql.js` 1.14.2 (SQLite 3.49.1), Datei `dist/sql-asm.js`
- Quelle: https://github.com/sql-js/sql.js · https://www.npmjs.com/package/sql.js
- Lizenz: MIT (siehe `LICENSE` in diesem Ordner)

Warum die asm.js-Variante und nicht WebAssembly? Die App wird direkt als Datei (`file://`) geöffnet. Dort darf die Seite
keine Nachbardateien per `fetch` laden, das Nachladen einer `.wasm`-Datei scheitert. `sql-asm.js` ist reines JavaScript,
wird per `<script>` eingebunden und braucht nichts weiter.
