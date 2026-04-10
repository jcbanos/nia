"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { TOOL_UI_METADATA, RISK_LABELS } from "@agents/types";

interface Props {
  userId: string;
  profile: Record<string, unknown> | null;
  toolSettings: Array<{ tool_id: string; enabled: boolean }>;
  telegramLinked: boolean;
  githubConnected: boolean;
  googleConnected: boolean;
}

export function SettingsForm({ userId, profile, toolSettings, telegramLinked, githubConnected, googleConnected }: Props) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [githubStatus, setGithubStatus] = useState<"connected" | "disconnected">(
    githubConnected ? "connected" : "disconnected"
  );
  const [googleStatus, setGoogleStatus] = useState<"connected" | "disconnected">(
    googleConnected ? "connected" : "disconnected"
  );
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectingGoogle, setDisconnectingGoogle] = useState(false);

  const [name, setName] = useState((profile?.name as string) ?? "");
  const [agentName, setAgentName] = useState((profile?.agent_name as string) ?? "Agente");
  const [systemPrompt, setSystemPrompt] = useState(
    (profile?.agent_system_prompt as string) ?? ""
  );
  const [enabledTools, setEnabledTools] = useState<string[]>(
    toolSettings.filter((t) => t.enabled).map((t) => t.tool_id)
  );
  const [linkCode, setLinkCode] = useState<string | null>(null);

  const supabase = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  function toggleTool(id: string) {
    setEnabledTools((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }

  async function handleSave() {
    setSaving(true);

    await supabase.from("profiles").update({
      name,
      agent_name: agentName,
      agent_system_prompt: systemPrompt.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq("id", userId);

    for (const tool of TOOL_UI_METADATA) {
      await supabase.from("user_tool_settings").upsert(
        {
          user_id: userId,
          tool_id: tool.id,
          enabled: enabledTools.includes(tool.id),
          config_json: {},
        },
        { onConflict: "user_id,tool_id" }
      );
    }

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    router.refresh();
  }

  async function generateTelegramCode() {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await supabase.from("telegram_link_codes").insert({
      user_id: userId,
      code,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    setLinkCode(code);
  }

  return (
    <div className="space-y-8">
      {/* Profile */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Perfil</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Nombre</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
      </section>

      {/* Agent */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Agente</h2>
        <div>
          <label className="block text-sm font-medium mb-1">Nombre del agente</label>
          <input
            type="text"
            value={agentName}
            onChange={(e) => setAgentName(e.target.value)}
            maxLength={50}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Instrucciones</label>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value.slice(0, 500))}
            rows={4}
            maxLength={500}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <p className="text-xs text-neutral-400 text-right mt-1">{systemPrompt.length}/500</p>
        </div>
      </section>

      {/* Tools */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Herramientas</h2>
        <div className="space-y-3">
          {TOOL_UI_METADATA.map((tool) => {
            const risk = RISK_LABELS[tool.risk];
            const enabled = enabledTools.includes(tool.id);
            return (
              <label
                key={tool.id}
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition ${
                  enabled
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-950/20"
                    : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
                }`}
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => toggleTool(tool.id)}
                  className="mt-0.5 rounded border-neutral-300"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{tool.name}</span>
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${risk.color}`}>
                      {risk.text}
                    </span>
                    {tool.requiresIntegration && (
                      <span className="text-xs text-neutral-400">
                        requiere {tool.requiresIntegration}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-neutral-500 mt-0.5">
                    {tool.description}
                  </p>
                </div>
              </label>
            );
          })}
        </div>
      </section>

      {/* GitHub */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">GitHub</h2>
        {githubStatus === "connected" ? (
          <div className="space-y-2">
            <p className="text-sm text-green-600">Cuenta de GitHub conectada.</p>
            <button
              onClick={async () => {
                setDisconnecting(true);
                await fetch("/api/github/disconnect", { method: "POST" });
                setGithubStatus("disconnected");
                setDisconnecting(false);
                router.refresh();
              }}
              disabled={disconnecting}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              {disconnecting ? "Desconectando..." : "Desconectar GitHub"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Conecta tu cuenta de GitHub para que el agente pueda gestionar repositorios e issues.
            </p>
            <a
              href="/api/github/authorize"
              className="inline-block rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Conectar GitHub
            </a>
          </div>
        )}
      </section>

      {/* Google / Gmail */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Google / Gmail</h2>
        {googleStatus === "connected" ? (
          <div className="space-y-2">
            <p className="text-sm text-green-600">Cuenta de Google conectada.</p>
            <button
              onClick={async () => {
                setDisconnectingGoogle(true);
                await fetch("/api/google/disconnect", { method: "POST" });
                setGoogleStatus("disconnected");
                setDisconnectingGoogle(false);
                router.refresh();
              }}
              disabled={disconnectingGoogle}
              className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950"
            >
              {disconnectingGoogle ? "Desconectando..." : "Desconectar Google"}
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Conecta tu cuenta de Google para que el agente pueda leer tus correos de Gmail.
            </p>
            <a
              href="/api/google/authorize"
              className="inline-block rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
            >
              Conectar Google
            </a>
          </div>
        )}
      </section>

      {/* Telegram */}
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Telegram</h2>
        {telegramLinked ? (
          <p className="text-sm text-green-600">Cuenta de Telegram vinculada.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-neutral-500">
              Vincula tu cuenta de Telegram para usar el agente desde allí.
            </p>
            {linkCode ? (
              <div className="rounded-md bg-neutral-50 p-4 dark:bg-neutral-900">
                <p className="text-sm">
                  Envía este código al bot en Telegram:{" "}
                  <code className="rounded bg-blue-100 px-2 py-0.5 text-sm font-mono font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    /link {linkCode}
                  </code>
                </p>
                <p className="text-xs text-neutral-400 mt-1">Expira en 10 minutos.</p>
              </div>
            ) : (
              <button
                onClick={generateTelegramCode}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Generar código de vinculación
              </button>
            )}
          </div>
        )}
      </section>

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Guardando..." : "Guardar cambios"}
        </button>
        {saved && (
          <span className="text-sm text-green-600">Guardado correctamente.</span>
        )}
      </div>
    </div>
  );
}
