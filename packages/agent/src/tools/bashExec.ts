import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";

export interface BashExecInput {
  terminal?: string;
  prompt: string;
}

export interface BashExecResult {
  terminal: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 5 * 1024 * 1024;

export async function executeBash(
  input: BashExecInput,
): Promise<BashExecResult> {
  const terminal = input.terminal ?? "";

  if (process.env.BASH_TOOL_ENABLED !== "true") {
    return {
      terminal,
      stdout: "",
      stderr:
        "Bash tool is disabled. Set BASH_TOOL_ENABLED=true to enable.",
      exitCode: 1,
    };
  }

  const cwd = process.env.BASH_TOOL_CWD || process.cwd();
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return {
      terminal,
      stdout: "",
      stderr: `BASH_TOOL_CWD path does not exist or is not a directory: ${cwd}`,
      exitCode: 1,
    };
  }

  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", input.prompt],
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, cwd },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error) {
          // Node ExecException stores the child exit code in `error.code` (number)
          // or signals a timeout/kill via `error.killed` / `error.signal`.
          exitCode =
            typeof (error as NodeJS.ErrnoException).code === "number"
              ? ((error as NodeJS.ErrnoException).code as unknown as number)
              : 1;
        }
        resolve({
          terminal,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode,
        });
      },
    );
  });
}
