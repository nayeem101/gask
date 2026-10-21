import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
export const DEFAULT_TIMEOUT_SECONDS = 90;
export const DEFAULT_COUNTRY = "us";
export const DEFAULT_LANG = "en";
export const MAX_QUERY_CHARS = 400;

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}

export type Options = {
  questionParts: string[];
  login: boolean;
  headed: boolean;
  noSources: boolean;
  ansi?: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
  timeoutMs: number;
  country: string;
  lang: string;
  profile?: string;
  chrome?: string;
  debugHtml?: string;
};

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    questionParts: [],
    login: false,
    headed: false,
    noSources: false,
    verbose: false,
    help: false,
    version: false,
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    country: DEFAULT_COUNTRY,
    lang: DEFAULT_LANG,
  };

  const expanded: string[] = [];
  for (const arg of argv) {
    if (/^-[vhV]{2,}$/.test(arg)) {
      for (const char of arg.slice(1)) expanded.push(`-${char}`);
    } else {
      expanded.push(arg);
    }
  }

  const valueOf = (index: number, flag: string): string => {
    const next = expanded[index + 1];
    if (next === undefined || next.startsWith("-") || next.trim() === "") {
      throw new ArgsError(`Error: ${flag} needs a value.\nRun: gask --help`);
    }
    return next.trim();
  };

  for (let i = 0; i < expanded.length; i++) {
    const arg = expanded[i];

    if (arg === "-") continue;
    if (arg === "-h" || arg === "--help" || arg === "help") options.help = true;
    else if (arg === "-V" || arg === "--version") options.version = true;
    else if (arg === "-v" || arg === "--verbose") options.verbose = true;
    else if (arg === "--login") options.login = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--no-sources") options.noSources = true;
    else if (arg === "--ansi") options.ansi = true;
    else if (arg === "--no-ansi") options.ansi = false;
    else if (arg === "--timeout" || arg === "-T") {
      options.timeoutMs = parseTimeout(valueOf(i, "--timeout"));
      i++;
    } else if (arg.startsWith("--timeout=")) {
      options.timeoutMs = parseTimeout(arg.slice("--timeout=".length));
    } else if (arg === "--country" || arg === "-c") {
      options.country = parseCountry(valueOf(i, "--country"));
      i++;
    } else if (arg.startsWith("--country=")) {
      options.country = parseCountry(arg.slice("--country=".length));
    } else if (arg === "--lang" || arg === "-l") {
      options.lang = parseLang(valueOf(i, "--lang"));
      i++;
    } else if (arg.startsWith("--lang=")) {
      options.lang = parseLang(arg.slice("--lang=".length));
    } else if (arg === "--profile") {
      options.profile = valueOf(i, "--profile");
      i++;
    } else if (arg.startsWith("--profile=")) {
      options.profile = requireValue(arg.slice("--profile=".length), "--profile");
    } else if (arg === "--chrome") {
      options.chrome = valueOf(i, "--chrome");
      i++;
    } else if (arg.startsWith("--chrome=")) {
      options.chrome = requireValue(arg.slice("--chrome=".length), "--chrome");
    } else if (arg === "--debug-html") {
      options.debugHtml = valueOf(i, "--debug-html");
      i++;
    } else if (arg.startsWith("--debug-html=")) {
      options.debugHtml = requireValue(arg.slice("--debug-html=".length), "--debug-html");
    } else if (arg === "--") {
      options.questionParts.push(...expanded.slice(i + 1));
      break;
    } else if (arg.startsWith("-") && arg.length > 1) {
      throw new ArgsError(`Unknown flag: ${arg}\nRun: gask --help`);
    } else {
      options.questionParts.push(arg);
    }
  }

  return options;
}

function requireValue(raw: string, flag: string): string {
  const value = raw.trim();
  if (!value) throw new ArgsError(`Error: ${flag} needs a non-empty value.\nRun: gask --help`);
  return value;
}

function parseTimeout(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new ArgsError(`Error: --timeout must be a whole number of seconds, got "${raw}".\nRun: gask --help`);
  }
  const seconds = Number(raw.trim());
  if (seconds < 5 || seconds > 600) {
    throw new ArgsError("Error: --timeout must be between 5 and 600 seconds.\nRun: gask --help");
  }
  return seconds * 1000;
}

function parseCountry(raw: string): string {
  const value = raw.trim();
  if (!/^[A-Za-z]{2}$/.test(value)) {
    throw new ArgsError(`Error: --country must be a 2-letter code (e.g. US, GB, DE), got "${raw}".\nRun: gask --help`);
  }
  return value.toLowerCase();
}

function parseLang(raw: string): string {
  const value = raw.trim().replace("_", "-");
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/.test(value)) {
    throw new ArgsError(`Error: --lang must be a language code (e.g. en, en-US), got "${raw}".\nRun: gask --help`);
  }
  const [language, region] = value.split("-");
  return region ? `${language.toLowerCase()}-${region.toUpperCase()}` : language.toLowerCase();
}

export function validateQuestion(raw: string): string {
  const question = raw.trim();
  if (!question) {
    throw new ArgsError('Usage: gask "your question"\nRun: gask --help');
  }
  if (question.length > MAX_QUERY_CHARS) {
    throw new ArgsError(
      `Error: question is ${question.length} characters; Google AI Mode accepts at most ${MAX_QUERY_CHARS}.\nShorten it and retry.`
    );
  }
  return question;
}

export function helpText(): string {
  return `gask v${VERSION} - ask Google AI Mode from the terminal (headless Chrome)

Usage:
  gask "your question"                 ask Google AI Mode
  gask --login                         open headed Chrome to accept consent / sign in
  gask --headed "question"             show the Chrome window while asking
  echo "question" | gask               read the question from stdin

Flags:
  --login                  one-time setup with the persistent Chrome profile
  --headed                 use a visible Chrome window (debugging / blocked headless)
  --no-sources             do not print the sources list
  --ansi                   force styled terminal output
  --no-ansi                force raw Markdown output (default when piped)
  --timeout <seconds>      overall wait for the answer (5-600, default 90)
  --country <code>         Google country code, e.g. US, GB, DE (default us)
  --lang <code>            Google language, e.g. en, en-US (default en)
  --profile <dir>          Chrome profile directory (default: %LOCALAPPDATA%\\gask\\chrome-profile)
  --chrome <path>          Chrome/Edge executable (default: auto-detected)
  --debug-html <path>      save the rendered Google page HTML for troubleshooting
  -v, --verbose            print Chrome/profile/timing details to stderr
  -h, --help               show this help (also: gask help)
  -V, --version            print version

Setup:
  1. gask --login          accept Google consent or sign in once
  2. gask "latest Bun release?"
  No API key is required. Chrome (or Edge) must be installed.

Examples:
  gask "latest Bun release?"
  gask --country GB "top tech news today"
  gask --timeout 120 "compare the top 3 budget 4K monitors"
  gask --headed "why is AI Mode blocked?"`;
}
