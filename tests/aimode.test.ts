import { describe, expect, test } from "bun:test";
import {
  buildPlainSearchUrl,
  buildSearchUrl,
  classifyPage,
  cleanAnswerText,
  isStatusText,
  normalizeSources,
} from "../src/aimode";

describe("buildSearchUrl", () => {
  test("builds a udm=50 AI Mode URL with language and country", () => {
    const url = new URL(buildSearchUrl("latest Bun release?", "gb", "en-GB"));
    expect(url.origin + url.pathname).toBe("https://www.google.com/search");
    expect(url.searchParams.get("udm")).toBe("50");
    expect(url.searchParams.get("q")).toBe("latest Bun release?");
    expect(url.searchParams.get("hl")).toBe("en-GB");
    expect(url.searchParams.get("gl")).toBe("gb");
  });

  test("trims the query", () => {
    const url = new URL(buildSearchUrl("  hello  ", "us", "en"));
    expect(url.searchParams.get("q")).toBe("hello");
  });
});

describe("buildPlainSearchUrl", () => {
  test("builds a plain search URL without udm=50", () => {
    const url = new URL(buildPlainSearchUrl("latest Bun release?", "gb", "en-GB"));
    expect(url.origin + url.pathname).toBe("https://www.google.com/search");
    expect(url.searchParams.has("udm")).toBe(false);
    expect(url.searchParams.get("q")).toBe("latest Bun release?");
    expect(url.searchParams.get("hl")).toBe("en-GB");
    expect(url.searchParams.get("gl")).toBe("gb");
  });
});

describe("cleanAnswerText", () => {
  test("removes UI lines and the echoed question", () => {
    const raw = [
      "AI Mode",
      "What is Bun?",
      "Bun is a JavaScript runtime, bundler, test runner, and package manager.",
      "Show more",
      "Sources",
      "https://bun.sh",
    ].join("\n");
    expect(cleanAnswerText(raw, "What is Bun?")).toBe(
      "Bun is a JavaScript runtime, bundler, test runner, and package manager."
    );
  });

  test("keeps lists and code-ish indentation, collapses blank runs", () => {
    const raw = "Intro\n\n\n\n- one\n- two\n\n    code line\n";
    expect(cleanAnswerText(raw)).toBe("Intro\n\n- one\n- two\n\n    code line");
  });

  test("normalizes CRLF, NBSP and zero-width characters", () => {
    expect(cleanAnswerText("a\u00a0b\r\nc\u200bd")).toBe("a b\ncd");
  });

  test("preserves Markdown headings, lists, and fenced code blocks", () => {
    const raw = [
      "## Key Features",
      "",
      "- **Fast**: starts in 10ms",
      "- Supports `Bun.serve()`",
      "",
      "```ts",
      "const a = 1;",
      "",
      "",
      "const b = 2;",
      "```",
    ].join("\n");
    expect(cleanAnswerText(raw)).toBe(raw);
  });

  test("drops a Markdown Sources section and linked source lines", () => {
    const raw = [
      "Answer.",
      "",
      "## Sources",
      "",
      "1. [Bun](<https://bun.com/>)",
      "2. [Docs](<https://bun.com/docs>)",
    ].join("\n");
    expect(cleanAnswerText(raw)).toBe("Answer.");
  });

  test("drops an echoed question even when it is Markdown", () => {
    expect(cleanAnswerText("**What is Bun?**\n\nBun is a runtime.", "What is Bun?")).toBe(
      "Bun is a runtime."
    );
  });
});

describe("isStatusText", () => {
  test("detects loading states and ignores real short answers", () => {
    expect(isStatusText("Thinking…")).toBe(true);
    expect(isStatusText("Searching the web")).toBe(true);
    expect(isStatusText("Show more")).toBe(true);
    expect(isStatusText("")).toBe(true);
    expect(isStatusText("42")).toBe(false);
    expect(isStatusText("Paris is the capital of France.")).toBe(false);
  });
});

describe("normalizeSources", () => {
  test("decodes Google redirects and escaped URLs", () => {
    const sources = normalizeSources([
      {
        title: "Bun",
        url: "https://www.google.com/url?q=https://bun.sh/docs%3Fref%3Dx%26a%3D1&sa=D",
      },
      {
        title: "Escaped",
        url: "https://example.com/a\\u003db\\u0026c\\u003dd",
      },
    ]);
    expect(sources).toEqual([
      { title: "Bun", url: "https://bun.sh/docs?ref=x&a=1" },
      { title: "Escaped", url: "https://example.com/a=b&c=d" },
    ]);
  });

  test("filters Google and invalid URLs, dedupes, caps, and falls back to hostname", () => {
    const raw = [
      { title: "Google", url: "https://www.google.com/search?q=x" },
      { title: "Gstatic", url: "https://encrypted-tbn0.gstatic.com/image.png" },
      { title: "", url: "https://www.example.com/page#section" },
      { title: "dup", url: "https://www.example.com/page" },
      { title: "ftp", url: "ftp://example.com/file" },
    ];
    expect(normalizeSources(raw)).toEqual([
      { title: "example.com", url: "https://www.example.com/page" },
    ]);

    const many = Array.from({ length: 12 }, (_, index) => ({
      title: `T${index}`,
      url: `https://site${index}.test/page`,
    }));
    expect(normalizeSources(many)).toHaveLength(8);
  });

  test("handles protocol-relative URLs", () => {
    expect(normalizeSources([{ title: "X", url: "//example.com/x" }])).toEqual([
      { title: "X", url: "https://example.com/x" },
    ]);
  });

  test("strips tracking and challenge parameters but keeps meaningful ones", () => {
    expect(
      normalizeSources([
        {
          title: "X",
          url: "https://example.com/page?utm_source=x&id=7&__cf_chl_rt_tk=abc&gclid=g#frag",
        },
        {
          title: "Only tracking",
          url: "https://example.com/other?utm_medium=y&fbclid=z",
        },
      ])
    ).toEqual([
      { title: "X", url: "https://example.com/page?id=7" },
      { title: "Only tracking", url: "https://example.com/other" },
    ]);
  });
});

describe("classifyPage", () => {
  test("detects CAPTCHA, unavailable, consent, JS, and blocked pages", () => {
    expect(classifyPage("https://www.google.com/sorry/index", "")?.kind).toBe("captcha");
    expect(classifyPage("https://www.google.com/search", "Our systems have detected unusual traffic")?.kind).toBe(
      "captcha"
    );
    expect(classifyPage("https://www.google.com/search", "AI Mode is not currently available")?.kind).toBe(
      "unavailable"
    );
    expect(classifyPage("https://consent.google.com/x", "Before you continue to Google")?.kind).toBe("consent");
    expect(classifyPage("https://www.google.com/search", "Enable JavaScript to continue")?.kind).toBe(
      "javascript"
    );
    expect(classifyPage("https://www.google.com/search", "403 Forbidden")?.kind).toBe("blocked");
    expect(classifyPage("https://www.google.com/search", "A normal answer")).toBeNull();
  });
});
