const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export function spinnerEnabled(): boolean {
  return !!process.stderr.isTTY && process.env.TERM !== "dumb";
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 1 ? "" : ` (${s}s)`;
}

export type Spinner = { stop: () => void };

const noopSpinner: Spinner = { stop: () => {} };

let cursorHidden = false;

function hideCursor(): void {
  if (cursorHidden) return;
  cursorHidden = true;
  process.stderr.write("\x1B[?25l");
}

function showCursor(): void {
  if (!cursorHidden) return;
  cursorHidden = false;
  process.stderr.write("\x1B[?25h");
}

let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => showCursor());
}

export function startSpinner(label = "asking Google AI Mode"): Spinner {
  if (!spinnerEnabled()) return noopSpinner;
  installExitHook();
  const startedAt = Date.now();
  hideCursor();
  let frame = 0;
  let stopped = false;
  const render = (): void => {
    process.stderr.write(
      `\r${FRAMES[frame % FRAMES.length]} ${label}…${formatElapsed(Date.now() - startedAt)}`
    );
  };
  render();
  const timer = setInterval(() => {
    frame++;
    render();
  }, INTERVAL_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      process.stderr.write("\r\x1B[K");
      showCursor();
    },
  };
}
