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
];

export function getToolRisk(toolId: string): ToolRisk {
  return TOOL_CATALOG.find((t) => t.id === toolId)?.risk ?? "high";
}

export function toolRequiresConfirmation(toolId: string): boolean {
  const risk = getToolRisk(toolId);
  return risk === "medium" || risk === "high";
}
