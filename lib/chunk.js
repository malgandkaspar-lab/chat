// Splits extracted text into passages small enough to embed and to quote to the model.
// Kept short on purpose: the chat model reads only ~64 tokens/s on this machine,
// and Estonian text costs about one token per 2.25 characters.
const TARGET = 800; // characters a passage aims for
const MAX = 1200; // a single block longer than this gets split
const MIN_FLUSH = 200; // a passage shorter than this is not closed yet

// Splits one oversized block by lines (tables, lists) or by sentences (prose).
// A table's heading rows are repeated so every piece still names its columns.
function splitLong(block) {
  const lines = block.split('\n');
  const byLines = lines.length > 1;
  const units = byLines ? lines : block.split(/(?<=[.!?])\s+/);
  const joiner = byLines ? '\n' : ' ';

  // A table's header is everything above its first row that holds a number in a cell.
  let header = [];
  if (byLines && lines.slice(0, 3).some((line) => line.includes(' | '))) {
    const firstData = lines.findIndex((line) => /(^|\| )-?\d+(,\d+)?( \||$)/.test(line));
    const candidate = lines.slice(0, firstData);
    if (firstData > 0 && firstData <= 5 && candidate.join('\n').length <= 400) header = candidate;
  }
  const headerSize = header.join(joiner).length;

  const pieces = [];
  let current = [];
  let size = 0;
  for (const unit of units.slice(header.length)) {
    if (current.length && size + unit.length > TARGET) {
      pieces.push([...header, ...current].join(joiner));
      current = [];
      size = headerSize;
    }
    for (let i = 0; i < unit.length; i += MAX) current.push(unit.slice(i, i + MAX));
    size += unit.length + 1;
  }
  if (current.length) pieces.push([...header, ...current].join(joiner));
  return pieces;
}

function chunkText(text) {
  const blocks = text.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const chunks = [];
  let heading = ''; // latest "## ..." line, carried into passages that start mid-section
  let current = [];
  let size = 0;
  let bodyCount = 0;

  const flush = () => {
    if (bodyCount) chunks.push(current.join('\n\n'));
    current = [];
    size = 0;
    bodyCount = 0;
  };
  const add = (piece, isHeading) => {
    // A short opening (a table's title, a one-line intro) stays with what follows it.
    if (bodyCount && size >= MIN_FLUSH && size + piece.length > TARGET) flush();
    if (!current.length && heading && !isHeading) {
      current.push(heading);
      size += heading.length;
    }
    current.push(piece);
    size += piece.length;
    if (!isHeading) bodyCount++;
  };

  for (const block of blocks) {
    if (block.startsWith('## ')) {
      if (size > TARGET / 2) flush();
      if (!bodyCount) { current = []; size = 0; } // drop a heading that had no text under it
      heading = block;
      add(block, true);
      continue;
    }
    for (const piece of block.length > MAX ? splitLong(block) : [block]) add(piece, false);
  }
  flush();

  // A short tail ("Viimati uuendatud ...") reads better attached to the passage before it.
  if (chunks.length > 1 && chunks[chunks.length - 1].length < 200) {
    const tail = chunks.pop();
    chunks[chunks.length - 1] += '\n\n' + tail;
  }
  return chunks;
}

module.exports = { chunkText };
