import { open, readFile, mkdir, rename, unlink, realpath } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
}

export interface EditFileInput {
  path: string;
  old_string: string;
  new_string: string;
}

interface FileResultOk {
  ok: true;
  tool: string;
  path: string;
  [key: string]: unknown;
}

interface FileResultError {
  ok: false;
  tool: string;
  path: string;
  error: { code: string; message: string };
}

export type FileResult = FileResultOk | FileResultError;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_READ_LINES = 10_000;
const MAX_CONTENT_BYTES = 5 * 1024 * 1024; // 5 MB cap for write_file content

// ---------------------------------------------------------------------------
// Safe-path resolution
// ---------------------------------------------------------------------------

function getRoot(): string | null {
  const root = process.env.FILE_TOOLS_ROOT;
  if (!root) return null;
  return path.resolve(root);
}

function errDisabled(tool: string, userPath: string): FileResult {
  return {
    ok: false,
    tool,
    path: userPath,
    error: {
      code: "TOOL_DISABLED",
      message:
        "File tools are disabled. Set FILE_TOOLS_ENABLED=true and FILE_TOOLS_ROOT to enable.",
    },
  };
}

function errResult(
  tool: string,
  resolvedPath: string,
  code: string,
  message: string,
): FileResult {
  return { ok: false, tool, path: resolvedPath, error: { code, message } };
}

export function resolveSafePath(
  userPath: string,
  root: string,
): { resolved: string; error?: undefined } | { resolved?: undefined; error: { code: string; message: string } } {
  if (path.isAbsolute(userPath)) {
    const normalized = path.normalize(userPath);
    if (!normalized.startsWith(root + path.sep) && normalized !== root) {
      return {
        error: {
          code: "PATH_OUTSIDE_ROOT",
          message: `Absolute path is outside the allowed root: ${userPath}`,
        },
      };
    }
  }

  const resolved = path.resolve(root, userPath);

  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return {
      error: {
        code: "PATH_OUTSIDE_ROOT",
        message: `Path escapes the allowed root directory: ${userPath}`,
      },
    };
  }

  return { resolved };
}

async function verifyRealPath(
  resolved: string,
  root: string,
): Promise<{ code: string; message: string } | null> {
  try {
    const real = await realpath(resolved);
    if (!real.startsWith(root + path.sep) && real !== root) {
      return {
        code: "SYMLINK_ESCAPE",
        message: `Resolved real path escapes the allowed root: ${real}`,
      };
    }
  } catch {
    // File may not exist yet (write_file) — that's fine
  }
  return null;
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

export async function executeReadFile(input: ReadFileInput): Promise<FileResult> {
  const tool = "read_file";

  if (process.env.FILE_TOOLS_ENABLED !== "true") {
    return errDisabled(tool, input.path);
  }

  const root = getRoot();
  if (!root) return errDisabled(tool, input.path);

  const safe = resolveSafePath(input.path, root);
  if (safe.error) return errResult(tool, input.path, safe.error.code, safe.error.message);
  const resolved = safe.resolved;

  const symlinkErr = await verifyRealPath(resolved, root);
  if (symlinkErr) return errResult(tool, resolved, symlinkErr.code, symlinkErr.message);

  if (!existsSync(resolved)) {
    return errResult(tool, resolved, "FILE_NOT_FOUND", `File not found: ${resolved}`);
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return errResult(tool, resolved, "IS_DIRECTORY", `Path is a directory, not a file: ${resolved}`);
  }

  try {
    const raw = await readFile(resolved, "utf-8");
    const allLines = raw.split("\n");
    const totalLines = allLines.length;

    let startLine = 1;
    let endLine = totalLines;
    let sliced = allLines;

    if (input.offset !== undefined || input.limit !== undefined) {
      startLine = Math.max(1, input.offset ?? 1);
      const maxLines = Math.min(input.limit ?? MAX_READ_LINES, MAX_READ_LINES);
      endLine = Math.min(startLine + maxLines - 1, totalLines);
      sliced = allLines.slice(startLine - 1, endLine);
    } else if (totalLines > MAX_READ_LINES) {
      endLine = MAX_READ_LINES;
      sliced = allLines.slice(0, MAX_READ_LINES);
    }

    return {
      ok: true,
      tool,
      path: resolved,
      content: sliced.join("\n"),
      startLine,
      endLine,
      totalLines,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown read error";
    return errResult(tool, resolved, "READ_ERROR", msg);
  }
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

export async function executeWriteFile(input: WriteFileInput): Promise<FileResult> {
  const tool = "write_file";

  if (process.env.FILE_TOOLS_ENABLED !== "true") {
    return errDisabled(tool, input.path);
  }

  const root = getRoot();
  if (!root) return errDisabled(tool, input.path);

  const safe = resolveSafePath(input.path, root);
  if (safe.error) return errResult(tool, input.path, safe.error.code, safe.error.message);
  const resolved = safe.resolved;

  const symlinkErr = await verifyRealPath(resolved, root);
  if (symlinkErr) return errResult(tool, resolved, symlinkErr.code, symlinkErr.message);

  const contentBytes = Buffer.byteLength(input.content, "utf-8");
  if (contentBytes > MAX_CONTENT_BYTES) {
    return errResult(
      tool,
      resolved,
      "CONTENT_TOO_LARGE",
      `Content exceeds maximum size of ${MAX_CONTENT_BYTES} bytes (got ${contentBytes}).`,
    );
  }

  try {
    await mkdir(path.dirname(resolved), { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown mkdir error";
    return errResult(tool, resolved, "MKDIR_ERROR", `Failed to create parent directories: ${msg}`);
  }

  let fd;
  try {
    // 'wx' = write + exclusive (fail if exists)
    fd = await open(resolved, "wx");
    await fd.writeFile(input.content, "utf-8");
    return {
      ok: true,
      tool,
      path: resolved,
      bytesWritten: contentBytes,
    };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === "EEXIST") {
      return errResult(
        tool,
        resolved,
        "FILE_EXISTS",
        "The file already exists. Use edit_file to modify existing files.",
      );
    }
    const msg = err instanceof Error ? err.message : "Unknown write error";
    return errResult(tool, resolved, "WRITE_ERROR", msg);
  } finally {
    await fd?.close();
  }
}

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

export async function executeEditFile(input: EditFileInput): Promise<FileResult> {
  const tool = "edit_file";

  if (process.env.FILE_TOOLS_ENABLED !== "true") {
    return errDisabled(tool, input.path);
  }

  const root = getRoot();
  if (!root) return errDisabled(tool, input.path);

  const safe = resolveSafePath(input.path, root);
  if (safe.error) return errResult(tool, input.path, safe.error.code, safe.error.message);
  const resolved = safe.resolved;

  const symlinkErr = await verifyRealPath(resolved, root);
  if (symlinkErr) return errResult(tool, resolved, symlinkErr.code, symlinkErr.message);

  if (!existsSync(resolved)) {
    return errResult(
      tool,
      resolved,
      "FILE_NOT_FOUND",
      `File not found: ${resolved}. Use write_file to create new files.`,
    );
  }

  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    return errResult(tool, resolved, "IS_DIRECTORY", `Path is a directory, not a file: ${resolved}`);
  }

  try {
    const content = await readFile(resolved, "utf-8");

    // Count occurrences of old_string
    let count = 0;
    let searchFrom = 0;
    while (true) {
      const idx = content.indexOf(input.old_string, searchFrom);
      if (idx === -1) break;
      count++;
      searchFrom = idx + input.old_string.length;
    }

    if (count === 0) {
      return errResult(
        tool,
        resolved,
        "NO_MATCH",
        "old_string was not found in the file. Verify the exact content including whitespace and line endings.",
      );
    }

    if (count > 1) {
      return errResult(
        tool,
        resolved,
        "MULTIPLE_MATCHES",
        `old_string was found ${count} times. It must match exactly once. Include more surrounding context to make it unique.`,
      );
    }

    const newContent = content.replace(input.old_string, input.new_string);

    // Atomic write: temp file + rename
    const tmpPath = resolved + `.tmp_${randomBytes(4).toString("hex")}`;
    try {
      await writeAtomically(resolved, tmpPath, newContent);
    } catch (err) {
      // Clean up temp file on failure
      try { await unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    }

    return {
      ok: true,
      tool,
      path: resolved,
      replacements: 1,
    };
  } catch (err) {
    if ((err as FileResult)?.ok === false) return err as FileResult;
    const msg = err instanceof Error ? err.message : "Unknown edit error";
    return errResult(tool, resolved, "EDIT_ERROR", msg);
  }
}

async function writeAtomically(
  target: string,
  tmpPath: string,
  content: string,
): Promise<void> {
  let fd;
  try {
    fd = await open(tmpPath, "w");
    await fd.writeFile(content, "utf-8");
  } finally {
    await fd?.close();
  }
  await rename(tmpPath, target);
}
