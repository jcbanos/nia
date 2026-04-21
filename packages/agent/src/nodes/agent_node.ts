import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatOpenAI } from "@langchain/openai";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LangChainTool = any;
import type { GraphState, GraphStateUpdate } from "../state";

interface AgentNodeOptions {
  model: ChatOpenAI;
  tools: LangChainTool[];
  baseSystemPrompt: string;
}

const ZURICH_DATE_FMT = new Intl.DateTimeFormat("en-CH", {
  timeZone: "Europe/Zurich",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

function buildEnrichedSystemPrompt(base: string): string {
  const now = ZURICH_DATE_FMT.format(new Date());
  return `${base}\n\nCurrent date/time (Europe/Zurich): ${now}`;
}

/**
 * Build the agent node. Tools are bound to the model exactly once at factory
 * time so cost and behaviour stay equivalent to the previous `createAgent()`
 * implementation.
 */
export function makeAgentNode({
  model,
  tools,
  baseSystemPrompt,
}: AgentNodeOptions) {
  const modelWithTools =
    tools.length > 0
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (model as any).bindTools(tools)
      : model;

  return async function agentNode(state: GraphState): Promise<GraphStateUpdate> {
    const systemMsg = new SystemMessage(
      buildEnrichedSystemPrompt(state.systemPrompt ?? baseSystemPrompt),
    );
    const inputMessages: BaseMessage[] = [systemMsg, ...state.messages];
    const aiResponse = await modelWithTools.invoke(inputMessages);
    return { messages: [aiResponse] };
  };
}
