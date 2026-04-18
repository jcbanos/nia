import {
  ToolMessage,
  SystemMessage,
  HumanMessage,
  AIMessage,
  RemoveMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { createCompactionModel } from "../model";
import type { GraphState, GraphStateUpdate } from "../state";

// ─── Tunables ──────────────────────────────────────────────────────────────
const WINDOW_MAX_TOKENS = 128_000;
const COMPACTION_THRESHOLD = 0.8;
const MICROCOMPACT_KEEP_LAST = 5;
const COMPACTION_TAIL_KEEP = 8;
const COMPACTION_FAILURE_LIMIT = 3;
const CLEARED_PLACEHOLDER = "[tool result cleared]";

// ─── Helpers ───────────────────────────────────────────────────────────────

function messageContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Conservative token estimate: ~4 chars/token over serialized content.
 * Used only to decide whether to fire the (expensive) LLM compaction.
 */
function estimateTokens(messages: BaseMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += messageContentToString(m.content).length;
  }
  return Math.ceil(chars / 4);
}

const COMPACTION_PROMPT = `You are a conversation compactor. Read the conversation transcript that follows and produce a compact, faithful summary in EXACTLY these 9 sections, in this order, using markdown headings:

## 1. Objetivo
## 2. Contexto clave
## 3. Decisiones
## 4. Tools usadas y resultados relevantes
## 5. Preferencias del usuario
## 6. Pendientes / preguntas abiertas
## 7. Errores encontrados
## 8. Estado actual
## 9. Próximos pasos probables

Rules:
- Keep it short and information-dense; preserve concrete identifiers (file paths, repo names, issue numbers, URLs).
- Do NOT invent facts. If a section has no content, write "—".
- Output ONLY the 9 sections in markdown. No preamble, no closing remarks.
`;

function roleLabel(m: BaseMessage): string {
  if (m instanceof HumanMessage) return "user";
  if (m instanceof AIMessage) return "assistant";
  if (m instanceof SystemMessage) return "system";
  if (m instanceof ToolMessage) return `tool(${m.name ?? ""})`;
  return "msg";
}

function transcriptOf(messages: BaseMessage[]): string {
  return messages
    .map((m) => `[${roleLabel(m)}]\n${messageContentToString(m.content)}`)
    .join("\n\n");
}

function microcompactPatch(messages: BaseMessage[]): ToolMessage[] {
  const toolMsgs = messages.filter(
    (m): m is ToolMessage => m instanceof ToolMessage,
  );
  if (toolMsgs.length <= MICROCOMPACT_KEEP_LAST) return [];

  const older = toolMsgs.slice(0, toolMsgs.length - MICROCOMPACT_KEEP_LAST);
  const patch: ToolMessage[] = [];
  for (const m of older) {
    if (!m.id) continue; // can't replace by id; leave as-is
    if (messageContentToString(m.content) === CLEARED_PLACEHOLDER) continue;
    patch.push(
      new ToolMessage({
        id: m.id,
        content: CLEARED_PLACEHOLDER,
        tool_call_id: m.tool_call_id,
        name: m.name,
      }),
    );
  }
  return patch;
}

/**
 * Apply the microcompact patch as if the reducer had already run, so the
 * subsequent token estimate reflects the post-microcompact state.
 */
function applyPatch(
  messages: BaseMessage[],
  patch: ToolMessage[],
): BaseMessage[] {
  if (patch.length === 0) return messages;
  const byId = new Map(patch.map((m) => [m.id!, m]));
  return messages.map((m) => (m.id && byId.get(m.id)) || m);
}

// ─── Node ──────────────────────────────────────────────────────────────────

/**
 * Transparent compaction node.
 *
 * Stage 1 — microcompact (free): replace contents of older `ToolMessage`s
 * (all but the last MICROCOMPACT_KEEP_LAST) with `[tool result cleared]`.
 *
 * Stage 2 — LLM compaction (only if estimated tokens >= 80% of window):
 * summarise everything except the last COMPACTION_TAIL_KEEP messages into a
 * 9-section structured summary using Haiku, strip any `<analysis>...</analysis>`
 * blocks the model may emit, and replace the head with a single SystemMessage.
 *
 * Circuit breaker: after COMPACTION_FAILURE_LIMIT consecutive failures, the
 * node falls back to passthrough (microcompact only) instead of looping on a
 * broken compactor.
 */
export async function compactionNode(
  state: GraphState,
): Promise<GraphStateUpdate> {
  const patch = microcompactPatch(state.messages);
  const afterMicro = applyPatch(state.messages, patch);

  const tokens = estimateTokens(afterMicro);
  const overThreshold = tokens >= WINDOW_MAX_TOKENS * COMPACTION_THRESHOLD;

  if (!overThreshold) {
    return {
      messages: patch,
      compactionCount: 0,
    };
  }

  if ((state.compactionCount ?? 0) >= COMPACTION_FAILURE_LIMIT) {
    // Circuit breaker tripped: passthrough.
    return { messages: patch };
  }

  if (afterMicro.length <= COMPACTION_TAIL_KEEP) {
    // Nothing meaningful to compact even though we are over threshold.
    return { messages: patch, compactionCount: 0 };
  }

  const head = afterMicro.slice(0, afterMicro.length - COMPACTION_TAIL_KEEP);
  const headWithIds = head.filter((m) => Boolean(m.id));

  if (headWithIds.length === 0) {
    return { messages: patch, compactionCount: 0 };
  }

  try {
    const model = createCompactionModel();
    const transcript = transcriptOf(head);
    const response = await model.invoke([
      new SystemMessage(COMPACTION_PROMPT),
      new HumanMessage(`Conversation transcript:\n\n${transcript}`),
    ]);
    const rawSummary = messageContentToString(response.content);
    const cleanSummary = rawSummary
      .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
      .trim();

    if (!cleanSummary) {
      throw new Error("Empty compaction summary");
    }

    const removals = headWithIds.map(
      (m) => new RemoveMessage({ id: m.id as string }),
    );
    const summaryMsg = new SystemMessage(
      `Resumen comprimido:\n${cleanSummary}`,
    );

    return {
      messages: [...patch, ...removals, summaryMsg],
      compactionCount: 0,
    };
  } catch {
    return {
      messages: patch,
      compactionCount: (state.compactionCount ?? 0) + 1,
    };
  }
}
