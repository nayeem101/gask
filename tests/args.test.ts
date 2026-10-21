import { describe, expect, test } from "bun:test";
import {
  ArgsError,
  MAX_QUERY_CHARS,
  parseArgs,
  validateQuestion,
} from "../src/args";

describe("parseArgs", () => {
  test("joins positional parts and applies defaults", () => {
    const options = parseArgs(["latest", "Bun", "release?"]);
    expect(options.questionParts.join(" ")).toBe("latest Bun release?");
    expect(options.timeoutMs).toBe(90_000);
    expect(options.country).toBe("us");
    expect(options.lang).toBe("en");
    expect(options.headed).toBe(false);
    expect(options.login).toBe(false);
    expect(options.noSources).toBe(false);
    expect(options.ansi).toBeUndefined();
  });

  test("parses --ansi and --no-ansi", () => {
    expect(parseArgs(["--ansi", "hi"]).ansi).toBe(true);
    expect(parseArgs(["--no-ansi", "hi"]).ansi).toBe(false);
  });

  test("parses flags, values, and = forms", () => {
    const options = parseArgs([
      "--headed",
      "--no-sources",
      "--timeout",
      "120",
      "--country=GB",
      "--lang",
      "en_US",
      "--profile",
      "C:\\tmp\\profile",
      "--chrome=C:\\Chrome\\chrome.exe",
      "--debug-html=page.html",
      "-v",
      "question",
    ]);
    expect(options.headed).toBe(true);
    expect(options.noSources).toBe(true);
    expect(options.timeoutMs).toBe(120_000);
    expect(options.country).toBe("gb");
    expect(options.lang).toBe("en-US");
    expect(options.profile).toBe("C:\\tmp\\profile");
    expect(options.chrome).toBe("C:\\Chrome\\chrome.exe");
    expect(options.debugHtml).toBe("page.html");
    expect(options.verbose).toBe(true);
  });

  test("supports combined short flags", () => {
    const options = parseArgs(["-vh", "hi"]);
    expect(options.verbose).toBe(true);
    expect(options.help).toBe(true);
  });

  test("-- treats the rest as the question", () => {
    const options = parseArgs(["--", "--not-a-flag", "-t"]);
    expect(options.questionParts).toEqual(["--not-a-flag", "-t"]);
  });

  test("bare - is a stdin marker", () => {
    expect(parseArgs(["-"]).questionParts).toEqual([]);
  });

  test("--login is recognized", () => {
    expect(parseArgs(["--login"]).login).toBe(true);
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["--bogus", "hi"])).toThrow(ArgsError);
  });

  test("rejects missing or invalid values", () => {
    expect(() => parseArgs(["--timeout"])).toThrow(ArgsError);
    expect(() => parseArgs(["--timeout=abc"])).toThrow(ArgsError);
    expect(() => parseArgs(["--timeout=3"])).toThrow(ArgsError);
    expect(() => parseArgs(["--country=USA"])).toThrow(ArgsError);
    expect(() => parseArgs(["--lang=english"])).toThrow(ArgsError);
    expect(() => parseArgs(["--chrome="])).toThrow(ArgsError);
  });
});

describe("validateQuestion", () => {
  test("trims and rejects empty questions", () => {
    expect(validateQuestion("  hi  ")).toBe("hi");
    expect(() => validateQuestion("   ")).toThrow(ArgsError);
  });

  test("enforces the Google AI Mode length limit", () => {
    expect(validateQuestion("a".repeat(MAX_QUERY_CHARS))).toHaveLength(MAX_QUERY_CHARS);
    expect(() => validateQuestion("a".repeat(MAX_QUERY_CHARS + 1))).toThrow(ArgsError);
  });
});
