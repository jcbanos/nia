import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  createServerClient,
  decrypt,
  getPendingToolCall,
  updateToolCallStatus,
} from "@agents/db";
import { executeCreateIssue, executeCreateRepo } from "@agents/agent";
import type { ToolContext } from "@agents/agent";

const TOOL_EXECUTORS: Record<
  string,
  (
    ctx: ToolContext,
    toolCallId: string,
    args: Record<string, unknown>
  ) => Promise<string>
> = {
  github_create_issue: (ctx, id, args) =>
    executeCreateIssue(
      ctx,
      id,
      args as Parameters<typeof executeCreateIssue>[2]
    ),
  github_create_repo: (ctx, id, args) =>
    executeCreateRepo(
      ctx,
      id,
      args as Parameters<typeof executeCreateRepo>[2]
    ),
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { action } = await request.json();
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json(
      { error: 'Action must be "approve" or "reject"' },
      { status: 400 }
    );
  }

  const { id: toolCallId } = await params;
  const db = createServerClient();

  const toolCall = await getPendingToolCall(db, toolCallId);
  if (!toolCall) {
    return NextResponse.json(
      { error: "Tool call not found or not pending" },
      { status: 404 }
    );
  }

  const { data: session } = await db
    .from("agent_sessions")
    .select("user_id")
    .eq("id", toolCall.session_id)
    .single();

  if (!session || session.user_id !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  if (action === "reject") {
    await updateToolCallStatus(db, toolCallId, "rejected");
    return NextResponse.json({
      ok: true,
      message: "Acción cancelada.",
    });
  }

  await updateToolCallStatus(db, toolCallId, "approved");

  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", user.id)
    .eq("status", "active");

  const decryptedTokens: Record<string, string> = {};
  for (const integration of integrations ?? []) {
    if (integration.encrypted_tokens) {
      try {
        decryptedTokens[integration.provider] = decrypt(
          integration.encrypted_tokens
        );
      } catch {
        /* skip */
      }
    }
  }

  const { data: toolSettings } = await db
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", user.id);

  const toolCtx: ToolContext = {
    db,
    userId: user.id,
    sessionId: toolCall.session_id,
    enabledTools: (toolSettings ?? []).map((t: Record<string, unknown>) => ({
      id: t.id as string,
      user_id: t.user_id as string,
      tool_id: t.tool_id as string,
      enabled: t.enabled as boolean,
      config_json: (t.config_json as Record<string, unknown>) ?? {},
    })),
    integrations: (integrations ?? []).map((i: Record<string, unknown>) => ({
      id: i.id as string,
      user_id: i.user_id as string,
      provider: i.provider as string,
      scopes: (i.scopes as string[]) ?? [],
      status: i.status as "active" | "revoked" | "expired",
      created_at: i.created_at as string,
    })),
    decryptedTokens,
  };

  const executor = TOOL_EXECUTORS[toolCall.tool_name];
  if (!executor) {
    await updateToolCallStatus(db, toolCallId, "failed", {
      error: `No executor for ${toolCall.tool_name}`,
    });
    return NextResponse.json(
      { error: `No executor for tool: ${toolCall.tool_name}` },
      { status: 400 }
    );
  }

  const resultStr = await executor(
    toolCtx,
    toolCallId,
    toolCall.arguments_json
  );

  let result: Record<string, unknown>;
  try {
    result = JSON.parse(resultStr);
  } catch {
    result = { message: resultStr };
  }

  return NextResponse.json({ ok: true, result });
}
