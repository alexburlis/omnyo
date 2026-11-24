import { extname } from "node:path";
import { whichCommandSync } from "which-command";

export function resolveExecutable(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv },
): string | undefined {
  const windows = process.platform === "win32";
  const envKeys = Object.keys(options.env).sort();

  const pathKey = windows
    ? envKeys.find((key) => key.toUpperCase() === "PATH")
    : "PATH";

  const pathExtKey = envKeys.find((key) => key.toUpperCase() === "PATHEXT");
  const commandExtension = extname(command);
  const pathExt = options.env[pathExtKey ?? "PATHEXT"] || ".EXE;.COM;.CMD;.BAT";

  return whichCommandSync(command, {
    cwd: options.cwd,
    path: options.env[pathKey ?? "PATH"] ?? "",
    pathExt:
      windows && commandExtension ? `${commandExtension};${pathExt}` : pathExt,
  });
}
