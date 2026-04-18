import { NextResponse } from "next/server";
import {
  createServerClient,
  getDueScheduledTasks,
  lockScheduledTask,
  completeScheduledTask,
  failScheduledTask,
  createScheduledTaskRun,
  updateScheduledTaskRun,
} from "@agents/db";
import { runAgent } from "@agents/agent";
import { sendTelegramMessage } from "@/lib/telegram";
import { buildToolContext } from "@/lib/agent-context";

const CRON_SECRET = process.env.CRON_SECRET ?? "";

export async function POST(request: Request) {
  const secret = request.headers.get("x-cron-secret");
  if (!CRON_SECRET || secret !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = createServerClient();

  const { data: allTasks } = await db
    .from("scheduled_tasks")
    .select("id, status, next_run_at");
  console.log("[cron] All tasks:", JSON.stringify(allTasks));

  const dueTasks = await getDueScheduledTasks(db);
  console.log("[cron] Due tasks:", dueTasks.length, JSON.stringify(dueTasks.map(t => ({ id: t.id, status: t.status, next_run_at: t.next_run_at }))));
  let processed = 0;

  for (const task of dueTasks) {
    console.log("[cron] Locking task:", task.id);
    const locked = await lockScheduledTask(db, task.id);
    console.log("[cron] Lock result:", locked ? "locked" : "skipped");
    if (!locked) continue;

    const { data: session, error: sessionError } = await db
      .from("agent_sessions")
      .insert({
        user_id: task.user_id,
        channel: "cron",
        status: "active",
        budget_tokens_used: 0,
        budget_tokens_limit: 100000,
      })
      .select()
      .single();

    console.log("[cron] Session:", session?.id, "error:", sessionError?.message);

    if (!session) {
      await failScheduledTask(db, task.id);
      continue;
    }

    const run = await createScheduledTaskRun(db, {
      task_id: task.id,
      agent_session_id: session.id,
    });

    try {
      const { data: profile } = await db
        .from("profiles")
        .select("agent_system_prompt")
        .eq("id", task.user_id)
        .single();

      const toolCtx = await buildToolContext(db, task.user_id, session.id);

      const result = await runAgent({
        message: task.prompt,
        userId: task.user_id,
        sessionId: session.id,
        systemPrompt:
          profile?.agent_system_prompt ?? "Eres un asistente útil.",
        db,
        enabledTools: toolCtx.enabledTools,
        integrations: toolCtx.integrations,
        decryptedTokens: toolCtx.decryptedTokens,
      });

      await updateScheduledTaskRun(db, run.id, { status: "completed" });

      let nextRunAt: string | undefined;
      if (task.schedule_type === "recurring" && task.cron_expr) {
        const { CronExpressionParser } = await import("cron-parser");
        const expr = CronExpressionParser.parse(task.cron_expr, {
          tz: task.timezone,
        });
        nextRunAt = expr.next().toDate().toISOString();
      }
      await completeScheduledTask(db, task.id, nextRunAt);

      // Telegram notification
      const { data: telegramAccount } = await db
        .from("telegram_accounts")
        .select("chat_id")
        .eq("user_id", task.user_id)
        .single();

      if (telegramAccount?.chat_id) {
        try {
          const summary =
            result.response.length > 500
              ? result.response.slice(0, 500) + "…"
              : result.response;
          await sendTelegramMessage(
            telegramAccount.chat_id,
            `⏰ Tarea programada ejecutada:\n\n"${task.prompt}"\n\nResultado:\n${summary}`
          );
          await updateScheduledTaskRun(db, run.id, { notified: true });
        } catch (notifyErr) {
          const msg =
            notifyErr instanceof Error ? notifyErr.message : "Unknown error";
          await updateScheduledTaskRun(db, run.id, {
            notified: false,
            notify_error: msg,
          });
        }
      } else {
        await updateScheduledTaskRun(db, run.id, {
          notified: false,
          notify_error: "no_telegram_link",
        });
      }

      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`Scheduled task ${task.id} failed:`, msg);
      await updateScheduledTaskRun(db, run.id, {
        status: "failed",
        error: msg,
      });
      await failScheduledTask(db, task.id);
    }
  }

  return NextResponse.json({ ok: true, processed });
}
