# SAFe WSJF

Priorisierung nach **Weighted Shortest Job First** (SAFe), die **ohne Server, ohne Installation und ohne Adminrechte**
läuft. Die App öffnet sich als Datei im Browser, liest die Tickets aus einem **CSV-Export von Jira**, ordnet sie in
zwei Rastern ein, berechnet den WSJF und schreibt die Werte **in dieselbe CSV zurück** (oder als Download mit
gleichem Aufbau). Gespeichert wird in einer echten **SQLite-Datenbank**, eine je Zug oder Portfolio.

Die Bewertung entspricht dem Raster der WSJF-App (CDRO/WSJF-App), ohne Jira-Anbindung, Abstimmung und Server.

Gebaut für Rechner mit stark eingeschränkten Rechten: Es wird kein Dienst gestartet, kein Port geöffnet, kein Programm
installiert. PowerShell ist optional und auch im Constrained Language Mode kein Hindernis, weil sie nur den Browser öffnet.

## Voraussetzungen

- Windows 10/11 (oder ein anderes System) mit einem Chromium-Browser, z. B. **Microsoft Edge**. Firefox funktioniert
  ebenfalls, schreibt aber nicht direkt in Dateien: dort gibt es die CSV und die Datenbank als Download.
- Sonst nichts. Kein Internet, keine Adminrechte, kein .NET, kein Node.

## Start

1. ZIP aus dem [Release](../../releases) oder aus dem Workflow-Artefakt herunterladen und entpacken.
2. Eine der drei Möglichkeiten:
   - **Doppelklick auf `index.html`** (öffnet im Standardbrowser), oder
   - Doppelklick auf `start.cmd`, oder
   - in PowerShell: `.\start.ps1` (mit `-Edge` wird Edge erzwungen).

Hinweis zu `start.ps1`: Heruntergeladene Dateien tragen die Internet-Markierung, und eine Richtlinie wie `RemoteSigned`
lehnt das Skript dann ab. Einmalig lösen mit `Unblock-File -Path .\start.ps1`. `index.html` und `start.cmd` sind davon
nicht betroffen.

## Ablauf

1. **Zug anlegen.** Beim ersten Start fragt die App nach dem Namen des Zugs (Agile Release Train) oder Portfolios.
   Weitere Züge über das Menü links oben. Jeder Zug hat seine eigene Datenbank, eigene Spaltenzuordnung und eigene
   CSV-Datei.
2. **CSV einlesen** (`CSV → CSV einlesen…`). In Jira die Tickets als CSV exportieren (alle Felder). Beim ersten
   Einlesen eines Zugs fragt die App, welche Spalte was enthält. Sie schlägt die üblichen Spalten von Jira vor
   (`Issue key`, `Summary`, `Custom field (User Business Value)`, `Custom field (Job Size)` …, auch die deutschen
   Namen); jede Zeile zeigt Beispielwerte. Die Zuordnung wird im Zug gespeichert und bei jedem weiteren Export
   wiederverwendet; ändern über `CSV → Spaltenzuordnung…`.
3. **Bewerten.** Tickets aus der Liste «Offen» in die Raster ziehen:
   - oben **Direkter Nutzen (UBV) × Zukünftiger Nutzen (RROE)**,
   - unten **Dringlichkeit (TC) × Dauer (Job Size)**.

   Ein Klick auf ein Ticket (oder `Enter`) öffnet die vier Werte zum Auswählen. Beim Ziehen erscheinen unten drei
   Felder: **Erforderlich** (steht immer oben, schreibt feste Werte), **Ausblenden** und **Werte löschen**.
   Zurück in die Liste «Offen» ziehen löscht die Werte dieses Rasters. `Ctrl+Z` macht die letzte Bewertung rückgängig.
4. **Priorisierte Liste.** WSJF = (UBV + RROE + TC) / Job Size, absteigend; erforderliche Tickets zuerst, Tickets ohne
   vollständige Bewertung am Ende. Ein Punkt markiert Werte, die noch nicht in der CSV stehen.
5. **Zurückschreiben** (`In CSV zurückschreiben`). In Edge und Chrome schreibt die App in die eingelesene Datei (der
   Browser fragt beim ersten Mal um Erlaubnis); sonst kommt die CSV als Download. Die Datei hat denselben Aufbau wie
   der Export und lässt sich mit dem CSV-Import von Jira wieder einspielen.

### Was beim Zurückschreiben passiert

- Kopfzeile, Reihenfolge, Trennzeichen, Zeilenende, Zeichensatz (UTF-8 mit oder ohne BOM, Windows-1252) und
  Anführungszeichen bleiben wie im Export. Zeilen, deren Werte sich nicht geändert haben, gehen **Byte für Byte**
  unverändert hinaus.
- Geändert werden nur die zugeordneten Spalten für UBV, RROE, TC, Job Size und (falls zugeordnet) WSJF.
- Fehlt eine dieser Spalten im Export, kann sie in der Zuordnung als **neue Spalte angehängt** werden.
- Hat sich die CSV seit dem Einlesen geändert (z. B. ein neuer Export an derselben Stelle), fragt die App, ob sie erst
  neu einlesen soll.

### Erneut einlesen

Ein neuer Export desselben Zugs (`CSV → CSV neu einlesen`) wird mit dem Stand in der Datenbank zusammengeführt, Wert
für Wert:

| hier geändert | in Jira geändert | Ergebnis |
| --- | --- | --- |
| nein | ja | Wert aus der CSV |
| ja | nein | eigener Wert bleibt |
| ja | ja, anders | eigener Wert bleibt, die App meldet den Konflikt |

Neue Tickets kommen dazu (mit den Labels zum Ausblenden gleich ausgeblendet, mit den Werten von «Erforderlich» als
erforderlich). Tickets, die im Export fehlen, landen unter **Nicht mehr in der CSV** und werden nicht zurückgeschrieben.

## Wo liegen die Daten?

Wie bei NoNotes zweistufig:

1. **Browser-Speicher (automatisch).** Jede Änderung geht nach kurzer Pause in den Browser-Speicher (IndexedDB).
   Achtung: «Browserdaten löschen» löscht auch diesen Stand.
2. **Datenbankdatei (empfohlen).** Über `Datenbank → Datenbankdatei anlegen…` legst du je Zug eine `.sqlite` an einem
   Ort deiner Wahl an. Ab dann schreibt die App jede Änderung direkt in diese Datei. Sie lässt sich sichern, kopieren,
   weitergeben und mit jedem SQLite-Werkzeug öffnen.

Nach einem Neustart des Browsers merkt sich die App die Datei und bittet mit **Mit Datei verbinden** um die Freigabe.
Ändert jemand die Datei von aussen (anderer Tab, Kopie von einer Kollegin), lädt die App den neuen Stand beim
Zurückkehren in den Tab und alle 30 Sekunden; gibt es zugleich eigene ungespeicherte Änderungen, fragt sie.

Weitere Funktionen im Menü **Datenbank**: Datenbankdatei öffnen, Dateiverbindung trennen, Kopie herunterladen, aus
Kopie importieren, Sprache. Im Menü der Züge: neuer Zug, Datenbankdatei als Zug öffnen, umbenennen, Adresse kopieren,
Zug entfernen (die Dateien auf der Platte bleiben).

**Adresse eines Zugs:** `index.html#zug=art-plattform` öffnet den Zug direkt (`#zug=2` den zweiten der Liste).
`Alt+1` … `Alt+9` wechselt, `Alt+0` öffnet das Menü.

### Einstellungen je Zug

- **Skala** der Raster, Vorgabe `1, 2, 3, 5, 8, 13, 20`. Werte ausserhalb der Skala bleiben erhalten; das Ticket steht
  dann neben dem Raster.
- **Werte für «Erforderlich»**, Vorgabe UBV 100, RROE 100, TC 100, Job Size 1 (wie in der WSJF-App).
- **Labels zum Ausblenden**, Vorgabe `informell`; über der Liste gibt es je Label einen Schalter.
- **Jira-Adresse** für Links auf die Tickets (optional).

## Technik

| Teil | Umsetzung |
| --- | --- |
| Oberfläche | `index.html`, `css/app.css`, `js/app.js`: reines HTML/CSS/JS, keine Frameworks, nichts gebündelt |
| CSV | `js/csv.js`: RFC 4180, Trennzeichen erkennen, Zeichensätze, Originaltext je Zeile für den verlustfreien Rundweg |
| Fachlogik | `js/wsjf.js`: Spaltenzuordnung, WSJF, Rangfolge, Dreiwegevergleich, Zeilen zum Zurückschreiben |
| Datenbank | [sql.js](https://github.com/sql-js/sql.js) (SQLite als JavaScript, ohne WebAssembly) in `vendor/sql.js/`; Schema in `js/db.js` |
| Persistenz | `js/storage.js` (IndexedDB, File System Access API), `js/session.js` (Züge, Speichern, Änderungen von aussen) |
| Sprachen | `js/i18n.js` und `lang/`: der deutsche Text ist der Schlüssel, Englisch liegt bei |
| Start | `start.ps1` (nur Cmdlets, läuft im Constrained Language Mode), `start.cmd` |

Warum kein lokaler Webserver? Auf dem Zielrechner steht PowerShell nur im Constrained Language Mode zur Verfügung;
dort sind weder `HttpListener` noch `winsqlite3.dll` nutzbar. Der Browser bringt mit der File System Access API alles
mit, um direkt in Dateien zu schreiben, und sql.js liefert SQLite als reines JavaScript.

Schema (Version 1, `js/db.js`): Eine neue Datei bekommt es ganz, eine ältere wird beim Öffnen angeglichen (fehlende
Tabellen und Spalten kommen dazu). Fremde SQLite-Dateien werden abgelehnt.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- app, schema_version, name, mapping, scale, required, hide_labels, jira_url,
  -- csv_headers, csv_raw_header, csv_format, csv_file_name, csv_stamp, csv_imported_at, csv_written_at
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_key TEXT NOT NULL UNIQUE,
  summary, status, issue_type, assignee, team, labels (JSON), description,
  ubv, rroe, tc, job_size,                              -- aktuelle Werte
  base_ubv, base_rroe, base_tc, base_job_size,          -- wie zuletzt in der CSV (für Zurückschreiben und Zusammenführen)
  state TEXT,                                           -- 'open' | 'required' | 'hidden'
  in_csv INTEGER, csv_row INTEGER, conflict INTEGER,
  created_at, updated_at
);
CREATE TABLE csv_rows (row INTEGER PRIMARY KEY, cells TEXT NOT NULL, raw TEXT);  -- letzter Stand der CSV, Zeile für Zeile
```

## Entwicklung

`src/index.html` lässt sich direkt im Browser öffnen. Die auslieferbare Form entsteht mit

```bash
npm run build        # schreibt dist/SAFe-WSJF
```

`npm test` baut und prüft dann:

| Lauf | Prüft |
| --- | --- |
| `tools/i18n.cjs check` | alle Texte der Oberfläche haben eine englische Übersetzung, keine überzähligen |
| `test/core.cjs` (ohne Browser) | CSV (Felder, Zeilenenden, Zeichensätze, Rundweg), WSJF, Rangfolge, Zuordnung, Zusammenführen, Datenbank |
| `test/app.cjs` | das Gebaute per `file://` in headless Chromium: Zug anlegen, Einlesen mit Zuordnung, Ziehen, Dialog, Rückgängig, Zurückschreiben, erneut Einlesen, Datenbankdatei, mehrere Züge, Firefox-Weg (Download), Englisch |

```bash
npm install
npx playwright install --with-deps chromium
npm test
```

## Release

Der Workflow `.github/workflows/package.yml` läuft bei jedem Push: Test, dann `SAFe-WSJF-<Version>.zip` als Artefakt.
Ein Tag `v*` (oder *Actions → Testen und paketieren → Run workflow* mit Version) legt ein Release mit dem ZIP an.

## Lizenz

MIT, siehe [LICENSE](LICENSE). Fremdbestandteile (sql.js) und Herkunft einzelner Teile: [NOTICE](NOTICE).
