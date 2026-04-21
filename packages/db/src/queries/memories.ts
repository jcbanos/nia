import type { DbClient } from "../client";

export type MemoryType = "episodic" | "semantic" | "procedural";

export interface Memory {
  id: string;
  user_id: string;
  type: MemoryType;
  content: string;
  embedding: number[] | null;
  retrieval_count: number;
  created_at: string;
  last_retrieved_at: string | null;
}

export interface MatchedMemory {
  id: string;
  type: MemoryType;
  content: string;
  retrieval_count: number;
  similarity: number;
}

export async function saveMemory(
  db: DbClient,
  params: {
    userId: string;
    type: MemoryType;
    content: string;
    embedding: number[];
  }
) {
  const { data, error } = await db
    .from("memories")
    .insert({
      user_id: params.userId,
      type: params.type,
      content: params.content,
      embedding: params.embedding,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Memory;
}

export async function searchMemories(
  db: DbClient,
  params: {
    userId: string;
    embedding: number[];
    limit?: number;
  }
): Promise<MatchedMemory[]> {
  const { data, error } = await db.rpc("match_memories", {
    p_user_id: params.userId,
    p_embedding: params.embedding,
    p_limit: params.limit ?? 8,
  });
  if (error) throw error;
  return (data ?? []) as MatchedMemory[];
}

/**
 * Increment retrieval_count and update last_retrieved_at for the given ids.
 *
 * Supabase JS lacks an atomic `+= 1` operator, so we fetch current counts and
 * write them back. This is acceptable here because it runs as a fire-and-forget
 * background increment with low contention.
 */
export async function incrementRetrievalCount(
  db: DbClient,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;

  const { data: rows, error: fetchError } = await db
    .from("memories")
    .select("id, retrieval_count")
    .in("id", ids);
  if (fetchError) throw fetchError;

  const now = new Date().toISOString();
  await Promise.all(
    (rows ?? []).map(async (row: { id: string; retrieval_count: number }) => {
      const { error } = await db
        .from("memories")
        .update({
          retrieval_count: (row.retrieval_count ?? 0) + 1,
          last_retrieved_at: now,
        })
        .eq("id", row.id);
      if (error) throw error;
    })
  );
}
