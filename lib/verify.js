// Checks an answer against the sources it cites: every number in it (amounts, years,
// dates) must really stand in a cited source. A model can attach the right-looking year
// to a figure from another year's article; this catches that before the answer is shown.

// "16 870", "2 360,2": digit groups of three separated by a space of any kind.
const GROUPED = /(?<!\d)\d{1,3}(?:[^\S\n]\d{3})+(?:[.,]\d+)?(?!\d)/g;
const PLAIN = /\d+(?:[.,]\d+)?/g;
const CITATION = /[\[【](\d+(?:\s*,\s*\d+)*)[\]】]/g;
const TABLE_ROW = /^\s*\|.*\|\s*$/; // a line of a Markdown table

// "2 360,20" and "2360.2" are the same number.
const canon = (token) => String(Number(token.replace(/\s/g, '').replace(',', '.')));

// The numbers written in a text, in canonical form, mapped to how they were written.
function numbersIn(text) {
  const found = new Map();
  const rest = text.replace(GROUPED, (match) => {
    found.set(canon(match), match);
    return ' ';
  });
  for (const match of rest.match(PLAIN) || []) found.set(canon(match), match);
  return found;
}

// Everything a source can vouch for: its text, title, label and its date in both spellings.
function sourceNumbers(passage) {
  const [year, month, day] = (passage.date || '').split('-');
  const dates = passage.date ? `${passage.date} ${day}.${month}.${year} ${Number(day)}. ${Number(month)}.` : '';
  const corpus = [passage.title, passage.label, passage.text, dates].filter(Boolean).join('\n');
  // Grouped and plain readings both count: "2025 163" may be two numbers or one.
  return new Set([...numbersIn(corpus).keys(), ...(corpus.match(PLAIN) || []).map(canon)]);
}

// Returns the numbers that no cited source contains, as [{ number, cited }]. Empty means fine.
function ungroundedNumbers(answer, passages) {
  const known = new Map(passages.map((passage) => [passage.n, sourceNumbers(passage)]));
  const citedIn = (text) =>
    [...text.matchAll(CITATION)].flatMap((match) => match[1].split(',').map(Number)).filter((n) => known.has(n));
  const everywhere = citedIn(answer);

  const problems = [];
  // One sentence, list item or table row at a time: a figure is checked against the sources
  // cited next to it.
  for (const segment of answer.split(/\n+|(?<=[.!?])\s+(?=[\p{Lu}\d*•-])/u)) {
    let cited = citedIn(segment);
    if (!cited.length) cited = everywhere.length ? everywhere : [...known.keys()];
    // Drop citations and list numbering ("2. Saada ..."). A year opening a sentence
    // ("2026. aastal ...") is not numbering and stays. A season written short ("2023/24")
    // counts by its first year, since the source may spell it out ("2023/2024").
    const text = segment
      .replace(CITATION, ' ')
      .replace(/^\s*\d{1,2}[.)]\s+(?=[\p{Lu}*])/u, ' ')
      .replace(/\b((?:19|20)\d{2})\/\d{2}\b(?!\/)/g, '$1');
    const numbers = [...numbersIn(text)];
    if (TABLE_ROW.test(segment)) {
      // A table row pairs a year or a name with its figures, so one and the same source
      // must hold all of them. "2024 | 163" built from two articles is how a figure ends
      // up under the wrong year.
      if (!cited.some((n) => numbers.every(([number]) => known.get(n).has(number)))) {
        problems.push(...numbers.map(([, written]) => ({ number: written, cited })));
      }
      continue;
    }
    for (const [number, written] of numbers) {
      if (!cited.some((n) => known.get(n).has(number))) problems.push({ number: written, cited });
    }
  }
  return problems;
}

// An answer without its tables: what is left when a table fails the check above. Given a
// row count, only the tables with fewer rows than that are taken out.
function withoutTables(answer, smallerThan = Infinity) {
  const kept = [];
  let table = [];
  const close = () => {
    if (table.length - 2 >= smallerThan) kept.push(...table); // less the header and the |---| line
    table = [];
  };
  for (const line of answer.split('\n')) {
    if (TABLE_ROW.test(line)) {
      table.push(line);
    } else {
      close();
      kept.push(line);
    }
  }
  close();
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const MONTHS = 'jaanuar|veebruar|märts|aprill|mai|juuni|juuli|august|septemb|oktoob|novemb|detsemb';

// The figures an answer states in its text, in order, as [{ value, written }]: its numbers
// apart from years, dates, seasons and citations. Tables are left out: they list many
// figures, and two answers are compared by the one each of them leads with.
function figures(answer) {
  const text = withoutTables(answer)
    .replace(CITATION, ' ')
    .replace(/\b\d{4}[-‑]\d{2}[-‑]\d{2}\b|\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, ' ') // 2026-01-19, 19.01.2026
    .replace(new RegExp(`\\b\\d{1,2}\\.?\\s*(?:${MONTHS})\\p{L}*`, 'giu'), ' ') // 19. jaanuaril
    .replace(/\b(?:19|20)\d{2}\s*[/–-]\s*(?:19|20)\d{2}\b/g, ' ') // seasons such as 2025/2026
    .replace(/^\s*\d{1,2}[.)]\s+(?=[\p{Lu}*])/gmu, ' '); // list numbering
  return [...numbersIn(text)]
    .map(([value, written]) => ({ value, written }))
    .filter(({ value }) => !(/^\d{4}$/.test(value) && Number(value) >= 1900 && Number(value) <= 2100));
}

// Two answers to the same question agree when each one's leading figure also appears in
// the other. "163" and "163 (eelmine maht 130)" agree; "33" and "163 (lisandus 33)" do not.
function sameFigures(first, second) {
  const a = figures(first);
  const b = figures(second);
  if (!a.length || !b.length) return a.length === b.length;
  return b.some((f) => f.value === a[0].value) && a.some((f) => f.value === b[0].value);
}

module.exports = { ungroundedNumbers, withoutTables, figures, sameFigures };
