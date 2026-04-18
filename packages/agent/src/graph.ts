import {
  MemorySaver,
  StateGraph,
  START,
  END,
  Command,
} from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type {
  UserToolSetting,
  UserIntegration,
  PendingConfirmation,
  InterruptPayload,
  HumanDecision,
} from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools } from "./tools/adapters";
import { getSessionMessages, addMessage } from "@agents/db";
import { GraphStateAnnotation } from "./state";
import type { GraphState } from "./state";
import { makeAgentNode } from "./nodes/agent_node";
import { makeToolExecutorNode } from "./nodes/tools_node";
import { compactionNode } from "./nodes/compaction_node";
import { buildConfirmationMessage } from "./nodes/confirmation_text";

// Module-level singleton – survives across HTTP requests within the same
// process.  Swap for @langchain/langgraph-checkpoint-postgres in production.
const checkpointer = new MemorySaver();

const MAX_TOOL_ITERATIONS = 6;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentInput {
  message: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  decryptedTokens: Record<string, string>;
  bypassConfirmation?: boolean;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation: PendingConfirmation | null;
  interrupt: InterruptPayload | null;
}

export interface ResumeInput {
  sessionId: string;
  decisions: HumanDecision[];
  db: DbClient;
  userId: string;
  systemPrompt: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  decryptedTokens: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolBuildContext {
  db: DbClient;
  userId: string;
  sessionId: string;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  decryptedTokens: Record<string, string>;
}

/**
 * `iterationCount` is derived from message history: the number of consecutive
 * `AIMessage` turns with tool_calls since the last `HumanMessage`. Equivalent
 * to counting how many times the agent has fired tools in this user turn.
 */
function deriveIterationCount(messages: BaseMessage[]): number {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof HumanMessage) break;
    if (m instanceof AIMessage && (m.tool_calls?.length ?? 0) > 0) count++;
  }
  return count;
}

function shouldContinue(state: GraphState): "tools" | "end" {
  const last = state.messages[state.messages.length - 1];
  if (!(last instanceof AIMessage)) return "end";
  if ((last.tool_calls?.length ?? 0) === 0) return "end";
  if (deriveIterationCount(state.messages) >= MAX_TOOL_ITERATIONS) return "end";
  return "tools";
}

function buildCompiledGraph(ctx: ToolBuildContext, systemPrompt: string) {
  const tools = buildLangChainTools(ctx);
  const model = createChatModel();

  const agentNode = makeAgentNode({
    model,
    tools,
    baseSystemPrompt: systemPrompt,
  });
  const toolsNode = makeToolExecutorNode({ tools });

  const graph = new StateGraph(GraphStateAnnotation)
    .addNode("compaction", compactionNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: END,
    })
    .addEdge("tools", "compaction");

  return graph.compile({ checkpointer });
}

interface ParsedResult {
  interrupt: InterruptPayload | null;
  pendingConfirmation: PendingConfirmation | null;
  responseText: string;
  toolCalls: string[];
}

function extractToolCallNames(messages: BaseMessage[]): string[] {
  const names: string[] = [];
  for (const msg of messages) {
    if (msg instanceof AIMessage && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        names.push(tc.name);
      }
    }
  }
  return names;
}

function parseAgentResult(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  sessionId: string,
): ParsedResult {
  const messages: BaseMessage[] = raw.messages ?? [];
  const toolCalls = extractToolCallNames(messages);

  if (raw.__interrupt__?.length) {
    const val = raw.__interrupt__[0].value;

    // The middleware emits camelCase keys (actionRequests, reviewConfigs,
    // args, actionName, allowedDecisions). Map them to our snake_case types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawActions: any[] =
      val.actionRequests ?? val.action_requests ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawReviews: any[] =
      val.reviewConfigs ?? val.review_configs ?? [];

    const interrupt: InterruptPayload = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      action_requests: rawActions.map((ar: any) => ({
        name: ar.name,
        arguments: ar.args ?? ar.arguments ?? {},
        description: ar.description,
      })),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      review_configs: rawReviews.map((rc: any) => ({
        action_name: rc.actionName ?? rc.action_name,
        allowed_decisions: rc.allowedDecisions ?? rc.allowed_decisions ?? [],
      })),
    };

    const first = interrupt.action_requests[0];
    const pendingConfirmation: PendingConfirmation | null = first
      ? {
          tool_call_id: sessionId,
          tool_name: first.name,
          message:
            first.description ??
            buildConfirmationMessage(first.name, first.arguments),
          args: first.arguments,
          interrupt,
        }
      : null;

    return {
      interrupt,
      pendingConfirmation,
      responseText: pendingConfirmation?.message ?? "",
      toolCalls,
    };
  }

  const last = messages[messages.length - 1];
  const responseText =
    typeof last?.content === "string"
      ? last.content
      : JSON.stringify(last?.content ?? "");

  return { interrupt: null, pendingConfirmation: null, responseText, toolCalls };
}

async function toAgentOutput(
  db: DbClient,
  sessionId: string,
  parsed: ParsedResult,
): Promise<AgentOutput> {
  const textToStore = parsed.interrupt
    ? parsed.pendingConfirmation?.message
    : parsed.responseText;

  if (textToStore) {
    await addMessage(db, sessionId, "assistant", textToStore);
  }

  return {
    response: parsed.responseText,
    toolCalls: parsed.toolCalls,
    pendingConfirmation: parsed.pendingConfirmation,
    interrupt: parsed.interrupt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const {
    message,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    decryptedTokens,
    bypassConfirmation,
  } = input;

  const compiled = buildCompiledGraph(
    { db, userId, sessionId, enabledTools, integrations, decryptedTokens },
    systemPrompt,
  );

  const config = { configurable: { thread_id: sessionId } };

  // If the checkpointer already holds state for this thread we only append
  // the new message; otherwise we bootstrap from the database so the model
  // has full conversational context.
  let hasCheckpoint = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snap: any = await (compiled as any).getState(config);
    const msgs = snap?.values?.messages;
    hasCheckpoint = Array.isArray(msgs) && msgs.length > 0;
  } catch {
    /* no checkpoint yet */
  }

  let inputMessages: BaseMessage[];
  if (hasCheckpoint) {
    inputMessages = [new HumanMessage(message)];
  } else {
    const history = await getSessionMessages(db, sessionId, 30);
    inputMessages = [
      ...history.map((m) =>
        m.role === "user"
          ? new HumanMessage(m.content)
          : new AIMessage(m.content),
      ),
      new HumanMessage(message),
    ];
  }

  await addMessage(db, sessionId, "user", message);

  const result = await compiled.invoke(
    {
      messages: inputMessages,
      sessionId,
      userId,
      systemPrompt,
      bypassConfirmation: bypassConfirmation ?? false,
    },
    config,
  );
  return toAgentOutput(db, sessionId, parseAgentResult(result, sessionId));
}

export async function resumeAgent(input: ResumeInput): Promise<AgentOutput> {
  const {
    sessionId,
    decisions,
    db,
    userId,
    systemPrompt,
    enabledTools,
    integrations,
    decryptedTokens,
  } = input;

  const compiled = buildCompiledGraph(
    { db, userId, sessionId, enabledTools, integrations, decryptedTokens },
    systemPrompt,
  );

  const config = { configurable: { thread_id: sessionId } };
  const result = await compiled.invoke(
    new Command({ resume: { decisions } }),
    config,
  );

  return toAgentOutput(db, sessionId, parseAgentResult(result, sessionId));
}
