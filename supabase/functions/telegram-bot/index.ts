// telegram-bot — your brain, in your pocket.
//
// Telegram calls this function (a "webhook") every time someone messages your
// bot. The checks run in a deliberate order:
//   1. Secret header — proves the request really came from Telegram.
//   2. Owner check  — proves the message came from YOUR chat.
//   3. Only then is the database touched.
//
// Commands:
//   /search words   or   ?words   → the 5 newest thoughts containing "words"
//   /recent                        → your last 5 thoughts
//   anything else                  → saved as a new thought
//
// Secrets (Supabase → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_CHAT_ID, OWNER_USER_ID
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const PREVIEW_CHARS = 300;

type TelegramMessage = {
  chat?: { id?: number };
  text?: string;
};
type TelegramUpdate = {
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

Deno.serve(async (req) => {
  // 1. SECRET CHECK — before anything else. Telegram attaches this header to
  //    every delivery because we gave it the secret in setWebhook. A stranger
  //    who finds this function's address does not know it.
  const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!webhookSecret || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== webhookSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  // From here on, always answer 200 so Telegram does not keep retrying the
  // same message — but log every problem so it shows up in the function's Logs.
  try {
    const update = (await req.json()) as TelegramUpdate;
    await handleUpdate(update);
  } catch (err) {
    console.error("telegram-bot: unexpected error", err);
  }
  return new Response("ok");
});

async function handleUpdate(update: TelegramUpdate) {
  const message = update.message ?? update.edited_message;
  const chatId = message?.chat?.id;
  if (!message || chatId === undefined) return; // nothing we can reply to

  // 2. OWNER CHECK — the most important part. Bot usernames are public, so
  //    without this anyone could read your brain with /recent or write into it.
  const ownerChatId = (Deno.env.get("TELEGRAM_CHAT_ID") ?? "").trim();
  if (!ownerChatId) {
    await reply(chatId, `This brain is not finished setting up. Your chat id is: ${chatId}`);
    return;
  }
  if (String(chatId) !== ownerChatId) {
    await reply(chatId, "This is a private brain.");
    return;
  }

  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    await reply(chatId, "I can only save text for now.");
    return;
  }

  const ownerUserId = (Deno.env.get("OWNER_USER_ID") ?? "").trim();
  if (!ownerUserId) {
    console.error("telegram-bot: OWNER_USER_ID secret is not set");
    await reply(chatId, "Setup problem: the OWNER_USER_ID secret is missing in Supabase.");
    return;
  }

  // 3. DATABASE. The service role key skips Row Level Security entirely, so
  //    every query below filters by your user id by hand, and every insert
  //    sets it — otherwise rows would save with no owner and vanish from your app.
  const db = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // "/search@YourBot words" is how Telegram sometimes sends commands; drop the @YourBot part.
  const command = text.match(/^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/);
  const name = command?.[1].toLowerCase();
  const rest = command?.[2].trim() ?? "";

  if (name === "start" || name === "help") {
    await reply(
      chatId,
      "Send me any text and I'll save it to your brain.\n\n" +
        "/search words — find thoughts containing those words (or start with ?)\n" +
        "/recent — your last 5 thoughts",
    );
    return;
  }

  if (name === "search" || (!command && text.startsWith("?"))) {
    const query = name === "search" ? rest : text.slice(1).trim();
    if (!query) {
      await reply(chatId, "What should I search for? Try: /search coffee");
      return;
    }
    // Treat % and _ as ordinary characters, not wildcards (same as the app).
    const pattern = "%" + query.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    const { data, error } = await db
      .from("thoughts")
      .select("content, created_at")
      .eq("user_id", ownerUserId)
      .ilike("content", pattern)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) {
      console.error("telegram-bot: search failed", error);
      await reply(chatId, "Search failed: " + error.message);
      return;
    }
    await reply(chatId, data.length ? formatList(`Results for "${query}":`, data) : `Nothing matched "${query}".`);
    return;
  }

  if (name === "recent") {
    const { data, error } = await db
      .from("thoughts")
      .select("content, created_at")
      .eq("user_id", ownerUserId)
      .order("created_at", { ascending: false })
      .limit(5);
    if (error) {
      console.error("telegram-bot: recent failed", error);
      await reply(chatId, "Could not load recent thoughts: " + error.message);
      return;
    }
    await reply(chatId, data.length ? formatList("Your last 5 thoughts:", data) : "Your brain is empty so far.");
    return;
  }

  if (command) {
    await reply(chatId, `I don't know /${name}. Try /search, /recent or /help.`);
    return;
  }

  // Anything else is a new thought.
  const { error } = await db.from("thoughts").insert({ content: text, user_id: ownerUserId, source: "telegram" });
  if (error) {
    console.error("telegram-bot: save failed", error);
    await reply(chatId, "Could not save: " + error.message);
    return;
  }
  await reply(chatId, "Saved to your brain");
}

function formatList(heading: string, rows: { content: string; created_at: string }[]) {
  const items = rows.map((row, i) => {
    const content = row.content.length > PREVIEW_CHARS ? row.content.slice(0, PREVIEW_CHARS) + "…" : row.content;
    const date = new Date(row.created_at).toISOString().slice(0, 10);
    return `${i + 1}. ${content}\n   (${date})`;
  });
  return heading + "\n\n" + items.join("\n\n");
}

// Plain text on purpose: no Markdown parsing, so nothing in a thought can break the message.
async function reply(chatId: number, text: string) {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!token) {
    console.error("telegram-bot: TELEGRAM_BOT_TOKEN secret is not set");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) console.error("telegram-bot: sendMessage failed", res.status, await res.text());
  } catch (err) {
    console.error("telegram-bot: sendMessage error", err);
  }
}
