// Shared bits for the functions your web app calls (capture-url, capture-youtube).
// The browser calls these directly, so they need CORS headers — the browser's
// permission slip for one website (your app) to talk to another (Supabase).

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// The caller's login token, from the Authorization header the app sends.
export function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
}
