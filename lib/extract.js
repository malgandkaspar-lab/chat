// Turns downloaded pages and files into plain text sections ready for chunking.
//
// Tables get special care. A small chat model cannot tell which bare number sits under
// which column, so a table with a header is written one row per line as
// "header: value; header: value" and every number carries its own labels.
const fs = require('node:fs');
const cheerio = require('cheerio');

const BOILERPLATE = [
  'script', 'style', 'noscript', 'template', 'footer', 'nav', 'form', 'iframe', 'svg', 'button', 'h1',
  '#block-breadcrumbs', '.visually-hidden', '.sr-only', '[class*="share"]', '[class*="cookie"]',
  '[class*="gallery"]', '[class*="menu"]', '[class*="feedback"]', 'a[href*="email-protection"]',
  // Blocks of these sites that repeat from page to page: press contacts, feedback form
  // confirmation, teasers of related pages, "all events" buttons.
  '.paragraph--type--news-author-item', '.webform-confirmation', '.confirmation-container',
  '#block-vprelatedcontent', '.region-content-bottom', 'a.btn',
].join(', ');

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'ul', 'ol', 'table', 'blockquote', 'figure', 'figcaption',
  'details', 'summary', 'dl', 'dt', 'dd', 'header', 'aside', 'main',
]);

const isHeading = (tag) => /^h[2-6]$/.test(tag);
const isNumber = (cell) => /^-?\d+([.,]\d+)?$/.test(cell.replace(/\s/g, ''));

function tidy(text) {
  return text
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((line) => line.trim().replace(/( \|)+$/, ''))
    .join('\n')
    .replace(/^(-|##)\n+(?=\S)(?!-|##)/gm, '$1 ') // marker left alone on its line by a nested block
    .replace(/^(-|##)$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------- web pages ---------- */

// Reads an HTML table into rows of single-line cell texts.
function tableRows(table) {
  const rows = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      if (child.type !== 'tag') continue;
      if (child.tagName === 'tr') {
        const cells = child.children.filter((c) => c.type === 'tag' && (c.tagName === 'td' || c.tagName === 'th'));
        const texts = cells.map((cell) => {
          const out = [];
          walk(cell, out, true);
          return out.join('').replace(/\s+/g, ' ').trim();
        });
        if (texts.some(Boolean)) rows.push({ texts, allTh: cells.every((c) => c.tagName === 'th') });
      } else if (child.tagName !== 'table') {
        visit(child);
      }
    }
  };
  visit(table);
  return rows;
}

function renderTable(table) {
  const rows = tableRows(table);
  if (!rows.length) return '';
  const header = rows[0].texts;
  // Tables without <th> are common here; three or more short label-like cells count as a header too.
  const headed =
    rows.length > 1 &&
    header.length > 1 &&
    (rows[0].allTh || header.length >= 3) &&
    header.slice(1).every(Boolean) &&
    header.every((cell) => cell.length <= 60 && !/\d{3,}|@/.test(cell));
  return rows
    .slice(headed ? 1 : 0)
    .map(({ texts }) =>
      headed && texts.length === header.length
        ? texts.map((cell, col) => (cell && header[col] ? `${header[col]}: ${cell}` : cell)).filter(Boolean).join('; ')
        : texts.join(' | '),
    )
    .join('\n');
}

// inCell keeps everything inside a table cell on one line.
function walk(node, out, inCell = false) {
  for (const child of node.childNodes || []) {
    if (child.type === 'text') {
      out.push(child.data.replace(/\s+/g, ' '));
      continue;
    }
    if (child.type !== 'tag') continue;
    const tag = child.tagName;
    if (inCell) {
      const breaks = ['br', 'li', 'tr', 'td', 'th'].includes(tag) || isHeading(tag) || BLOCK_TAGS.has(tag);
      if (breaks) out.push(' ');
      walk(child, out, true);
      if (breaks) out.push(' ');
    } else if (tag === 'table') {
      out.push('\n\n' + renderTable(child) + '\n\n');
    } else if (isHeading(tag)) {
      out.push('\n\n## '); walk(child, out); out.push('\n\n');
    } else if (tag === 'li') {
      out.push('\n- '); walk(child, out);
    } else if (tag === 'br') {
      out.push('\n');
    } else if (BLOCK_TAGS.has(tag)) {
      out.push('\n\n'); walk(child, out); out.push('\n\n');
    } else {
      walk(child, out);
    }
  }
}

// "07.04.2022" -> "2022-04-07"
function isoFromEstonianDate(text) {
  const m = text && text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

function parseHtml(html, url) {
  const $ = cheerio.load(html);
  const title =
    $('h1').first().text().replace(/\s+/g, ' ').trim() ||
    $('title').text().split('|')[0].trim();
  const canonical = $('link[rel=canonical]').attr('href') || url;
  const isNews = $('article[class*="node--type-news"], article[class*="node--type-blogi"]').length > 0;

  // News carry their publication date first; other pages only say when they were last updated.
  let date = ($('time[datetime]').first().attr('datetime') || '').slice(0, 10) || null;
  const root = $('main').first().length ? $('main').first() : $('body');
  const rootText = root.text();
  if (!date && isNews) date = isoFromEstonianDate(rootText);
  if (!date) date = isoFromEstonianDate((rootText.match(/uuendatud:?\s*\d{1,2}\.\d{1,2}\.\d{4}/i) || [])[0]);

  root.find(BOILERPLATE).remove();
  const out = [];
  walk(root.get(0), out);
  return { title, canonical, date, isNews, text: tidy(out.join('')) };
}

/* ---------- PDF ---------- */

// Removes page headers and footers: lines at the top or bottom edge that repeat on many pages.
function dropRunningHeaders(pages) {
  if (pages.length < 6) return;
  const EDGE = 2;
  const key = (line) => line.replace(/\d+/g, '#');
  const edgeLines = (lines) => lines.map((line, i) => (i < EDGE || i >= lines.length - EDGE ? key(line) : null));
  const counts = new Map();
  const perPage = pages.map((page) => page.text.split('\n').filter(Boolean));
  for (const lines of perPage) {
    for (const k of new Set(edgeLines(lines).filter(Boolean))) counts.set(k, (counts.get(k) || 0) + 1);
  }
  pages.forEach((page, n) => {
    const edges = edgeLines(perPage[n]);
    const repeated = new Set(perPage[n].filter((line, i) => edges[i] && counts.get(edges[i]) > pages.length * 0.2));
    if (repeated.size) page.text = tidy(page.text.split('\n').filter((line) => !repeated.has(line)).join('\n'));
  });
}

// Returns one text per page. Wide horizontal gaps become " | " so table columns stay apart.
async function parsePdf(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    let text = '';
    let lastY = null;
    let lastEnd = null;
    let lastHeight = 0;
    for (const item of content.items) {
      if (!('str' in item) || !item.str) continue;
      const x = item.transform[4];
      const y = item.transform[5];
      const height = item.height || Math.abs(item.transform[3]) || 10;
      if (lastY !== null) {
        // Measured against the taller neighbour, so a superscript (the 3 of m3) stays on its line.
        const lineHeight = Math.max(height, lastHeight);
        const drop = Math.abs(y - lastY);
        if (drop > lineHeight * 1.8) text += '\n\n';
        else if (drop > lineHeight * 0.5) text += '\n';
        else if (x - lastEnd > lineHeight * 1.5) text += ' | ';
        else if (x - lastEnd > lineHeight * 0.15) text += ' ';
      }
      text += item.str;
      lastY = y;
      lastEnd = x + item.width;
      lastHeight = height;
    }
    text = text.replace(/\b(m|km) ?([23])(?=[\s.,;:)]|$)/g, (whole, unit, power) => unit + (power === '2' ? '²' : '³'));
    pages.push({ number, text: tidy(text) });
    page.cleanup();
  }
  await task.destroy();
  dropRunningHeaders(pages);
  return pages;
}

/* ---------- Excel ---------- */

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') {
    // Cells hold full precision (52.0564...); round the way the published tables do.
    if (Number.isInteger(value)) return String(value);
    const rounded = Math.abs(value) >= 1 ? Math.round(value * 100) / 100 : Number(value.toPrecision(3));
    return String(rounded).replace('.', ',');
  }
  // Headers are often letter-spaced ("K o k k u") and hyphenated across lines ("Arengu-\nklass").
  return String(value)
    .replace(/-\r?\n/g, '')
    .split(/\s{2,}|\r?\n/)
    .map((part) => (/^(?:\p{L} ){2,}\p{L}$/u.test(part.trim()) ? part.replace(/ /g, '') : part))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Some sheets hold two tables side by side (all forest | managed forest) with identical headers.
// Returns the column where the second one starts, or 0 for an ordinary sheet.
function sideBySideColumn(rows) {
  const header = rows.find((row) => row.filter(Boolean).length >= 3);
  if (!header) return 0;
  const filled = header.map((cell, i) => (cell ? i : -1)).filter((i) => i >= 0);
  const half = filled.length / 2;
  if (!Number.isInteger(half)) return 0;
  const shift = filled[half] - filled[0];
  const mirrored = filled.slice(0, half).every((col, i) => filled[i + half] === col + shift && header[col] === header[col + shift]);
  return mirrored ? shift : 0;
}

// Fallback for a table whose header cannot be made out: cells joined with " | ".
function plainTable(table) {
  const width = Math.max(...table.map((cells) => cells.length));
  const used = Array.from({ length: width }, (unused, col) => table.some((cells) => cells[col]));
  return table.map((cells) => {
    const filled = cells.filter(Boolean);
    return filled.length === 1 ? filled[0] : cells.filter((cell, col) => used[col]).join(' | ');
  });
}

// Writes each data row as "label: value; ..." using the header rows above the first number.
// `first` marks the sheet's opening table, whose title is already the sheet's title.
function describeTable(table, first) {
  const filledCount = (cells) => cells.filter(Boolean).length;
  let row = 0;
  const titles = [];
  while (row < table.length && filledCount(table[row]) === 1) titles.push(table[row++].find(Boolean));
  const headerStart = row;
  while (row < table.length && filledCount(table[row]) > 1 && !table[row].some(isNumber)) row++;
  const headers = table.slice(headerStart, row);
  const body = table.slice(row);
  if (!headers.length || !body.some((cells) => cells.some(isNumber))) return plainTable(table);

  const width = Math.max(...table.map((cells) => cells.length));
  const levels = headers.map((cells, level) => {
    // Upper header rows use merged cells: a label also covers the empty cells to its right.
    let last = '';
    const spread = Array.from({ length: width }, (unused, col) => {
      if (cells[col]) last = cells[col];
      return level < headers.length - 1 ? last : cells[col] || '';
    });
    // A label spanning most of the table ("Enamuspuuliik") says nothing about a single column.
    const counts = new Map();
    for (const label of spread) counts.set(label, (counts.get(label) || 0) + 1);
    return spread.map((label) => (width > 4 && counts.get(label) > width / 2 ? '' : label));
  });
  const labels = Array.from({ length: width }, (unused, col) =>
    [...new Set(levels.map((level) => level[col]).filter(Boolean))].join(' '),
  );

  const firstNumber = Math.min(...body.map((cells) => cells.findIndex(isNumber)).filter((col) => col >= 0));
  const carried = [];
  const prefix = titles.length && !first ? `${titles.join(' / ')} – ` : '';
  const lines = first ? [...titles] : [];
  for (const cells of body) {
    if (!cells.some(isNumber)) {
      lines.push(cells.filter(Boolean).join(' | '));
      continue;
    }
    // Row names are often written once for a group of rows: "Metsamaa | Lage ala",
    // then only "| Küps mets". The missing outer name is carried down.
    const ownName = cells.slice(0, firstNumber).findIndex(Boolean);
    const pairs = [];
    for (let col = 0; col < width; col++) {
      let cell = cells[col] || '';
      if (col < firstNumber) {
        if (ownName >= 0 && col < ownName) cell = carried[col] || '';
        else carried[col] = cell;
      }
      if (cell) pairs.push(labels[col] ? `${labels[col]}: ${cell}` : cell);
    }
    lines.push(prefix + pairs.join('; '));
  }
  return lines;
}

// Rows separated by empty rows form tables.
function tablesText(rows) {
  const tables = [[]];
  for (const row of rows) {
    const cells = [...row];
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.length) tables[tables.length - 1].push(cells);
    else if (tables[tables.length - 1].length) tables.push([]);
  }
  return tables
    .filter((table) => table.length)
    .map((table, n) => describeTable(table, n === 0).join('\n'))
    .join('\n\n');
}

// Returns one text per sheet, or two for a sheet with tables side by side.
async function parseXlsx(file) {
  const { default: readExcelFile } = await import('read-excel-file/node');
  const sheets = await readExcelFile(file);
  return sheets.flatMap(({ sheet, data }) => {
    const rows = data.map((row) => row.map(formatCell));
    const split = sideBySideColumn(rows);
    const parts = split ? [rows.map((row) => row.slice(0, split)), rows.map((row) => row.slice(split))] : [rows];
    return parts.map((part) => ({ name: sheet, text: tidy(tablesText(part)) }));
  });
}

/* ---------- CSV ---------- */

// Returns the file as one text: every data row written out with the header row's column names.
function parseCsv(file) {
  const bytes = fs.readFileSync(file);
  let text = bytes.toString('utf8');
  if (text.includes('�')) text = new TextDecoder('windows-1257').decode(bytes); // not UTF-8 after all
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const firstLine = text.slice(0, text.indexOf('\n'));
  const delimiter = [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter || ch === '\n') {
      row.push(cell.trim());
      cell = '';
      if (ch === '\n') { rows.push(row); row = []; }
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell || row.length) rows.push([...row, cell.trim()]);

  const [header, ...body] = rows.filter((cells) => cells.some(Boolean));
  const lines = body.map((cells) =>
    cells.map((value, col) => (value && header[col] ? `${header[col]}: ${value}` : value)).filter(Boolean).join('; '),
  );
  return tidy(lines.join('\n'));
}

module.exports = { parseHtml, parsePdf, parseXlsx, parseCsv };
