import type { ToolDefinition, ToolRisk } from "@agents/types";

export const TOOL_CATALOG: ToolDefinition[] = [
  {
    id: "get_user_preferences",
    name: "get_user_preferences",
    description: "Returns the current user preferences and agent configuration.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "list_enabled_tools",
    name: "list_enabled_tools",
    description: "Lists all tools the user has currently enabled.",
    risk: "low",
    parameters_schema: { type: "object", properties: {}, required: [] },
  },
  {
    id: "github_list_repos",
    name: "github_list_repos",
    description: "Lists the user's GitHub repositories.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        per_page: { type: "number", description: "Results per page (max 30)" },
      },
      required: [],
    },
  },
  {
    id: "github_list_issues",
    name: "github_list_issues",
    description: "Lists issues for a given repository.",
    risk: "low",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        state: { type: "string", enum: ["open", "closed", "all"] },
      },
      required: ["owner", "repo"],
    },
  },
  {
    id: "github_create_issue",
    name: "github_create_issue",
    description: "Creates a new issue in a GitHub repository. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
  },
  {
    id: "github_create_repo",
    name: "github_create_repo",
    description:
      "Creates a new GitHub repository for the authenticated user. Requires confirmation.",
    risk: "medium",
    requires_integration: "github",
    parameters_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Repository name" },
        description: { type: "string", description: "Repository description" },
        is_private: {
          type: "boolean",
          description: "Whether the repository should be private",
        },
      },
      required: ["name"],
    },
  },
  {
    id: "gmail_list_today_emails",
    name: "gmail_list_today_emails",
    description: "Lists emails received today from the user's Gmail inbox.",
    risk: "low",
    requires_integration: "google",
    parameters_schema: {
      type: "object",
      properties: {
        max_results: {
          type: "number",
          description: "Max emails to return (default 20, max 50)",
        },
      },
      required: [],
    },
  },
  {
    id: "web_search",
    name: "web_search",
    description:
      "Searches the web for current information on any topic and returns relevant results.",
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query" },
        max_results: {
          type: "number",
          description: "Number of results (default 5, max 10)",
        },
      },
      required: ["query"],
    },
  },
  {
    id: "bash",
    name: "bash",
    description:
      "Executes a shell command on the server host. Requires confirmation.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        terminal: {
          type: "string",
          description: "Logical terminal identifier for correlation",
        },
        prompt: {
          type: "string",
          description: "The shell command to execute",
        },
      },
      required: ["prompt"],
    },
  },
  {
    id: "read_file",
    name: "read_file",
    description:
      'Reads an existing text file under the configured workspace root. Use this when you need to inspect source code, config, logs, or any UTF-8 text without changing it. Do not use this to create or modify files; use write_file or edit_file instead. Parameters: "path" is relative to the workspace root (no ".."). Optional "offset" is the 1-based start line number. Optional "limit" is the maximum number of lines to return starting at offset. If both are omitted the tool reads from the beginning up to a server-enforced maximum. Returns JSON with "ok", "content", line metadata, or an error object.',
    risk: "low",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root",
        },
        offset: {
          type: "number",
          description: "1-based start line number (optional)",
        },
        limit: {
          type: "number",
          description: "Maximum number of lines to return (optional)",
        },
      },
      required: ["path"],
    },
  },
  {
    id: "write_file",
    name: "write_file",
    description:
      "Creates a new file with the given UTF-8 content. Use this only when the file must not exist yet (first-time creation). If the file already exists this tool fails by design — use edit_file to change existing files. Returns JSON with ok and bytesWritten, or an error object. Requires confirmation.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root",
        },
        content: {
          type: "string",
          description: "Full file body to write (UTF-8)",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    id: "edit_file",
    name: "edit_file",
    description:
      "Edits an existing UTF-8 text file by replacing exactly one occurrence of old_string with new_string. Do not use this to create a new file (use write_file). old_string must match uniquely — if it matches zero or multiple places the tool fails with a clear message. Returns JSON with ok and replacements count, or an error object. Requires confirmation.",
    risk: "high",
    parameters_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the workspace root",
        },
        old_string: {
          type: "string",
          description: "Exact literal substring to find (not regex)",
        },
        new_string: {
          type: "string",
          description: "Replacement string",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
