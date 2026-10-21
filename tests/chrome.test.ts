import { describe, expect, test } from "bun:test";
import path from "node:path";
import { chromeCandidates, defaultProfileDir } from "../src/chrome";

describe("chromeCandidates", () => {
  test("includes Chrome and Edge under the Windows program roots", () => {
    const candidates = chromeCandidates(
      {
        ProgramFiles: "C:\\Program Files",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      },
      "win32"
    );
    expect(candidates).toContain(
      path.join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe")
    );
    expect(candidates).toContain(
      path.join("C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")
    );
    expect(candidates).toContain(
      path.join("C:\\Users\\me\\AppData\\Local", "Google", "Chrome", "Application", "chrome.exe")
    );
  });

  test("prefers GASK_CHROME and de-duplicates", () => {
    const candidates = chromeCandidates(
      {
        GASK_CHROME: "D:\\Chrome\\chrome.exe",
        CHROME_PATH: "D:\\Chrome\\chrome.exe",
      },
      "win32"
    );
    expect(candidates[0]).toBe("D:\\Chrome\\chrome.exe");
    expect(candidates.filter((item) => item === "D:\\Chrome\\chrome.exe")).toHaveLength(1);
  });
});

describe("defaultProfileDir", () => {
  test("uses LOCALAPPDATA on Windows", () => {
    expect(defaultProfileDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32")).toBe(
      path.join("C:\\Users\\me\\AppData\\Local", "gask", "chrome-profile")
    );
  });

  test("honors GASK_PROFILE", () => {
    expect(
      defaultProfileDir(
        { GASK_PROFILE: "D:\\profiles\\gask", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        "win32"
      )
    ).toBe(path.resolve("D:\\profiles\\gask"));
  });
});
