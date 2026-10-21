import { describe, expect, test } from "bun:test";
import { formatSourcesMarkdown, renderMarkdownAnsi } from "../src/format";

describe("formatSourcesMarkdown", () => {
  test("renders a Markdown sources section with links", () => {
    expect(formatSourcesMarkdown([{ title: "Bun", url: "https://bun.com/" }])).toBe(
      "## Sources\n\n1. [Bun](<https://bun.com/>)\n"
    );
  });

  test("returns an empty string for no sources", () => {
    expect(formatSourcesMarkdown([])).toBe("");
  });

  test("escapes emphasis characters in source titles", () => {
    expect(
      formatSourcesMarkdown([{ title: "Bun *fast* _runtime_", url: "https://bun.com/" }])
    ).toBe("## Sources\n\n1. [Bun \\*fast\\* \\_runtime\\_](<https://bun.com/>)\n");
  });
});

describe("renderMarkdownAnsi", () => {
  test("renders headings, bold, and inline code", () => {
    expect(renderMarkdownAnsi("## Title")).toBe("\x1b[1;36mTitle\x1b[0m");
    expect(renderMarkdownAnsi("**bold** and `code`")).toBe(
      "\x1b[1mbold\x1b[0m and \x1b[36mcode\x1b[0m"
    );
  });

  test("renders unordered and ordered lists", () => {
    expect(renderMarkdownAnsi("- one\n- two")).toBe(
      "\x1b[36m•\x1b[0m one\n\x1b[36m•\x1b[0m two"
    );
    expect(renderMarkdownAnsi("1. one")).toBe("\x1b[36m1.\x1b[0m one");
  });

  test("renders fenced code blocks", () => {
    expect(renderMarkdownAnsi("```ts\nconst a = 1;\n```")).toBe(
      "\x1b[2m\x1b[36mconst a = 1;\x1b[0m"
    );
  });

  test("renders links and sources", () => {
    const rendered = renderMarkdownAnsi(
      formatSourcesMarkdown([{ title: "Bun", url: "https://bun.com/" }])
    );
    expect(rendered).toContain("\x1b[1;36mSources\x1b[0m");
    expect(rendered).toContain("\x1b[4;34mBun\x1b[0m");
    expect(rendered).toContain("https://bun.com/");
  });

  test("renders tables with a styled header", () => {
    const rendered = renderMarkdownAnsi(
      "| Name | Value |\n| --- | --- |\n| Bun | 1.4 |"
    );
    const lines = rendered.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("\x1b[1mName\x1b[0m");
    expect(lines[1]).toContain("─┼─");
    expect(lines[2]).toContain("Bun");
  });

  test("honors escaped Markdown characters", () => {
    expect(renderMarkdownAnsi("a \\* b")).toBe("a * b");
  });
});
