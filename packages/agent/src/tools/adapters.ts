import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { TOOL_CATALOG } from "./catalog";
import { createToolCall, updateToolCallStatus } from "@agents/db";
import { executeBash } from "./bashExec";

interface ToolContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  decryptedTokens: Record<string, string>;
}

function isToolAvailable(toolId: string, ctx: ToolContext): boolean {
  const setting = ctx.enabledTools.find((t) => t.tool_id === toolId);
  if (!setting?.enabled) return false;

  const def = TOOL_CATALOG.find((t) => t.id === toolId);
  if (def?.requires_integration) {
    const hasIntegration = ctx.integrations.some(
      (i) => i.provider === def.requires_integration && i.status === "active"
    );
    if (!hasIntegration) return false;
  }
  return true;
}

async function getOctokit(ctx: ToolContext) {
  const token = ctx.decryptedTokens.github;
  if (!token) throw new Error("GitHub token not available");
  const { Octokit } = await import("octokit");
  return new Octokit({ auth: token });
}

interface GoogleTokenBlob {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? "";

async function getGmailAccessToken(ctx: ToolContext): Promise<string> {
  const raw = ctx.decryptedTokens.google;
  if (!raw) throw new Error("Google token not available");

  const blob: GoogleTokenBlob = JSON.parse(raw);

  if (Date.now() < blob.expires_at - 60_000) {
    return blob.access_token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: blob.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json();
  if (!data.access_token) {
    throw new Error("Failed to refresh Google access token");
  }

  blob.access_token = data.access_token;
  blob.expires_at = Date.now() + (data.expires_in ?? 3600) * 1000;
  ctx.decryptedTokens.google = JSON.stringify(blob);

  return blob.access_token;
}

export function buildLangChainTools(ctx: ToolContext) {
  const tools = [];

  if (isToolAvailable("get_user_preferences", ctx)) {
    tools.push(
      tool(
        async () => {
          const { getProfile } = await import("@agents/db");
          const profile = await getProfile(ctx.db, ctx.userId);
          return JSON.stringify({
            name: profile.name,
            timezone: profile.timezone,
            language: profile.language,
            agent_name: profile.agent_name,
          });
        },
        {
          name: "get_user_preferences",
          description:
            "Returns the current user preferences and agent configuration.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("list_enabled_tools", ctx)) {
    tools.push(
      tool(
        async () => {
          const enabled = ctx.enabledTools
            .filter((t) => t.enabled)
            .map((t) => t.tool_id);
          return JSON.stringify(enabled);
        },
        {
          name: "list_enabled_tools",
          description: "Lists all tools the user has currently enabled.",
          schema: z.object({}),
        }
      )
    );
  }

  if (isToolAvailable("github_list_repos", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "github_list_repos",
            input,
            false
          );
          try {
            const octokit = await getOctokit(ctx);
            const { data } =
              await octokit.rest.repos.listForAuthenticatedUser({
                per_page: input.per_page,
                sort: "updated",
              });
            const repos = data.map((r) => ({
              name: r.name,
              full_name: r.full_name,
              private: r.private,
              html_url: r.html_url,
              description: r.description,
            }));
            const result = { repos };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", {
              error: msg,
            });
            return JSON.stringify({ error: msg });
          }
        },
        {
          name: "github_list_repos",
          description: "Lists the user's GitHub repositories.",
          schema: z.object({
            per_page: z.number().max(30).optional().default(10),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_list_issues", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "github_list_issues",
            input,
            false
          );
          try {
            const octokit = await getOctokit(ctx);
            const { data } = await octokit.rest.issues.listForRepo({
              owner: input.owner,
              repo: input.repo,
              state: input.state as "open" | "closed" | "all",
            });
            const issues = data.map((i) => ({
              number: i.number,
              title: i.title,
              state: i.state,
              html_url: i.html_url,
              user: i.user?.login,
            }));
            const result = { issues };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", {
              error: msg,
            });
            return JSON.stringify({ error: msg });
          }
        },
        {
          name: "github_list_issues",
          description: "Lists issues for a given repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            state: z
              .enum(["open", "closed", "all"])
              .optional()
              .default("open"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_issue", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "github_create_issue",
            input,
            false
          );
          return await executeCreateIssue(ctx, record.id, input);
        },
        {
          name: "github_create_issue",
          description:
            "Creates a new issue in a GitHub repository.",
          schema: z.object({
            owner: z.string(),
            repo: z.string(),
            title: z.string(),
            body: z.string().optional().default(""),
          }),
        }
      )
    );
  }

  if (isToolAvailable("github_create_repo", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "github_create_repo",
            input,
            false
          );
          return await executeCreateRepo(ctx, record.id, input);
        },
        {
          name: "github_create_repo",
          description:
            "Creates a new GitHub repository for the authenticated user.",
          schema: z.object({
            name: z.string(),
            description: z.string().optional().default(""),
            is_private: z.boolean().optional().default(false),
          }),
        }
      )
    );
  }

  if (isToolAvailable("web_search", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "web_search",
            input,
            false
          );
          try {
            const apiKey = process.env.TAVILY_API_KEY;
            if (!apiKey) throw new Error("TAVILY_API_KEY is not configured");

            const maxResults = Math.min(Math.max(input.max_results, 1), 10);
            const res = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                api_key: apiKey,
                query: input.query,
                max_results: maxResults,
                include_answer: true,
              }),
            });

            if (!res.ok) {
              throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
            }

            const data = await res.json();
            const result = {
              answer: data.answer ?? null,
              results: (data.results ?? []).map(
                (r: { title: string; url: string; content: string }) => ({
                  title: r.title,
                  url: r.url,
                  content: r.content,
                })
              ),
            };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", {
              error: msg,
            });
            return JSON.stringify({ error: msg });
          }
        },
        {
          name: "web_search",
          description:
            "Searches the web for current information on any topic and returns relevant results.",
          schema: z.object({
            query: z.string().describe("The search query"),
            max_results: z
              .number()
              .min(1)
              .max(10)
              .optional()
              .default(5)
              .describe("Number of results to return"),
          }),
        }
      )
    );
  }

  if (isToolAvailable("gmail_list_today_emails", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "gmail_list_today_emails",
            input,
            false
          );
          try {
            const accessToken = await getGmailAccessToken(ctx);
            const headers = { Authorization: `Bearer ${accessToken}` };

            const now = new Date();
            const todayEpoch = Math.floor(
              new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
            );
            const maxResults = Math.min(input.max_results, 50);

            const listRes = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=after:${todayEpoch}&maxResults=${maxResults}`,
              { headers }
            );
            const listData = await listRes.json();

            if (!listData.messages?.length) {
              const result = { emails: [], total: 0 };
              await updateToolCallStatus(ctx.db, record.id, "executed", result);
              return JSON.stringify(result);
            }

            const emails = await Promise.all(
              listData.messages.map(async (m: { id: string }) => {
                const msgRes = await fetch(
                  `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
                  { headers }
                );
                const msg = await msgRes.json();
                const getHeader = (name: string) =>
                  msg.payload?.headers?.find(
                    (h: { name: string; value: string }) =>
                      h.name.toLowerCase() === name.toLowerCase()
                  )?.value ?? "";
                return {
                  id: msg.id,
                  from: getHeader("From"),
                  subject: getHeader("Subject"),
                  date: getHeader("Date"),
                  snippet: msg.snippet ?? "",
                };
              })
            );

            const result = { emails, total: emails.length };
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", {
              error: msg,
            });
            return JSON.stringify({ error: msg });
          }
        },
        {
          name: "gmail_list_today_emails",
          description:
            "Lists emails received today from the user's Gmail inbox.",
          schema: z.object({
            max_results: z.number().max(50).optional().default(20),
          }),
        }
      )
    );
  }

  if (isToolAvailable("bash", ctx)) {
    tools.push(
      tool(
        async (input) => {
          const record = await createToolCall(
            ctx.db,
            ctx.sessionId,
            "bash",
            input,
            false
          );
          try {
            const result = await executeBash(input);
            await updateToolCallStatus(ctx.db, record.id, "executed", result);
            return JSON.stringify(result);
          } catch (err) {
            const msg =
              err instanceof Error ? err.message : "Unknown error";
            await updateToolCallStatus(ctx.db, record.id, "failed", {
              error: msg,
            });
            return JSON.stringify({ error: msg });
          }
        },
        {
          name: "bash",
          description:
            "Executes a shell command on the server host. Requires confirmation.",
          schema: z.object({
            terminal: z
              .string()
              .optional()
              .default("")
              .describe("Logical terminal identifier for correlation"),
            prompt: z
              .string()
              .max(10_000)
              .describe("The shell command to execute"),
          }),
        }
      )
    );
  }

  return tools;
}

export async function executeCreateIssue(
  ctx: ToolContext,
  toolCallId: string,
  args: { owner: string; repo: string; title: string; body?: string }
): Promise<string> {
  try {
    const octokit = await getOctokit(ctx);
    const { data } = await octokit.rest.issues.create({
      owner: args.owner,
      repo: args.repo,
      title: args.title,
      body: args.body ?? "",
    });
    const result = {
      message: `Issue #${data.number} created`,
      issue_url: data.html_url,
      number: data.number,
    };
    await updateToolCallStatus(ctx.db, toolCallId, "executed", result);
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await updateToolCallStatus(ctx.db, toolCallId, "failed", { error: msg });
    return JSON.stringify({ error: msg });
  }
}

export async function executeCreateRepo(
  ctx: ToolContext,
  toolCallId: string,
  args: { name: string; description?: string; is_private?: boolean }
): Promise<string> {
  try {
    const octokit = await getOctokit(ctx);
    const { data } = await octokit.rest.repos.createForAuthenticatedUser({
      name: args.name,
      description: args.description ?? "",
      private: args.is_private ?? false,
    });
    const result = {
      message: `Repository "${data.full_name}" created`,
      html_url: data.html_url,
      full_name: data.full_name,
    };
    await updateToolCallStatus(ctx.db, toolCallId, "executed", result);
    return JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    await updateToolCallStatus(ctx.db, toolCallId, "failed", { error: msg });
    return JSON.stringify({ error: msg });
  }
}

export { type ToolContext };
