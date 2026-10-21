import { sleep, type PageSession } from "./cdp";

export const AI_MODE_BASE = "https://www.google.com/search";
export const MAX_SOURCES = 8;

export class AiModeError extends Error {
  readonly kind:
    | "captcha"
    | "unavailable"
    | "consent"
    | "timeout"
    | "empty"
    | "blocked"
    | "navigation";

  constructor(kind: AiModeError["kind"], message: string) {
    super(message);
    this.name = "AiModeError";
    this.kind = kind;
  }
}

export type RawSource = { url?: unknown; title?: unknown };
export type Source = { title: string; url: string };

export type PageProblemKind = "captcha" | "unavailable" | "consent" | "javascript" | "blocked";
export type PageProblem = { kind: PageProblemKind; message: string };

export type ScrapeOptions = {
  country: string;
  lang: string;
  timeoutMs: number;
  verbose?: (message: string) => void;
};

export type ScrapeResult = {
  answer: string;
  sources: Source[];
  html: string;
  elapsedMs: number;
};

export function buildSearchUrl(query: string, country: string, lang: string): string {
  const params = new URLSearchParams({
    udm: "50",
    q: query.trim(),
    hl: lang,
    gl: country.toLowerCase(),
  });
  return `${AI_MODE_BASE}?${params.toString()}`;
}

export function buildPlainSearchUrl(query: string, country: string, lang: string): string {
  const params = new URLSearchParams({
    q: query.trim(),
    hl: lang,
    gl: country.toLowerCase(),
  });
  return `${AI_MODE_BASE}?${params.toString()}`;
}

export function classifyPage(url: string, text: string): PageProblem | null {
  const compact = text.replace(/\s+/g, " ").trim();

  if (
    /\/sorry\//i.test(url) ||
    /unusual traffic|automated queries|verify you(?:'|\u2019)?re human|not a robot|systems have detected/i.test(compact)
  ) {
    return {
      kind: "captcha",
      message:
        "Google is asking for a CAPTCHA or flagged automated traffic.\nRun: gask --headed \"your question\" and complete the check, or run gask --login once.",
    };
  }

  if (/AI Mode is not currently available|AI Mode isn't available|AI Mode is not available/i.test(compact)) {
    return {
      kind: "unavailable",
      message:
        "Google AI Mode is not available for this profile/region.\nRun gask --login and sign in with a Google account, or retry with --headed.",
    };
  }

  if (/before you continue to google|we use cookies and data to/i.test(compact)) {
    return {
      kind: "consent",
      message: "Google is showing a consent screen. Run: gask --login",
    };
  }

  if (/enable javascript to continue|javascript is disabled/i.test(compact)) {
    return {
      kind: "javascript",
      message: "Google returned a JavaScript-required page. Retry or run gask --headed.",
    };
  }

  if (/access denied|request blocked|403 forbidden/i.test(compact)) {
    return {
      kind: "blocked",
      message: "Google blocked this request. Wait a while, then retry or run gask --headed.",
    };
  }

  return null;
}

const STATUS_ONLY =
  /^(?:thinking|searching(?: the web)?|looking up|loading|generating|composing|analyzing|working|ai mode|sources?|show more|show all|show full answer|read more|view more|see more|search)$/i;

export function isStatusText(text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return true;
  return STATUS_ONLY.test(compact.replace(/[\s.…]+$/g, ""));
}

const DROP_LINES =
  /^(?:ai mode|sources?|show more|show all|show full answer|read more|view more|see more|copy|copy code|related|ask a follow.?up|ask follow.?up|search|google|share|listen)$/i;

function plainMarkdownLine(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}

export function cleanAnswerText(raw: string, query?: string): string {
  let text = raw.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
  text = text.replace(/[\u200B-\u200D\uFEFF]/g, "");

  const out: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let blankPending = false;
  let skippingSources = false;

  for (const line of text.split("\n")) {
    const fence = line.trim().match(/^(```+|~~~+)/);
    if (fence) {
      const marker = fence[1]![0]!;
      if (!inFence) {
        inFence = true;
        fenceChar = marker;
        if (blankPending && out.length > 0) out.push("");
        blankPending = false;
        out.push(line);
      } else if (marker === fenceChar) {
        inFence = false;
        fenceChar = "";
        out.push(line);
      } else {
        out.push(line);
      }
      continue;
    }

    if (inFence) {
      out.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      if (out.length > 0) blankPending = true;
      continue;
    }

    const plain = plainMarkdownLine(trimmed);
    if (query && plain === query.trim()) continue;
    if (/^AI Mode reply\b/i.test(plain)) continue;
    if (DROP_LINES.test(plain)) {
      if (/^sources?$/i.test(plain)) skippingSources = true;
      continue;
    }
    if (
      skippingSources &&
      /^(?:\d+[.)]\s*)?(?:[-*+]\s*)?(?:\[[^\]]+\]\(\s*<?https?:|https?:\/\/|www\.)/i.test(trimmed)
    ) {
      continue;
    }
    skippingSources = false;

    if (blankPending && out.length > 0) {
      out.push("");
      blankPending = false;
    }
    out.push(line.replace(/[ \t]+$/g, ""));
  }

  while (out.length > 0 && !out[out.length - 1]!.trim()) out.pop();
  return out.join("\n");
}

function isGoogleHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "google.com" ||
    /(^|\.)google\.[a-z.]+$/.test(host) ||
    /(^|\.)gstatic\.com$/.test(host) ||
    /(^|\.)googleusercontent\.com$/.test(host) ||
    /(^|\.)googleadservices\.com$/.test(host)
  );
}

function decodeSourceUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let value = raw
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/");
  if (!value) return null;
  if (value.startsWith("//")) value = `https:${value}`;

  try {
    let parsed = new URL(value, "https://www.google.com/");
    if (isGoogleHost(parsed.hostname) && (parsed.pathname === "/url" || parsed.pathname === "/url/")) {
      const target = parsed.searchParams.get("q") ?? parsed.searchParams.get("url");
      if (!target) return null;
      value = target;
      parsed = new URL(target, "https://www.google.com/");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:utm_|gclid$|fbclid$|msclkid$|mc_cid$|mc_eid$|__cf_chl)/i.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    if ([...parsed.searchParams.keys()].length === 0) parsed.search = "";
    if (isGoogleHost(parsed.hostname)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function normalizeSources(raw: RawSource[], cap = MAX_SOURCES): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const url = decodeSourceUrl(item?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let title = typeof item?.title === "string" ? item.title.replace(/\s+/g, " ").trim() : "";
    if (!title) {
      try {
        title = new URL(url).hostname.replace(/^www\./i, "");
      } catch {
        title = url;
      }
    }
    out.push({ title, url });
    if (out.length >= cap) break;
  }

  return out;
}

const WAIT_STATE_SCRIPT = String.raw`(() => {
  const main =
    document.querySelector('[data-container-id="main-col"]') ||
    (document.querySelector('[data-session-thread-id]')
      ? document.querySelector('[data-session-thread-id]').parentElement
      : null);
  return {
    url: location.href,
    hasMain: !!main,
    mainText: main ? (main.innerText || '') : '',
    bodyText: document.body ? (document.body.innerText || '').slice(0, 20000) : ''
  };
})()`;

const EXPAND_SCRIPT = String.raw`(() => {
  const main =
    document.querySelector('[data-container-id="main-col"]') ||
    (document.querySelector('[data-session-thread-id]')
      ? document.querySelector('[data-session-thread-id]').parentElement
      : null);
  if (!main) return false;
  let clicked = false;
  const elements = main.querySelectorAll('button, [role="button"], a');
  for (const el of elements) {
    const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''))
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (/^(show more|show all|show full answer|read more|view more|see more)$/.test(label)) {
      try {
        el.click();
        clicked = true;
      } catch (error) {}
    }
  }
  return clicked;
})()`;

const CONSENT_SCRIPT = String.raw`(() => {
  const direct = document.querySelector('#L2AGLb');
  if (direct) {
    try {
      direct.click();
      return 'accept-all';
    } catch (error) {}
  }
  const elements = Array.from(document.querySelectorAll('button, a, [role="button"]'));
  const patterns = [
    /^accept all$/i,
    /^accept all cookies$/i,
    /^i agree$/i,
    /^agree to all$/i,
    /^accept$/i
  ];
  for (const el of elements) {
    const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''))
      .replace(/\s+/g, ' ')
      .trim();
    if (patterns.some((pattern) => pattern.test(label))) {
      try {
        el.click();
        return label;
      } catch (error) {}
    }
  }
  return '';
})()`;

const EXTRACT_ANSWER_SCRIPT = String.raw`(() => {
  const TICK = String.fromCharCode(96);
  const main =
    document.querySelector('[data-container-id="main-col"]') ||
    (document.querySelector('[data-session-thread-id]')
      ? document.querySelector('[data-session-thread-id]').parentElement
      : null);
  if (!main) return '';
  const clone = main.cloneNode(true);
  const removeAll = (selector) => {
    try {
      clone.querySelectorAll(selector).forEach((el) => el.remove());
    } catch (error) {}
  };
  removeAll('script, style, noscript, svg, img, sup, button, textarea, [role="status"]');
  removeAll('.MheKwc, .WBgIic, .DHPVt, .AHmQrc, .DBd2Wb, .HvurC, [data-subtree="aimba"], [aria-label="Sources"], [aria-label="Source"]');
  try {
    clone.querySelectorAll('[role="link"]').forEach((el) => {
      if (el.querySelector('img') && el.querySelector('span')) el.remove();
    });
  } catch (error) {}
  try {
    clone.querySelectorAll('[style]').forEach((el) => {
      const style = (el.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
      if (style.includes('display:none')) el.remove();
    });
  } catch (error) {}

  const normalize = (text) =>
    (text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ');

  const TICK_ESCAPE = new RegExp('([' + TICK + '*_\\[\\]])', 'g');
  const escapeText = (text) => text.replace(/\\/g, '\\\\').replace(TICK_ESCAPE, '\\$1');

  const wrap = (value, marker) => {
    const leading = (value.match(/^\s*/) || [''])[0];
    const trailing = (value.match(/\s*$/) || [''])[0];
    const core = value.slice(leading.length, value.length - trailing.length);
    if (!core) return value;
    return leading + marker + core + marker + trailing;
  };

  const inlineCode = (value) => {
    const text = normalize(value).trim();
    if (!text) return '';
    if (text.indexOf(TICK) !== -1) return TICK + TICK + ' ' + text + ' ' + TICK + TICK;
    return TICK + text + TICK;
  };

  const renderInline = (node, style) => {
    if (!node) return '';
    if (node.nodeType === 3) return escapeText(normalize(node.nodeValue || ''));
    if (node.nodeType !== 1) return '';
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return '  \n';
    if (tag === 'code') return inlineCode(el.textContent || '');
    if (tag === 'pre') return '';
    if (tag === 'img' || tag === 'svg' || tag === 'script' || tag === 'style') return '';
    const next = { bold: style.bold, italic: style.italic };
    let addBold = false;
    let addItalic = false;
    if ((tag === 'strong' || tag === 'b' || tag === 'mark') && !next.bold) {
      next.bold = true;
      addBold = true;
    }
    if ((tag === 'em' || tag === 'i') && !next.italic) {
      next.italic = true;
      addItalic = true;
    }
    let inner = '';
    for (const child of el.childNodes) inner += renderInline(child, next);
    if (addBold && addItalic) inner = wrap(inner, '***');
    else if (addBold) inner = wrap(inner, '**');
    else if (addItalic) inner = wrap(inner, '*');
    return inner;
  };

  const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, ul, ol, pre, table, blockquote, hr, [role="heading"], .n6owBd';

  const renderList = (list, depth) => {
    const ordered = list.tagName.toLowerCase() === 'ol';
    let counter = Number(list.getAttribute('start') || 1);
    const lines = [];
    for (const li of list.children) {
      if (!li.tagName || li.tagName.toLowerCase() !== 'li') continue;
      const nested = [];
      for (const child of li.children) {
        if (child.tagName && /^(ul|ol)$/i.test(child.tagName)) nested.push(child);
      }
      const item = li.cloneNode(true);
      item.querySelectorAll('ul, ol').forEach((el) => el.remove());
      const text = renderInline(item, { bold: false, italic: false }).trim();
      if (text) {
        const indent = '  '.repeat(depth);
        if (ordered) {
          lines.push(indent + counter + '. ' + text);
          counter++;
        } else {
          lines.push(indent + '- ' + text);
        }
      }
      for (const child of nested) {
        const rendered = renderList(child, depth + 1);
        if (rendered) lines.push(rendered);
      }
    }
    return lines.join('\n');
  };

  const renderTable = (table) => {
    const rows = [];
    for (const tr of table.querySelectorAll('tr')) {
      const cells = [];
      for (const cell of tr.querySelectorAll('th, td')) {
        const text = renderInline(cell, { bold: false, italic: false })
          .replace(/\n+/g, ' ')
          .replace(/\|/g, '\\|')
          .trim();
        cells.push(text);
      }
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    const width = Math.max.apply(null, rows.map((row) => row.length));
    const normalized = rows.map((row) => {
      const copy = row.slice();
      while (copy.length < width) copy.push('');
      return copy;
    });
    const header = normalized[0];
    const lines = [
      '| ' + header.join(' | ') + ' |',
      '| ' + header.map(() => '---').join(' | ') + ' |'
    ];
    for (const row of normalized.slice(1)) lines.push('| ' + row.join(' | ') + ' |');
    return lines.join('\n');
  };

  const renderCode = (codeEl, language) => {
    const code = (codeEl.textContent || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (!code.trim()) return '';
    let lang = (language || '').trim().split(/\s+/)[0] || '';
    if (!lang) {
      const langMatch = (codeEl.getAttribute('class') || '').match(/language-([\w+-]+)/);
      lang = langMatch ? langMatch[1] : '';
    }
    lang = lang.replace(/[^\w+#.-]/g, '');
    let fenceLength = 3;
    const runs = code.match(new RegExp(TICK + '+', 'g')) || [];
    for (const run of runs) fenceLength = Math.max(fenceLength, run.length + 1);
    const fence = TICK.repeat(fenceLength);
    return fence + lang + '\n' + code + '\n' + fence;
  };

  const blocks = [];
  const push = (value) => {
    const text = (value || '').replace(/[ \t]+\n/g, '\n').trim();
    if (text) blocks.push(text);
  };

  const walk = (parent) => {
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) {
        const text = normalize(node.nodeValue || '');
        if (text.trim()) push(escapeText(text));
        continue;
      }
      if (node.nodeType !== 1) continue;
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'svg', 'img', 'button', 'textarea', 'sup'].includes(tag)) continue;
      const classes = (el.getAttribute('class') || '').split(/\s+/);
      if (classes.includes('yhAwj')) continue;
      if (el.matches('.BpxUDf, .aiModeUiCodeBlock__Container')) {
        const pre = el.querySelector('pre');
        const codeEl = (pre && pre.querySelector('code')) || pre || el.querySelector('code');
        if (codeEl) {
          const langEl = el.querySelector('.GlO4G');
          const language = langEl ? normalize(langEl.textContent || '') : '';
          push(renderCode(codeEl, language));
        }
        continue;
      }
      const role = el.getAttribute('role') || '';
      if (role === 'heading' || /^h[1-6]$/.test(tag)) {
        let level = 2;
        if (/^h[1-6]$/.test(tag)) level = Number(tag.charAt(1));
        else if (el.getAttribute('aria-level')) level = Number(el.getAttribute('aria-level'));
        level = Math.max(1, Math.min(6, level || 2));
        const text = renderInline(el, { bold: false, italic: false }).trim();
        if (text) push('#'.repeat(level) + ' ' + text);
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        push(renderList(el, 0));
        continue;
      }
      if (tag === 'pre') {
        push(renderCode(el.querySelector('code') || el, ''));
        continue;
      }
      if (tag === 'table') {
        push(renderTable(el));
        continue;
      }
      if (tag === 'blockquote') {
        const text = renderInline(el, { bold: false, italic: false }).trim();
        if (text) push(text.split('\n').map((line) => '> ' + line).join('\n'));
        continue;
      }
      if (tag === 'hr') {
        push('---');
        continue;
      }
      if (tag === 'p' || (tag === 'div' && classes.includes('n6owBd'))) {
        push(renderInline(el, { bold: false, italic: false }));
        continue;
      }
      if (el.querySelector(BLOCK_SELECTOR)) {
        walk(el);
      } else {
        push(renderInline(el, { bold: false, italic: false }));
      }
    }
  };

  walk(clone);
  return blocks.join('\n\n');
})()`;

const EXTRACT_SOURCES_SCRIPT = String.raw`(() => {
  const rhs = document.querySelector('[data-container-id="rhs-col"]');
  if (!rhs) return [];
  const out = [];
  const seen = new Set();
  const titleOf = (el) => {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || '';
    return label.replace(/\s+/g, ' ').trim();
  };
  rhs.querySelectorAll('a[href]').forEach((a) => {
    const href = (a.getAttribute('href') || '').trim();
    if (!/\/goto\?url=/.test(href) || seen.has(href)) return;
    seen.add(href);
    out.push({ url: href, title: titleOf(a) });
  });
  return out.slice(0, 20);
})()`;

const EXTRACT_FALLBACK_SOURCES_SCRIPT = String.raw`(() => {
  const roots = [
    document.querySelector('[data-container-id="rhs-col"]'),
    document.querySelector('[data-container-id="main-col"]')
  ].filter(Boolean);
  const out = [];
  const seen = new Set();
  const isBad = (raw) => {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true;
      const host = parsed.hostname.toLowerCase();
      if (host === 'google.com' || /(^|\.)google\.[a-z.]+$/.test(host)) return true;
      if (/(^|\.)gstatic\.com$/.test(host)) return true;
      if (/(^|\.)googleusercontent\.com$/.test(host)) return true;
      if (/(^|\.)googleadservices\.com$/.test(host)) return true;
      if (parsed.pathname === '/' && !parsed.search) return true;
      if (/\.(?:jpe?g|png|gif|webp|svg|ico|bmp|avif|css|js)$/i.test(parsed.pathname)) return true;
      return false;
    } catch (error) {
      return true;
    }
  };
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    while (walker.nextNode()) {
      const text = (walker.currentNode.nodeValue || '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/\\u003d/gi, '=')
        .replace(/\\u0026/gi, '&')
        .replace(/\\\//g, '/');
      for (const match of text.matchAll(/"(https?:\/\/[^"\\\s]+)"/g)) {
        const url = match[1];
        if (isBad(url) || seen.has(url)) continue;
        seen.add(url);
        out.push({ url, title: '' });
        if (out.length >= 30) return out;
      }
    }
  }
  return out;
})()`;

type WaitState = {
  url: string;
  hasMain: boolean;
  mainText: string;
  bodyText: string;
};

function meaningfulSnapshot(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !isStatusText(line))
    .join("\n");
}

async function handleConsent(page: PageSession, verbose?: (message: string) => void): Promise<boolean> {
  try {
    const clicked = await page.evaluate<string>(CONSENT_SCRIPT, 10_000);
    if (!clicked) return false;
    verbose?.(`consent accepted (${clicked})`);
    await sleep(1200);
    return true;
  } catch {
    return false;
  }
}

async function waitForAnswer(
  page: PageSession,
  timeoutMs: number,
  verbose?: (message: string) => void
): Promise<number> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let previous = "";
  let stableCount = 0;
  let expanded = false;
  let consentAttempts = 0;

  while (Date.now() < deadline) {
    let state: WaitState | null = null;
    try {
      state = await page.evaluate<WaitState>(WAIT_STATE_SCRIPT, 10_000);
    } catch {
      state = null;
    }

    if (state) {
      const problem = classifyPage(state.url, state.bodyText);
      if (problem) {
        if (problem.kind === "consent") {
          if (consentAttempts < 2 && (await handleConsent(page, verbose))) {
            consentAttempts++;
            continue;
          }
        }
        throw new AiModeError(
          problem.kind === "captcha"
            ? "captcha"
            : problem.kind === "unavailable"
              ? "unavailable"
              : problem.kind === "consent"
                ? "consent"
                : "blocked",
          problem.message
        );
      }

      const snapshot = meaningfulSnapshot(state.mainText);
      if (snapshot) {
        if (!expanded) {
          expanded = true;
          try {
            const clicked = await page.evaluate<boolean>(EXPAND_SCRIPT, 10_000);
            if (clicked) await sleep(500);
          } catch {
            // ignore
          }
        }

        if (snapshot === previous) {
          stableCount++;
          if (stableCount >= 3) {
            verbose?.(`answer stabilized after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
            return Date.now() - startedAt;
          }
        } else {
          stableCount = 0;
          previous = snapshot;
        }
      }
    }

    await sleep(700);
  }

  throw new AiModeError(
    "timeout",
    `Google AI Mode did not finish within ${Math.round(timeoutMs / 1000)}s.\nRetry with --timeout 120, or use --headed to watch the page.`
  );
}

async function resolveSourceRedirects(
  page: PageSession,
  raw: RawSource[],
  verbose?: (message: string) => void
): Promise<RawSource[]> {
  const cache = new Map<string, string>();
  const out: RawSource[] = [];

  for (const item of raw) {
    const rawUrl = typeof item?.url === "string" ? item.url.trim() : "";
    if (!rawUrl) continue;
    if (!/\/goto\?url=/i.test(rawUrl)) {
      out.push(item);
      continue;
    }

    let resolved = cache.get(rawUrl);
    if (resolved === undefined) {
      resolved = await page.resolveRedirect(rawUrl);
      cache.set(rawUrl, resolved);
      if (resolved) verbose?.(`resolved source: ${resolved}`);
    }
    if (resolved) out.push({ url: resolved, title: item.title });
  }

  return out;
}

export async function scrapeAiMode(
  page: PageSession,
  query: string,
  options: ScrapeOptions
): Promise<ScrapeResult> {
  const startedAt = Date.now();
  const { country, lang, timeoutMs, verbose } = options;

  const plainUrl = buildPlainSearchUrl(query, country, lang);
  verbose?.(`opening ${plainUrl}`);
  try {
    await page.navigate(plainUrl, 25_000);
  } catch (error) {
    throw new AiModeError(
      "navigation",
      `Could not open Google: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  await handleConsent(page, verbose);
  await sleep(1500);

  const searchUrl = buildSearchUrl(query, country, lang);
  verbose?.(`opening ${searchUrl}`);
  try {
    await page.navigate(searchUrl, 35_000);
  } catch (error) {
    throw new AiModeError(
      "navigation",
      `Could not open Google AI Mode: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  await handleConsent(page, verbose);
  await waitForAnswer(page, timeoutMs, verbose);

  let rawAnswer = "";
  let answer = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    rawAnswer = await page.evaluate<string>(EXTRACT_ANSWER_SCRIPT, 30_000);
    answer = cleanAnswerText(rawAnswer, query);
    if (answer) break;
    await sleep(1500);
  }

  if (!answer) {
    throw new AiModeError(
      "empty",
      "Google AI Mode returned an empty answer.\nRetry with --timeout 120 or --headed to see what the page is doing."
    );
  }

  let rawSources = await page.evaluate<RawSource[]>(EXTRACT_SOURCES_SCRIPT, 30_000);
  let resolvedSources = await resolveSourceRedirects(
    page,
    Array.isArray(rawSources) ? rawSources : [],
    verbose
  );
  let sources = normalizeSources(resolvedSources);
  if (sources.length === 0) {
    await sleep(800);
    rawSources = await page.evaluate<RawSource[]>(EXTRACT_SOURCES_SCRIPT, 30_000);
    resolvedSources = await resolveSourceRedirects(
      page,
      Array.isArray(rawSources) ? rawSources : [],
      verbose
    );
    sources = normalizeSources(resolvedSources);
  }
  if (sources.length === 0) {
    verbose?.("no source cards resolved; scanning serialized page data");
    const fallback = await page.evaluate<RawSource[]>(EXTRACT_FALLBACK_SOURCES_SCRIPT, 30_000);
    sources = normalizeSources(Array.isArray(fallback) ? fallback : []);
  }

  const html = await page.getHtml();
  return {
    answer,
    sources,
    html,
    elapsedMs: Date.now() - startedAt,
  };
}
