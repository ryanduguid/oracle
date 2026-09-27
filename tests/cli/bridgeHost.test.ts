import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveBridgeHostToken, startReverseTunnelForTest } from "../../src/cli/bridge/host.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
}));

let dir: string;
let artifact: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-"));
  artifact = path.join(dir, "bridge-connection.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedArtifact(token: string): Promise<void> {
  await writeFile(artifact, JSON.stringify({ remoteHost: "127.0.0.1:9473", remoteToken: token }));
}

describe("resolveBridgeHostToken", () => {
  test("uses the explicit token when provided", async () => {
    await seedArtifact("artifact-token");
    expect(await resolveBridgeHostToken("explicit-token", true, artifact)).toBe("explicit-token");
  });

  test("explicit --token auto generates a fresh token even on the respawn path", async () => {
    await seedArtifact("artifact-token");
    const generated = await resolveBridgeHostToken("auto", true, artifact);
    expect(generated).not.toBe("artifact-token");
    expect(generated).toMatch(/^[0-9a-f]{32}$/);
  });

  test("auto regenerates on each call", async () => {
    const a = await resolveBridgeHostToken("auto", false, artifact);
    const b = await resolveBridgeHostToken("auto", false, artifact);
    expect(a).not.toBe(b);
  });

  test("the internal --respawn child reuses the artifact token", async () => {
    await seedArtifact("handoff-token");
    expect(await resolveBridgeHostToken(undefined, true, artifact)).toBe("handoff-token");
  });

  test("respawn generates a fresh token when the artifact is missing or invalid", async () => {
    expect(await resolveBridgeHostToken(undefined, true, artifact)).toMatch(/^[0-9a-f]{32}$/);
    await writeFile(artifact, "not json");
    expect(await resolveBridgeHostToken(undefined, true, artifact)).toMatch(/^[0-9a-f]{32}$/);
    await writeFile(artifact, JSON.stringify({ remoteToken: "  " }));
    expect(await resolveBridgeHostToken(undefined, true, artifact)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("an ordinary restart rotates the credential even when an artifact exists", async () => {
    await seedArtifact("previous-run-token");
    const generated = await resolveBridgeHostToken(undefined, false, artifact);
    expect(generated).not.toBe("previous-run-token");
    expect(generated).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("reverse SSH tunnel on Windows", () => {
  const originalCwd = process.cwd();
  const originalPlatform = process.platform;
  const tunnel = { sshTarget: "user@host", remotePort: 9473, localPort: 9473, log: () => {} };

  afterEach(() => {
    process.chdir(originalCwd);
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.unstubAllEnvs();
    spawn.mockReset();
  });

  // The working directory holds a planted ssh.exe and PATH also reaches it through ".".
  async function plantSshInWorkingDirectory(pathDirs: string[]): Promise<void> {
    const project = path.join(dir, "project");
    await mkdir(project);
    await writeFile(path.join(project, "ssh.exe"), "");
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.stubEnv("PATH", [".", ...pathDirs].join(path.delimiter));
    process.chdir(project);
  }

  test("spawns ssh from absolute PATH entries only, in libuv's order", async () => {
    const empty = path.join(dir, "empty");
    const bin = path.join(dir, "bin");
    await mkdir(empty);
    await mkdir(bin);
    await writeFile(path.join(bin, "ssh.com"), "");
    await writeFile(path.join(bin, "ssh.exe"), "");
    await plantSshInWorkingDirectory([empty, bin]);
    spawn.mockReturnValue(Object.assign(new EventEmitter(), { pid: 1, kill: vi.fn() }));

    startReverseTunnelForTest(tunnel).stop();

    expect(spawn).toHaveBeenCalledWith(path.join(bin, "ssh.com"), expect.any(Array), {
      stdio: "ignore",
    });
  });

  test("fails instead of spawning a bare ssh when no absolute PATH entry has it", async () => {
    await plantSshInWorkingDirectory([]);

    expect(() => startReverseTunnelForTest(tunnel)).toThrow("--ssh requires ssh on PATH");
    expect(spawn).not.toHaveBeenCalled();
  });
});
