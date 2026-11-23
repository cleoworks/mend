// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------- Section 3: file lines ---------- */

interface FileLines {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

/* ---------- Section 5: matching lines at three tiers ---------- */

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function normAt(tier: number, s: string): string {
  return tier === 0 ? s : tier === 1 ? trimTrail(s) : trimBoth(s);
}

/** All start positions where O occurs in `lines` at one tier (occurrences may overlap). */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const no = o.map((s) => normAt(tier, s));
  const nl = lines.map((s) => normAt(tier, s));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (nl[i + j] !== no[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const at = occurrencesAt(lines, o, t);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

interface NLine {
  text: string;
  ctx: boolean;
  oi: number; // for a context line, its index within O
}

/**
 * Replace lines[pos .. pos+O.length) with N. Context lines are written as the file's own matched
 * lines; at tier 2 the other lines of N are re-indented (section 5).
 */
function spliceMatch(lines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const written: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(lines[pos]!);
    p = leadWs(o[0]!);
  }
  for (const nl of n) {
    if (nl.ctx) {
      written.push(lines[pos + nl.oi]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      written.push(t);
    }
  }
  return [...lines.slice(0, pos), ...written, ...lines.slice(pos + o.length)];
}

/** Build O and N from a hunk/chunk body (context, `-` and `+` lines in body order). */
function bodyON(body: { kind: string; text: string }[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: true, oi: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ text: b.text, ctx: false, oi: -1 });
  }
  return { o, n };
}

/* ---------- Section 6: unified diffs ---------- */

interface Hunk {
  a: number;
  body: { kind: string; text: string; slash: boolean; srcEmpty: boolean }[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function sectionPath(raw: string): string {
  let s = raw;
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return s;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let header = false;
  let hasPair = false;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let renOld: string | null = null;
  let renNew: string | null = null;
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let newMode = false;
  let delMode = false;

  const begin = (o: string | null, n: string | null): void => {
    cur = { oldPath: null, newPath: null, create: false, del: false, hunks: [] };
    sections.push(cur);
    header = true;
    hasPair = false;
    diffOld = o;
    diffNew = n;
    renOld = null;
    renNew = null;
    pairOld = null;
    pairNew = null;
    newMode = false;
    delMode = false;
  };
  const finishHeader = (): void => {
    if (cur === null) return;
    cur.oldPath = pairOld ?? renOld ?? diffOld;
    cur.newPath = pairNew ?? renNew ?? diffNew;
    cur.create = newMode || cur.oldPath === '/dev/null';
    cur.del = delMode || cur.newPath === '/dev/null';
    header = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null && header) finishHeader();
      begin(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // A ---/+++ pair: part of the current section's header, or the start of a new section.
      if (cur === null || !header || hasPair) {
        if (cur !== null && header) finishHeader();
        begin(null, null);
      }
      pairOld = sectionPath(line.slice(4));
      pairNew = sectionPath(lines[i + 1]!.slice(4));
      hasPair = true;
      i += 2;
      continue;
    }
    if (cur !== null && header && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (header) finishHeader();
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          hunk.body.push({ kind: bl === '' ? ' ' : bl[0]!, text: bl === '' ? '' : bl.slice(1), slash: false, srcEmpty: bl === '' });
          i += 1;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.srcEmpty) hunk.body.pop();
      // A `\` line refers to the body line before it.
      const cleaned: { kind: string; text: string; slash: boolean; srcEmpty: boolean }[] = [];
      for (const b of hunk.body) {
        if (b.kind === '\\') {
          if (cleaned.length > 0) cleaned[cleaned.length - 1]!.slash = true;
        } else cleaned.push(b);
      }
      hunk.body = cleaned;
      cur.hunks.push(hunk);
      continue;
    }
    if (cur !== null && header) {
      if (line.startsWith('rename from ')) renOld = line.slice(12).trim();
      else if (line.startsWith('rename to ')) renNew = line.slice(10).trim();
      else if (line.startsWith('new file mode')) newMode = true;
      else if (line.startsWith('deleted file mode')) delMode = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (cur !== null && header) finishHeader();
  return sections;
}

/** Apply one section's hunks to a file's lines; returns the new FileLines or throws Fail. */
function applyHunks(f: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let lines = [...f.lines];
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = bodyON(h.body);
    const lastNp = [...h.body].reverse().find((b) => b.kind === ' ' || b.kind === '+');
    const slashAfter = lastNp !== undefined && lastNp.slash;
    if (o.length === 0) {
      const pos = Math.min(h.a + d, lines.length);
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...n.map((x) => x.text), ...lines.slice(pos)];
      if (atEnd && h.body.length > 0) final = !slashAfter;
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const runsToEnd = best + o.length === lines.length;
    lines = spliceMatch(lines, best, o, n, found.tier);
    if (runsToEnd) final = !slashAfter;
    d += n.length - o.length;
  }
  return { br: f.br, lines, final };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const edit: Edit = (tree) => {
      const oldP = sec.oldPath;
      const newP = sec.newPath;
      if (sec.create) {
        const p = newP ?? oldP;
        if (p === null) throw new Fail('missing', '');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: string[] = [];
        let lastSlash = false;
        for (const h of sec.hunks) {
          for (const b of h.body) {
            if (b.kind === '+') {
              plus.push(b.text);
              lastSlash = b.slash;
            }
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastSlash ? '' : '\n'));
        return;
      }
      if (sec.del) {
        const p = oldP ?? newP;
        if (p === null) throw new Fail('missing', '');
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const out = applyHunks(splitFile(before), sec.hunks, strict, oldP);
        tree.now.set(newP, joinFile(out));
        tree.now.set(oldP, null);
        tree.moves.push([oldP, newP]);
        return;
      }
      const p = oldP ?? newP;
      if (p === null) throw new Fail('missing', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const out = applyHunks(splitFile(before), sec.hunks, strict, p);
      tree.now.set(p, joinFile(out));
    };
    return edit;
  });
}

/* ---------- Section 7: SEARCH/REPLACE blocks ---------- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // index of the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const found = findTier(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const n: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oi: -1 }));
      const out = spliceMatch(f.lines, found.at[0]!, oldLines, n, found.tier);
      tree.now.set(p, joinFile({ br: f.br, lines: out, final: f.final }));
    });
    prevPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------- Section 8: V4A patches ---------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: string; text: string }[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const isHeader = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (!isHeader(line)) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i + 1;
    const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'del' : 'upd';
    const p = line.slice(line.indexOf(': ') + 2).trim();
    i += 1;
    // Collect this section's raw lines (up to the next section or End Patch), dropping trailing blanks.
    const raw: { text: string; no: number }[] = [];
    while (i < last && !isHeader(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();

    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }
    if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    // Update File.
    let moveTo: string | null = null;
    let start = 0;
    if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
      start = 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    for (let k = start; k < raw.length; k += 1) {
      const r = raw[k]!;
      const l = r.text;
      if (l === '*** End of File') {
        // Ends the current chunk (section 8). With no chunk in progress it starts none: a chunk
        // starts only at an `@@` line or, for the first chunk, at a body line, so an Update
        // section holding only this line still has no chunk (and, without Move to, is a parse
        // error at its Update File line).
        if (cur !== null) cur.eof = true;
        cur = null;
        continue;
      }
      if (l.startsWith('@@')) {
        cur = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
        chunks.push(cur);
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        if (cur === null) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
        }
        cur.body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${r.no}`);
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
    const mv = moveTo;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
      const f = splitFile(before);
      let flines = [...f.lines];
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          let hit = -1;
          const max = strict ? 0 : 2;
          for (let t = 0; t <= max && hit < 0; t += 1) {
            for (let j = cursor; j < flines.length; j += 1) {
              if (normAt(t, flines[j]!) === normAt(t, ch.anchor)) {
                hit = j;
                break;
              }
            }
          }
          if (hit < 0) throw new Fail('no-match', p);
          cursor = hit + 1;
        }
        const { o, n } = bodyON(ch.body);
        if (o.length === 0) {
          const pos = ch.eof ? flines.length : Math.min(cursor, flines.length);
          flines = [...flines.slice(0, pos), ...n.map((x) => x.text), ...flines.slice(pos)];
          cursor = pos + n.length;
          continue;
        }
        let pos = -1;
        let tierUsed = 0;
        const maxT = strict ? 0 : 2;
        for (let t = 0; t <= maxT; t += 1) {
          let cand = occurrencesAt(flines, o, t).filter((x) => x >= cursor);
          if (ch.eof) cand = cand.filter((x) => x + o.length === flines.length);
          if (cand.length > 0) {
            pos = cand[0]!;
            tierUsed = t;
            break;
          }
        }
        if (pos < 0) throw new Fail('no-match', p);
        flines = spliceMatch(flines, pos, o, n, tierUsed);
        cursor = pos + n.length;
      }
      const outText = joinFile({ br: f.br, lines: flines, final: f.final });
      if (mv !== null) {
        tree.now.set(mv, outText);
        tree.now.set(p, null);
        tree.moves.push([p, mv]);
      } else {
        tree.now.set(p, outText);
      }
    });
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Move pairs (section 2): an R line replaces the pair's D and A lines and sorts by the new path.
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  const rowList: { key: string; line: string }[] = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.get(n) !== undefined) {
      movedOld.add(o);
      movedNew.add(n);
      rowList.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  for (const p of tree.now.keys()) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowList.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rowList.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = rowList.map((r) => r.line);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
