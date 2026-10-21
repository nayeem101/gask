import fs from "node:fs";
import path from "node:path";
import { acquireProfileLock, defaultProfileDir, launchChrome, resolveChrome } from "../src/chrome";
import { attachPage, CdpClient, sleep } from "../src/cdp";

const rawArgs = process.argv.slice(2);
const headless = !rawArgs.includes("--headed");
const query = rawArgs.filter((arg) => !arg.startsWith("--")).join(" ").trim() || "what is the capital of France?";
const profileDir = defaultProfileDir();
const chromePath = resolveChrome();
const lock = await acquireProfileLock(profileDir);
const chrome = await launchChrome({ chromePath, profileDir, headed: !headless, lang: "en" });
const client = new CdpClient(`ws://127.0.0.1:${chrome.port}${chrome.browserWsPath}`);

try {
  await client.connect();
  const page = await attachPage(client, "en");

  const probeState = async (label: string): Promise<void> => {
    const state = await page.evaluate<Record<string, unknown>>(`(() => ({
      url: location.href,
      title: document.title,
      webdriver: navigator.webdriver,
      userAgent: navigator.userAgent,
      uaData: navigator.userAgentData ? {
        brands: navigator.userAgentData.brands,
        mobile: navigator.userAgentData.mobile,
        platform: navigator.userAgentData.platform
      } : null,
      language: navigator.language,
      languages: navigator.languages,
      body: document.body ? document.body.innerText.slice(0, 3000) : '',
      htmlLength: document.documentElement.outerHTML.length
    }))()`);
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(state, null, 2));
    fs.mkdirSync("probe-output", { recursive: true });
    fs.writeFileSync(path.join("probe-output", `${label}.html`), await page.getHtml(), "utf8");
  };

  await page.navigate("https://www.google.com/search?q=test&hl=en&gl=us", 30_000);
  await sleep(3000);
  await probeState("plain-search");

  const url = `https://www.google.com/search?udm=50&q=${encodeURIComponent(query)}&hl=en&gl=us`;
  await page.navigate(url, 35_000);
  await sleep(8000);
  await probeState("ai-mode");

  const cards = await page.evaluate<Array<{ label: string; href: string }>>(`(() => {
    const rhs = document.querySelector('[data-container-id="rhs-col"]');
    if (!rhs) return [];
    const seen = new Set();
    const items = [];
    rhs.querySelectorAll('a[href*="/goto?url="]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const label = (a.getAttribute('aria-label') || a.innerText || '').replace(/\\s+/g, ' ').trim();
      if (!href || seen.has(href)) return;
      seen.add(href);
      items.push({ label, href });
    });
    return items;
  })()`);
  const sources = [];
  for (const card of cards) {
    sources.push({ ...card, href: card.href.slice(0, 60), resolved: await page.resolveRedirect(card.href) });
  }
  console.log("\n=== sources ===");
  console.log(JSON.stringify({ count: sources.length, sources }, null, 2));

  await page.navigate("https://www.google.com/", 25_000);
  await sleep(2000);
  await probeState("homepage");
} finally {
  try {
    await client.send("Browser.close", {}, undefined, 3000);
  } catch {
    // ignore
  }
  client.close();
  if (!(await chrome.waitForExit(2000))) await chrome.kill();
  lock.release();
}
