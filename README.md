# gask

Ask Google Search AI Mode from the terminal and print a formatted answer with its sources.

`gask` drives your installed Chrome in headless mode through the DevTools protocol.
There is no API key and no third-party service in the middle: the query is a normal
Google search using a persistent local Chrome profile.

Answers are printed as Markdown (headings, lists, bold text, inline code, code blocks,
and tables). On an interactive terminal, `gask` renders that Markdown with ANSI styling
automatically. When output is piped, it stays raw Markdown.

## Requirements

- Windows 10/11 (cmd, PowerShell, or Git Bash).
- Google Chrome (or Microsoft Edge) installed.
- [Bun](https://bun.sh) only if you build from source. The compiled `gask.exe` has no runtime dependency.

## Install

From this directory:

```sh
bun install
bun run install:local
```

`install:local` builds `gask.exe`, copies it to `%USERPROFILE%\bin\gask.exe`, and
checks that `--version` runs. Make sure `%USERPROFILE%\bin` is on your `PATH`.

To run without installing:

```sh
bun src/index.ts "What is the capital of France?"
```

## Usage

```sh
gask "What is the capital of France?"
gask --no-sources "latest Bun release?"
gask --ansi "list the key new features in Bun 1.4"
gask --country GB "top tech news today"
gask --timeout 120 "compare the top 3 budget 4K monitors"
echo "how tall is Mount Everest?" | gask
```

The answer goes to stdout. Progress and diagnostics go to stderr, so pipes stay clean:

```sh
gask "latest Bun release?"
```

Raw Markdown is the default when piped, which makes it easy to save or post-process:

```sh
gask "latest Bun release?" > answer.md
gask --no-ansi --no-sources "latest Bun release?" | head -n 5
```

### Output formatting

- Default on a terminal: Markdown rendered with ANSI styling (bold, bullets, headings,
  inline code, code blocks, and aligned tables).
- Default when piped or redirected: raw Markdown.
- `--ansi`: force styled terminal output.
- `--no-ansi`: force raw Markdown even on a terminal.

Sources are printed as a Markdown `## Sources` list with links, so the whole output can
be saved as a `.md` file.

### Flags

| Flag | Description |
| --- | --- |
| `--login` | Open headed Chrome once to accept consent or sign in. |
| `--headed` | Show the Chrome window while asking (debugging, CAPTCHA checks). |
| `--no-sources` | Print only the answer. |
| `--ansi` | Force styled terminal output. |
| `--no-ansi` | Force raw Markdown output. |
| `--timeout <seconds>` | Overall answer wait, 5-600 (default 90). |
| `--country <code>` | Google country, e.g. `US`, `GB`, `DE` (default `us`). |
| `--lang <code>` | Google language, e.g. `en`, `en-US` (default `en`). |
| `--profile <dir>` | Chrome profile directory. |
| `--chrome <path>` | Chrome or Edge executable. |
| `--debug-html <path>` | Save the rendered Google page HTML. |
| `-v`, `--verbose` | Print Chrome path, profile, timing, and source resolution to stderr. |
| `-h`, `--help` | Show help. |
| `-V`, `--version` | Print the version. |

## How it works

1. Finds your installed Chrome and launches it headless with a private persistent
   profile at `%LOCALAPPDATA%\gask\chrome-profile`.
2. Attaches to a tab through the Chrome DevTools Protocol.
3. Opens a plain Google search first, then navigates to AI Mode (`udm=50`).
4. Waits until the generated answer stops changing.
5. Converts the answer DOM to Markdown and extracts the source cards. Google wraps
   source links in `/goto?url=...` redirects, so each redirect is resolved in a
   background tab.
6. Prints the Markdown answer, then a `## Sources` list. On a terminal, the Markdown
   is rendered with ANSI styling.
7. Closes the tab and Chrome, and releases the profile lock.

## First run and blocks

If Google shows a consent screen, run:

```sh
gask --login
```

If Google reports unusual traffic or asks for a CAPTCHA:

- Wait a while and retry.
- Run `gask --headed "your question"` and complete the check in the window.
- Sign in once with `gask --login` if AI Mode needs an account in your region.

`gask` does not attempt to bypass CAPTCHAs.

AI Mode availability varies by country and account. If it is unavailable, try
`--country` and `--lang`, or sign in.

## Troubleshooting

- **Chrome not found.** Pass `--chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"`
  or set `GASK_CHROME`.
- **Profile is busy.** Another `gask` or Chrome instance is using the profile.
  Close it and retry, or use `--profile` with a different directory.
- **Timeout or empty answer.** Retry with `--timeout 120`, then `--headed` to watch
  the page, and `--debug-html out.html` to keep the rendered HTML.
- **Missing sources.** Some answers have no source cards. Use `-v` to see redirect
  resolution and fallback extraction.

## Privacy

Queries are sent to Google exactly as a normal search in your browser. The only
persistent data is the Chrome profile (cookies and settings) under
`%LOCALAPPDATA%\gask\chrome-profile`. Use `--profile` to choose another location,
or delete that directory to reset.

## Development

```sh
bun test
bun run typecheck
bun run probe "What is the capital of France?"
bun run build
```

The live probe writes page snapshots to `probe-output/` for debugging.

Source layout:

- `src/args.ts` - argument parsing, validation, help.
- `src/chrome.ts` - Chrome discovery, profile lock, process launch.
- `src/cdp.ts` - minimal Chrome DevTools Protocol client.
- `src/aimode.ts` - navigation, Markdown answer/source extraction, error classification.
- `src/format.ts` - Markdown-to-ANSI rendering and source formatting.
- `src/spinner.ts` - stderr spinner.
- `src/index.ts` - CLI orchestration and output.
- `scripts/probe.ts` - live AI Mode probe.
- `scripts/install.ts` - build and local install.
