/* ============================================================================
   Prince Alex TicketHub - pdfkit.js
   ---------------------------------------------------------------------------
   A small PDF writer, in one file, with no dependencies.

   WHY THIS FILE EXISTS
   The signed organizer agreement has to leave the building as a real PDF -
   something that can be printed, attached to an email or handed to an auditor.
   This project has no build step, no package manager and no CDN (the CSP only
   allows 'self'), so the file is assembled here in the browser, byte by byte:
   objects, a cross-reference table and a trailer. No library, no network call,
   nothing to install, and it works offline.

   WHAT IT SUPPORTS
     - A4 pages, automatic pagination, a running header and a "Page N of M"
       footer that is only written once the page count is known
     - the four PDF base-14 Helvetica faces, so NO font file is ever embedded
     - real advance-width measurement, so text wraps and aligns exactly
     - WinAnsi output: smart quotes, en/em dashes, ellipsis, bullet and the
       Latin-1 accents fold in, and anything a base-14 font cannot draw becomes
       a safe '?' instead of mojibake
     - rectangles, rounded rectangles, hairlines, text, tables, definition
       grids, bullet lists, indented quotes and inline bold/italic/underline

   THE ONE LIMITATION
   Base-14 fonts are Latin-only. Emoji, CJK and other scripts outside WinAnsi
   cannot be drawn, so they are replaced with '?'. Organizer agreements are
   written in English, so in practice this never fires; it is stated here so
   nobody is surprised by it later.

   USAGE
     const doc = new PdfKit.PdfDoc({ title: "Organizer Agreement" });
     doc.rect(0, 0, 595, 80, "#0B1220");
     doc.text("Hello", 48, 40, { size: 14, bold: true, color: "#FFFFFF" });
     const bytes = doc.build();               // Uint8Array, ready for a Blob
   ========================================================================== */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ page -- */
  const PAGE_W = 595.28;   /* A4, in PostScript points (1/72 inch) */
  const PAGE_H = 841.89;
  const MARGIN_L = 48;
  const MARGIN_R = 48;

  /* ---------------------------------------------------------- font metrics --
     The four base-14 Helvetica faces are guaranteed to be present in every
     PDF reader, so nothing has to be embedded and the file stays small. The
     oblique faces share the advance widths of their upright twins. The tables
     below cover WinAnsi codes 32-126, in units of 1/1000 em. */
  const W_REGULAR =
    "278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278," +
    "556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556," +
    "1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778," +
    "667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556," +
    "333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556," +
    "556,556,333,500,278,556,500,722,500,500,500,334,260,334,584";
  const W_BOLD =
    "278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278," +
    "556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611," +
    "975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778," +
    "667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556," +
    "333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611," +
    "611,611,389,556,333,611,556,778,556,556,500,389,280,389,584";

  const WIDTHS = {
    false: W_REGULAR.split(",").map(Number),
    true: W_BOLD.split(",").map(Number)
  };
  /* Latin-1 accents reuse the advance width of the ASCII letter they sit on,
     so an accented word wraps exactly like its unaccented twin. 0 means "this
     code has no ASCII twin", and LATIN1_WIDTH below supplies the real value. */
  const LATIN1_FOLD = (function () {
    const t = new Array(256).fill(0);
    const put = (from, to, ch) => { for (let c = from; c <= to; c++) t[c] = ch.charCodeAt(0); };
    put(160, 160, " "); put(161, 161, "!");
    put(192, 197, "A"); put(199, 199, "C"); put(200, 203, "E"); put(204, 207, "I");
    put(208, 208, "D"); put(209, 209, "N"); put(210, 214, "O"); put(216, 216, "O");
    put(217, 217, "U"); put(218, 220, "U"); put(221, 221, "Y"); put(222, 222, "p");
    put(224, 229, "a"); put(231, 231, "c"); put(232, 235, "e"); put(236, 239, "i");
    put(240, 240, "o"); put(241, 241, "n"); put(242, 246, "o"); put(248, 248, "o");
    put(249, 252, "u"); put(253, 253, "y"); put(255, 255, "y");
    return t;
  })();
  /* Symbols with no ASCII twin: currency signs, punctuation and the fractions
     and superscripts that appear in fee clauses. */
  const LATIN1_WIDTH = {
    162: 556, 163: 556, 164: 556, 165: 556, 166: 260, 167: 556, 168: 333, 169: 737,
    170: 370, 171: 556, 172: 584, 173: 333, 174: 737, 175: 400, 176: 584, 177: 537,
    178: 333, 179: 333, 180: 333, 181: 556, 182: 537, 183: 278, 184: 333, 185: 365,
    186: 556, 187: 611, 188: 584, 189: 834, 190: 834, 191: 834, 198: 1000, 223: 611,
    230: 889, 254: 611
  };

  /* ------------------------------------------------------------- encoding --
     WinAnsiEncoding keeps ASCII where it is, relocates the smart punctuation
     into 0x80-0x9F, and otherwise matches Latin-1 - so the mapping is a short
     table plus two folds. Anything genuinely un-drawable becomes '?' rather
     than a mojibake byte. */
  const WINANSI_HIGH = {
    0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
    0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
    0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F
  };
  /* Typographic characters with an obvious twin: every dash becomes a hyphen,
     exotic spaces become real spaces, primes become apostrophes. */
  const WINANSI_FOLD = {
    0x00A0: 0x20, 0x00AD: 0x2D, 0x2002: 0x20, 0x2003: 0x20, 0x2004: 0x20, 0x2005: 0x20,
    0x2006: 0x20, 0x2007: 0x20, 0x2008: 0x20, 0x2009: 0x20, 0x200A: 0x20, 0x202F: 0x20,
    0x200B: 0x20, 0x200C: 0x20, 0x200D: 0x20, 0x2028: 0x20, 0x2029: 0x20, 0x3000: 0x20,
    0x2010: 0x2D, 0x2011: 0x2D, 0x2012: 0x2D, 0x2015: 0x97, 0x2212: 0x2D, 0x2044: 0x2F,
    0x2032: 0x27, 0x2033: 0x22, 0x2035: 0x60, 0x2036: 0x5E, 0x02BC: 0x27
  };
  /* -------------------------------------------------------------- helpers -- */
  /* Two decimals is the PDF precision that matters here; anything finer just
     makes the file bigger without changing a pixel. */
  function n(v){
    const x = Number(v);
    if (!isFinite(x)) return "0";
    const r = Math.round(x * 100) / 100;
    return (r === 0 ? "0" : String(r));
  }
  function rgb(hex){
    let h = String(hex == null ? "" : hex).trim().replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
    const v = parseInt(h, 16);
    return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
  }
  /* One colour operator, either fill (rg) or stroke (RG). */
  function cs(hex, stroke){
    const c = rgb(hex);
    return n(c[0]) + " " + n(c[1]) + " " + n(c[2]) + (stroke ? " RG" : " rg");
  }
  /* A JS string -> an array of WinAnsi byte codes. Never throws, never emits a
     byte a base-14 font cannot draw. */
  function toWinAnsi(value){
    const s = String(value == null ? "" : value);
    const out = [];
    for (let i = 0; i < s.length; i++){
      let c = s.charCodeAt(i);
      /* A surrogate pair has no WinAnsi twin; collapse it to one '?'. */
      if (c >= 0xD800 && c <= 0xDFFF){
        if (c <= 0xDBFF && i + 1 < s.length){
          const d = s.charCodeAt(i + 1);
          if (d >= 0xDC00 && d <= 0xDFFF) i++;
        }
        out.push(0x3F);
        continue;
      }
      if (c >= 32 && c < 127){ out.push(c); continue; }
      const high = WINANSI_HIGH[c];
      if (high !== undefined){ out.push(high); continue; }
      const fold = WINANSI_FOLD[c];
      if (fold !== undefined){ out.push(fold); continue; }
      if (c > 159 && c < 256){ out.push(c); continue; }   /* Latin-1 keeps its code */
      out.push(0x3F);
    }
    return out;
  }
  /* A PDF literal string: parentheses, backslashes and CR escaped. Split into
     short runs because some readers dislike very long single strings. */
  function lit(value, chunk){
    const bytes = toWinAnsi(value);
    const size = chunk || 200;
    let out = "";
    for (let i = 0; i < bytes.length; i += size) out += pdfStr(bytes, i, Math.min(i + size, bytes.length)) + " Tj\n";
    return out || "() Tj\n";
  }
  /* The bare "( ... )" form, for dictionary values such as /Title. */
  function pdfStr(bytes, from, to){
    const start = from == null ? 0 : from;
    const stop = to == null ? bytes.length : to;
    let s = "";
    for (let i = start; i < stop; i++){
      const b = bytes[i];
      if (b === 40 || b === 41 || b === 92) s += "\\" + String.fromCharCode(b);
      else if (b === 13) s += "\\r";
      else s += String.fromCharCode(b);
    }
    return "(" + s + ")";
  }
  function docString(value){ return pdfStr(toWinAnsi(value)); }
  function charWidth(code, bold){
    if (code >= 32 && code <= 126) return WIDTHS[bold ? "true" : "false"][code - 32];
    if (LATIN1_WIDTH[code] !== undefined) return LATIN1_WIDTH[code];
    const base = LATIN1_FOLD[code];
    if (base) return WIDTHS[bold ? "true" : "false"][base - 32];
    return 556;
  }
  const _measureCache = new Map();
  function measure(value, bold, size){
    const key = bold ? "b" : "r";
    let table = _measureCache.get(key);
    if (!table){ table = new Map(); _measureCache.set(key, table); }
    const hit = table.get(value);
    if (hit !== undefined) return hit * size / 1000;
    const bytes = toWinAnsi(value);
    let w = 0;
    for (let i = 0; i < bytes.length; i++) w += charWidth(bytes[i], bold);
    /* Bounded so a pathological document cannot grow this without limit. */
    if (table.size > 20000) table.clear();
    table.set(value, w);
    return w * size / 1000;
  }
  /* ----------------------------------------------------------- text model --
     A "run" is a stretch of text sharing one style. Rich text (bold, italic,
     underline inside a sentence) is just a list of runs, which is what makes
     the signed agreement keep its emphasis in the PDF. */
  function makeRun(text, opt){
    const o = opt || {};
    return {
      text: String(text == null ? "" : text),
      bold: !!o.bold,
      italic: !!o.italic,
      underline: !!o.underline,
      mono: !!o.mono,
      size: o.size == null ? 10 : o.size,
      color: o.color || "0B1220"
    };
  }
  /* Accepts a plain string or an array of runs and always hands back runs. */
  function toRuns(value, opt){
    if (Array.isArray(value)) return value.filter(r => r && r.text !== "");
    return [makeRun(value, opt)];
  }
  function sameStyle(a, b){
    return a.bold === b.bold && a.italic === b.italic && a.underline === b.underline
      && a.mono === b.mono && a.size === b.size && a.color === b.color;
  }
  /* Tabs and runs of whitespace collapse, and neighbouring runs that share a
     style are merged: fewer, longer runs mean fewer text-showing operators.
     Only the OUTER edges are trimmed. A space at the start of an interior run
     is the word gap after a <strong> or an <em>, and dropping it would run the
     two words together on the page. */
  function normalizeRuns(runs){
    const out = [];
    for (const r of runs || []){
      if (!r || r.text === "") continue;
      const text = String(r.text).replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(/[ ]+/g, " ");
      for (const piece of text.split("\n")){
        if (piece === "") continue;
        const last = out[out.length - 1];
        if (last && sameStyle(last, r)) {
          const needsGap = last.text && piece && !/\s$/.test(last.text) && !/^\s/.test(piece)
            && !/[\.,:;!?)]$/.test(last.text) && !/^[\(\[]/.test(piece);
          last.text += (needsGap ? " " : "") + piece;
        } else out.push(makeRun(piece, r));
      }
    }
    for (let i = 0; i < out.length; i++){
      if (i === 0) out[i].text = out[i].text.replace(/^ +/, "");
      if (i === out.length - 1) out[i].text = out[i].text.replace(/ +$/, "");
    }
    return out.filter(r => r.text !== "");
  }
  function faceOf(run){
    if (run.bold && run.italic) return "F4";
    if (run.bold) return "F2";
    if (run.italic) return "F3";
    return "F1";
  }
  /* A word wider than its column (a long URL or a hash) is broken by character
     rather than allowed to bleed past the margin. */
  function hardBreak(text, run, width){
    const out = [];
    let cur = "", curW = 0;
    for (const ch of String(text)){
      const w = measure(ch, run.bold, run.size);
      if (cur && curW + w > width){
        out.push(Object.assign({}, run, { text: cur, w: curW }));
        cur = ""; curW = 0;
      }
      cur += ch; curW += w;
    }
    out.push(Object.assign({}, run, { text: cur, w: curW }));
    return out;
  }
  /* Greedy, run-aware line breaking. Returns an array of lines, each an array
     of { text, w, run }. */
  function breakLines(runs, width){
    const items = [];
    for (const r of runs){
      const parts = String(r.text).split(/(\s+)/);
      for (const p of parts){
        if (p === "") continue;
        items.push({ text: p, space: /^\s+$/.test(p), w: measure(p, r.bold, r.size), run: r });
      }
    }
    const lines = [];
    let line = [], lw = 0;
    const flush = () => {
      while (line.length && line[line.length - 1].space) line.pop();
      if (line.length) lines.push(line);
      line = []; lw = 0;
    };
    for (const it of items){
      if (it.space){
        /* Trailing space never triggers a wrap of its own: it is dropped when
           the line closes. */
        if (line.length){ line.push(it); lw += it.w; }
        continue;
      }
      if (line.length && lw + it.w > width) flush();
      if (!line.length && it.w > width){
        const pieces = hardBreak(it.text, it.run, width);
        for (let i = 0; i < pieces.length - 1; i++) lines.push([pieces[i]]);
        const last = pieces[pieces.length - 1];
        line = [last]; lw = last.w;
        continue;
      }
      line.push(it);
      lw += it.w;
    }
    flush();
    return lines;
  }
  function lineWidth(line){
    let w = 0;
    for (const it of line) w += it.w;
    return w;
  }
  /* ==================================================================== doc ==
     Coordinates are top-left origin with y growing downwards (like the page it
     resembles); every operator is flipped to PDF's bottom-left origin on the
     way out, so the layout code never has to think about it. */
  class PdfDoc {
    constructor(opt){
      const o = opt || {};
      this.meta = {
        title: o.title || "Document",
        author: o.author || "",
        subject: o.subject || "",
        keywords: o.keywords || ""
      };
      this.W = o.width || PAGE_W;
      this.H = o.height || PAGE_H;
      this.ml = o.left == null ? MARGIN_L : o.left;
      this.mr = o.right == null ? MARGIN_R : o.right;
      this.mt = o.top == null ? 56 : o.top;
      this.mb = o.bottom == null ? 64 : o.bottom;
      this.contentWidth = this.W - this.ml - this.mr;
      /* Painted at build() time, when the page count is finally known. */
      this.onFirstPage = o.onFirstPage || null;
      this.onPage = o.onPage || null;
      this.onFooter = o.onFooter || null;
      this.pages = [];
      this.page = null;
      this.y = 0;
      this.newPage(true);
    }
    /* PDF origin is bottom-left: flip a top-down y into it. */
    py(y){ return this.H - y; }
    op(s){ this.page.ops.push(s); }
    newPage(first){
      this.pages.push({ ops: [] });
      this.page = this.pages[this.pages.length - 1];
      this.y = this.mt;
      const painter = first ? this.onFirstPage : this.onPage;
      if (painter) painter(this);
    }
    /* Room for `h` more points, or a page break. A block taller than a whole
       page is still drawn rather than looping forever. */
    ensure(h){
      const limit = this.H - this.mb;
      if (this.y + h > limit){
        if (this.y <= this.mt + 0.5){ return false; }
        this.newPage(false);
        return true;
      }
      return false;
    }
    space(h){ this.y += h; return this; }

    /* ---------------------------------------------------------- primitives -- */
    rect(x, y, w, h, color){
      this.op(cs(color) + " " + n(x) + " " + n(this.py(y + h)) + " " + n(w) + " " + n(h) + " re f\n");
      return this;
    }
    /* A rounded rectangle drawn as four bezier corners. Card panels read much
       better with a soft radius than with hard corners. */
    roundRect(x, y, w, h, r, color){
      const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
      const bx = x, by = this.py(y + h), bw = w, bh = h;
      const k = 0.5523 * rad;
      let s = "";
      s += n(bx + rad) + " " + n(by + bh) + " m\n";
      s += n(bx + bw - rad) + " " + n(by + bh) + " l\n";
      s += n(bx + bw - rad + k) + " " + n(by + bh) + " " + n(bx + bw) + " " + n(by + bh - rad + k)
         + " " + n(bx + bw) + " " + n(by + bh - rad) + " c\n";
      s += n(bx + bw) + " " + n(by + rad) + " l\n";
      s += n(bx + bw) + " " + n(by + rad - k) + " " + n(bx + bw - rad + k) + " " + n(by)
         + " " + n(bx + bw - rad) + " " + n(by) + " c\n";
      s += n(bx + rad) + " " + n(by) + " l\n";
      s += n(bx + rad - k) + " " + n(by) + " " + n(bx) + " " + n(by + rad - k)
         + " " + n(bx) + " " + n(by + rad) + " c\n";
      s += n(bx) + " " + n(by + bh - rad) + " l\n";
      s += n(bx) + " " + n(by + bh - rad + k) + " " + n(bx + rad - k) + " " + n(by + bh)
         + " " + n(bx + rad) + " " + n(by + bh) + " c\n";
      s += "h\n";
      this.op(cs(color) + " " + s + "f\n");
      return this;
    }
    /* Outlined panel. `all` draws the full border, otherwise the edges are
       chosen individually so a card can carry a coloured top edge only. */
    frame(x, y, w, h, color, lw, edges){
      const e = edges || {};
      const top = e.top !== false, bottom = e.bottom !== false;
      const left = e.left !== false, right = e.right !== false;
      const width = lw == null ? 0.7 : lw;
      let s = cs(color, true) + " " + n(width) + " w\n";
      const yb = this.py(y + h);
      if (bottom) s += n(x) + " " + n(yb) + " m " + n(x + w) + " " + n(yb) + " l S\n";
      if (top) s += n(x) + " " + n(this.py(y)) + " m " + n(x + w) + " " + n(this.py(y)) + " l S\n";
      if (left) s += n(x) + " " + n(yb) + " m " + n(x) + " " + n(this.py(y)) + " l S\n";
      if (right) s += n(x + w) + " " + n(yb) + " m " + n(x + w) + " " + n(this.py(y)) + " l S\n";
      this.op(s);
      return this;
    }
    line(x1, y1, x2, y2, color, lw){
      this.op(cs(color, true) + " " + n(lw == null ? 0.7 : lw) + " w "
        + n(x1) + " " + n(this.py(y1)) + " m " + n(x2) + " " + n(this.py(y2)) + " l S\n");
      return this;
    }
    /* A tick drawn from two strokes: a check mark that scales and needs no
       symbol font. */
    check(cx, cy, size, color, lw){
      const s = size / 2;
      this.line(cx - s, cy + s * 0.05, cx - s * 0.25, cy + s * 0.62, color, lw || 1.6);
      this.line(cx - s * 0.25, cy + s * 0.62, cx + s, cy - s * 0.62, color, lw || 1.6);
      return this;
    }
    /* A horizontal rule that leaves room for the next block. */
    hr(y, x, w, color, before, after){
      this.y += before == null ? 8 : before;
      this.line(x == null ? this.ml : x, this.y, (x == null ? this.ml : x) + (w == null ? this.contentWidth : w), this.y,
        color || "E6E8F0", 0.7);
      this.y += after == null ? 8 : after;
      return this;
    }

    /* -------------------------------------------------------------- writing -- */
    /* One already-broken line of runs. `y` is the BASELINE. Alignment needs the
       box width, which every caller has. */
    drawLine(line, x, y, width, align){
      const w = lineWidth(line);
      let cx = x;
      if (align === "center") cx = x + ((width || 0) - w) / 2;
      else if (align === "right") cx = x + (width || 0) - w;
      /* One BT/ET per line, with a text matrix per styled run. Path operators
         are illegal inside a text object, so underlines are collected and drawn
         straight after it. This keeps a full page to a few dozen operators
         instead of one per word. */
      let body = "";
      const rules = [];
      for (const it of line){
        const run = it.run;
        if (it.text === "") continue;
        /* Whitespace is never painted: every run carries its own absolute text
           matrix, so a space only has to advance the pen. Skipping the glyph
           removes thousands of no-op operators from a long agreement. */
        if (/^\s+$/.test(it.text)){ cx += it.w; continue; }
        /* Monospace runs (hashes, references) keep their columns aligned. */
        const font = run.mono ? (run.bold ? "F6" : "F5") : faceOf(run);
        body += "/" + font + " " + n(run.size) + " Tf " + cs(run.color)
          + " rg 1 0 0 1 " + n(cx) + " " + n(this.py(y)) + " Tm " + lit(it.text);
        if (run.underline) rules.push([cx, y + run.size * 0.13, it.w, Math.max(0.5, run.size * 0.055), run.color]);
        cx += it.w;
      }
      if (!body) return this;
      this.op("BT\n" + body + "ET\n");
      for (const r of rules) this.rect(r[0], r[1], r[2], r[3], r[4]);
      return this;
    }
    /* A single line, measured but never wrapped. Returns its width so callers
       can chain right-aligned text next to a left-aligned label. */
    text(value, x, y, opt){
      const o = opt || {};
      const runs = normalizeRuns(toRuns(value, o));
      const line = [];
      for (const r of runs) line.push({ text: r.text, w: measure(r.text, r.bold, r.size), run: r });
      this.drawLine(line, x, y, o.width || 0, o.align || "left");
      return lineWidth(line);
    }
    /* Wrapped, flowing text. This is the workhorse: paragraphs, list items,
       table cells and every block of the agreement itself go through it. */
    flow(value, x, y, width, opt){
      const o = opt || {};
      const size = o.size == null ? 10 : o.size;
      const lh = o.lineHeight || Math.round(size * 1.45 * 100) / 100;
      const runs = normalizeRuns(toRuns(value, o));
      if (!runs.length) return y;
      const lines = breakLines(runs, width);
      /* Keep a heading or the first lines of a paragraph together: if fewer
         than two lines fit on the rest of this page, start the next one. */
      const need = lines.length * lh;
      if (lines.length > 1 && y + need > this.H - this.mb && y + 2 * lh > this.H - this.mb){
        if (this.y > this.mt + 0.5){ this.newPage(false); y = this.y; }
      }
      for (const line of lines){
        this.ensure(lh);
        this.drawLine(line, x, y + lh * 0.78, width, o.align || "left");
        y += lh;
        this.y = Math.max(this.y, y);
      }
      return y;
    }
    /* Paragraph shorthand that also tracks the cursor. */
    para(value, x, y, width, opt){
      const o = opt || {};
      const end = this.flow(value, x, y, width, o);
      this.y = end + (o.after == null ? 8 : o.after);
      return this.y;
    }
    /* Measure a value without drawing it. */
    widthOf(value, opt){
      const o = opt || {};
      const runs = normalizeRuns(toRuns(value, o));
      let w = 0;
      for (const r of runs) w += measure(r.text, r.bold, r.size);
      return w;
    }
    /* How many lines `value` needs at `width`. A background has to be painted
       before the text that sits on it, so the caller needs the height up
       front - this is how it gets it without laying the text out twice. */
    lineCount(value, width, opt){
      const o = opt || {};
      const runs = normalizeRuns(toRuns(value, o));
      if (!runs.length) return 0;
      return breakLines(runs, width).length;
    }
    /* The same, in points, using the same leading flow() would use. */
    flowHeight(value, width, opt){
      const o = opt || {};
      const size = o.size == null ? 10 : o.size;
      const lh = o.lineHeight || Math.round(size * 1.45 * 100) / 100;
      return this.lineCount(value, width, o) * lh;
    }
    /* Letter-spaced uppercase label. `Tc` is the PDF operator for extra space
       between glyphs, so the tracking is exact and the width is predictable -
       which is what makes the wide section headings read as designed. */
    caps(value, x, y, opt){
      const o = opt || {};
      const size = o.size == null ? 8.5 : o.size;
      const track = o.tracking == null ? 0.9 : o.tracking;
      const src = String(value == null ? "" : value).toUpperCase();
      const w = measure(src, !!o.bold, size) + track * Math.max(0, src.length - 1);
      this.op("BT /" + (o.bold ? "F2" : "F1") + " " + n(size) + " Tf " + n(track) + " Tc "
        + cs(o.color || "5A6478") + " rg 1 0 0 1 " + n(x) + " " + n(this.py(y)) + " Tm "
        + lit(src) + " ET\n");
      return w;
    }
    /* Right-aligned text: measure first, then start at the right edge. */
    textRight(value, xRight, y, opt){
      const o = opt || {};
      const w = this.widthOf(value, o);
      this.text(value, xRight - w, y, o);
      return w;
    }
    /* Centre-aligned text across a box. */
    textCenter(value, x, width, y, opt){
      const o = opt || {};
      const w = this.widthOf(value, o);
      this.text(value, x + (width - w) / 2, y, o);
      return w;
    }

    /* ----------------------------------------------------------- components -- */
    /* A numbered section: small tracked eyebrow, title, hairline underneath. */
    section(title, opt){
      const o = opt || {};
      const x = o.x == null ? this.ml : o.x;
      const w = o.width == null ? this.contentWidth : o.width;
      const size = o.size == null ? 13 : o.size;
      this.ensure(48);
      this.y += o.before == null ? 4 : o.before;
      if (o.eyebrow) this.caps(o.eyebrow, x, this.y + 8, { color: o.accent || "4F46E5", bold: true, size: 8 });
      this.y += 13;
      this.y = this.flow(title, x, this.y, w, {
        size: size, bold: true, color: o.color || "0B1220", lineHeight: Math.round(size * 1.26 * 100) / 100
      });
      if (o.rule !== false){
        this.y += 7;
        this.line(x, this.y, x + w, this.y, o.ruleColor || "E6E8F0", 0.7);
        this.y += 1;
      }
      this.y += o.after == null ? 13 : o.after;
      return this.y;
    }
    /* Label/value rows with alternating tint and hairline separators - the
       "who signed what, when and under which reference" block. Rows split
       across pages cleanly because each row is measured on its own. */
    defList(pairs, opt){
      const o = opt || {};
      const x = o.x == null ? this.ml : o.x;
      const w = o.width == null ? this.contentWidth : o.width;
      const labelW = o.labelWidth == null ? Math.min(200, Math.round(w * 0.36)) : o.labelWidth;
      const gap = o.gap == null ? 14 : o.gap;
      const valueW = w - labelW - gap;
      const size = o.size == null ? 9.5 : o.size;
      const lh = Math.round(size * 1.42 * 100) / 100;
      const padY = o.padY == null ? 7 : o.padY;
      const dash = o.dash == null ? "-" : o.dash;
      const list = pairs || [];
      for (let i = 0; i < list.length; i++){
        const p = list[i] || {};
        const raw = p.value == null || p.value === "" ? dash : p.value;
        const vLines = breakLines(normalizeRuns(toRuns(raw, {
          size: p.size || size, bold: !!p.bold, color: p.color || o.valueColor || "0B1220", mono: !!p.mono
        })), valueW);
        const lLines = p.label ? breakLines(normalizeRuns(toRuns(p.label, {
          size: size, bold: true, color: o.labelColor || "46506B"
        })), labelW) : [];
        const rows = Math.max(vLines.length, lLines.length);
        const h = rows * lh + padY * 2;
        this.ensure(h);
        const top = this.y;
        if (o.zebra !== false && i % 2 === 1) this.rect(x, top, w, h, o.zebraFill || "FAFAFD");
        lLines.forEach((line, k) => this.drawLine(line, x, top + padY + lh * 0.78 + k * lh, labelW, "left"));
        vLines.forEach((line, k) => this.drawLine(line, x + labelW + gap, top + padY + lh * 0.78 + k * lh, valueW, "left"));
        this.line(x, top + h, x + w, top + h, o.ruleColor || "EDEFF5", 0.6);
        this.y = top + h;
      }
      return this.y;
    }
    /* A column table. Column widths are given as relative weights and are
       normalised, so callers never have to do page arithmetic. The header band
       is re-drawn automatically after a page break, because a fee table that
       loses its headings mid-document is unusable. */
    table(opt){
      const o = opt || {};
      const x = o.x == null ? this.ml : o.x;
      const w = o.width == null ? this.contentWidth : o.width;
      const cols = o.columns || [];
      const padX = o.padX == null ? 9 : o.padX;
      const padY = o.padY == null ? 7 : o.padY;
      const size = o.size == null ? 9.5 : o.size;
      const lh = Math.round(size * 1.4 * 100) / 100;
      const sum = cols.reduce((s, c) => s + (c.width == null ? 1 : c.width), 0) || 1;
      const cells = [];
      let acc = x;
      for (const c of cols){
        const cw = (c.width == null ? 1 : c.width) / sum * w;
        cells.push({ x: acc, w: cw, align: c.align || "left", color: c.color, bold: c.bold });
        acc += cw;
      }
      /* Header is measured up front so its height is exact. */
      const head = o.head || null;
      let headLines = null, headH = 0;
      if (head){
        headLines = head.map((label, i) => {
          const c = cells[i] || { x: x, w: 0, align: "left" };
          const runs = normalizeRuns(toRuns(label, { size: size - 0.5, bold: true, color: o.headColor || "5A6478" }));
          return { lines: breakLines(runs, Math.max(8, c.w - padX * 2)), cell: c };
        });
        const rows = Math.max(1, ...headLines.map(h => h.lines.length));
        headH = rows * lh + padY * 2 + 2;
      }
      const drawHead = () => {
        const top = this.y;
        if (headH){
          this.rect(x, top, w, headH, o.headFill || "F2F4FA");
          headLines.forEach((h, i) => h.lines.forEach((line, k) => this.drawLine(line,
            h.cell.x + (h.cell.align === "right" ? 0 : padX), top + padY + lh * 0.78 + k * lh,
            h.cell.w - padX * 2, h.cell.align)));
          this.line(x, top + headH, x + w, top + headH, "D9DDEA", 0.7);
          this.y = top + headH;
        }
      };
      if (head){
        this.ensure(headH);
        drawHead();
      }
      const rows = o.rows || [];
      for (let r = 0; r < rows.length; r++){
        const row = rows[r] || [];
        const laid = cells.map((c, i) => {
          const raw = row[i];
          const spec = (raw && typeof raw === "object" && !Array.isArray(raw) && raw.text === undefined && raw.runs === undefined)
            ? raw : { value: raw };
          const runs = spec.runs || normalizeRuns(toRuns(raw && raw.runs ? raw.runs : spec.value, {
            size: spec.size || size, bold: spec.bold != null ? spec.bold : !!c.bold,
            color: spec.color || c.color || o.valueColor || "1F2937", mono: !!spec.mono
          }));
          return {
            lines: breakLines(runs, Math.max(8, c.w - padX * 2)),
            align: spec.align || c.align
          };
        });
        const rowLines = Math.max(1, ...laid.map(l => l.lines.length));
        const h = rowLines * lh + padY * 2;
        if (this.y + h > this.H - this.mb && this.y > this.mt + 0.5){
          this.newPage(false);
          if (head) drawHead();
        }
        const top = this.y;
        if (o.zebra !== false && r % 2 === 1) this.rect(x, top, w, h, o.zebraFill || "FBFBFE");
        laid.forEach((l, i) => l.lines.forEach((line, k) => this.drawLine(line,
          cells[i].x + (l.align === "right" ? 0 : padX), top + padY + lh * 0.78 + k * lh,
          cells[i].w - padX * 2, l.align)));
        this.line(x, top + h, x + w, top + h, o.ruleColor || "EDEFF5", 0.6);
        this.y = top + h;
      }
      return this.y;
    }
    /* A row of summary figures. The card height is derived from the wrapped
       value, so a long percentage or a two-line figure never collides with the
       caption underneath it. */
    statTiles(items, opt){
      const o = opt || {};
      const x = o.x == null ? this.ml : o.x;
      const w = o.width == null ? this.contentWidth : o.width;
      const list = items || [];
      if (!list.length) return this.y;
      const gap = o.gap == null ? 10 : o.gap;
      const padX = o.padX == null ? 12 : o.padX;
      const vSize = o.valueSize || 14;
      const count = list.length;
      const tw = (w - gap * (count - 1)) / count;
      const innerW = Math.max(12, tw - padX * 2);
      const wrapped = list.map(it => {
        const lines = breakLines(normalizeRuns(toRuns(it.value, {
          size: vSize, bold: true, color: o.valueColor || "0B1220"
        })), innerW);
        const shown = lines.slice(0, 2);
        const h = 20 + shown.length * (vSize * 1.14) + (it.sub ? 13 : 0) + 10;
        return { it: it, lines: shown, h: h };
      });
      const h = Math.max(...wrapped.map(v => v.h));
      this.ensure(h);
      const top = this.y;
      wrapped.forEach((v, i) => {
        const tx = x + i * (tw + gap);
        const ch = v.h;
        this.roundRect(tx, top, tw, ch, 6, o.fill || "F7F8FC");
        this.frame(tx, top, tw, ch, o.border || "E4E7F0", 0.7);
        this.caps(v.it.label, tx + padX, top + 18, { size: 7.4, bold: true, color: o.labelColor || "767F94" });
        v.lines.forEach((line, k) => this.drawLine(line, tx + padX, top + 20 + vSize * 0.86 + k * vSize * 1.14, innerW, "left"));
        if (v.it.sub) this.text(v.it.sub, tx + padX, top + ch - 9, { size: 7.6, color: o.subColor || "767F94" });
      });
      this.y = top + h;
      return this.y;
    }
    /* A tinted panel with a coloured left edge. Used for the verification note
       and any warning: the accent bar is what makes a block of small print
       read as deliberate rather than as an apology. */
    callout(opt){
      const o = opt || {};
      const x = o.x == null ? this.ml : o.x;
      const w = o.width == null ? this.contentWidth : o.width;
      const padX = o.padX == null ? 14 : o.padX;
      const padY = o.padY == null ? 12 : o.padY;
      const size = o.size == null ? 9 : o.size;
      const lh = Math.round(size * 1.46 * 100) / 100;
      const bar = o.bar == null ? 3 : o.bar;
      const innerW = w - padX * 2 - bar;
      const blocks = o.blocks && o.blocks.length ? o.blocks : [{ label: o.label, value: o.value }];
      /* Measure every block first: the panel height must be known before the
         background can be painted. */
      const laid = blocks.map(b => {
        const out = [];
        if (b && b.label){
          out.push({ kind: "label", lines: breakLines(normalizeRuns(toRuns(b.label, {
            size: size - 0.8, bold: true, color: o.labelColor || "3C4763"
          })), innerW) });
        }
        if (b && b.value != null && b.value !== ""){
          out.push({ kind: "body", runs: b.runs || normalizeRuns(toRuns(b.value, {
            size: size, color: o.color || "3A4359", bold: !!b.bold, mono: !!b.mono
          })), lines: breakLines(b.runs || normalizeRuns(toRuns(b.value, {
            size: size, color: o.color || "3A4359", bold: !!b.bold, mono: !!b.mono
          })), innerW) });
        }
        return out;
      }).flat();
      let bodyH = padY * 2;
      laid.forEach((b, i) => { bodyH += b.lines.length * lh; if (i) bodyH += 4; });
      this.ensure(bodyH);
      const top = this.y;
      this.roundRect(x, top, w, bodyH, 5, o.fill || "F5F7FF");
      if (bar > 0) this.rect(x, top, bar, bodyH, o.accent || "4F46E5");
      let y = top + padY;
      laid.forEach((b, i) => {
        if (i) y += 4;
        b.lines.forEach((line, k) => this.drawLine(line, x + padX + bar, y + lh * 0.78 + k * lh, innerW, "left"));
        y += b.lines.length * lh;
      });
      this.y = top + bodyH;
      return this.y;
    }
    /* Bullet or numbered items with hanging indents, so a wrapped clause stays
       aligned under its own text rather than under its marker. */
    bullets(items, opt){
      const o = opt || {};
      const x = o.x == null ? this.ml : o.x;
      const w = o.width == null ? this.contentWidth : o.width;
      const size = o.size == null ? 9.5 : o.size;
      const lh = Math.round(size * 1.46 * 100) / 100;
      const indent = o.indent == null ? 16 : o.indent;
      const gap = o.gap == null ? 5 : o.gap;
      const markerW = o.markerWidth == null ? 15 : o.markerWidth;
      const list = items || [];
      for (let i = 0; i < list.length; i++){
        const item = list[i] || "";
        const raw = Array.isArray(item) ? item : [item];
        const runs = normalizeRuns(toRuns(raw, { size: size, color: o.color || "1F2937" }));
        if (!runs.length) continue;
        const lines = breakLines(runs, w - indent - markerW);
        this.ensure(lines.length * lh);
        const top = this.y;
        const marker = o.marker || "\u2022";
        const label = typeof marker === "function" ? marker(i) : marker;
        this.text(label, x + indent, top + lh * 0.78, {
          size: size, bold: !!o.markerBold, color: o.markerColor || o.color || "1F2937"
        });
        lines.forEach((line, k) => this.drawLine(line, x + indent + markerW, top + lh * 0.78 + k * lh, w - indent - markerW, "left"));
        this.y = top + lines.length * lh + gap;
      }
      return this.y;
    }

    /* Renders parsed rich-HTML blocks (headings, paragraphs, lists, quotes and
       rules) as flowing document text. */
    html(blocks, opt){
      const o = opt || {};
      const x = o.x == null ? this.ml : o.x;
      const w = o.width == null ? this.contentWidth : o.width;
      const base = o.size || 10;
      const ink = o.color || "1F2937";
      const list = blocks || [];
      const headSize = [base + 3.2, base + 1.6, base + 0.4];
      for (let i = 0; i < list.length; i++){
        const b = list[i] || {};
        const indent = b.indent || 0;
        const bx = x + indent;
        const bw = w - indent;
        if (b.type === "rule"){
          this.ensure(14);
          this.hr(this.y, bx, bw, o.ruleColor || "E6E8F0", 7, 7);
          continue;
        }
        if (b.type === "head"){
          const size = headSize[Math.max(0, Math.min(2, (b.level || 3) - 3))];
          /* The first heading sits tight under the section rule; later ones get
             breathing room, and both stay with at least their first line. */
          if (i !== 0){
            this.ensure(size * 2.4 + 13);
            this.y += 13;
          } else {
            this.ensure(size * 2.4);
          }
          this.flow((b.runs || []).map(r => Object.assign({}, r, {
            size: size, bold: true, color: o.headColor || "0B1220"
          })), bx, this.y, bw, { lineHeight: Math.round(size * 1.3 * 100) / 100 });
          this.y += 5;
          continue;
        }
        if (b.type === "quote"){
          const size = base;
          const lh = Math.round(size * 1.5 * 100) / 100;
          const runs = (b.runs || []).map(r => Object.assign({}, r, {
            size: size, italic: true, color: o.quoteColor || "3A4359"
          }));
          const lines = breakLines(normalizeRuns(runs), bw - 18);
          const h = Math.max(1, lines.length) * lh + 10;
          this.ensure(h);
          const top = this.y;
          this.rect(bx, top, bw, h, o.quoteFill || "F5F7FF");
          this.rect(bx, top, 2.5, h, o.quoteAccent || "4F46E5");
          lines.forEach((line, k) => this.drawLine(line, bx + 12, top + 5 + lh * 0.78 + k * lh, bw - 18, "left"));
          this.y = top + h + 8;
          continue;
        }
        if (b.type === "li"){
          const size = base;
          const lh = Math.round(size * 1.46 * 100) / 100;
          const markerW = b.ordered ? 20 : 13;
          const lines = breakLines(normalizeRuns(b.runs || []), bw - markerW);
          this.ensure(Math.max(1, lines.length) * lh);
          const top = this.y;
          this.text(b.ordered ? (b.index + ".") : "\u2022", bx, top + lh * 0.78, {
            size: size, bold: !!b.ordered, color: b.ordered ? ink : (o.markerColor || "4F46E5")
          });
          lines.forEach((line, k) => this.drawLine(line, bx + markerW, top + lh * 0.78 + k * lh, bw - markerW, "left"));
          this.y = top + Math.max(1, lines.length) * lh + 3;
          continue;
        }
        /* "line" is a <br> inside a paragraph: same leading, no gap after. */
        const size = base;
        const lh = Math.round((b.type === "line" ? 1.28 : 1.5) * size * 100) / 100;
        this.ensure(lh);
        this.y = this.flow(b.runs || [], bx, this.y, bw, {
          lineHeight: lh, size: size, color: ink
        });
        if (b.type !== "line") this.y += 7;
      }
      return this.y;
    }
  }
  /* ====================================================== rich HTML input ==
     The agreement text arrives as the Worker's sanitised HTML - a fixed
     allow-list of p/strong/em/u/h3-h5/ul/ol/li/blockquote/hr/a/code/mark/small.
     It is parsed and mapped onto blocks, so the signed document keeps its
     headings, emphasis, lists and quotes instead of collapsing into one grey
     wall of text. A tag outside the allow-list is unwrapped: its words are
     kept, the tag is dropped. */
  const NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "\u2013",
    mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201C", rdquo: "\u201D",
    bull: "\u2022", middot: "\u00B7", hellip: "\u2026", deg: "\u00B0",
    copy: "\u00A9", reg: "\u00AE", trade: "\u2122", eacute: "\u00E9", egrave: "\u00E8",
    agrave: "\u00E0", ccedil: "\u00E7", shy: "\u00AD", pound: "\u00A3", euro: "\u20AC",
    times: "\u00D7", divide: "\u00F7", laquo: "\u00AB", raquo: "\u00BB", para: "\u00B6"
  };
  function decodeEntities(text){
    return String(text == null ? "" : text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (whole, body){
      if (body.charAt(0) === "#"){
        const code = body.charAt(1) === "x" || body.charAt(1) === "X"
          ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        if (!isFinite(code) || code < 0 || code > 0x10FFFF) return whole;
        try { return String.fromCodePoint(code); } catch (e){ return whole; }
      }
      const hit = NAMED_ENTITIES[body.toLowerCase()];
      return hit === undefined ? whole : hit;
    });
  }
  /* Used when there is no DOM (tests, and any non-browser host). It keeps the
     words and the paragraph breaks, and drops the markup. */
  function plainBlocks(html, base){
    const text = decodeEntities(String(html == null ? "" : html)
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<\/\s*(p|div|h[3-6]|li|blockquote)\s*>/gi, "\n\n")
      .replace(/<\s*(p|div|h[3-6]|li|blockquote)\b[^>]*>/gi, "\n\n")
      .replace(/<[^>]*>/g, ""));
    const blocks = [];
    for (const chunk of text.split(/\n{2,}/)){
      const lines = chunk.split(/\n/).map(l => l.trim()).filter(l => l !== "");
      if (!lines.length) continue;
      const runs = [];
      lines.forEach((line, i) => {
        if (i) runs.push(makeRun(" ", { size: base.size, color: base.color }));
        runs.push(makeRun(line, { size: base.size, color: base.color }));
      });
      const norm = normalizeRuns(runs);
      if (norm.length) blocks.push({ type: "p", runs: norm });
    }
    return blocks;
  }
  function parseHtmlBlocks(html, base){
    const b = Object.assign({ size: 10, color: "1F2937" }, base || {});
    const src = String(html == null ? "" : html);
    if (!src.trim()) return [];
    if (typeof DOMParser === "undefined") return plainBlocks(src, b);

    let doc = null;
    try { doc = new DOMParser().parseFromString(src, "text/html"); } catch (e){ doc = null; }
    if (!doc || !doc.body) return plainBlocks(src, b);

    /* A flat event stream, then a folding pass into blocks. Going through a
       stream (rather than building blocks recursively) is what makes nested
       lists and quotes compose correctly. */
    const stream = [];
    const walk = (node, style) => {
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++){
        const child = kids[i];
        if (child.nodeType === 3){
          if (child.nodeValue) stream.push({ t: "text", text: child.nodeValue, style: style });
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = String(child.tagName || "").toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") continue;
        const s = Object.assign({}, style);
        switch (tag){
          case "br": stream.push({ t: "line" }); continue;
          case "hr": stream.push({ t: "rule" }); continue;
          case "strong": case "b": s.bold = true; break;
          case "em": case "i": s.italic = true; break;
          case "u": s.underline = true; break;
          case "small": s.scale = 0.88; break;
          case "code": s.mono = true; break;
          case "mark": s.scale = 0.98; break;
          case "a": s.link = true; break;
          case "h3": case "h4": case "h5": case "h6":
            stream.push({ t: "headOpen", level: Number(tag.charAt(1)) || 3 });
            walk(child, s);
            stream.push({ t: "headClose" });
            continue;
          case "p": case "div": case "section": case "article":
            stream.push({ t: "paraOpen" });
            walk(child, s);
            stream.push({ t: "paraClose" });
            continue;
          case "ul": case "ol":
            stream.push({ t: "listOpen", ordered: tag === "ol" });
            walk(child, s);
            stream.push({ t: "listClose" });
            continue;
          case "li":
            stream.push({ t: "itemOpen" });
            walk(child, s);
            stream.push({ t: "itemClose" });
            continue;
          case "blockquote":
            stream.push({ t: "quoteOpen" });
            walk(child, s);
            stream.push({ t: "quoteClose" });
            continue;
          default: break;    /* unknown tag: unwrapped, children still walked */
        }
        walk(child, s);
      }
    };
    walk(doc.body, { bold: false, italic: false, underline: false, mono: false, scale: 1, link: false });

    const toRun = (text, s) => makeRun(text, {
      bold: s.bold, italic: s.italic, underline: s.underline || s.link, mono: s.mono,
      size: Math.round(b.size * (s.scale || 1) * 10) / 10,
      color: s.link ? (b.linkColor || "4F46E5") : b.color
    });
    const blocks = [];
    const stack = [];
    let cur = [];
    const take = () => { const r = normalizeRuns(cur); cur = []; return r; };
    const top = () => (stack.length ? stack[stack.length - 1] : null);
    const context = () => {
      const c = { indent: 0, quote: false, ordered: false, index: 1 };
      for (const m of stack){
        if (m.k === "item"){ c.indent += 15; c.ordered = m.ordered; c.index = m.index; }
        else if (m.k === "quote"){ c.quote = true; c.indent += 4; }
      }
      return c;
    };
    const emit = (type, extra) => {
      const runs = take();
      if (!runs.length) return;
      blocks.push(Object.assign({ type: type, runs: runs }, context(), extra || {}));
    };
    /* Text collected outside any marker still belongs to a paragraph. */
    const flushPara = () => { if (normalizeRuns(cur).length) emit("p"); };
    const popIf = (kind) => { if (top() && top().k === kind) stack.pop(); };
    for (const ev of stream){
      switch (ev.t){
        case "text":
          if (ev.text) cur.push(toRun(ev.text, ev.style));
          break;
        case "line": emit("line"); break;
        case "rule":
          take();
          blocks.push(Object.assign({ type: "rule", runs: [] }, context()));
          break;
        case "headOpen": flushPara(); stack.push({ k: "head", level: ev.level }); break;
        case "headClose": emit("head", { level: (top() && top().k === "head" ? stack.pop().level : 3) }); break;
        case "paraOpen": flushPara(); stack.push({ k: "para" }); break;
        case "paraClose": emit("p"); popIf("para"); break;
        case "listOpen": flushPara(); stack.push({ k: "list", ordered: !!ev.ordered, count: 0 }); break;
        case "listClose": flushPara(); popIf("list"); break;
        case "itemOpen": {
          flushPara();
          const parent = top();
          const ordered = !!(parent && parent.ordered);
          const index = (parent && parent.k === "list") ? (++parent.count) : 1;
          stack.push({ k: "item", ordered: ordered, index: index });
          break;
        }
        case "itemClose": {
          const marker = (top() && top().k === "item") ? stack.pop() : null;
          emit("li", { ordered: !!(marker && marker.ordered), index: (marker && marker.index) || 1 });
          break;
        }
        case "quoteOpen": flushPara(); stack.push({ k: "quote" }); break;
        case "quoteClose": emit("quote"); popIf("quote"); break;
        default: break;
      }
    }
    flushPara();
    return blocks;
  }
  /* ================================================================ output ==
     The file is written by hand: header, indirect objects, a cross-reference
     table and a trailer. Every object offset is recorded as it is written,
     because a single wrong offset makes the whole file unreadable. */
  const FONTS = [
    ["F1", "Helvetica"],
    ["F2", "Helvetica-Bold"],
    ["F3", "Helvetica-Oblique"],
    ["F4", "Helvetica-BoldOblique"],
    ["F5", "Courier"],
    ["F6", "Courier-Bold"]
  ];
  function pad10(v){ return ("0000000000" + v).slice(-10); }
  function pdfTimestamp(d){
    const p = v => (v < 10 ? "0" : "") + v;
    return "D:" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
      + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "+00'00'";
  }
  PdfDoc.prototype.build = function(){
    const total = this.pages.length;
    /* Footers are painted here, not while laying out, because they carry
       "Page N of M" and the total is not known until the last block is placed. */
    if (!this.built && this.onFooter){
      for (let i = 0; i < total; i++){
        this.page = this.pages[i];
        this.onFooter(this, i + 1, total);
      }
    }
    this.built = true;

    /* Objects 1 and 2 (the catalog and the page tree) are reserved up front so
       the numbering stays stable while the page objects are created. */
    const objs = [null, null, null];
    const add = (dict, stream) => { objs.push({ dict: dict, stream: stream || null }); return objs.length - 1; };
    const fontRefs = FONTS.map(f => add("<< /Type /Font /Subtype /Type1 /BaseFont /" + f[1]
      + " /Encoding /WinAnsiEncoding >>"));
    const fontRes = FONTS.map((f, i) => "/" + f[0] + " " + fontRefs[i] + " 0 R").join(" ");
    const kids = [];
    for (const page of this.pages){
      const body = page.ops.join("");
      const stream = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++) stream[i] = body.charCodeAt(i) & 0xFF;
      const cid = add(null, stream);
      kids.push(add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + n(this.W) + " " + n(this.H) + "]"
        + " /Resources << /Font << " + fontRes + " >> >> /Contents " + cid + " 0 R >>"));
    }
    const stamp = pdfTimestamp(new Date());
    const infoId = add("<< /Title " + docString(this.meta.title)
      + " /Author " + docString(this.meta.author)
      + " /Subject " + docString(this.meta.subject)
      + " /Keywords " + docString(this.meta.keywords)
      + " /Producer " + docString("Prince Alex TicketHub pdfkit")
      + " /Creator " + docString("Prince Alex TicketHub")
      + " /CreationDate (" + stamp + ") >>");
    objs[1] = { dict: "<< /Type /Catalog /Pages 2 0 R >>", stream: null };
    objs[2] = { dict: "<< /Type /Pages /Kids [" + kids.map(k => k + " 0 R").join(" ")
      + "] /Count " + kids.length + " >>", stream: null };

    const out = [];
    let pos = 0;
    const put = s => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xFF); pos += s.length; };
    const putBytes = arr => { for (let i = 0; i < arr.length; i++) out.push(arr[i]); pos += arr.length; };
    /* The four high bytes mark the file as binary so no transport mangles it. */
    put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    const offsets = new Array(objs.length).fill(0);
    for (let i = 1; i < objs.length; i++){
      const o = objs[i];
      if (!o) continue;
      offsets[i] = pos;
      put(i + " 0 obj\n");
      if (o.stream){
        put("<< /Length " + o.stream.length + " >>\nstream\n");
        putBytes(o.stream);
        put("\nendstream\nendobj\n");
      } else {
        put(o.dict + "\nendobj\n");
      }
    }
    /* A stable-looking /ID pair. It only has to be a 16-byte hex string that
       matches itself; viewers use it to tell revisions apart. */
    let h = 2166136261;
    const seed = this.meta.title + "|" + stamp + "|" + total + "|" + out.length;
    for (let i = 0; i < seed.length; i++){ h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    const hex = pad10(h >>> 0).slice(2) + pad10(Math.imul(h, 2654435761) >>> 0).slice(2);
    const id = hex + hex;
    const xref = pos;
    put("xref\n0 " + objs.length + "\n0000000000 65535 f \n");
    for (let i = 1; i < objs.length; i++) put(pad10(offsets[i]) + " 00000 n \n");
    put("trailer\n<< /Size " + objs.length + " /Root 1 0 R /Info " + infoId + " 0 R"
      + " /ID [<" + id + "> <" + id + ">] >>\nstartxref\n" + xref + "\n%%EOF\n");
    return new Uint8Array(out);
  };
  /* Bytes only, for a caller that wants to upload or hash the file. */
  PdfDoc.prototype.bytes = function(){ return this.build(); };
  /* Hands the finished file to the browser as a normal download. */
  PdfDoc.prototype.save = function(filename){
    const bytes = this.build();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return bytes.length;
  };

  global.PdfKit = {
    version: "1.0",
    PdfDoc: PdfDoc,
    parseHtmlBlocks: parseHtmlBlocks,
    plainBlocks: plainBlocks,
    decodeEntities: decodeEntities,
    makeRun: makeRun,
    toRuns: toRuns,
    measure: measure,
    PAGE_W: PAGE_W,
    PAGE_H: PAGE_H
  };
})(typeof window !== "undefined" ? window : globalThis);
