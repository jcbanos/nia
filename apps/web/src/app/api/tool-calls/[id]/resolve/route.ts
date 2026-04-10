import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decrypt } from "@agents/db";
import { resumeAgent } from "@agents/agent";
import type { HumanDecision } from "@agents/types";

/**
 * Backward-compatible resolve endpoint.
 *
 * In the new HITL flow the graph stores the *session ID* as the
 * `pendingConfirmation.tool_call_id`, so the `[id]` route param is
 * treated as a session ID.  Decisions are forwarded to `resumeAgent`
 * which resumes the graph via `Command({ resume })`.
 *
 * Prefer using POST /api/chat with `{ resume: true }` instead.
 */
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

  const { id: sessionId } = await params;
  const db = createServerClient();

  const { data: session } = await supabase
    .from("agent_sessions")
    .select("user_id")
    .eq("id", sessionId)
    .single();

  if (!session || session.user_id !== user.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("agent_system_prompt")
    .eq("id", user.id)
    .single();

  const { data: toolSettings } = await supabase
    .from("user_tool_settings")
    .select("*")
    .eq("user_id", user.id);

  const { data: integrations } = await supabase
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

  const decisions: HumanDecision[] = [{ type: action }];

  const result = await resumeAgent({
    sessionId,
    decisions,
    db,
    userId: user.id,
    systemPrompt:
      (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.",
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
  });

  return NextResponse.json({
    ok: true,
    response: result.response,
    interrupt: result.interrupt,
    toolCalls: result.toolCalls,
    result: result.response ? { message: result.response } : null,
  });
}
