import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServerClient, decrypt } from "@agents/db";
import { runAgent, resumeAgent, flushSessionMemory } from "@agents/agent";
import type { HumanDecision } from "@agents/types";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const db = createServerClient();

    // ── Shared user context ────────────────────────────────────

    const { data: profile } = await supabase
      .from("profiles")
      .select("agent_system_prompt, agent_name")
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
          /* token could not be decrypted, skip */
        }
      }
    }

    const enabledTools = (toolSettings ?? []).map(
      (t: Record<string, unknown>) => ({
        id: t.id as string,
        user_id: t.user_id as string,
        tool_id: t.tool_id as string,
        enabled: t.enabled as boolean,
        config_json: (t.config_json as Record<string, unknown>) ?? {},
      })
    );

    const mappedIntegrations = (integrations ?? []).map(
      (i: Record<string, unknown>) => ({
        id: i.id as string,
        user_id: i.user_id as string,
        provider: i.provider as string,
        scopes: (i.scopes as string[]) ?? [],
        status: i.status as "active" | "revoked" | "expired",
        created_at: i.created_at as string,
      })
    );

    const systemPrompt =
      (profile?.agent_system_prompt as string) ?? "Eres un asistente útil.";

    // ── Resume mode ────────────────────────────────────────────

    if (body.resume === true) {
      const { sessionId, decisions } = body as {
        sessionId: string;
        decisions: HumanDecision[];
      };

      if (!sessionId || !Array.isArray(decisions) || decisions.length === 0) {
        return NextResponse.json(
          { error: "sessionId and decisions[] are required for resume" },
          { status: 400 }
        );
      }

      const { data: session } = await supabase
        .from("agent_sessions")
        .select("user_id")
        .eq("id", sessionId)
        .single();

      if (!session || session.user_id !== user.id) {
        return NextResponse.json(
          { error: "Session not found" },
          { status: 404 }
        );
      }

      const result = await resumeAgent({
        sessionId,
        decisions,
        db,
        userId: user.id,
        systemPrompt,
        enabledTools,
        integrations: mappedIntegrations,
        decryptedTokens,
      });

      return NextResponse.json({
        response: result.interrupt ? null : result.response,
        pendingConfirmation: result.pendingConfirmation,
        interrupt: result.interrupt,
        sessionId,
        toolCalls: result.toolCalls,
      });
    }

    // ── New message mode ───────────────────────────────────────

    const { message } = body;
    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    let session = await supabase
      .from("agent_sessions")
      .select("*")
      .eq("user_id", user.id)
      .eq("channel", "web")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .single()
      .then((r) => r.data);

    if (!session) {
      const { data } = await supabase
        .from("agent_sessions")
        .insert({
          user_id: user.id,
          channel: "web",
          status: "active",
          budget_tokens_used: 0,
          budget_tokens_limit: 100000,
        })
        .select()
        .single();
      session = data;
    }

    if (!session) {
      return NextResponse.json(
        { error: "Failed to create session" },
        { status: 500 }
      );
    }

    const result = await runAgent({
      message,
      userId: user.id,
      sessionId: session.id,
      systemPrompt,
      db,
      enabledTools,
      integrations: mappedIntegrations,
      decryptedTokens,
    });

    if (!result.pendingConfirmation) {
      console.log(`[chat] scheduling memory flush for session=${session.id}`);
      flushSessionMemory({
        db,
        userId: user.id,
        sessionId: session.id,
      }).catch((e) => console.error("memory flush failed:", e));
    } else {
      console.log("[chat] skipping memory flush: pending confirmation");
    }

    return NextResponse.json({
      response: result.interrupt ? null : result.response,
      pendingConfirmation: result.pendingConfirmation,
      interrupt: result.interrupt,
      sessionId: session.id,
      toolCalls: result.toolCalls,
    });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
