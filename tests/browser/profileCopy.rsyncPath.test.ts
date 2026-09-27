import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { copyChromeProfile } from "../../src/browser/profileCopy.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

const originalPlatform = process.platform;
let dir: string;
let src: string;
let dest: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "oracle-copyprofile-rsync-"));
  src = path.join(dir, "src");
  dest = path.join(dir, "dest");
  await mkdir(path.join(src, "Default"), { recursive: true });
  await writeFile(path.join(src, "Local State"), "{}");
  await mkdir(dest);
  Object.defineProperty(process, "platform", { value: "win32" });
});

afterEach(async () => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.unstubAllEnvs();
  spawn.mockReset();
  await rm(dir, { recursive: true, force: true });
});

test("runs rsync from its absolute PATH location on Windows", async () => {
  const bin = path.join(dir, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "rsync.exe"), "");
  vi.stubEnv("PATH", bin);
  spawn.mockImplementation(() => {
    const child = new EventEmitter();
    setImmediate(() => child.emit("close", 0));
    return child;
  });

  await expect(copyChromeProfile(src, dest)).resolves.toBe("Default");
  expect(spawn).toHaveBeenCalledWith(path.join(bin, "rsync.exe"), expect.any(Array), {
    stdio: "ignore",
  });
});

test("fails without spawning a bare rsync when no absolute PATH entry has it", async () => {
  vi.stubEnv("PATH", ".");

  await expect(copyChromeProfile(src, dest)).rejects.toThrow(
    "--copy-profile requires rsync on PATH",
  );
  expect(spawn).not.toHaveBeenCalled();
  // The copied Local State holds the cookie key, so the partial profile must be gone.
  await expect(stat(dest)).rejects.toThrow();
});
