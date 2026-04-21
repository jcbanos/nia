import { type DbClient, decrypt } from "@agents/db";

export async function buildToolContext(
  db: DbClient,
  userId: string,
  sessionId: string
) {
  const { data: integrations } = await db
    .from("user_integrations")
    .select("*")
    .eq("user_id", userId)
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
    .eq("user_id", userId);

  return {
    db,
    userId,
    sessionId,
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
}
