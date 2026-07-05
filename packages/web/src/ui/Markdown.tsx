import { useState, type ReactNode } from "react";

/**
 * Tiny CommonMark-ish renderer for assistant messages.
 * Supports: fenced code (```lang), ATX headings, tables (GFM pipe), ul/ol lists,
 * blockquotes, hr, links, **bold**, *italic*, `inline code`, ~~strike~~.
 * Not a full spec — good enough for the kinds of replies Claude produces.
 */
export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="md">
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; start: number; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | {
      kind: "table";
      header: string[];
      align: (null | "left" | "right" | "center")[];
      rows: string[][];
    };

function Block({ block }: { block: Block }) {
  switch (block.kind) {
    case "p":
      return <p>{renderInline(block.text)}</p>;
    case "h": {
      const Tag = `h${Math.min(6, block.level)}` as "h1";
      return <Tag>{renderInline(block.text)}</Tag>;
    }
    case "code":
      return <CodeBlock lang={block.lang} text={block.text} />;
    case "ul":
      return (
        <ul>
          {block.items.map((it, i) => (
            <li key={i}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol start={block.start}>
          {block.items.map((it, i) => (
            <li key={i}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote>
          <Markdown text={block.text} />
        </blockquote>
      );
    case "hr":
      return <hr />;
    case "table":
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.header.map((h, i) => (
                  <th key={i} style={alignStyle(block.align[i] ?? null)}>
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((c, i) => (
                    <td key={i} style={alignStyle(block.align[i] ?? null)}>
                      {renderInline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

function alignStyle(a: null | "left" | "right" | "center"): React.CSSProperties | undefined {
  return a ? { textAlign: a } : undefined;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };
  const lines = text.split("\n");
  // Trim one trailing empty line that fenced blocks usually carry.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || "Plain Text"}</span>
        <button className="md-code-copy" onClick={copy} title="Copy code">
          {copied ? "✓ copied" : "⧉ copy"}
        </button>
      </div>
      <pre className="md-code-body">
        <code>
          {lines.map((ln, i) => (
            <span className="md-code-line" key={i}>
              <span className="md-code-gutter">{i + 1}</span>
              <span className="md-code-text">{ln || " "}</span>
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

// ─── block parser ──────────────────────────────────────────────────────────

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const at = (k: number): string => lines[k] ?? "";
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = at(i);

    // fenced code — must come first so we don't parse markdown inside
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(at(i))) {
        buf.push(at(i));
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      out.push({ kind: "code", lang, text: buf.join("\n") });
      continue;
    }

    // ATX heading
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h && h[1] && h[2] !== undefined) {
      out.push({ kind: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    // hr
    if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }

    // GFM table: header row + separator |---|---|
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(at(i + 1))) {
      const header = splitRow(line);
      const align = splitRow(at(i + 1)).map((c) => {
        const t = c.trim();
        const l = t.startsWith(":");
        const r = t.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : null;
      }) as (null | "left" | "right" | "center")[];
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(at(i))) {
        const row = splitRow(at(i));
        while (row.length < header.length) row.push("");
        rows.push(row);
        i++;
      }
      out.push({ kind: "table", header, align, rows });
      continue;
    }

    // unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(at(i))) {
        items.push(at(i).replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      out.push({ kind: "ul", items });
      continue;
    }

    // ordered list
    const olm = line.match(/^\s*(\d+)\.\s+/);
    if (olm && olm[1]) {
      const start = parseInt(olm[1], 10);
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(at(i))) {
        items.push(at(i).replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push({ kind: "ol", start, items });
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(at(i))) {
        buf.push(at(i).replace(/^>\s?/, ""));
        i++;
      }
      out.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }

    // blank
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // paragraph — accumulate until we hit blank or a new block start
    const pbuf: string[] = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(at(i)) && !isBlockStart(at(i), at(i + 1))) {
      pbuf.push(at(i));
      i++;
    }
    out.push({ kind: "p", text: pbuf.join("\n") });
  }
  return out;
}

function isBlockStart(line: string, next?: string): boolean {
  if (/^```/.test(line)) return true;
  if (/^#{1,6}\s+/.test(line)) return true;
  if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) return true;
  if (/^\s*[-*+]\s+/.test(line)) return true;
  if (/^\s*\d+\.\s+/.test(line)) return true;
  if (/^>\s?/.test(line)) return true;
  if (next && /^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(next)) return true;
  return false;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

// ─── inline renderer ───────────────────────────────────────────────────────

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };
  const push = (n: ReactNode) => {
    flush();
    out.push(<span key={out.length}>{n}</span>);
  };

  const ch = (k: number): string => text[k] ?? "";

  while (i < text.length) {
    const c = ch(i);

    // inline code `...`
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        push(<code>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }

    // bold **...** or __...__
    if ((c === "*" || c === "_") && ch(i + 1) === c) {
      const marker = c + c;
      const end = text.indexOf(marker, i + 2);
      if (end > i + 1) {
        push(<strong>{renderInline(text.slice(i + 2, end))}</strong>);
        i = end + 2;
        continue;
      }
    }

    // italic *...* or _..._ (require non-space after opener to avoid matching bare *)
    if ((c === "*" || c === "_") && ch(i + 1) && !/\s/.test(ch(i + 1))) {
      const end = text.indexOf(c, i + 1);
      if (end > i && !/\s/.test(ch(end - 1))) {
        push(<em>{renderInline(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    }

    // strike ~~...~~
    if (c === "~" && ch(i + 1) === "~") {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 1) {
        push(<s>{renderInline(text.slice(i + 2, end))}</s>);
        i = end + 2;
        continue;
      }
    }

    // link [label](url)
    if (c === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && ch(close + 1) === "(") {
        const paren = text.indexOf(")", close + 2);
        if (paren > close + 1) {
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, paren);
          push(
            <a href={url} target="_blank" rel="noopener noreferrer">
              {renderInline(label)}
            </a>,
          );
          i = paren + 1;
          continue;
        }
      }
    }

    // preserve single newlines within a paragraph as <br/>
    if (c === "\n") {
      push(<br />);
      i++;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}
