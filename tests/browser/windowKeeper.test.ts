import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

const { execFileAsync } = vi.hoisted(() => ({ execFileAsync: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: execFileAsync }),
}));

afterEach(() => {
  setOracleHomeDirOverrideForTest(null);
  execFileAsync.mockReset();
});

test("starts the keeper through its hidden self-relaunch and logs its pid", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "oracle-window-keeper-"));
  setOracleHomeDirOverrideForTest(home);
  execFileAsync.mockResolvedValue({ stdout: "4321\r\n", stderr: "" });
  const logger = vi.fn();
  const { startChromeWindowKeeper, WINDOW_KEEPER_SCRIPT_NAME } =
    await import("../../src/browser/windowKeeper.js");
  try {
    await startChromeWindowKeeper(1234, logger as never);

    const scriptPath = path.join(home, WINDOW_KEEPER_SCRIPT_NAME);
    expect(execFileAsync).toHaveBeenCalledWith(
      expect.stringMatching(/System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/),
      expect.arrayContaining(["-NoProfile", "-File", scriptPath, "-ChromePid", "1234", "-Detach"]),
      { windowsHide: true, timeout: 20_000 },
    );
    expect(WINDOW_KEEPER_SCRIPT_NAME).toMatch(/^chrome-window-keeper-[0-9a-f]{12}\.ps1$/);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("(keeper pid 4321)"));
    expect(await readFile(scriptPath, "utf8")).toContain(
      "Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("logs instead of failing the run when the keeper cannot start", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "oracle-window-keeper-"));
  setOracleHomeDirOverrideForTest(home);
  execFileAsync.mockRejectedValue(new Error("spawn powershell.exe ENOENT"));
  const logger = vi.fn();
  const { startChromeWindowKeeper } = await import("../../src/browser/windowKeeper.js");
  try {
    await expect(startChromeWindowKeeper(1234, logger as never)).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining(
        "Could not start the Chrome window keeper: spawn powershell.exe ENOENT",
      ),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
