// ============================================================================
// WEEKLY-DIGEST  (the weekly report agent)
// ============================================================================
// Runs once a week, on a schedule set up with pg_cron. It reads the last 7 days
// of thoughts, asks the AI (through the call-llm gateway) for a summary of what
// you have been learning, and saves that summary back into your brain as a new
// thought with category 'digest'.
//
// Like enrich-thought, it always returns 200. A failed digest is logged, and
// nothing else is affected.
// ============================================================================

const MIN_THOUGHTS = 5;          // fewer than this and there isn't enough to summarize
const DIGEST_MODEL = "claude-sonnet-5-5"; // a stronger model for better writing; costs a few cents a week

Deno.serve(async () => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    };

    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Last 7 days of thoughts, leaving out earlier digests so they don't summarize themselves.
    const url =
      `${supabaseUrl}/rest/v1/thoughts` +
      `?select=id,content,category,user_id,created_at` +
      `&created_at=gte.${encodeURIComponent(since)}` +
      `&or=(category.is.null,category.neq.digest)` +
      `&order=created_at.asc`;

    const listRes = await fetch(url, { headers });
    if (!listRes.ok) {
      console.error("weekly-digest: could not read thoughts", listRes.status, await listRes.text());
      return new Response("ok", { status: 200 });
    }
    const thoughts: Array<{ content: string; category: string | null; user_id: string }> =
      await listRes.json();

    if (thoughts.length < MIN_THOUGHTS) {
      console.log(`weekly-digest: only ${thoughts.length} thoughts this week, skipping`);
      return new Response("ok", { status: 200 });
    }

    // Your brain belongs to you, but the code should not assume one user.
    // Make one digest per user, each built only from that user's thoughts.
    const byUser = new Map<string, typeof thoughts>();
    for (const t of thoughts) {
      if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
      byUser.get(t.user_id)!.push(t);
    }

    for (const [userId, userThoughts] of byUser) {
      if (userThoughts.length < MIN_THOUGHTS) continue;

      const notes = userThoughts
        .map((t, i) => `${i + 1}. [${t.category ?? "uncategorized"}] ${t.content}`)
        .join("\n\n");

      // Ask the gateway. Every call between our own functions needs the service key.
      const llmRes = await fetch(`${supabaseUrl}/functions/v1/call-llm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({
          model: DIGEST_MODEL,
          systemPrompt:
            "You write a personal weekly review for someone's private notes. Be specific and warm, and do not invent anything that is not in the notes.",
          prompt:
            `Here are the notes saved this week:\n\n${notes}\n\n` +
            `Write the review with these three parts, using short headings:\n` +
            `1. What I have been learning, grouped by topic.\n` +
            `2. Key themes that show up across the notes.\n` +
            `3. One question I seem to be exploring, phrased as I would phrase it.`,
          maxTokens: 1200,
          userId,
          source: "weekly-digest",
        }),
      });

      if (!llmRes.ok) {
        console.error("weekly-digest: call-llm failed", llmRes.status, await llmRes.text());
        continue;
      }

      const { text } = await llmRes.json();
      const weekOf = new Date().toISOString().slice(0, 10);

      // Save the digest as a new thought. It is saved as category 'digest', so
      // enrich-thought skips it and it stays out of future digests.
      const saveRes = await fetch(`${supabaseUrl}/rest/v1/thoughts`, {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          user_id: userId,
          content: `Weekly review, week of ${weekOf}\n\n${text}`,
          category: "digest",
          source: "weekly-digest",
        }),
      });

      if (!saveRes.ok) {
        console.error("weekly-digest: could not save digest", saveRes.status, await saveRes.text());
      } else {
        console.log(`weekly-digest: saved digest for user ${userId}`);
      }
    }
  } catch (err) {
    console.error("weekly-digest crashed", err);
  }

  return new Response("ok", { status: 200 });
});
