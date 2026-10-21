#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import {
  ArgsError,
  VERSION,
  helpText,
  parseArgs,
  validateQuestion,
  type Options,
} from "./args";
import {
  acquireProfileLock,
  ChromeLaunchError,
  ChromeNotFoundError,
  defaultProfileDir,
  launchChrome,
  ProfileBusyError,
  resolveChrome,
  type ChromeProcess,
  type ProfileLock,
} from "./chrome";
import { attachPage, CdpClient, CdpError, type PageSession } from "./cdp";
import { AiModeError, scrapeAiMode } from "./aimode";
import { formatSourcesMarkdown, renderMarkdownAnsi } from "./format";
import { startSpinner, type Spinner } from "./spinner";

type Session = {
  chromePath: string;
  profileDir: string;
  chrome: ChromeProcess;
  client: CdpClient;
  page: PageSession;
  lock: ProfileLock;
  spinner?: Spinner;
};

let activeCleanup: (() => Promise<void>) | null = null;
let shuttingDown = false;

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const cleanup = activeCleanup;
  activeCleanup = null;
  if (cleanup) {
    try {
      await cleanup();
    } catch {
      // ignore cleanup errors during shutdown
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => {
  void shutdown(130);
});

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function openSession(options: Options, headed: boolean): Promise<Session> {
  const chromePath = resolveChrome(options.chrome);
  const profileDir = options.profile ? path.resolve(options.profile) : defaultProfileDir();
  const lock = await acquireProfileLock(profileDir);

  let chrome: ChromeProcess | undefined;
  let client: CdpClient | undefined;
  try {
    chrome = await launchChrome({
      chromePath,
      profileDir,
      headed,
      lang: options.lang,
    });
    client = new CdpClient(`ws://127.0.0.1:${chrome.port}${chrome.browserWsPath}`);
    await client.connect();
    const page = await attachPage(client, options.lang);
    return { chromePath, profileDir, chrome, client, page, lock };
  } catch (error) {
    try {
      if (client) await client.send("Browser.close", {}, undefined, 3000);
    } catch {
      // ignore
    }
    client?.close();
    if (chrome) {
      if (!(await chrome.waitForExit(1500))) await chrome.kill();
    }
    lock.release();
    throw error;
  }
}

async function closeSession(session: Session): Promise<void> {
  session.spinner?.stop();
  try {
    await session.page.closeTarget();
  } catch {
    // ignore
  }
  try {
    await session.client.send("Browser.close", {}, undefined, 3000);
  } catch {
    // Browser.close often closes the socket before replying
  }
  session.client.close();
  const exited = await session.chrome.waitForExit(3000);
  if (!exited) await session.chrome.kill();
  session.lock.release();
}

function saveHtml(file: string, html: string): void {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html, "utf8");
  console.error(`[gask] saved rendered HTML to ${target}`);
}

function printAnswer(answer: string, useAnsi: boolean): void {
  const rendered = useAnsi ? renderMarkdownAnsi(answer) : answer;
  process.stdout.write(`${rendered.replace(/\s+$/, "")}\n`);
}

function printSources(sources: { title: string; url: string }[], useAnsi: boolean): void {
  if (sources.length === 0) return;
  const markdown = formatSourcesMarkdown(sources);
  process.stdout.write("\n");
  process.stdout.write(useAnsi ? renderMarkdownAnsi(markdown) : markdown);
}

async function waitForEnter(label: string): Promise<void> {
  process.stdout.write(`${label}\n`);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });
  process.stdin.pause();
}

async function runLogin(options: Options): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new ArgsError("--login must be run in an interactive terminal.");
  }

  const spinner = startSpinner("opening Chrome");
  const session = await openSession(options, true);
  session.spinner = spinner;
  spinner.stop();

  console.log("A Chrome window is open with the gask profile.");
  console.log("Accept Google consent and sign in if you want AI Mode to use your account.");
  console.log(`Profile: ${session.profileDir}`);
  await waitForEnter("Press Enter here to close Chrome.");

  await closeSession(session);
  activeCleanup = null;
  console.log("Profile saved. Try: gask \"latest Bun release?\"");
}

async function runAsk(options: Options, question: string): Promise<void> {
  const spinner = startSpinner("asking Google AI Mode");
  const startedAt = Date.now();
  let session: Session | undefined;

  try {
    session = await openSession(options, options.headed);
    session.spinner = spinner;
    activeCleanup = () => closeSession(session!);

    const result = await scrapeAiMode(session.page, question, {
      country: options.country,
      lang: options.lang,
      timeoutMs: options.timeoutMs,
      verbose: options.verbose ? (message) => console.error(`[gask] ${message}`) : undefined,
    });

    spinner.stop();
    if (options.debugHtml) saveHtml(options.debugHtml, result.html);

    const useAnsi = options.ansi ?? Boolean(process.stdout.isTTY);
    printAnswer(result.answer, useAnsi);
    if (!options.noSources) printSources(result.sources, useAnsi);

    if (options.verbose) {
      console.error(
        `[gask] chrome=${session.chromePath}\n[gask] profile=${session.profileDir}\n[gask] format=${useAnsi ? "ansi" : "markdown"}\n[gask] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s, sources=${result.sources.length}`
      );
    }
  } catch (error) {
    spinner.stop();
    if (options.debugHtml && session) {
      try {
        saveHtml(options.debugHtml, await session.page.getHtml());
      } catch {
        // page may be gone
      }
    }
    throw error;
  } finally {
    activeCleanup = null;
    if (session) await closeSession(session);
  }
}

function printError(error: unknown, verbose: boolean): void {
  if (
    error instanceof ArgsError ||
    error instanceof ChromeNotFoundError ||
    error instanceof ChromeLaunchError ||
    error instanceof ProfileBusyError ||
    error instanceof AiModeError ||
    error instanceof CdpError
  ) {
    console.error(error.message);
    if (verbose && error.stack) console.error(error.stack);
    return;
  }
  if (error instanceof Error) {
    console.error(error.message);
    if (verbose && error.stack) console.error(error.stack);
    return;
  }
  console.error(String(error));
}

async function main(): Promise<void> {
  let options: Options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    printError(error, false);
    process.exitCode = 1;
    return;
  }

  if (options.version) {
    console.log(`gask ${VERSION}`);
    return;
  }
  if (options.help) {
    console.log(helpText());
    return;
  }

  try {
    if (options.login) {
      await runLogin(options);
      return;
    }

    let question = options.questionParts.join(" ").trim();
    if (!question) question = await readStdin();
    question = validateQuestion(question);

    await runAsk(options, question);
  } catch (error) {
    printError(error, options.verbose);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
