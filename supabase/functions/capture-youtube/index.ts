// ============================================================================
// CAPTURE-YOUTUBE
// ============================================================================
// Paste a YouTube link in the app; this function gets what was said in the
// video and saves it to your brain.
//
// WHY THIS FILE IS COMPLICATED — worth understanding before changing anything:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a datacentre — which is exactly what a Supabase edge function is. Code
// that works perfectly on your laptop fails once deployed. That is not a bug
// in your code, it is YouTube treating servers differently from people.
//
// So we try several routes and take the first that works:
//
//   1. SUPADATA    — a service built for this. Fetches from residential IPs, so
//                    it gets real transcripts. Free tier covers ~100/month.
//                    Optional: with no SUPADATA_API_KEY we skip to route 2.
//   2. INNERTUBE   — YouTube's own internal app API. We identify as the iPhone
//                    and Android apps, which YouTube serves properly even from
//                    a datacentre. Posing as the app is a workaround YouTube
//                    does not officially allow, and it can stop working any
//                    week without warning — which is why it is not first.
//   3. DESCRIPTION — if no captions exist anywhere, fall back to the title and
//                    description so you still capture something. Clearly
//                    labelled as such, so you know it is not what was said.
//
// No AI summary yet — that needs an AI key, which arrives in Level 5. Until
// then the full transcript is saved, so it is still searchable.
// ============================================================================

import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { bearerToken, corsHeaders, jsonResponse } from "../_shared/http.ts";
import { decodeEntities } from "../_shared/text.ts";

interface VideoContent {
  content: string;
  hasTranscript: boolean;
  source: "supadata" | "innertube" | "description";
}

// ---------------------------------------------------------------------------
// Pull the 11-character video id out of any YouTube URL shape
// ---------------------------------------------------------------------------
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/(?:embed|shorts|live)\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.trim().match(p);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Title via oEmbed — lightweight, no key, essentially always works
// ---------------------------------------------------------------------------
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (res.ok) {
      const data = await res.json();
      if (data?.title) return decodeEntities(String(data.title));
    }
  } catch { /* fall through to placeholder */ }
  return `Video ${videoId}`;
}

// ---------------------------------------------------------------------------
// ROUTE 1 — Supadata
// ---------------------------------------------------------------------------
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  const key = Deno.env.get("SUPADATA_API_KEY") ?? "";
  if (!key) return null;

  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`,
      { headers: { "x-api-key": key }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) {
      // 402 here almost always means the free monthly quota is spent
      console.log(`[youtube] Supadata HTTP ${res.status} — falling through`);
      return null;
    }

    const data = await res.json();
    // Either one string, or a list of { text } segments
    const transcript = (typeof data?.content === "string"
      ? data.content
      : (Array.isArray(data?.content) ? data.content : []).map((s: { text?: string }) => s.text ?? "").join(" "))
      .replace(/\s+/g, " ")
      .trim();

    if (!transcript) return null;
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`);
    return { content: decodeEntities(transcript), hasTranscript: true, source: "supadata" };
  } catch (err) {
    console.error("[youtube] Supadata error:", String(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
// ROUTES 2 and 3 — Innertube (YouTube's internal app API), then description
//
// We pose as the iPhone app first, then Android. YouTube hands mobile apps a
// full caption list even from a datacentre, where the normal web page would
// give us nothing.
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
type PlayerResponse = any;

async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: "IOS",
      userAgent: "com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      context: {
        clientName: "IOS", clientVersion: "19.29.1",
        deviceMake: "Apple", deviceModel: "iPhone17,2",
        osName: "iPhone", osVersion: "18.1.0.22B83", hl: "en", gl: "US",
      },
    },
    {
      name: "ANDROID",
      userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14)",
      context: { clientName: "ANDROID", clientVersion: "20.10.38", hl: "en", gl: "US" },
    },
  ];

  let best: PlayerResponse = null;

  for (const client of clients) {
    try {
      const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`);
        continue;
      }

      const result = await res.json();
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(tracks) && tracks.length > 0) {
        console.log(`[youtube] Innertube ${client.name}: ${tracks.length} caption tracks`);
        best = result;
        break;
      }
      // Keep the first response around — even without captions it carries the
      // description, which is better than nothing.
      if (!best) best = result;
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`);
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err));
    }
  }

  if (!best) return null;

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      // deno-lint-ignore no-explicit-any
      const t = tracks as any[];
      const track =
        t.find((x) => x.languageCode === "en" && x.kind !== "asr") ??
        t.find((x) => x.languageCode === "en") ??
        t.find((x) => String(x.languageCode ?? "").startsWith("en")) ??
        t[0];

      const capRes = await fetch(track.baseUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
        signal: AbortSignal.timeout(12_000),
      });

      if (capRes.ok) {
        const xml = await capRes.text();
        // Caption XML looks like <text start="1.2" dur="3.4">words</text>,
        // or in the newer format <p t="1200" d="3400"><s>words</s></p>
        const transcript = [...xml.matchAll(/<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/g)]
          .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, "")))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`);
          return { content: transcript, hasTranscript: true, source: "innertube" };
        }
      } else {
        console.log(`[youtube] caption download HTTP ${capRes.status}`);
      }
    }

    // ROUTE 3 — no captions anywhere. Use the description.
    const details = best?.videoDetails;
    const description: string = details?.shortDescription ?? "";
    const keywords: string = (details?.keywords as string[] | undefined)?.join(", ") ?? "";

    if (description || keywords) {
      const content = [description, keywords ? `Keywords: ${keywords}` : ""].filter(Boolean).join("\n\n");
      console.log(`[youtube] Falling back to description — ${description.length} chars`);
      return { content, hasTranscript: false, source: "description" };
    }

    return null;
  } catch (err) {
    console.error("[youtube] Innertube parse error:", String(err));
    return null;
  }
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    // Identify the caller from their login token. We never trust a user id
    // sent in the request body — that would let anyone write into anyone
    // else's brain.
    const { data: { user }, error: authError } = await admin.auth.getUser(bearerToken(req));
    if (authError || !user) return jsonResponse({ ok: false, error: "Not signed in" }, 401);

    const { url } = await req.json();
    if (!url || typeof url !== "string") return jsonResponse({ ok: false, error: "A YouTube url is required" }, 400);

    const videoId = extractVideoId(url);
    if (!videoId) {
      return jsonResponse({
        ok: false,
        error: "That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=...",
      }, 400);
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const title = await fetchTitle(videoUrl, videoId);

    // Try each route in order, first success wins
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId));
    if (!result) {
      return jsonResponse({
        ok: false,
        error: "Could not read anything from that video. It may be private, age-restricted, or region-locked. " +
          "You can still paste the transcript yourself.",
      }, 422);
    }

    // Same format the app's own YouTube tab has always used — plus a clear
    // label when all we could get was the description.
    const label = result.hasTranscript ? "" : "(No transcript was available — this is the video description.)\n\n";
    const content = `📹 YouTube: ${title}\n${videoUrl}\n\n${label}${result.content}`;

    const { data: thought, error: saveErr } = await admin.from("thoughts").insert({
      user_id: user.id,
      content,
      source: "youtube",
      metadata: {
        title,
        video_id: videoId,
        video_url: videoUrl,
        has_transcript: result.hasTranscript,
        fetched_via: result.source,
      },
    }).select("id").single();
    if (saveErr || !thought) {
      console.error("[youtube] save failed", saveErr);
      return jsonResponse({ ok: false, error: "Could not save: " + (saveErr?.message ?? "unknown") }, 500);
    }

    // The full transcript (or description), kept separately. Non-fatal: the thought is already saved.
    const { error: srcErr } = await admin.from("thought_sources").insert({
      thought_id: thought.id,
      user_id: user.id,
      source_text: result.content,
      source_kind: result.hasTranscript ? "youtube_transcript" : "youtube_description",
      char_count: result.content.length,
      truncated: false,
    });
    if (srcErr) console.error("[youtube] source text not saved (thought is saved)", srcErr);

    return jsonResponse({
      ok: true,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.source,
      chars: result.content.length,
    });
  } catch (err) {
    console.error("[youtube] Failed:", err);
    return jsonResponse({ ok: false, error: String(err) }, 500);
  }
});
