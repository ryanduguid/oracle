import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getOracleHomeDir } from "../oracleHome.js";
import { windowsPowerShellExecutable } from "../windowsSystem.js";
import type { BrowserLogger } from "./types.js";

// Runs until Chrome exits. Every 500 ms it moves each visible Chrome root window just below the
// lowest window it overlaps, unless that window has focus (the user is using it).
const WINDOW_KEEPER_SCRIPT = `param([Parameter(Mandatory = $true)][int]$ChromePid, [switch]$Detach, [string]$ReadyFile)
$ErrorActionPreference = 'Stop'
if ($Detach) {
  # Node kills its non-detached children with it, and detached PowerShell gets no console.
  # Start-Process gives the keeper its own hidden console outside Node's job.
  $ready = Join-Path ([IO.Path]::GetTempPath()) ('oracle-window-keeper-{0}.ready' -f [guid]::NewGuid())
  $keeper = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', ('"{0}"' -f $PSCommandPath), '-ChromePid', $ChromePid, '-ReadyFile', ('"{0}"' -f $ready))
  for ($i = 0; $i -lt 100; $i++) {
    if (Test-Path -LiteralPath $ready) {
      Remove-Item -LiteralPath $ready
      $keeper.Id
      exit 0
    }
    if ($keeper.HasExited) {
      [Console]::Error.WriteLine('The keeper exited before it was ready.')
      exit 1
    }
    Start-Sleep -Milliseconds 100
  }
  "$($keeper.Id), not ready after 10 s"
  exit 0
}
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class OracleWindowKeeper {
  private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] private static extern IntPtr SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
  [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }

  private const uint GaRootOwner = 3;
  private const uint SwpNoSize = 0x1, SwpNoMove = 0x2, SwpNoActivate = 0x10, SwpAsyncWindowPos = 0x4000;
  private const int DwmwaCloaked = 14;

  // A window the user can see: visible, not minimised or cloaked, and not the desktop or a taskbar.
  private static bool IsShown(IntPtr hwnd, out Rect rect) {
    rect = new Rect();
    if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return false;
    int cloaked;
    if (DwmGetWindowAttribute(hwnd, DwmwaCloaked, out cloaked, 4) == 0 && cloaked != 0) return false;
    var name = new StringBuilder(64);
    GetClassName(hwnd, name, name.Capacity);
    string cls = name.ToString();
    if (cls == "Progman" || cls == "WorkerW" || cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd") return false;
    return GetWindowRect(hwnd, out rect) && rect.Right - rect.Left > 1 && rect.Bottom - rect.Top > 1;
  }

  private static uint ProcessOf(IntPtr hwnd) {
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    return pid;
  }

  // Moves each Chrome root window (its dialogs and bubbles follow) just below the lowest window it
  // overlaps, and reports whether anything moved. The window group that has focus stays put: the
  // user is using it. Windows refuses some windows as a position reference (a full-screen overlay
  // on this machine), so it tries the next one up.
  private static bool Tick(uint chromePid) {
    IntPtr focusedRoot = GetAncestor(GetForegroundWindow(), GaRootOwner);
    var windows = new List<IntPtr>();
    EnumWindows((hwnd, _) => { windows.Add(hwnd); return true; }, IntPtr.Zero);
    bool moved = false;
    for (int i = 0; i < windows.Count; i++) {
      Rect chrome;
      if (windows[i] == focusedRoot || ProcessOf(windows[i]) != chromePid || GetAncestor(windows[i], GaRootOwner) != windows[i] || !IsShown(windows[i], out chrome)) continue;
      var below = new List<IntPtr>();
      for (int j = i + 1; j < windows.Count; j++) {
        Rect other;
        if (ProcessOf(windows[j]) != chromePid && IsShown(windows[j], out other) &&
            other.Left < chrome.Right && chrome.Left < other.Right && other.Top < chrome.Bottom && chrome.Top < other.Bottom) {
          below.Add(windows[j]);
        }
      }
      for (int k = below.Count - 1; k >= 0; k--) {
        if (SetWindowPos(windows[i], below[k], 0, 0, 0, 0, SwpNoSize | SwpNoMove | SwpNoActivate | SwpAsyncWindowPos)) {
          moved = true;
          break;
        }
      }
    }
    return moved;
  }

  public static void Run(Process chrome) {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    uint chromePid = (uint)chrome.Id;
    int streak = 0;
    do {
      // Moving on ten ticks in a row means another window keeps taking the bottom; yield for a minute.
      if (!Tick(chromePid)) streak = 0;
      else if (++streak >= 10) {
        streak = 0;
        if (chrome.WaitForExit(60000)) return;
      }
    } while (!chrome.WaitForExit(500));
  }
}
'@
$chrome = [Diagnostics.Process]::GetProcessById($ChromePid)
# Holding a handle keeps exit checks on this Chrome even if Windows reuses its pid.
[void]$chrome.Handle
if ($ReadyFile) { Set-Content -LiteralPath $ReadyFile -Value 'ready' }
[OracleWindowKeeper]::Run($chrome)
`;

// Named by content, so a launch never rewrites a script that another launch is about to run.
export const WINDOW_KEEPER_SCRIPT_NAME = `chrome-window-keeper-${createHash("sha256")
  .update(WINDOW_KEEPER_SCRIPT)
  .digest("hex")
  .slice(0, 12)}.ps1`;

const exists = (filePath: string) =>
  access(filePath).then(
    () => true,
    () => false,
  );

/** Windows only: keep Oracle's Chrome behind other windows until that Chrome exits. */
export async function startChromeWindowKeeper(
  chromePid: number,
  logger: BrowserLogger,
): Promise<void> {
  const scriptPath = path.join(getOracleHomeDir(), WINDOW_KEEPER_SCRIPT_NAME);
  try {
    if (!(await exists(scriptPath))) {
      await mkdir(path.dirname(scriptPath), { recursive: true });
      const temporaryPath = `${scriptPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, WINDOW_KEEPER_SCRIPT, "utf8");
      await rename(temporaryPath, scriptPath).catch(async (error: unknown) => {
        await rm(temporaryPath, { force: true });
        if (!(await exists(scriptPath))) throw error;
      });
    }
    // The script relaunches itself hidden and prints the keeper's pid once ready.
    const { stdout } = await promisify(execFile)(
      windowsPowerShellExecutable(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-ChromePid",
        String(chromePid),
        "-Detach",
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    logger(
      `[browser] Keeping Chrome pid ${chromePid} behind other windows (keeper pid ${stdout.trim()}).`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger(`[browser] Could not start the Chrome window keeper: ${message}`);
  }
}
