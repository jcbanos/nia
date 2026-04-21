import type { DbClient } from "../client";

export interface ScheduledTask {
  id: string;
  user_id: string;
  prompt: string;
  schedule_type: "one_time" | "recurring";
  run_at: string | null;
  cron_expr: string | null;
  timezone: string;
  status: "active" | "running" | "paused" | "completed" | "failed";
  last_run_at: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
}

export interface ScheduledTaskRun {
  id: string;
  task_id: string;
  status: "running" | "completed" | "failed";
  started_at: string;
  finished_at: string | null;
  error: string | null;
  agent_session_id: string | null;
  notified: boolean;
  notify_error: string | null;
  created_at: string;
}

export async function createScheduledTask(
  db: DbClient,
  params: {
    user_id: string;
    prompt: string;
    schedule_type: "one_time" | "recurring";
    run_at?: string;
    cron_expr?: string;
    timezone?: string;
    next_run_at: string;
  }
) {
  const { data, error } = await db
    .from("scheduled_tasks")
    .insert({
      user_id: params.user_id,
      prompt: params.prompt,
      schedule_type: params.schedule_type,
      run_at: params.run_at ?? null,
      cron_expr: params.cron_expr ?? null,
      timezone: params.timezone ?? "UTC",
      next_run_at: params.next_run_at,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTask;
}

export async function getDueScheduledTasks(db: DbClient) {
  const { data, error } = await db
    .from("scheduled_tasks")
    .select("*")
    .eq("status", "active")
    .lte("next_run_at", new Date().toISOString())
    .order("next_run_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ScheduledTask[];
}

/**
 * Atomically mark a task as "running" only if it is still "active".
 * Returns the updated row, or null if another worker already grabbed it.
 */
export async function lockScheduledTask(db: DbClient, taskId: string) {
  const { data, error } = await db
    .from("scheduled_tasks")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("status", "active")
    .select()
    .single();
  if (error && error.code === "PGRST116") return null; // no rows matched
  if (error) throw error;
  return data as ScheduledTask | null;
}

export async function completeScheduledTask(
  db: DbClient,
  taskId: string,
  nextRunAt?: string
) {
  if (nextRunAt) {
    const { error } = await db
      .from("scheduled_tasks")
      .update({
        status: "active",
        last_run_at: new Date().toISOString(),
        next_run_at: nextRunAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", taskId);
    if (error) throw error;
  } else {
    const { error } = await db
      .from("scheduled_tasks")
      .update({
        status: "completed",
        last_run_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", taskId);
    if (error) throw error;
  }
}

export async function failScheduledTask(db: DbClient, taskId: string) {
  const { error } = await db
    .from("scheduled_tasks")
    .update({
      status: "failed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId);
  if (error) throw error;
}

export async function createScheduledTaskRun(
  db: DbClient,
  params: {
    task_id: string;
    agent_session_id?: string;
  }
) {
  const { data, error } = await db
    .from("scheduled_task_runs")
    .insert({
      task_id: params.task_id,
      status: "running",
      agent_session_id: params.agent_session_id ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ScheduledTaskRun;
}

export async function updateScheduledTaskRun(
  db: DbClient,
  runId: string,
  updates: {
    status?: "completed" | "failed";
    error?: string;
    notified?: boolean;
    notify_error?: string;
  }
) {
  const { error } = await db
    .from("scheduled_task_runs")
    .update({
      ...updates,
      finished_at:
        updates.status === "completed" || updates.status === "failed"
          ? new Date().toISOString()
          : undefined,
    })
    .eq("id", runId);
  if (error) throw error;
}
