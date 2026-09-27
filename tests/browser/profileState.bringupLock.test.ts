import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  ORACLE_BRINGUP_LOCK_FILENAME,
  acquireProfileRunLock,
} from "../../src/browser/profileState.js";

describe("browser bring-up lock", () => {
  test("uses its own file, so a held automation lock does not block bring-up", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-bringup-"));
    try {
      const automation = await acquireProfileRunLock(dir, { timeoutMs: 500, pollMs: 50 });
      const bringup = await acquireProfileRunLock(dir, {
        timeoutMs: 500,
        pollMs: 50,
        lockFilename: ORACLE_BRINGUP_LOCK_FILENAME,
      });
      expect(bringup?.path).toBe(path.join(dir, ORACLE_BRINGUP_LOCK_FILENAME));
      expect((await readdir(dir)).sort()).toEqual(
        ["oracle-automation.lock", ORACLE_BRINGUP_LOCK_FILENAME].sort(),
      );
      await bringup?.release();
      await automation?.release();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a second bring-up waits for the first and never steals a live owner's lock", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "oracle-bringup-"));
    try {
      const first = await acquireProfileRunLock(dir, {
        timeoutMs: 500,
        pollMs: 50,
        lockFilename: ORACLE_BRINGUP_LOCK_FILENAME,
      });
      await expect(
        acquireProfileRunLock(dir, {
          timeoutMs: 150,
          pollMs: 50,
          lockFilename: ORACLE_BRINGUP_LOCK_FILENAME,
        }),
      ).rejects.toThrow(/still held by pid/);
      await first?.release();
      const second = await acquireProfileRunLock(dir, {
        timeoutMs: 500,
        pollMs: 50,
        lockFilename: ORACLE_BRINGUP_LOCK_FILENAME,
      });
      expect(second).not.toBeNull();
      await second?.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
