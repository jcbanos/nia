import { HumanMessage } from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import {
  searchMemories,
  incrementRetrievalCount,
  type MatchedMemory,
  type MemoryType,
} from "@agents/db";
import { generateEmbedding } from "../embeddings";
import type { GraphState, GraphStateUpdate } from "../state";

interface MemoryInjectionOptions {
  db: DbClient;
  userId: string;
}

const MEMORY_LIMIT = 8;

const TYPE_LABELS: Record<MemoryType, string> = {
  episodic: "Episódicos (qué hizo y cuándo)",
  semantic: "Semánticos (preferencias y conocimiento durable)",
  procedural: "Procedurales (cómo opera, rutinas)",
};

function messageContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function findLatestUserInput(state: GraphState): string | null {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m instanceof HumanMessage) {
      const text = messageContentToString(m.content).trim();
      return text.length > 0 ? text : null;
    }
  }
  return null;
}

function buildMemoryBlock(memories: MatchedMemory[]): string {
  const grouped: Record<MemoryType, string[]> = {
    episodic: [],
    semantic: [],
    procedural: [],
  };
  for (const m of memories) {
    if (m.type in grouped) grouped[m.type].push(`- ${m.content}`);
  }

  const sections: string[] = [];
  const order: MemoryType[] = ["semantic", "episodic", "procedural"];
  for (const type of order) {
    const lines = grouped[type];
    if (lines.length === 0) continue;
    sections.push(`${TYPE_LABELS[type]}:\n${lines.join("\n")}`);
  }
  if (sections.length === 0) return "";

  return `[MEMORIA DEL USUARIO]\n${sections.join("\n\n")}\n[/MEMORIA DEL USUARIO]`;
}

/**
 * Build the memory-injection node. Runs as the first node after START on every
 * graph turn: embeds the latest user input, retrieves the top-N most similar
 * memories for the user, increments their retrieval count (fire-and-forget),
 * and prepends a `[MEMORIA DEL USUARIO]` block to `state.systemPrompt`.
 *
 * Failure-safe: any error (network, DB, parse) returns `{}` so memory issues
 * never break a user-facing turn.
 */
export function createMemoryInjectionNode({
  db,
  userId,
}: MemoryInjectionOptions) {
  return async function memoryInjectionNode(
    state: GraphState
  ): Promise<GraphStateUpdate> {
    const input = findLatestUserInput(state);
    if (!input) {
      console.log("[memory_injection] skip: no user input found");
      return {};
    }

    let memories: MatchedMemory[] = [];
    try {
      const embedding = await generateEmbedding(input);
      memories = await searchMemories(db, {
        userId,
        embedding,
        limit: MEMORY_LIMIT,
      });
    } catch (error) {
      console.error("[memory_injection] retrieval failed", error);
      return {};
    }

    console.log(`[memory_injection] retrieved ${memories.length} memory(ies)`);
    if (memories.length === 0) return {};

    incrementRetrievalCount(
      db,
      memories.map((m) => m.id)
    ).catch((error) => {
      console.error("memory_injection: increment failed", error);
    });

    const block = buildMemoryBlock(memories);
    if (!block) return {};

    const base = state.systemPrompt ?? "";
    const enriched = base ? `${block}\n\n${base}` : block;
    return { systemPrompt: enriched };
  };
}
