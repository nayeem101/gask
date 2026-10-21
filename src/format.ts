export type SourceLike = { title: string; url: string };

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";
const UNDERLINE = "\x1b[4m";
const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const HEADING = "\x1b[1;36m";
const LINK = "\x1b[4;34m";

export function renderMarkdownAnsi(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceChar = "";

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = line.trim().match(/^(```+|~~~+)/);

    if (fence) {
      const marker = fence[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
      } else if (marker === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }

    if (inFence) {
      out.push(`${DIM}${CYAN}${line}${RESET}`);
      continue;
    }

    if (
      isTableRow(line) &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1]!)
    ) {
      const block = [line, lines[index + 1]!];
      let next = index + 2;
      while (next < lines.length && isTableRow(lines[next]!)) {
        block.push(lines[next]!);
        next++;
      }
      out.push(renderTableAnsi(block));
      index = next - 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(`${HEADING}${parseInline(heading[2]!)}${RESET}`);
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(`${DIM}${"─".repeat(40)}${RESET}`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      out.push(`${DIM}│ ${RESET}${parseInline(quote[1]!)}`);
      continue;
    }

    const list = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (list) {
      const indent = list[1]!;
      const marker = list[2]!;
      const ordered = /^\d/.test(marker);
      out.push(`${indent}${CYAN}${ordered ? marker : "•"}${RESET} ${parseInline(list[3]!)}`);
      continue;
    }

    out.push(parseInline(line));
  }

  return out.join("\n");
}

export function formatSourcesMarkdown(sources: SourceLike[]): string {
  if (sources.length === 0) return "";
  const lines = ["## Sources", ""];
  sources.forEach((source, index) => {
    lines.push(`${index + 1}. [${escapeLinkLabel(source.title)}](<${escapeLinkUrl(source.url)}>)`);
  });
  return `${lines.join("\n")}\n`;
}

function escapeLinkLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([\[\]`*_])/g, "\\$1");
}

function escapeLinkUrl(value: string): string {
  return value.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\s/g, "%20");
}

function countRun(text: string, index: number, char: string): number {
  let count = 0;
  while (text[index + count] === char) count++;
  return count;
}

function findClosing(text: string, start: number, marker: string): number {
  for (let index = start; index <= text.length - marker.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (marker.length === 1 && text[index] === "`") {
      const run = countRun(text, index, "`");
      const end = findClosing(text, index + run, "`".repeat(run));
      if (end !== -1) {
        index = end + run - 1;
        continue;
      }
    }
    if (
      marker.length === 1 &&
      (text.startsWith("**", index) || text.startsWith("__", index))
    ) {
      const double = text.slice(index, index + 2);
      const end = findClosing(text, index + 2, double);
      if (end !== -1) {
        index = end + 1;
        continue;
      }
    }
    if (text.startsWith(marker, index)) return index;
  }
  return -1;
}

function parseLink(
  text: string,
  start: number
): { label: string; url: string; end: number } | null {
  let index = start + 1;
  let label = "";

  while (index < text.length) {
    if (text[index] === "\\") {
      label += text[index]! + (text[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (text[index] === "]") break;
    label += text[index];
    index++;
  }

  if (text[index] !== "]" || text[index + 1] !== "(") return null;
  index += 2;

  let url = "";
  if (text[index] === "<") {
    index++;
    while (index < text.length && text[index] !== ">") {
      url += text[index];
      index++;
    }
    if (text[index] !== ">") return null;
    index++;
  } else {
    let depth = 0;
    while (index < text.length) {
      const char = text[index]!;
      if (char === "\\") {
        url += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === "(") depth++;
      if (char === ")") {
        if (depth === 0) break;
        depth--;
      }
      url += char;
      index++;
    }
  }

  if (text[index] !== ")") return null;
  return { label, url, end: index + 1 };
}

function parseInline(text: string): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;

    if (char === "\\" && index + 1 < text.length) {
      out += text[index + 1]!;
      index += 2;
      continue;
    }

    if (char === "`") {
      const run = countRun(text, index, "`");
      const marker = "`".repeat(run);
      const end = findClosing(text, index + run, marker);
      if (end !== -1) {
        let code = text.slice(index + run, end);
        if (run > 1 && code.startsWith(" ") && code.endsWith(" ")) {
          code = code.slice(1, -1);
        }
        out += `${CYAN}${code}${RESET}`;
        index = end + run;
        continue;
      }
    }

    if (char === "[") {
      const link = parseLink(text, index);
      if (link) {
        out += `${LINK}${parseInline(link.label)}${RESET}${DIM} — ${link.url}${RESET}`;
        index = link.end;
        continue;
      }
    }

    if (text.startsWith("***", index) || text.startsWith("___", index)) {
      const marker = text.slice(index, index + 3);
      const end = findClosing(text, index + 3, marker);
      if (end !== -1) {
        out += `${BOLD}${ITALIC}${parseInline(text.slice(index + 3, end))}${RESET}`;
        index = end + 3;
        continue;
      }
    }

    if (text.startsWith("**", index) || text.startsWith("__", index)) {
      const marker = text.slice(index, index + 2);
      const end = findClosing(text, index + 2, marker);
      if (end !== -1) {
        out += `${BOLD}${parseInline(text.slice(index + 2, end))}${RESET}`;
        index = end + 2;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const end = findClosing(text, index + 1, char);
      if (end !== -1) {
        out += `${ITALIC}${parseInline(text.slice(index + 1, end))}${RESET}`;
        index = end + 1;
        continue;
      }
    }

    out += char;
    index++;
  }

  return out;
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";

  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index]!;
    if (char === "\\") {
      const next = trimmed[index + 1];
      if (next === "|") {
        current += "|";
        index++;
        continue;
      }
      current += char;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function plainText(value: string): string {
  return value
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\\([\\`*_{}\[\]()#+\-.!>|])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function visibleLength(value: string): number {
  return value.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function renderTableAnsi(lines: string[]): string {
  const rows = lines.map(splitTableRow);
  const header = rows[0] ?? [];
  const body = rows.slice(2);
  const columnCount = Math.max(...rows.map((row) => row.length), 1);
  const alignments = (rows[1] ?? []).map((cell) => {
    const value = cell.trim();
    const left = value.startsWith(":");
    const right = value.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
  const widths: number[] = [];

  for (let column = 0; column < columnCount; column++) {
    const values = rows.map((row) => plainText(row[column] ?? ""));
    widths[column] = Math.max(3, ...values.map((value) => value.length));
  }

  const renderRow = (cells: string[], isHeader: boolean): string => {
    const rendered: string[] = [];
    for (let column = 0; column < columnCount; column++) {
      const content = parseInline(cells[column] ?? "");
      const padding = Math.max(0, widths[column]! - visibleLength(content));
      const alignment = alignments[column] ?? "left";
      let leftPad = 0;
      let rightPad = padding;
      if (alignment === "right") {
        leftPad = padding;
        rightPad = 0;
      } else if (alignment === "center") {
        leftPad = Math.floor(padding / 2);
        rightPad = padding - leftPad;
      }
      const styled = isHeader ? `${BOLD}${content}${RESET}` : content;
      rendered.push(`${" ".repeat(leftPad)}${styled}${" ".repeat(rightPad)}`);
    }
    return rendered.join(`${DIM} │ ${RESET}`);
  };

  const out = [renderRow(header, true)];
  out.push(widths.map((width) => "─".repeat(width)).join(`${DIM}─┼─${RESET}`));
  for (const row of body) out.push(renderRow(row, false));
  return out.join("\n");
}
