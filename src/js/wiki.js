/* SAFe WSJF – Jira-Wiki-Markup als HTML (für die Beschreibung aus dem CSV-Export).
   Reine Funktion ohne DOM: render(text, { jiraUrl }) → HTML-Text. Aller Text wird escaped; es entstehen nur feste Tags,
   Links nur mit http, https und mailto, Farben nur als Name oder #hex. Im Browser als window.WsjfWiki, in Node über require().

   Unterstützt
   - Blöcke: h1. … h6., bq., ----, Listen mit * - # (auch gemischt verschachtelt: *#), Tabellen (||Kopf|| und |Zelle|),
     {code[:sprache]} … {code}, {noformat} … {noformat}, {quote} … {quote},
     {panel[:title=…]} … {panel}, {info}, {note}, {tip}, {warning} (je mit optionalem title=)
   - Inline: *fett*, _kursiv_, -durchgestrichen-, +unterstrichen+, ^hoch^, ~tief~, ??Zitat??, {{monospace}},
     {color:red}…{color}, [Text|URL], [URL], [Text][URL] (nachsichtig), [~name], [~accountid:…], !bild.png!, \\ (Umbruch),
     Adressen im Text und Vorgangsschlüssel (ART-123, als Link mit jiraUrl), \ vor einem Zeichen hebt es auf. */
(function (global) {
  'use strict';

  const t = (s, p) => (global.WsjfI18n ? global.WsjfI18n.t(s, p) : s.replace(/\{(\w+)\}/g, (m, k) => (p && k in p ? p[k] : m)));

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /** Nur sichere Adressen; sonst null. */
  function safeUrl(u) {
    const s = String(u || '').trim();
    return /^(https?:\/\/|mailto:)[^\s"<>]+$/i.test(s) ? s : null;
  }

  function safeColor(c) {
    const s = String(c || '').trim();
    return /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(s) ? s : null;
  }

  const link = (href, html) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;

  // ---------- Inline ----------

  /** Einfache Auszeichnungen: Zeichen, Tag. Start nicht nach einem Wortzeichen und nicht vor Leerraum, Ende umgekehrt. */
  const SIMPLE = [['*', 'strong'], ['_', 'em'], ['-', 'del'], ['+', 'ins'], ['^', 'sup'], ['~', 'sub'], ['??', 'cite']];

  function simpleRe(mark) {
    const m = mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // (Vorgänger)(Marke)(Inhalt ohne Leerraum am Rand)(Marke), danach kein Wortzeichen
    return new RegExp(`(^|[^\\w\\\\])${m}(?=\\S)((?:(?!${m}).)*?\\S|\\S)${m}(?![\\w])`, 'g');
  }
  const SIMPLE_RE = SIMPLE.map(([mark, tag]) => ({ re: simpleRe(mark), tag }));

  const INLINE = [
    { name: 'escape', re: /\\([^\\\s])/g },
    { name: 'break', re: /\\\\/g },
    { name: 'mono', re: /\{\{(.+?)\}\}/g },
    { name: 'color', re: /\{color:([^}]*)\}([\s\S]*?)\{color\}/g },
    { name: 'linkPair', re: /\[([^\]|[\n]+)\]\[([^\]\n]+)\]/g },
    { name: 'link', re: /\[([^\]\n]+)\]/g },
    { name: 'image', re: /!([^!\s|][^!\n|]*)(?:\|[^!\n]*)?!/g },
  ];

  /** Inline-Text → HTML. */
  function inline(s, ctx) {
    let out = '';
    let rest = s;
    for (;;) {
      let best = null;
      for (const p of INLINE) {
        p.re.lastIndex = 0;
        const m = p.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { p, m, start: m.index, len: m[0].length };
      }
      for (const p of SIMPLE_RE) {
        p.re.lastIndex = 0;
        const m = p.re.exec(rest);
        if (m) {
          const start = m.index + m[1].length; // Vorgänger gehört zum Text davor
          if (!best || start < best.start) best = { p: { name: 'simple', tag: p.tag }, m, start, len: m[0].length - m[1].length };
        }
      }
      if (!best) { out += plain(rest, ctx); return out; }
      out += plain(rest.slice(0, best.start), ctx);
      out += renderInline(best.p, best.m, ctx);
      rest = rest.slice(best.start + best.len);
    }
  }

  function renderInline(p, m, ctx) {
    switch (p.name) {
      case 'escape': return esc(m[1]);
      case 'break': return '<br>';
      case 'mono': return `<code>${esc(m[1])}</code>`;
      case 'color': {
        const c = safeColor(m[1]);
        return c ? `<span style="color:${c}">${inline(m[2], ctx)}</span>` : inline(m[2], ctx);
      }
      case 'linkPair': {
        const href = safeUrl(m[2]);
        return href ? link(href, inline(m[1], ctx)) : esc(m[0]);
      }
      case 'link': return linkTag(m[1], ctx);
      case 'image': return `<span class="wiki-image" title="${esc(t('Bild aus Jira, nicht im CSV-Export enthalten'))}">🖼 ${esc(m[1].trim())}</span>`;
      case 'simple': return `<${p.tag}>${inline(m[2], ctx)}</${p.tag}>`;
      default: return esc(m[0]);
    }
  }

  /** [Text|URL], [URL], [~name], [~accountid:…], [mailto:…]. */
  function linkTag(body, ctx) {
    const b = body.trim();
    if (b.startsWith('~')) {
      const who = b.slice(1);
      const name = /^accountid:/i.test(who) ? t('Benutzer') : who;
      return `<span class="wiki-mention">@${esc(name)}</span>`;
    }
    const bar = b.lastIndexOf('|');
    const text = bar >= 0 ? b.slice(0, bar) : null;
    const target = bar >= 0 ? b.slice(bar + 1) : b;
    const href = safeUrl(target) || issueUrl(target, ctx);
    if (!href) return esc('[' + body + ']');
    return link(href, text != null ? inline(text, ctx) : esc(target));
  }

  function issueUrl(key, ctx) {
    const base = ctx && ctx.jiraUrl ? String(ctx.jiraUrl).trim().replace(/\/+$/, '') : '';
    if (!base || !/^https?:\/\//i.test(base) || !/^[A-Z][A-Z0-9_]+-\d+$/.test(String(key).trim())) return null;
    return `${base}/browse/${encodeURIComponent(String(key).trim())}`;
  }

  /** Reiner Text: escapen, Adressen und Vorgangsschlüssel verlinken. */
  function plain(s, ctx) {
    if (!s) return '';
    const re = /(https?:\/\/[^\s<>"'\]|]+[^\s<>"'\]|.,;:!?)])|\b([A-Z][A-Z0-9_]+-\d+)\b/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(s))) {
      const href = m[1] ? safeUrl(m[1]) : issueUrl(m[2], ctx);
      if (!href) continue;
      out += esc(s.slice(last, m.index)) + link(href, esc(m[0]));
      last = m.index + m[0].length;
    }
    return out + esc(s.slice(last));
  }

  // ---------- Blöcke ----------

  const PANELS = ['panel', 'info', 'note', 'tip', 'warning'];

  /** Parameter wie «title=Hinweis|borderStyle=dashed» → { title: 'Hinweis', … }. */
  function params(s) {
    const out = {};
    for (const part of String(s || '').split('|')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
    }
    return out;
  }

  /** Zeile einer Tabelle in Zellen zerlegen; | in [..] und {{..}} zählt nicht. */
  function cells(line) {
    const out = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
      let head = false;
      if (line.startsWith('||', i)) { head = true; i += 2; } else if (line[i] === '|') i += 1; else break;
      let depth = 0;
      let mono = false;
      let j = i;
      for (; j < n; j++) {
        const c = line[j];
        if (line.startsWith('{{', j)) { mono = true; j++; continue; }
        if (line.startsWith('}}', j)) { mono = false; j++; continue; }
        if (c === '\\') { j++; continue; }
        if (c === '[') depth++;
        else if (c === ']') depth = Math.max(0, depth - 1);
        else if (c === '|' && !depth && !mono) break;
      }
      const text = line.slice(i, j);
      if (j >= n && !text.trim()) break; // abschliessendes |
      out.push({ head, text: text.trim() });
      i = j;
    }
    return out;
  }

  function render(text, ctx) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    return blocks(lines, ctx || {});
  }

  function blocks(lines, ctx) {
    let out = '';
    let para = [];
    let list = null; // [{ type: 'ul'|'ol' }] offene Ebenen
    const flushPara = () => {
      if (para.length) out += `<p>${para.map(l => inline(l, ctx)).join('<br>')}</p>`;
      para = [];
    };
    const closeList = () => {
      if (!list) return;
      while (list.length) out += `</li></${list.pop().type}>`;
      list = null;
    };
    const flush = () => { flushPara(); closeList(); };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // {code} und {noformat}: Inhalt wörtlich, auch auf einer Zeile ({code}x{code}).
      let m = /^\{(code|noformat)(?::([^}]*))?\}(.*)$/i.exec(trimmed);
      if (m) {
        flush();
        const tag = m[1].toLowerCase();
        const endRe = new RegExp(`\\{${tag}\\}`, 'i');
        const body = [];
        let first = m[3];
        let end = endRe.exec(first);
        if (end) body.push(first.slice(0, end.index));
        else {
          if (first) body.push(first);
          for (i++; i < lines.length; i++) {
            end = endRe.exec(lines[i]);
            if (end) { const pre = lines[i].slice(0, end.index); if (pre) body.push(pre); break; }
            body.push(lines[i]);
          }
        }
        const p = params(m[2]);
        const title = p.title ? `<div class="wiki-code-title">${esc(p.title)}</div>` : '';
        out += `<pre class="wiki-${tag}">${title}<code>${esc(body.join('\n'))}</code></pre>`;
        continue;
      }

      // {quote} und Panels: Inhalt rekursiv.
      m = new RegExp(`^\\{(quote|${PANELS.join('|')})(?::([^}]*))?\\}(.*)$`, 'i').exec(trimmed);
      if (m) {
        flush();
        const tag = m[1].toLowerCase();
        const endRe = new RegExp(`\\{${tag}\\}`, 'i');
        const body = [];
        const first = m[3];
        let end = endRe.exec(first);
        if (end) body.push(first.slice(0, end.index));
        else {
          if (first) body.push(first);
          for (i++; i < lines.length; i++) {
            end = endRe.exec(lines[i]);
            if (end) { const pre = lines[i].slice(0, end.index); if (pre.trim()) body.push(pre); break; }
            body.push(lines[i]);
          }
        }
        const inner = blocks(body, ctx);
        if (tag === 'quote') out += `<blockquote>${inner}</blockquote>`;
        else {
          const p = params(m[2]);
          const title = p.title ? `<div class="wiki-panel-title">${inline(p.title, ctx)}</div>` : '';
          out += `<div class="wiki-panel wiki-${tag}">${title}${inner}</div>`;
        }
        continue;
      }

      if (!trimmed) { flush(); continue; }

      m = /^h([1-6])\.\s+(.*)$/.exec(trimmed);
      if (m) { flush(); out += `<h${m[1]}>${inline(m[2], ctx)}</h${m[1]}>`; continue; }

      m = /^bq\.\s+(.*)$/.exec(trimmed);
      if (m) { flush(); out += `<blockquote><p>${inline(m[1], ctx)}</p></blockquote>`; continue; }

      if (/^-{4,}$/.test(trimmed)) { flush(); out += '<hr>'; continue; }

      // Tabelle: aufeinanderfolgende Zeilen, die mit | beginnen.
      if (trimmed.startsWith('|')) {
        flush();
        let rows = '';
        for (; i < lines.length && lines[i].trim().startsWith('|'); i++) {
          rows += '<tr>' + cells(lines[i].trim()).map(c => {
            const tag = c.head ? 'th' : 'td';
            return `<${tag}>${inline(c.text, ctx)}</${tag}>`;
          }).join('') + '</tr>';
        }
        i--;
        out += `<table class="wiki-table"><tbody>${rows}</tbody></table>`;
        continue;
      }

      // Listen: * und - ungeordnet, # nummeriert; Tiefe = Anzahl Zeichen. Einzelnes «-» nur als Ebene 1.
      m = /^([*#-]+)\s+(.*)$/.exec(trimmed);
      if (m && !(m[1].length > 1 && m[1].includes('-'))) {
        flushPara();
        const marks = m[1];
        const types = [...marks].map(c => (c === '#' ? 'ol' : 'ul'));
        if (!list) list = [];
        // Gemeinsamen Anfang behalten, Rest schliessen.
        let keep = 0;
        while (keep < list.length && keep < types.length && list[keep].type === types[keep]) keep++;
        if (keep === types.length && keep === list.length) out += '</li><li>';
        else {
          while (list.length > keep) out += `</li></${list.pop().type}>`;
          if (list.length === types.length) out += '</li><li>';
          while (list.length < types.length) {
            const type = types[list.length];
            out += `<${type}><li>`;
            list.push({ type });
          }
        }
        out += inline(m[2], ctx);
        continue;
      }

      // Fortsetzung: normale Zeile beendet die Liste.
      closeList();
      para.push(line);
    }
    flush();
    return out;
  }

  const api = { render, inline: (s, ctx) => inline(s, ctx || {}), esc };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.WsjfWiki = api;
})(typeof window !== 'undefined' ? window : globalThis);
