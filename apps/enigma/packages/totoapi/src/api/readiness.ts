// Can this server actually do the work, and will it say so before I trust it?
//
// WHY A SEPARATE CHECK. `probe` answers "is there a server and is its
// certificate trusted", and `verify` answers "does this token work". Neither
// asks the question a person actually has: WILL MY COMPILE RUN. Until now the
// first honest answer to that arrived when a real document failed, several
// minutes and one real piece of work later.
//
// WHAT IT ASKS, in the order a failure is cheapest to explain:
//
//   1. does the token authenticate            (`/api/v1/pool`)
//   2. is there capacity in the pool at all
//   3. is a capsule held, and does it accept work
//
// Each step's failure is a DIFFERENT SENTENCE, because each needs a different
// action from the reader: mint a new token, wait for capacity, or reserve a
// capsule. "Could not connect" for all three is the message this replaces.
//
// WHAT IT DOES NOT DO. It does not submit a job. A readiness check that ran a
// real compile would bill the person for asking whether they could compile,
// and would take tens of seconds to answer a question they asked because they
// were in a hurry.
import type { ApiClient } from "./client";
import { ApiFailure } from "./errors";
import { listCapsules, type Capsule } from "./capsules";
import { verify, type Dimensions, type PoolReading } from "./auth";

/** How ready the server is, worst finding first. */
export type Readiness =
  /** Everything checked out; a compile submitted now should run. */
  | "ready"
  /** Reachable and authenticated, but nothing will run right now. */
  | "no-capacity"
  /** Authenticated, but no capsule is held or none accepts work. */
  | "no-capsule"
  /** The token is not accepted. */
  | "unauthorized"
  /** The server could not be reached at all. */
  | "unreachable";

export interface ReadinessReport {
  state: Readiness;
  /** One sentence, addressed to the person, saying what to do next. Never a
   *  status code and never a stack. */
  message: string;
  pool: PoolReading | null;
  capsules: Capsule[];
  /** The capsule a job would land in, when one is obvious. */
  target: Capsule | null;
}

function empty(dimensions: Dimensions | undefined): boolean {
  if (!dimensions) return true;
  return (dimensions.cpu_millicores ?? 0) <= 0 || (dimensions.ram_mb ?? 0) <= 0;
}

/** Ask the server whether work would run, and say so in one sentence.
 *
 *  NEVER THROWS. Every failure this can meet is a legitimate answer to the
 *  question — a dead token is a readiness result, not an exception — and a
 *  check that threw would need the caller to reimplement this classification
 *  in a catch block. */
export async function checkReadiness(client: ApiClient): Promise<ReadinessReport> {
  let pool: PoolReading;
  try {
    pool = await verify(client);
  } catch (err) {
    const failure = err instanceof ApiFailure ? err : null;
    // `unauthorized` and `network` need opposite actions from the reader, so
    // they must never collapse into one message. The kind lives on `.error`,
    // not on the exception — `ApiFailure` carries an `ApiError`.
    if (failure && failure.error.kind === "unauthorized") {
      return {
        state: "unauthorized",
        message: "The server did not accept this token. Mint a new one at "
          + "Compute Capsules → API tokens and paste it again.",
        pool: null, capsules: [], target: null,
      };
    }
    return {
      state: "unreachable",
      message: "Could not reach the server. Check the address and that you "
        + "are online.",
      pool: null, capsules: [], target: null,
    };
  }

  // Capsules are asked for SECOND and their failure is not fatal: a server
  // that authenticates but cannot list capsules is still a server you can
  // edit against, and the report should say what it knows rather than
  // collapsing to "unreachable" on a secondary call.
  let capsules: Capsule[] = [];
  try {
    capsules = (await listCapsules(client)).capsules ?? [];
  } catch {
    capsules = [];
  }

  const working = capsules.filter((c) => c.accepts_work);
  if (working.length > 0) {
    const target = working[0];
    return {
      state: "ready",
      message: `Ready — ${target.name} is holding capacity and accepting work.`,
      pool, capsules, target,
    };
  }

  if (empty(pool.available)) {
    return {
      state: "no-capacity",
      message: "The pool has no free capacity right now. A compile will queue "
        + "until something is released.",
      pool, capsules, target: null,
    };
  }

  if (capsules.length === 0) {
    return {
      state: "no-capsule",
      message: "No capsule is reserved on this account. Reserve one on the "
        + "server's Compute Capsules desk, then check again.",
      pool, capsules, target: null,
    };
  }

  // Capsules exist but none takes work: say WHICH state they are in, because
  // "starting" and "expired" want different patience from the reader.
  const states = [...new Set(capsules.map((c) => c.state))].join(", ");
  return {
    state: "no-capsule",
    message: `A capsule is reserved but not accepting work (${states}). `
      + "It may still be starting, or it may have expired.",
    pool, capsules, target: null,
  };
}

/** Whether a compile submitted now stands a chance. The one thing a button
 *  should branch on — never `state === "ready"` spelled out at each call site,
 *  so a future state cannot be forgotten at one of them. */
export function canRunWork(report: ReadinessReport | null): boolean {
  return report?.state === "ready";
}

/** A short label for a chip in the corner of the window. */
export function readinessLabel(report: ReadinessReport | null): string {
  switch (report?.state) {
    case "ready": return "ready";
    case "no-capacity": return "no capacity";
    case "no-capsule": return "no capsule";
    case "unauthorized": return "token refused";
    case "unreachable": return "offline";
    default: return "not checked";
  }
}
