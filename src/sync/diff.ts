/**
 * Line diff for the conflict view (Myers' O(ND) algorithm, written from the
 * paper: E. Myers, "An O(ND) Difference Algorithm and Its Variations", 1986).
 * Pure, no Obsidian imports.
 */

export type DiffOp =
  /** line present in both: a = line number in A (1-based), b = in B */
  | { t: "eq"; a: number; b: number; text: string }
  /** only in A */
  | { t: "del"; a: number; text: string }
  /** only in B */
  | { t: "add"; b: number; text: string };

export function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.replace(/\r\n?/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop(); // trailing newline isn't a line
  return lines;
}

/** Edit script between two line arrays. Falls back to "replace everything" if the files differ in more than `maxD` lines. */
export function diffLines(a: string[], b: string[], maxD = 4000): DiffOp[] {
  // Common prefix/suffix are cheap to strip and make typical note edits fast.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);

  type Mid = Array<{ t: "eq" | "del" | "add"; text: string }>;
  const mid: Mid = myers(A, B, maxD) ?? [...A.map((text) => ({ t: "del" as const, text })), ...B.map((text) => ({ t: "add" as const, text }))];

  const out: DiffOp[] = [];
  let ia = 1;
  let ib = 1;
  for (let i = 0; i < pre; i++) out.push({ t: "eq", a: ia++, b: ib++, text: a[i] });
  for (const m of mid) {
    if (m.t === "eq") out.push({ t: "eq", a: ia++, b: ib++, text: m.text });
    else if (m.t === "del") out.push({ t: "del", a: ia++, text: m.text });
    else out.push({ t: "add", b: ib++, text: m.text });
  }
  for (let i = a.length - suf; i < a.length; i++) out.push({ t: "eq", a: ia++, b: ib++, text: a[i] });
  return out;
}

function myers(A: string[], B: string[], maxD: number): Array<{ t: "eq" | "del" | "add"; text: string }> | null {
  const N = A.length;
  const M = B.length;
  if (N === 0 && M === 0) return [];
  const max = N + M;
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  const limit = Math.min(max, maxD);

  for (let d = 0; d <= limit; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= N && y >= M) return backtrack(A, B, trace, off);
    }
  }
  return null;
}

function backtrack(A: string[], B: string[], trace: Int32Array[], off: number) {
  const ops: Array<{ t: "eq" | "del" | "add"; text: string }> = [];
  let x = A.length;
  let y = B.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ t: "eq", text: A[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: "add", text: B[y - 1] });
      else ops.push({ t: "del", text: A[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

export interface Hunk {
  aStart: number;
  aLen: number;
  bStart: number;
  bLen: number;
  ops: DiffOp[];
}

/** Group an edit script into unified-diff hunks with `context` unchanged lines around each change. */
export function toHunks(ops: DiffOp[], context = 3): Hunk[] {
  const changed = ops.map((o, i) => (o.t === "eq" ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const i of changed) {
    const s = Math.max(0, i - context);
    const e = Math.min(ops.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }
  return ranges.map(([s, e]) => {
    const slice = ops.slice(s, e + 1);
    const aLines = slice.filter((o) => o.t !== "add") as Array<{ a: number }>;
    const bLines = slice.filter((o) => o.t !== "del") as Array<{ b: number }>;
    // Position of an empty side = the line before where it would be inserted.
    const before = ops.slice(0, s);
    const aBefore = before.filter((o) => o.t !== "add").length;
    const bBefore = before.filter((o) => o.t !== "del").length;
    return {
      aStart: aLines.length ? aLines[0].a : aBefore,
      aLen: aLines.length,
      bStart: bLines.length ? bLines[0].b : bBefore,
      bLen: bLines.length,
      ops: slice,
    };
  });
}

/** Render hunks as classic unified-diff text (used for the log/clipboard and tests). */
export function unifiedText(hunks: Hunk[], aName: string, bName: string): string {
  const out = [`--- ${aName}`, `+++ ${bName}`];
  for (const h of hunks) {
    out.push(`@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@`);
    for (const o of h.ops) out.push(`${o.t === "eq" ? " " : o.t === "del" ? "-" : "+"}${o.text}`);
  }
  return out.join("\n");
}

/** Pairs deletions with additions for a side-by-side view. */
export interface SideRow {
  left?: { n: number; text: string; changed: boolean };
  right?: { n: number; text: string; changed: boolean };
}

export function sideBySide(ops: DiffOp[]): SideRow[] {
  const rows: SideRow[] = [];
  let dels: Array<{ n: number; text: string }> = [];
  let adds: Array<{ n: number; text: string }> = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({
        left: dels[i] ? { ...dels[i], changed: true } : undefined,
        right: adds[i] ? { ...adds[i], changed: true } : undefined,
      });
    }
    dels = [];
    adds = [];
  };
  for (const o of ops) {
    if (o.t === "del") dels.push({ n: o.a, text: o.text });
    else if (o.t === "add") adds.push({ n: o.b, text: o.text });
    else {
      flush();
      rows.push({ left: { n: o.a, text: o.text, changed: false }, right: { n: o.b, text: o.text, changed: false } });
    }
  }
  flush();
  return rows;
}

const TEXT_EXT = new Set(["md", "markdown", "txt", "canvas", "json", "css", "js", "ts", "csv", "tsv", "html", "htm", "xml", "svg", "yml", "yaml", "toml", "ini", "base", "excalidraw", "tex", "bib", "org", "log"]);

/** Decode a file for diffing, or null if it looks binary. */
export function decodeText(path: string, data: ArrayBuffer): string | null {
  const ext = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  const bytes = new Uint8Array(data);
  if (!TEXT_EXT.has(ext) && bytes.includes(0)) return null;
  try {
    const s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return s.includes("\u0000") ? null : s.replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** Short explanation when the "conflict" is only cosmetic. */
export function cosmeticDifference(a: string, b: string): string | null {
  if (a === b) return "The contents are identical.";
  if (a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n")) return "The versions differ only in line endings (Windows vs iPhone/Mac).";
  if (a.replace(/\s+$/gm, "").trimEnd() === b.replace(/\s+$/gm, "").trimEnd()) return "The versions differ only in trailing spaces or blank lines at the end.";
  return null;
}
