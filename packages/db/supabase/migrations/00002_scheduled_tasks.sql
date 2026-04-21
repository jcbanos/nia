-- ============================================================
-- Allow 'cron' as a channel in agent_sessions
-- ============================================================
alter table public.agent_sessions drop constraint agent_sessions_channel_check;
alter table public.agent_sessions add constraint agent_sessions_channel_check
  check (channel in ('web', 'telegram', 'cron'));

-- ============================================================
-- scheduled_tasks
-- ============================================================
create table public.scheduled_tasks (
  id             uuid primary key default uuid_generate_v4(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  prompt         text not null,
  schedule_type  text not null check (schedule_type in ('one_time', 'recurring')),
  run_at         timestamptz,
  cron_expr      text,
  timezone       text not null default 'UTC',
  status         text not null default 'active' check (status in ('active', 'running', 'paused', 'completed', 'failed')),
  last_run_at    timestamptz,
  next_run_at    timestamptz not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index idx_scheduled_tasks_due
  on public.scheduled_tasks (status, next_run_at)
  where status = 'active';

alter table public.scheduled_tasks enable row level security;

create policy "Users can manage own scheduled tasks"
  on public.scheduled_tasks for all
  using (auth.uid() = user_id);

-- ============================================================
-- scheduled_task_runs (execution audit log)
-- ============================================================
create table public.scheduled_task_runs (
  id               uuid primary key default uuid_generate_v4(),
  task_id          uuid not null references public.scheduled_tasks(id) on delete cascade,
  status           text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  error            text,
  agent_session_id uuid references public.agent_sessions(id),
  notified         boolean not null default false,
  notify_error     text,
  created_at       timestamptz not null default now()
);

create index idx_scheduled_task_runs_task
  on public.scheduled_task_runs (task_id, created_at desc);

alter table public.scheduled_task_runs enable row level security;

create policy "Users can view own task runs"
  on public.scheduled_task_runs for all
  using (
    exists (
      select 1 from public.scheduled_tasks t
      where t.id = task_id and t.user_id = auth.uid()
    )
  );
