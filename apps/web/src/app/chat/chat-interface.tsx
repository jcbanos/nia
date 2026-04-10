"use client";

import { useState, useRef, useEffect, useCallback } from "react";

// ── Types (aligned with @agents/types) ───────────────────────────────────

interface Message {
  role: string;
  content: string;
  created_at?: string;
}

interface ActionRequest {
  name: string;
  arguments: Record<string, unknown>;
  description?: string;
}

interface ReviewConfig {
  action_name: string;
  allowed_decisions: HumanDecisionType[];
}

type HumanDecisionType = "approve" | "edit" | "reject";

interface HumanDecision {
  type: HumanDecisionType;
  editedAction?: { name: string; args: Record<string, unknown> };
  message?: string;
}

interface InterruptPayload {
  action_requests: ActionRequest[];
  review_configs: ReviewConfig[];
}

interface PendingConfirmation {
  tool_call_id: string;
  tool_name: string;
  message: string;
  args: Record<string, unknown>;
  interrupt?: InterruptPayload;
}

// ── Friendly display names / risk badge styles ───────────────────────────

const TOOL_DISPLAY: Record<string, { label: string; risk: string }> = {
  github_create_issue: { label: "GitHub: Crear Issue", risk: "medium" },
  github_create_repo: { label: "GitHub: Crear Repositorio", risk: "medium" },
  github_list_repos: { label: "GitHub: Listar Repos", risk: "low" },
  github_list_issues: { label: "GitHub: Listar Issues", risk: "low" },
  gmail_list_today_emails: { label: "Gmail: Emails de Hoy", risk: "low" },
  get_user_preferences: { label: "Preferencias del Usuario", risk: "low" },
  list_enabled_tools: { label: "Listar Herramientas", risk: "low" },
  web_search: { label: "Buscar en la Web", risk: "low" },
};

const RISK_BADGE: Record<string, { text: string; cls: string }> = {
  low: {
    text: "Bajo",
    cls: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  },
  medium: {
    text: "Medio",
    cls: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
  },
  high: {
    text: "Alto",
    cls: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  },
};

// ── InterruptState holds everything the UI needs while waiting for user ──

interface InterruptState {
  interrupt: InterruptPayload;
  pending: PendingConfirmation | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function toolLabel(name: string): string {
  return TOOL_DISPLAY[name]?.label ?? name;
}

function toolRisk(name: string): string {
  return TOOL_DISPLAY[name]?.risk ?? "high";
}

function riskBadge(risk: string) {
  const b = RISK_BADGE[risk] ?? RISK_BADGE.high;
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase leading-none ${b.cls}`}
    >
      {b.text}
    </span>
  );
}

function formatArgValue(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ── Sub-components ──────────────────────────────────────────────────────

function ArgumentsTable({
  args,
  editing,
  editedArgs,
  onArgChange,
}: {
  args: Record<string, unknown>;
  editing: boolean;
  editedArgs: Record<string, unknown>;
  onArgChange: (key: string, value: string) => void;
}) {
  const entries = Object.entries(args);
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 rounded-md border border-neutral-200 dark:border-neutral-700 overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-neutral-100 dark:bg-neutral-800">
            <th className="px-3 py-1.5 text-left font-medium text-neutral-500 dark:text-neutral-400">
              Parámetro
            </th>
            <th className="px-3 py-1.5 text-left font-medium text-neutral-500 dark:text-neutral-400">
              Valor
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, val]) => (
            <tr
              key={key}
              className="border-t border-neutral-200 dark:border-neutral-700"
            >
              <td className="px-3 py-1.5 font-mono text-neutral-600 dark:text-neutral-300">
                {key}
              </td>
              <td className="px-3 py-1.5 text-neutral-900 dark:text-neutral-100">
                {editing ? (
                  <input
                    type="text"
                    value={formatArgValue(editedArgs[key] ?? val)}
                    onChange={(e) => onArgChange(key, e.target.value)}
                    className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-neutral-600 dark:bg-neutral-900"
                  />
                ) : (
                  <span className="font-mono">{formatArgValue(val)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionRequestCard({
  action,
  index,
  allowedDecisions,
  resolving,
  editing,
  editedArgs,
  onDecision,
  onStartEdit,
  onCancelEdit,
  onArgChange,
}: {
  action: ActionRequest;
  index: number;
  allowedDecisions: HumanDecisionType[];
  resolving: boolean;
  editing: boolean;
  editedArgs: Record<string, unknown>;
  onDecision: (index: number, decision: HumanDecisionType) => void;
  onStartEdit: (index: number) => void;
  onCancelEdit: () => void;
  onArgChange: (key: string, value: string) => void;
}) {
  const risk = toolRisk(action.name);
  const canApprove = allowedDecisions.includes("approve");
  const canEdit = allowedDecisions.includes("edit");
  const canReject = allowedDecisions.includes("reject");

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700 dark:bg-amber-950">
      {/* Header */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          {toolLabel(action.name)}
        </span>
        {riskBadge(risk)}
      </div>

      {/* Description */}
      {action.description && (
        <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
          {action.description}
        </p>
      )}

      {/* Arguments */}
      <ArgumentsTable
        args={action.arguments}
        editing={editing}
        editedArgs={editedArgs}
        onArgChange={onArgChange}
      />

      {/* Actions */}
      <div className="mt-3 flex items-center gap-2">
        {canApprove && !editing && (
          <button
            onClick={() => onDecision(index, "approve")}
            disabled={resolving}
            className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {resolving ? "..." : "Aprobar"}
          </button>
        )}
        {canEdit && !editing && (
          <button
            onClick={() => onStartEdit(index)}
            disabled={resolving}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Editar
          </button>
        )}
        {editing && (
          <>
            <button
              onClick={() => onDecision(index, "edit")}
              disabled={resolving}
              className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {resolving ? "..." : "Enviar cambios"}
            </button>
            <button
              onClick={onCancelEdit}
              disabled={resolving}
              className="rounded-md bg-neutral-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-600 disabled:opacity-50"
            >
              Cancelar
            </button>
          </>
        )}
        {canReject && (
          <button
            onClick={() => onDecision(index, "reject")}
            disabled={resolving}
            className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {resolving ? "..." : "Rechazar"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

interface Props {
  agentName: string;
  initialMessages: Message[];
}

export function ChatInterface({ agentName, initialMessages }: Props) {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [interruptState, setInterruptState] = useState<InterruptState | null>(
    null,
  );
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editedArgs, setEditedArgs] = useState<Record<string, unknown>>({});
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interruptState]);

  // ── Parse API response into local state ───────────────────────────────

  const processResponse = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (data: any) => {
      if (data.sessionId) setSessionId(data.sessionId);

      if (data.response) {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
        ]);
      }

      if (data.interrupt) {
        setInterruptState({
          interrupt: data.interrupt as InterruptPayload,
          pending: data.pendingConfirmation ?? null,
        });
      } else if (data.pendingConfirmation) {
        const pc = data.pendingConfirmation as PendingConfirmation;
        setInterruptState({
          interrupt: pc.interrupt ?? {
            action_requests: [
              {
                name: pc.tool_name,
                arguments: pc.args,
                description: pc.message,
              },
            ],
            review_configs: [
              {
                action_name: pc.tool_name,
                allowed_decisions: ["approve", "reject"],
              },
            ],
          },
          pending: pc,
        });
      } else {
        setInterruptState(null);
      }
    },
    [],
  );

  // ── Send a new user message ───────────────────────────────────────────

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;

    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setInput("");
    setLoading(true);
    setInterruptState(null);
    setEditingIndex(null);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      processResponse(await res.json());
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Error al procesar tu mensaje. Intenta de nuevo.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  // ── Handle approve / edit / reject ────────────────────────────────────

  async function handleDecision(
    actionIndex: number,
    decision: HumanDecisionType,
  ) {
    if (!interruptState || resolving) return;

    const resolveSessionId =
      sessionId ?? interruptState.pending?.tool_call_id;
    if (!resolveSessionId) return;

    setResolving(true);

    const action = interruptState.interrupt.action_requests[actionIndex];
    const humanDecision: HumanDecision = { type: decision };

    if (decision === "edit" && action) {
      humanDecision.editedAction = {
        name: action.name,
        args: { ...action.arguments, ...editedArgs },
      };
    }

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resume: true,
          sessionId: resolveSessionId,
          decisions: [humanDecision],
        }),
      });

      const data = await res.json();
      setInterruptState(null);
      setEditingIndex(null);
      setEditedArgs({});
      processResponse(data);

      if (!data.response && decision === "reject") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "Acción cancelada." },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Error al resolver la confirmación.",
        },
      ]);
    } finally {
      setResolving(false);
    }
  }

  // ── Editing helpers ───────────────────────────────────────────────────

  function startEditing(index: number) {
    setEditingIndex(index);
    if (interruptState) {
      setEditedArgs({
        ...interruptState.interrupt.action_requests[index].arguments,
      });
    }
  }

  function cancelEditing() {
    setEditingIndex(null);
    setEditedArgs({});
  }

  function handleArgChange(key: string, value: string) {
    setEditedArgs((prev) => ({ ...prev, [key]: value }));
  }

  function getAllowedDecisions(actionName: string): HumanDecisionType[] {
    if (!interruptState) return ["approve", "reject"];
    const cfg = interruptState.interrupt.review_configs.find(
      (rc) => rc.action_name === actionName,
    );
    return cfg?.allowed_decisions ?? ["approve", "reject"];
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-1 flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-2xl space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-sm text-neutral-400 py-20">
              <p className="text-lg font-medium text-neutral-600 dark:text-neutral-300">
                ¡Hola! Soy {agentName}
              </p>
              <p className="mt-1">Escribe un mensaje para comenzar.</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
                }`}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>
              </div>
            </div>
          ))}

          {/* Interrupt: action request cards */}
          {interruptState && (
            <div className="flex justify-start">
              <div className="max-w-[90%] space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                  Confirmación requerida
                </p>
                {interruptState.interrupt.action_requests.map(
                  (action, idx) => (
                    <ActionRequestCard
                      key={`${action.name}-${idx}`}
                      action={action}
                      index={idx}
                      allowedDecisions={getAllowedDecisions(action.name)}
                      resolving={resolving}
                      editing={editingIndex === idx}
                      editedArgs={editedArgs}
                      onDecision={handleDecision}
                      onStartEdit={startEditing}
                      onCancelEdit={cancelEditing}
                      onArgChange={handleArgChange}
                    />
                  ),
                )}
              </div>
            </div>
          )}

          {loading && (
            <div className="flex justify-start">
              <div className="rounded-lg bg-neutral-100 px-4 py-2.5 text-sm dark:bg-neutral-800">
                <span className="animate-pulse">Pensando...</span>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <form
          onSubmit={handleSend}
          className="mx-auto flex max-w-2xl gap-2"
        >
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Escribe tu mensaje..."
            disabled={loading}
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Enviar
          </button>
        </form>
      </div>
    </div>
  );
}
