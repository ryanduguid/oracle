import path from "node:path";

// Windows searches the working directory (often the user's project) before PATH for a bare
// executable name, so Oracle runs Windows system helpers by absolute path.
export function windowsSystemExecutable(relativePath: string): string {
  return path.join(process.env.SystemRoot ?? "C:/Windows", "System32", relativePath);
}

export function windowsPowerShellExecutable(): string {
  return windowsSystemExecutable("WindowsPowerShell/v1.0/powershell.exe");
}
