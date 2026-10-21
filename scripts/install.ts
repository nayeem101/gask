import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const output = path.join(root, "gask.exe");

console.log("[gask] building gask.exe");
const build = Bun.spawnSync(
  [process.execPath, "build", "--compile", "src/index.ts", "--outfile", output],
  { cwd: root, stdout: "inherit", stderr: "inherit" }
);

if (build.exitCode !== 0) {
  console.error(`[gask] build failed with code ${build.exitCode ?? 1}`);
  process.exit(build.exitCode ?? 1);
}

if (!fs.existsSync(output)) {
  console.error(`[gask] build did not produce ${output}`);
  process.exit(1);
}

const binDir = path.join(os.homedir(), "bin");
fs.mkdirSync(binDir, { recursive: true });
const destination = path.join(binDir, "gask.exe");

try {
  fs.copyFileSync(output, destination);
} catch (error) {
  console.error(
    `[gask] could not copy to ${destination}: ${error instanceof Error ? error.message : String(error)}\nClose any running gask process and retry.`
  );
  process.exit(1);
}

console.log(`[gask] installed ${destination}`);

const normalize = (value: string): string =>
  process.platform === "win32" ? value.toLowerCase() : value;
const pathEntries = (process.env.PATH ?? "")
  .split(path.delimiter)
  .map((entry) => normalize(path.resolve(entry.trim())))
  .filter(Boolean);
const onPath = pathEntries.includes(normalize(binDir));

const check = Bun.spawnSync([destination, "--version"], {
  stdout: "pipe",
  stderr: "pipe",
});
const versionOutput = new TextDecoder().decode(check.stdout).trim();
if (check.exitCode === 0) {
  console.log(`[gask] verified: ${versionOutput || "gask --version"}`);
} else {
  console.error(`[gask] installed but ${destination} --version failed`);
}

if (!onPath) {
  console.log(`[gask] ${binDir} is not on PATH. Add it once with PowerShell:`);
  console.log(
    `[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";${binDir}", 'User')`
  );
  console.log("[gask] then restart your terminal.");
} else {
  console.log("[gask] ready in cmd, PowerShell, and Git Bash:");
  console.log('  gask "latest Bun release?"');
}
