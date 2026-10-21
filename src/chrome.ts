import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class ChromeNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromeNotFoundError";
  }
}

export class ChromeLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromeLaunchError";
  }
}

export class ProfileBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileBusyError";
  }
}

type Env = Record<string, string | undefined>;

export function chromeCandidates(env: Env = process.env, platform: string = process.platform): string[] {
  const candidates: string[] = [];
  if (env.GASK_CHROME) candidates.push(env.GASK_CHROME);
  if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);

  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(
      (value): value is string => !!value
    );
    for (const root of roots) {
      candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
      candidates.push(path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"));
    }
    candidates.push("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    candidates.push("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
  } else if (platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    candidates.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
    candidates.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
  } else {
    candidates.push("/usr/bin/google-chrome");
    candidates.push("/usr/bin/google-chrome-stable");
    candidates.push("/usr/bin/chromium");
    candidates.push("/usr/bin/chromium-browser");
    candidates.push("/snap/bin/chromium");
    candidates.push("/usr/bin/microsoft-edge");
  }

  return [...new Set(candidates)];
}

export function resolveChrome(explicit?: string): string {
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new ChromeNotFoundError(
      `Chrome executable not found at "${explicit}".\nPass a valid path with --chrome or set GASK_CHROME.`
    );
  }

  for (const candidate of chromeCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const names = ["chrome", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "msedge", "microsoft-edge"];
  for (const name of names) {
    const found = Bun.which(name);
    if (found) return found;
  }

  throw new ChromeNotFoundError(
    "Chrome or Edge was not found.\nInstall Google Chrome, or pass --chrome <path> / set GASK_CHROME."
  );
}

export function defaultProfileDir(env: Env = process.env, platform: string = process.platform): string {
  if (env.GASK_PROFILE?.trim()) return path.resolve(env.GASK_PROFILE.trim());
  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "gask", "chrome-profile");
  }
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "gask", "chrome-profile");
  }
  const dataHome = env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "gask", "chrome-profile");
}

export type ProfileLock = { release: () => void };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function acquireProfileLock(profileDir: string, waitMs = 5000): Promise<ProfileLock> {
  fs.mkdirSync(profileDir, { recursive: true });
  const lockPath = path.join(profileDir, ".gask.lock");
  const deadline = Date.now() + waitMs;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // ignore
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 10 * 60 * 1000) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // lock disappeared between checks
      }
      if (Date.now() >= deadline) {
        throw new ProfileBusyError(
          `Another gask run is using the Chrome profile:\n  ${profileDir}\nWait for it to finish, or use --profile <dir>.`
        );
      }
      await sleep(200);
    }
  }
}

export type LaunchOptions = {
  chromePath: string;
  profileDir: string;
  headed: boolean;
  lang: string;
};

export type ChromeProcess = {
  proc: Bun.Subprocess;
  port: number;
  browserWsPath: string;
  profileDir: string;
  stderrOutput: () => string;
  waitForExit: (timeoutMs: number) => Promise<boolean>;
  kill: () => Promise<void>;
};

export async function launchChrome(options: LaunchOptions): Promise<ChromeProcess> {
  const { chromePath, profileDir, headed, lang } = options;
  fs.mkdirSync(profileDir, { recursive: true });

  const portFile = path.join(profileDir, "DevToolsActivePort");
  try {
    fs.rmSync(portFile, { force: true });
  } catch {
    // ignore
  }

  const args = [
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-component-update",
    "--disable-component-extensions-with-background-pages",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-client-side-phishing-detection",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-hang-monitor",
    "--disable-ipc-flooding-protection",
    "--disable-save-password-bubble",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication",
    "--metrics-recording-only",
    "--mute-audio",
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--force-device-scale-factor=1",
    "--window-size=1280,900",
    `--lang=${lang}`,
    "--password-store=basic",
    "--use-mock-keychain",
  ];

  if (!headed) args.unshift("--headless=new");

  const proc = Bun.spawn([chromePath, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });

  let stderrText = "";
  const stderrStream = proc.stderr;
  if (stderrStream && typeof stderrStream !== "number") {
    void (async () => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of stderrStream as ReadableStream<Uint8Array>) {
          stderrText += decoder.decode(chunk, { stream: true });
          if (stderrText.length > 16_000) stderrText = stderrText.slice(-16_000);
        }
      } catch {
        // ignore
      }
    })();
  }

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) return true;
      await sleep(100);
    }
    return proc.exitCode !== null;
  };

  const kill = async (): Promise<void> => {
    if (proc.exitCode !== null) return;
    try {
      proc.kill();
    } catch {
      // ignore
    }
    const exited = await waitForExit(2000);
    if (!exited && process.platform === "win32") {
      try {
        Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        // ignore
      }
    }
  };

  const stderrOutput = (): string => stderrText.trim();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const lines = fs.readFileSync(portFile, "utf8").split(/\r?\n/);
      const port = Number(lines[0]?.trim());
      const browserWsPath = lines[1]?.trim();
      if (
        Number.isInteger(port) &&
        port > 0 &&
        browserWsPath !== undefined &&
        browserWsPath.startsWith("/devtools/browser/")
      ) {
        return {
          proc,
          port,
          browserWsPath,
          profileDir,
          stderrOutput,
          waitForExit,
          kill,
        };
      }
    } catch {
      // file not ready yet
    }

    if (proc.exitCode !== null) {
      const detail = stderrOutput();
      throw new ChromeLaunchError(
        `Chrome exited before it was ready (code ${proc.exitCode}).${detail ? `\n${detail}` : ""}`
      );
    }

    await sleep(100);
  }

  await kill();
  const detail = stderrOutput();
  throw new ChromeLaunchError(
    `Chrome did not open a debugging port within 20s.${detail ? `\n${detail}` : ""}`
  );
}
