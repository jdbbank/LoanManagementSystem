/**
 * Minimal Markdown reader for `USER-MANUAL-TH.md`, written by hand instead of adding a parser
 * dependency. It supports exactly the syntax the manual uses: headings, paragraphs, blockquotes,
 * rules, fenced code, ordered/unordered lists one level deep, task items, GFM tables with
 * alignment, and inline code / bold / italic / links. Unknown markup is rendered as plain text
 * rather than dropped, so an edit to the manual can never silently lose a sentence.
 */

export type Align = 'left' | 'center' | 'right';

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; parts: Inline[] }
  | { kind: 'em'; parts: Inline[] }
  | { kind: 'link'; parts: Inline[]; href: string };

export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  items: ListItem[];
}

export interface ListItem {
  parts: Inline[];
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { kind: 'heading'; level: number; id: string; parts: Inline[]; plain: string }
  | { kind: 'paragraph'; parts: Inline[] }
  | { kind: 'quote'; parts: Inline[] }
  | { kind: 'rule' }
  | { kind: 'code'; text: string }
  | ListBlock
  | { kind: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

/** One `##` chapter of the manual — the unit the sidebar lists and the search filters. */
export interface Section {
  id: string;
  /** Leading "11." of the heading, used to anchor a diagram to a chapter without matching on text. */
  number: string;
  title: string;
  blocks: Block[];
}

export interface ManualDoc {
  /** Everything before the first `##` — the document title and its preamble. */
  front: Block[];
  sections: Section[];
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^\s*```/;
const QUOTE = /^>\s?(.*)$/;
const LIST_ITEM = /^(\s*)(?:([-*+])|(\d+[.)]))\s+(.*)$/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEP = /^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;

/**
 * GitHub's anchor rule: lowercase, punctuation gone, spaces to hyphens — the manual's TOC links are
 * written against it. Thai/Lao vowel and tone marks are `\p{M}`, not `\p{L}`, so they must stay in
 * the allowed set or every Thai anchor loses its marks and no TOC link resolves.
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} \-_]/gu, '')
    .replace(/ /g, '-');
}

export function inlineText(parts: Inline[]): string {
  return parts
    .map((p) => (p.kind === 'text' || p.kind === 'code' ? p.text : inlineText(p.parts)))
    .join('');
}

/** The text a block renders to — what the manual's chapter search matches against. */
export function blockText(block: Block): string {
  switch (block.kind) {
    case 'heading':
      return block.plain;
    case 'paragraph':
    case 'quote':
      return inlineText(block.parts);
    case 'code':
      return block.text;
    case 'rule':
      return '';
    case 'list':
      return block.items.map((item) => [inlineText(item.parts), ...item.children.map(blockText)].join(' ')).join(' ');
    case 'table':
      return [...block.head, ...block.rows.flat()].map(inlineText).join(' ');
  }
}

const WORD_START = /[\p{L}\p{N}]/u;

/**
 * `*` is overloaded in this manual: `*"note"*` is emphasis while `` `Field`* `` is a
 * required-field marker, so an opener only counts when the character before it opens a segment.
 */
function emOpenerAllowed(src: string, i: number): boolean {
  const before = i === 0 ? '' : src[i - 1];
  if (!before || before === ' ') return true;
  return !WORD_START.test(before) && before !== '*' && before !== '`';
}

function emCloserAllowed(src: string, j: number): boolean {
  const after = j === src.length - 1 ? '' : src[j + 1];
  return !after || /[\s)]/.test(after);
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  let i = 0;

  const flush = () => {
    if (text) {
      out.push({ kind: 'text', text });
      text = '';
    }
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ kind: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (ch === '*' && src[i + 1] === '*') {
      const end = src.indexOf('**', i + 2);
      if (end > i) {
        flush();
        out.push({ kind: 'strong', parts: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (ch === '*' && emOpenerAllowed(src, i)) {
      let end = -1;
      for (let j = i + 1; j < src.length; j += 1) {
        if (src[j] === '*' && emCloserAllowed(src, j)) {
          end = j;
          break;
        }
      }
      if (end > i) {
        flush();
        out.push({ kind: 'em', parts: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    if (ch === '[') {
      const close = src.indexOf('](', i);
      if (close > i) {
        const hrefEnd = src.indexOf(')', close + 2);
        if (hrefEnd > close) {
          flush();
          out.push({
            kind: 'link',
            href: src.slice(close + 2, hrefEnd),
            parts: parseInline(src.slice(i + 1, close)),
          });
          i = hrefEnd + 1;
          continue;
        }
      }
    }

    text += ch;
    i += 1;
  }

  flush();
  return out;
}

const splitCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

const alignOf = (spec: string): Align => {
  const left = spec.startsWith(':');
  const right = spec.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
};

function parseTable(lines: string[], start: number): { block: Block; next: number } {
  const align = splitCells(lines[start + 1]).map(alignOf);
  const head = splitCells(lines[start]).map((cell) => parseInline(cell));
  const rows: Inline[][][] = [];
  let i = start + 2;
  while (i < lines.length && TABLE_ROW.test(lines[i]) && !TABLE_SEP.test(lines[i])) {
    rows.push(splitCells(lines[i]).map((cell) => parseInline(cell)));
    i += 1;
  }
  return { block: { kind: 'table', align, head, rows }, next: i };
}

interface RawItem {
  indent: number;
  ordered: boolean;
  body: string;
}

function toListItem(raw: RawItem, children: Block[]): ListItem {
  const check = /^\[([ xX])\]\s+(.*)$/.exec(raw.body);
  return {
    checked: check ? check[1].toLowerCase() === 'x' : null,
    parts: parseInline(check ? check[2] : raw.body),
    children,
  };
}

/**
 * List items are collected flat, then nested by indent. The manual only goes one level deep, so a
 * deeper item is attached to the last shallower one instead of recursing further.
 */
function parseList(lines: string[], start: number): { block: ListBlock; next: number } {
  const baseIndent = LIST_ITEM.exec(lines[start])![1].length;
  const raw: RawItem[] = [];
  let i = start;

  while (i < lines.length) {
    const item = LIST_ITEM.exec(lines[i]);
    if (item) {
      raw.push({ indent: item[1].length, ordered: Boolean(item[3]), body: item[4] });
      i += 1;
      continue;
    }
    // An indented, marker-less line continues the previous item (the manual wraps long bullets).
    if (raw.length && /^\s{2,}\S/.test(lines[i])) {
      raw[raw.length - 1].body += ` ${lines[i].trim()}`;
      i += 1;
      continue;
    }
    break;
  }

  const top: RawItem[] = [];
  const childrenOf = new Map<RawItem, RawItem[]>();
  let lastTop: RawItem | null = null;
  for (const item of raw) {
    if (item.indent <= baseIndent) {
      lastTop = item;
      top.push(item);
      continue;
    }
    if (lastTop) childrenOf.set(lastTop, [...(childrenOf.get(lastTop) ?? []), item]);
  }

  return {
    block: {
      kind: 'list',
      ordered: raw[0].ordered,
      items: top.map((item) => {
        const nested = childrenOf.get(item);
        return toListItem(item, nested ? [parseNestedList(nested)] : []);
      }),
    },
    next: i,
  };
}

/** Nested items already have their indent resolved, so they are grouped by their own first indent. */
function parseNestedList(items: RawItem[]): ListBlock {
  const base = Math.min(...items.map((item) => item.indent));
  const top = items.filter((item) => item.indent === base);
  return {
    kind: 'list',
    ordered: top[0].ordered,
    items: top.map((item) => toListItem(item, [])),
  };
}

function isBlockStart(line: string): boolean {
  return (
    !line.trim() ||
    HEADING.test(line) ||
    RULE.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    TABLE_ROW.test(line)
  );
}

export function parseMarkdown(src: string): ManualDoc {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  const usedIds = new Map<string, number>();

  const uniqueId = (base: string): string => {
    const seen = usedIds.get(base) ?? 0;
    usedIds.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const parts = parseInline(heading[2].trim());
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        id: uniqueId(slugify(heading[2])),
        parts,
        plain: inlineText(parts),
      });
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const parts: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        parts.push(QUOTE.exec(lines[i])![1]);
        i += 1;
      }
      blocks.push({ kind: 'quote', parts: parseInline(parts.join(' ')) });
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const parsed = parseTable(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlockStart(lines[i])) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: 'paragraph', parts: parseInline(paragraph.join(' ')) });
  }

  const front: Block[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const block of blocks) {
    if (block.kind === 'heading' && block.level === 2) {
      const number = /^(\d+)\./.exec(block.plain)?.[1] ?? '';
      current = { id: block.id, number, title: block.plain.replace(/^\d+\.\s*/, ''), blocks: [block] };
      sections.push(current);
      continue;
    }
    if (current) current.blocks.push(block);
    else front.push(block);
  }

  return { front, sections };
}
