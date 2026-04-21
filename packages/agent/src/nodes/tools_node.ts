import { interrupt } from "@langchain/langgraph";
import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { HumanDecision } from "@agents/types";
import { toolRequiresConfirmation } from "../tools/catalog";
import { buildConfirmationMessage } from "./confirmation_text";
import type { GraphState, GraphStateUpdate } from "../state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LangChainTool = any;

interface ToolsNodeOptions {
  tools: LangChainTool[];
}

interface PendingCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

function lastAIMessage(messages: BaseMessage[]): AIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof AIMessage) return m;
  }
  return undefined;
}

function findTool(tools: LangChainTool[], name: string): LangChainTool | undefined {
  return tools.find((t) => t?.name === name);
}

async function runTool(
  tool: LangChainTool,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const result = await tool.invoke(args);
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return JSON.stringify({ error: msg });
  }
}

/**
 * Build the tool-executor node.
 *
 * Responsibilities:
 * - Pull pending tool calls from the last `AIMessage`.
 * - For tool calls flagged by the catalog as requiring confirmation (and when
 *   `bypassConfirmation` is false), raise a single `interrupt(...)` whose
 *   payload mirrors what `humanInTheLoopMiddleware` used to emit (camelCase),
 *   so the existing `parseAgentResult` keeps working unchanged.
 * - Apply the human decisions returned via `Command({ resume: { decisions } })`:
 *   approve → execute; reject → ToolMessage with rejection notice; edit →
 *   execute with the user-provided arguments.
 * - Execute non-confirmation tools directly.
 */
export function makeToolExecutorNode({ tools }: ToolsNodeOptions) {
  return async function toolExecutorNode(
    state: GraphState,
  ): Promise<GraphStateUpdate> {
    const last = lastAIMessage(state.messages);
    const toolCalls = last?.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { messages: [] };
    }

    const needsHITL: PendingCall[] = [];
    const direct: PendingCall[] = [];

    for (const tc of toolCalls) {
      const id = tc.id ?? `${tc.name}-${Math.random().toString(36).slice(2)}`;
      const args = (tc.args ?? {}) as Record<string, unknown>;
      const call: PendingCall = { id, name: tc.name, args };
      if (!state.bypassConfirmation && toolRequiresConfirmation(tc.name)) {
        needsHITL.push(call);
      } else {
        direct.push(call);
      }
    }

    const out: ToolMessage[] = [];

    // Execute non-confirmation tools first so the interrupt payload only
    // reflects the calls actually awaiting user input.
    for (const call of direct) {
      const tool = findTool(tools, call.name);
      const content = tool
        ? await runTool(tool, call.args)
        : JSON.stringify({ error: `Tool not found: ${call.name}` });
      out.push(
        new ToolMessage({
          content,
          tool_call_id: call.id,
          name: call.name,
        }),
      );
    }

    if (needsHITL.length > 0) {
      const payload = {
        actionRequests: needsHITL.map((c) => ({
          name: c.name,
          args: c.args,
          description: buildConfirmationMessage(c.name, c.args),
        })),
        reviewConfigs: needsHITL.map((c) => ({
          actionName: c.name,
          allowedDecisions: ["approve", "reject", "edit"] as const,
        })),
      };

      // `interrupt` pauses the graph; on `Command({ resume: { decisions } })`
      // it returns the resume value. We accept either a bare array of
      // decisions or an object containing `decisions`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resumed: any = interrupt(payload);
      const decisions: HumanDecision[] = Array.isArray(resumed)
        ? resumed
        : Array.isArray(resumed?.decisions)
          ? resumed.decisions
          : [];

      for (let i = 0; i < needsHITL.length; i++) {
        const call = needsHITL[i];
        const decision = decisions[i] ?? decisions[0] ?? { type: "reject" as const };

        if (decision.type === "approve") {
          const tool = findTool(tools, call.name);
          const content = tool
            ? await runTool(tool, call.args)
            : JSON.stringify({ error: `Tool not found: ${call.name}` });
          out.push(
            new ToolMessage({
              content,
              tool_call_id: call.id,
              name: call.name,
            }),
          );
        } else if (decision.type === "edit") {
          const editedName = decision.editedAction?.name ?? call.name;
          const editedArgs =
            decision.editedAction?.args ??
            (call.args as Record<string, unknown>);
          const tool = findTool(tools, editedName);
          const content = tool
            ? await runTool(tool, editedArgs)
            : JSON.stringify({ error: `Tool not found: ${editedName}` });
          out.push(
            new ToolMessage({
              content,
              tool_call_id: call.id,
              name: editedName,
            }),
          );
        } else {
          // reject (or unknown decision)
          const reason = decision.message ?? "Rejected by user";
          out.push(
            new ToolMessage({
              content: JSON.stringify({ error: reason }),
              tool_call_id: call.id,
              name: call.name,
            }),
          );
        }
      }
    }

    return { messages: out };
  };
}
