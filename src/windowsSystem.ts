import { lstatSync } from "node:fs";
import path from "node:path";

// Windows searches the working directory (often the user's project) before PATH for a bare
// executable name, so Oracle runs Windows system helpers by absolute path.
export function windowsSystemExecutable(relativePath: string): string {
  return path.join(process.env.SystemRoot ?? "C:/Windows", "System32", relativePath);
}

export function windowsPowerShellExecutable(): string {
  return windowsSystemExecutable("WindowsPowerShell/v1.0/powershell.exe");
}

// On Windows, resolves a PATH tool as libuv would (`name.com`, then `name.exe`, in PATH order)
// but skips the working directory and relative PATH entries. Returns null when no absolute
// entry has it; callers must report that rather than spawn the bare name. Other platforms get
// the bare name.
export function pathToolExecutable(name: string): string | null {
  if (process.platform !== "win32") return name;
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (!path.isAbsolute(dir)) continue;
    for (const extension of [".com", ".exe"]) {
      const candidate = path.join(dir, name + extension);
      // lstat, unlike stat, accepts app execution aliases, which libuv also runs.
      const stats = lstatSync(candidate, { throwIfNoEntry: false });
      if (stats && !stats.isDirectory()) return candidate;
    }
  }
  return null;
}
