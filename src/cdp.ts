const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export { sleep };

export class CdpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpError";
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
};

type Listener = (params: unknown, sessionId?: string) => void;

export class CdpClient {
  private readonly url: string;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<Listener>>();
  private closed = false;

  constructor(url: string) {
    this.url = url;
  }

  async connect(timeoutMs = 10_000): Promise<void> {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new CdpError("Timed out connecting to Chrome DevTools."));
      }, timeoutMs);

      const cleanup = (): void => {
        clearTimeout(timer);
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };

      const onOpen = (): void => {
        cleanup();
        resolve();
      };

      const onError = (): void => {
        cleanup();
        reject(new CdpError("Failed to connect to Chrome DevTools."));
      };

      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });

    ws.addEventListener("message", (event: MessageEvent) => this.handleMessage(event.data));
    ws.addEventListener("close", () => this.handleClose());
  }

  private handleMessage(data: unknown): void {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      text = new TextDecoder().decode(data as ArrayBufferView);
    } else {
      text = String(data);
    }

    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      sessionId?: string;
      result?: unknown;
      error?: { message?: string; data?: string };
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const detail = message.error.data ? ` (${message.error.data})` : "";
        pending.reject(new CdpError(`${pending.method}: ${message.error.message ?? "Chrome error"}${detail}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      const exactKey = `${message.sessionId ?? ""}:${message.method}`;
      const wildcardKey = `*:${message.method}`;
      for (const key of [exactKey, wildcardKey]) {
        const listeners = this.listeners.get(key);
        if (!listeners) continue;
        for (const listener of listeners) {
          try {
            listener(message.params, message.sessionId);
          } catch {
            // ignore listener errors
          }
        }
      }
    }
  }

  private handleClose(): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError(`Chrome connection closed during ${pending.method}.`));
      this.pending.delete(id);
    }
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 15_000
  ): Promise<T> {
    if (this.closed || !this.ws) {
      return Promise.reject(new CdpError("Chrome DevTools connection is closed."));
    }

    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`Chrome command timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });

      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`Failed to send ${method}: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  on(method: string, listener: Listener, sessionId?: string): () => void {
    const key = `${sessionId ?? "*"}:${method}`;
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.listeners.delete(key);
    };
  }

  waitForEvent<T = unknown>(
    method: string,
    options: { sessionId?: string; timeoutMs?: number; predicate?: (params: T) => boolean } = {}
  ): Promise<T> {
    const { sessionId, timeoutMs = 15_000, predicate } = options;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`Timed out waiting for Chrome event: ${method}`));
      }, timeoutMs);

      const off = this.on(
        method,
        (params) => {
          const value = params as T;
          if (predicate && !predicate(value)) return;
          clearTimeout(timer);
          off();
          resolve(value);
        },
        sessionId
      );
    });
  }

  close(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.handleClose();
  }
}

export type PageSession = {
  targetId: string;
  sessionId: string;
  evaluate: <T = unknown>(expression: string, timeoutMs?: number) => Promise<T>;
  navigate: (url: string, timeoutMs?: number) => Promise<void>;
  resolveRedirect: (url: string, timeoutMs?: number) => Promise<string>;
  getHtml: () => Promise<string>;
  closeTarget: () => Promise<void>;
};

function localeFor(lang: string): string {
  if (lang.includes("-")) return lang;
  return lang === "en" ? "en-US" : lang;
}

function acceptLanguageFor(lang: string): string {
  const locale = localeFor(lang);
  const base = locale.split("-")[0] ?? locale;
  return locale === base ? base : `${locale},${base}`;
}

export async function attachPage(client: CdpClient, lang: string): Promise<PageSession> {
  const version = await client.send<{ product: string; userAgent: string }>("Browser.getVersion");
  const userAgent = version.userAgent
    .replace(/HeadlessChrome\//g, "Chrome/")
    .replace(/\sHeadless\s/g, " ")
    .trim();
  const fullVersion =
    version.product.match(/Chrome\/([\d.]+)/)?.[1] ??
    userAgent.match(/Chrome\/([\d.]+)/)?.[1] ??
    "0.0.0.0";
  const majorVersion = fullVersion.split(".")[0] ?? "0";
  const acceptLanguage = acceptLanguageFor(lang);

  const created = await client.send<{ targetId: string }>("Target.createTarget", {
    url: "about:blank",
  });
  const targetId = created.targetId;

  const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;

  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Network.enable", {}, sessionId);
  await client.send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId
  );
  await client.send(
    "Emulation.setUserAgentOverride",
    {
      userAgent,
      acceptLanguage,
      platform: "Win32",
      userAgentMetadata: {
        brands: [
          { brand: "Chromium", version: majorVersion },
          { brand: "Google Chrome", version: majorVersion },
          { brand: "Not_A Brand", version: "24" },
        ],
        fullVersionList: [
          { brand: "Chromium", version: fullVersion },
          { brand: "Google Chrome", version: fullVersion },
          { brand: "Not_A Brand", version: "24.0.0.0" },
        ],
        fullVersion,
        platform: "Windows",
        platformVersion: "10.0.0",
        architecture: "x86",
        model: "",
        mobile: false,
        bitness: "64",
        wow64: false,
      },
    },
    sessionId
  );
  try {
    await client.send("Emulation.setLocaleOverride", { locale: localeFor(lang) }, sessionId);
  } catch {
    // locale override is best-effort
  }
  await client.send(
    "Network.setExtraHTTPHeaders",
    { headers: { "Accept-Language": acceptLanguage } },
    sessionId
  );

  const evaluate = async <T = unknown>(expression: string, timeoutMs = 30_000): Promise<T> => {
    const result = await client.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        disableBreaks: true,
      },
      sessionId,
      timeoutMs
    );

    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "JavaScript evaluation failed";
      throw new CdpError(detail);
    }

    return result.result?.value as T;
  };

  const navigate = async (url: string, timeoutMs = 30_000): Promise<void> => {
    await client.send("Page.navigate", { url }, sessionId, 10_000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const state = await evaluate<string>("document.readyState", 5000);
        if (state === "interactive" || state === "complete") return;
      } catch {
        // execution context may be swapping during navigation
      }
      await sleep(150);
    }
    throw new CdpError(`Timed out loading ${url}`);
  };

  const resolveRedirect = async (rawUrl: string, timeoutMs = 12_000): Promise<string> => {
    let absolute: string;
    try {
      absolute = new URL(rawUrl, "https://www.google.com/").href;
    } catch {
      return "";
    }
    if (!/\/goto\?url=/i.test(absolute)) return absolute;

    let targetId = "";
    try {
      const target = await client.send<{ targetId: string }>(
        "Target.createTarget",
        { url: absolute },
        undefined,
        5_000
      );
      targetId = target.targetId;

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const info = await client.send<{ targetInfo?: { url?: string } }>(
          "Target.getTargetInfo",
          { targetId },
          undefined,
          5_000
        );
        const current = info.targetInfo?.url ?? "";
        if (
          current &&
          !current.startsWith("about:") &&
          !/\/goto\?url=/i.test(current) &&
          !/\/sorry\//i.test(current)
        ) {
          return current;
        }
        await sleep(250);
      }
      return "";
    } catch {
      return "";
    } finally {
      if (targetId) {
        try {
          await client.send("Target.closeTarget", { targetId }, undefined, 3_000);
        } catch {
          // target may already be closed
        }
      }
    }
  };

  const getHtml = (): Promise<string> => evaluate<string>("document.documentElement.outerHTML");

  const closeTarget = async (): Promise<void> => {
    try {
      await client.send("Target.closeTarget", { targetId }, undefined, 5000);
    } catch {
      // browser may already be closing
    }
  };

  return { targetId, sessionId, evaluate, navigate, resolveRedirect, getHtml, closeTarget };
}

export async function waitForValue<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 300
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    try {
      lastValue = await fn();
      if (predicate(lastValue)) return lastValue;
    } catch {
      // keep polling
    }
    await sleep(intervalMs);
  }
  if (lastValue !== undefined) return lastValue;
  throw new CdpError(`Condition was not met within ${Math.round(timeoutMs / 1000)}s.`);
}
