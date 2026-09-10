// Capsule API tokens — the platform's bearer story since 2026-09-10.
//
// PASTE ONCE, NOT A PASSWORD. The user mints a token on the server's Compute
// Capsules desk (`/capsules/tokens/`), copies it once — the server keeps only a
// hash and cannot show it again — and pastes it here. Rust files it in the OS
// keyring under the normalised server URL and attaches it to every request.
//
// This replaced `POST /api/login/`, which took a username and password and
// handed back a Django session key. That module's own header predicted the
// swap: "a revocable personal-access-token flow replaces this when the server
// grows one; the call sites won't change." The server grew one, and they did
// not — `client.ts` still just asks `getToken()` for a string.
//
// Why it is better here specifically:
//   * the app never sees a password, so a compromised editor cannot replay one
//     against anything else the person uses;
//   * the token is REVOCABLE from a page the user can reach, and revoking is
//     immediate — the next request is a 401;
//   * it is labelled, so "which of these is my laptop" has an answer six months
//     later.
//
// A token acts as its owner: there are no scopes to choose and none to get
// wrong. It reaches exactly what that person reaches in a browser.
import type { ApiClient } from "./client";

/** The shape the server prints. `capsule.<selector>.<verifier>` — the prefix
 *  exists so an accidentally-pasted token is recognisable as one in a log or a
 *  config file. */
export const TOKEN_PREFIX = "capsule.";

/** Cheap local check before a round trip, and before anything is stored.
 *
 *  Deliberately shallow: it proves the shape, not the credential. Only the
 *  server can say whether a token is live, and `verify` below is how you ask.
 *  A stricter regex here would be a second rule that could disagree with
 *  `tokens.py`, which is the one that decides. */
export function looksLikeToken(raw: string): boolean {
  const parts = raw.trim().split(".");
  return parts.length === 3 && parts[0] === "capsule"
    && parts[1].length > 0 && parts[2].length > 0;
}

/** Prove a token works, by using it.
 *
 *  `/pool` rather than a dedicated whoami: it is the cheapest authenticated
 *  read on the server and it needs no capsule, no workspace and no job — so it
 *  answers 200 for a brand-new account that owns nothing at all. A sign-in
 *  check that required a reserved capsule would refuse the very people who are
 *  connecting for the first time.
 *
 *  Throws `ApiFailure` — `unauthorized` for a dead token, `network` for an
 *  unreachable server. The caller shows the difference, because "wrong token"
 *  and "no internet" need different actions from the user. */
export async function verify(client: ApiClient): Promise<PoolReading> {
  return client.get<PoolReading>("/api/v1/pool");
}

/** What `/api/v1/pool` answers. The four dimensions, three ways.
 *
 *  Transcribed from `services.pool_report()` rather than guessed. Extra keys
 *  the server adds later are ignored by this type and survive at runtime,
 *  which is why the client parses rather than validates. */
export interface Dimensions {
  cpu_millicores: number;
  ram_mb: number;
  scratch_mb: number;
  pids: number;
}

export interface PoolReading {
  total: Dimensions;
  booked: Dimensions;
  available: Dimensions;
}
