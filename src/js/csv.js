/* SAFe WSJF – CSV lesen und schreiben.
   Reine Funktionen ohne DOM, im Browser als window.WsjfCsv, in Node über require().
   Ziel ist ein verlustfreier Rundweg: Ein Jira-Export, der eingelesen und unverändert wieder geschrieben wird, ist
   Byte für Byte gleich. Dafür merkt sich parse() Trennzeichen, Zeilenende, Anführungszeichen und den Zeilenumbruch am
   Ende; decode() merkt sich Zeichensatz und BOM. */
(function (global) {
  'use strict';

  // ---------- Zeichensatz ----------

  // Windows-1252: 0x80–0x9F weichen von Latin-1 ab (undefinierte Stellen bleiben leer).
  const CP1252_HIGH = [
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
    0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
  ];

  /** Bytes → { text, encoding: 'utf-8' | 'windows-1252', bom }. UTF-8 mit oder ohne BOM, sonst Windows-1252 (Excel). */
  function decode(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) {
      return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8', bom: true };
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8', bom: false };
    } catch (e) {
      let s = '';
      for (let i = 0; i < b.length; i++) {
        const c = b[i];
        s += String.fromCharCode(c >= 0x80 && c <= 0x9F ? (CP1252_HIGH[c - 0x80] || c) : c);
      }
      return { text: s, encoding: 'windows-1252', bom: false };
    }
  }

  /** Text → Bytes im angegebenen Zeichensatz. Zeichen, die es in Windows-1252 nicht gibt, werden zu «?». */
  function encode(text, encoding, bom) {
    if (encoding === 'windows-1252') {
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 0x80 || (c >= 0xA0 && c <= 0xFF)) out[i] = c;
        else {
          const j = CP1252_HIGH.indexOf(c);
          out[i] = j >= 0 && c !== 0 ? 0x80 + j : 0x3F;
        }
      }
      return out;
    }
    const body = new TextEncoder().encode(text);
    if (!bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xEF, 0xBB, 0xBF]);
    out.set(body, 3);
    return out;
  }

  // ---------- Lesen ----------

  /** Häufigstes Trennzeichen der ersten Zeile (ausserhalb von Anführungszeichen): Komma, Semikolon oder Tab. */
  function detectDelimiter(text) {
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') quoted = !quoted;
      else if (!quoted && (c === '\n' || c === '\r')) break;
      else if (!quoted && c in counts) counts[c]++;
    }
    let best = ',';
    for (const d of [';', '\t']) if (counts[d] > counts[best]) best = d;
    return best;
  }

  /** CSV nach RFC 4180 (Felder in "…" dürfen Trennzeichen, Zeilenumbrüche und "" enthalten).
   *  Ergebnis: { rows, raw, delimiter, lineEnding, quoteAll, trailingNewline }; raw[i] ist der Originaltext von rows[i] ohne
   *  Zeilenende (für unveränderte Zeilen beim Zurückschreiben). */
  function parse(text, delimiter) {
    const d = delimiter || detectDelimiter(text);
    const rows = [];
    const raw = [];
    let rowStart = 0;
    let row = [];
    let field = '';
    let quoted = false;
    let wasQuoted = false;
    let headerQuotes = 0;
    let headerFields = 0;
    let inHeader = true;
    let i = 0;
    const n = text.length;
    const endField = () => {
      row.push(field);
      if (inHeader) { headerFields++; if (wasQuoted) headerQuotes++; }
      field = '';
      wasQuoted = false;
    };
    const endRow = end => { endField(); rows.push(row); raw.push(text.slice(rowStart, end)); row = []; inHeader = false; };
    while (i < n) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { quoted = true; wasQuoted = true; i++; continue; }
      if (c === d) { endField(); i++; continue; }
      if (c === '\r' && text[i + 1] === '\n') { endRow(i); i += 2; rowStart = i; continue; }
      if (c === '\n' || c === '\r') { endRow(i); i++; rowStart = i; continue; }
      field += c; i++;
    }
    const trailingNewline = n > 0 && (text[n - 1] === '\n' || text[n - 1] === '\r') && !quoted;
    if (!trailingNewline && (field !== '' || row.length || wasQuoted)) endRow(n);
    const lf = text.indexOf('\n');
    const lineEnding = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
    return { rows, raw, delimiter: d, lineEnding, quoteAll: headerFields > 0 && headerQuotes === headerFields, trailingNewline };
  }

  // ---------- Schreiben ----------

  function quoteField(value, opts) {
    const s = value == null ? '' : String(value);
    if (opts.quoteAll || s.includes(opts.delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')
      || /^\s|\s$/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /** Zeilen → Text mit den Angaben aus parse(). Eine Zeile darf statt eines Arrays ein String sein: dann geht sie
   *  unverändert hinaus (Originaltext einer unveränderten Zeile). */
  function stringify(rows, opts) {
    const o = Object.assign({ delimiter: ',', lineEnding: '\n', quoteAll: false, trailingNewline: true }, opts || {});
    const text = rows.map(r => (typeof r === 'string' ? r : r.map(f => quoteField(f, o)).join(o.delimiter))).join(o.lineEnding);
    return o.trailingNewline && rows.length ? text + o.lineEnding : text;
  }

  const api = { decode, encode, detectDelimiter, parse, stringify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WsjfCsv = api;
})(typeof window !== 'undefined' ? window : globalThis);
