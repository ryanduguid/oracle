import { afterEach, expect, test, vi } from "vitest";
import { canSpawnForTest } from "../../src/remote/server.js";

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync,
}));

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  spawnSync.mockReset();
});

test("looks up Windows login openers with where.exe by absolute path", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  spawnSync.mockReturnValue({ status: 1 });

  expect(canSpawnForTest("start")).toBe(false);
  // A bare `where` would let the working directory supply the lookup helper.
  expect(spawnSync).toHaveBeenCalledWith(
    expect.stringMatching(/^[A-Za-z]:[\\/].*System32[\\/]where\.exe$/),
    ["start"],
    { stdio: "ignore" },
  );
});
