# Scheduled Tasks

## Overview

The agent can create scheduled tasks (one-time or recurring) that execute automatically via a cron endpoint. Each execution runs `runAgent` with the task's prompt and notifies the user via Telegram.

## Database Setup

Run the migration `packages/db/supabase/migrations/00002_scheduled_tasks.sql` against your Supabase project. This creates:

- **`scheduled_tasks`** — stores task definitions (prompt, schedule type, cron expression, next run time).
- **`scheduled_task_runs`** — audit log of each execution with status, timing, and notification outcome.

## Environment Variables

Add to your `.env` (see `.env.example`):

```
CRON_SECRET=<generate-a-random-secret>
```

## Supabase Cron Setup

In the Supabase Dashboard, go to **Database → Extensions** and enable `pg_cron` if not already enabled.

Then create a cron job that fires every minute:

```sql
select cron.schedule(
  'run-scheduled-tasks',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://<your-app-domain>/api/cron/scheduled-tasks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<your-CRON_SECRET-value>'
    ),
    body := '{}'::jsonb
  );
  $$
);
```

Replace `<your-app-domain>` and `<your-CRON_SECRET-value>` with your actual values.

> **Note:** The `pg_net` extension (`net.http_post`) must also be enabled for outbound HTTP from the database.

## How It Works

1. The agent tool `schedule_task` lets users create tasks via chat (web or Telegram).
2. Every minute, Supabase Cron POSTs to `/api/cron/scheduled-tasks`.
3. The endpoint reads due tasks (`next_run_at <= now`, `status = active`), locks each one atomically, then runs `runAgent` with the task's prompt.
4. After execution, the result is sent to the user via Telegram (if linked). If no Telegram account is linked, the run is recorded as `notified=false` without error.
5. For recurring tasks, `next_run_at` is recalculated from the cron expression. One-time tasks are marked `completed`.

## Example Prompts

Users can ask the agent to create scheduled tasks naturally:

- *"Recuérdame revisar mis emails todos los lunes a las 9am"* → recurring, `cron_expr: "0 9 * * 1"`
- *"Mañana a las 3pm busca las noticias principales de Hacker News"* → one-time, `run_at: "2025-01-15T15:00:00Z"`
- *"Cada día a las 8am dame un resumen de mis issues abiertos en GitHub"* → recurring, `cron_expr: "0 8 * * *"`
