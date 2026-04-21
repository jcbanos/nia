-- ============================================================
-- pgvector extension (required for embedding similarity search)
-- ============================================================
create extension if not exists vector;

-- ============================================================
-- memories
-- ============================================================
create table public.memories (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  type              text not null check (type in ('episodic', 'semantic', 'procedural')),
  content           text not null,
  embedding         vector(1536),
  retrieval_count   int  not null default 0,
  created_at        timestamptz not null default now(),
  last_retrieved_at timestamptz
);

create index on public.memories
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

alter table public.memories enable row level security;

create policy "Users manage own memories"
  on public.memories for all
  using (auth.uid() = user_id);

-- ============================================================
-- match_memories RPC (cosine similarity search)
-- ============================================================
create or replace function public.match_memories(
  p_user_id   uuid,
  p_embedding vector(1536),
  p_limit     int default 8
) returns table (
  id              uuid,
  type            text,
  content         text,
  retrieval_count int,
  similarity      float
) language sql stable as $$
  select
    id,
    type,
    content,
    retrieval_count,
    1 - (embedding <=> p_embedding) as similarity
  from public.memories
  where user_id = p_user_id
    and embedding is not null
  order by embedding <=> p_embedding
  limit p_limit;
$$;
