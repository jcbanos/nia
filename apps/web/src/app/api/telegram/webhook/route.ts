import { NextResponse } from "next/server";
import { createServerClient } from "@agents/db";
import { runAgent, resumeAgent, flushSessionMemory } from "@agents/agent";
import { sendTelegramMessage, answerCallbackQuery } from "@/lib/telegram";
import { buildToolContext } from "@/lib/agent-context";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message: { chat: { id: number }; message_id: number };
    data: string;
  };
}

function parseBotCommand(messageText: string): {
  command: string;
  args: string;
} {
  const trimmed = messageText.trim();
  const i = trimmed.indexOf(" ");
  const head = i === -1 ? trimmed : trimmed.slice(0, i);
  const tail = i === -1 ? "" : trimmed.slice(i + 1).trim();
  const at = head.indexOf("@");
  const command = (at === -1 ? head : head.slice(0, at)).toLowerCase();
  return { command, args: tail };
}

export async function POST(request: Request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const update: TelegramUpdate = await request.json();
  const db = createServerClient();

  if (update.callback_query) {
    const cb = update.callback_query;
    const [action, toolCallId] = cb.data.split(":");

    if ((action === "approve" || action === "reject") && toolCallId) {
      const sessionId = toolCallId;

      const { data: session } = await db
        .from("agent_sessions")
        .select("user_id")
        .eq("id", sessionId)
        .single();

      if (!session) {
        await answerCallbackQuery(cb.id, "Sesión no encontrada");
        return NextResponse.json({ ok: true });
      }

      const isApprove = action === "approve";
      await answerCallbackQuery(cb.id, isApprove ? "Aprobado" : "Rechazado");
      await sendTelegramMessage(
        cb.message.chat.id,
        isApprove ? "Acción aprobada. Ejecutando..." : "Acción cancelada."
      );

      if (isApprove) {
        const { data: profile } = await db
          .from("profiles")
          .select("agent_system_prompt")
          .eq("id", session.user_id)
          .single();

        const toolCtx = await buildToolContext(db, session.user_id, sessionId);

        const result = await resumeAgent({
          sessionId,
          decisions: [{ type: "approve" }],
          db,
          userId: session.user_id,
          systemPrompt:
            profile?.agent_system_prompt ?? "Eres un asistente útil.",
          enabledTools: toolCtx.enabledTools,
          integrations: toolCtx.integrations,
          decryptedTokens: toolCtx.decryptedTokens,
        });

        if (result.pendingConfirmation) {
          const pc = result.pendingConfirmation;
          await sendTelegramMessage(
            cb.message.chat.id,
            pc.message ?? "Se requiere confirmación.",
            {
              inline_keyboard: [
                [
                  {
                    text: "Aprobar",
                    callback_data: `approve:${pc.tool_call_id}`,
                  },
                  {
                    text: "Cancelar",
                    callback_data: `reject:${pc.tool_call_id}`,
                  },
                ],
              ],
            }
          );
        } else {
          await sendTelegramMessage(cb.message.chat.id, result.response);
          flushSessionMemory({
            db,
            userId: session.user_id,
            sessionId,
          }).catch((e) => console.error("memory flush failed:", e));
        }
      }
    }

    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.text) {
    return NextResponse.json({ ok: true });
  }

  const telegramUserId = message.from.id;
  const chatId = message.chat.id;
  const text = message.text.trim();
  const { command, args } = parseBotCommand(text);

  if (command === "/start") {
    await sendTelegramMessage(
      chatId,
      "¡Hola! Soy tu agente personal.\n\nSi ya tienes cuenta web, ve a Ajustes → Telegram en la web, genera un código de vinculación y envíamelo así:\n/link TU_CODIGO"
    );
    return NextResponse.json({ ok: true });
  }

  if (command === "/link") {
    const code = args.trim().toUpperCase();
    if (!code) {
      await sendTelegramMessage(
        chatId,
        "Indica el código que generaste en la web, por ejemplo:\n/link ABC123"
      );
      return NextResponse.json({ ok: true });
    }

    const { data: linkRecord } = await db
      .from("telegram_link_codes")
      .select("*")
      .eq("code", code)
      .eq("used", false)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (!linkRecord) {
      await sendTelegramMessage(
        chatId,
        "Código inválido o expirado. Genera uno nuevo desde la web."
      );
      return NextResponse.json({ ok: true });
    }

    await db.from("telegram_accounts").upsert(
      {
        user_id: linkRecord.user_id,
        telegram_user_id: telegramUserId,
        chat_id: chatId,
        linked_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    await db
      .from("telegram_link_codes")
      .update({ used: true })
      .eq("id", linkRecord.id);

    await sendTelegramMessage(
      chatId,
      "¡Cuenta vinculada correctamente! Ya puedes chatear conmigo."
    );
    return NextResponse.json({ ok: true });
  }

  const { data: telegramAccount } = await db
    .from("telegram_accounts")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .single();

  if (!telegramAccount) {
    await sendTelegramMessage(
      chatId,
      "No tienes una cuenta vinculada. Usa /link TU_CODIGO (código desde Ajustes en la web)."
    );
    return NextResponse.json({ ok: true });
  }

  const userId = telegramAccount.user_id;

  let session = await db
    .from("agent_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("channel", "telegram")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()
    .then((r) => r.data);

  if (!session) {
    const { data } = await db
      .from("agent_sessions")
      .insert({
        user_id: userId,
        channel: "telegram",
        status: "active",
        budget_tokens_used: 0,
        budget_tokens_limit: 100000,
      })
      .select()
      .single();
    session = data;
  }

  if (!session) {
    await sendTelegramMessage(chatId, "Error interno creando sesión.");
    return NextResponse.json({ ok: true });
  }

  const { data: profile } = await db
    .from("profiles")
    .select("agent_system_prompt")
    .eq("id", userId)
    .single();

  const toolCtx = await buildToolContext(db, userId, session.id);

  try {
    const result = await runAgent({
      message: text,
      userId,
      sessionId: session.id,
      systemPrompt:
        profile?.agent_system_prompt ?? "Eres un asistente útil.",
      db,
      enabledTools: toolCtx.enabledTools,
      integrations: toolCtx.integrations,
      decryptedTokens: toolCtx.decryptedTokens,
    });

    if (result.pendingConfirmation) {
      const pc = result.pendingConfirmation;
      await sendTelegramMessage(
        chatId,
        pc.message ?? "Se requiere confirmación.",
        {
          inline_keyboard: [
            [
              {
                text: "Aprobar",
                callback_data: `approve:${pc.tool_call_id}`,
              },
              {
                text: "Cancelar",
                callback_data: `reject:${pc.tool_call_id}`,
              },
            ],
          ],
        }
      );
    } else {
      await sendTelegramMessage(chatId, result.response);
      flushSessionMemory({
        db,
        userId,
        sessionId: session.id,
      }).catch((e) => console.error("memory flush failed:", e));
    }
  } catch (error) {
    console.error("Telegram agent error:", error);
    await sendTelegramMessage(
      chatId,
      "Hubo un error procesando tu mensaje. Intenta de nuevo."
    );
  }

  return NextResponse.json({ ok: true });
}
