// Shared check for functions that only your OWN tools may call (they spend
// money): call-llm, generate-embedding, backfill-embeddings.
//
// Supabase's gateway has already verified the token's signature before the
// request reaches us (verify_jwt is on by default for these functions). All
// that is left is to confirm the token carries the service_role role. We also
// accept an exact match with the key stored in the function's environment.

import { bearerToken } from "./http.ts";

export function isServiceRoleRequest(req: Request): boolean {
  const token = bearerToken(req);
  if (!token) return false;

  const envKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (envKey && token === envKey) return true;

  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
    return JSON.parse(atob(padded)).role === "service_role";
  } catch {
    return false;
  }
}
