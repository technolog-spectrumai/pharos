// One error taxonomy for every API call, constructed in one place from
// (status, body). Callers switch on `kind`, never on a status code — that is
// what keeps a server-side wording change from breaking client logic.
export type ApiError =
  | { kind: "unauthorized" }
  // A REFUSAL THE SERVER NAMED. `/api/v1/` answers `{error, code}` for every
  // refusal it can explain — no capsule held, quota spent, a generated file,
  // the wrong workspace kind. The sentence is for the person; `code` is what
  // the UI branches on, and it is stable where the sentence is not.
  //
  // Added when the capsule API landed: 409 used to mean one thing (a save
  // conflict, carrying `content_hash`) and now means "refused, because". Both
  // shapes arrive on 409, so `classify` tells them apart by which field is
  // present rather than by status alone.
  | { kind: "refused"; code: string; message: string }
  | { kind: "payment-required"; entitlement: string; plansUrl: string }
  | { kind: "forbidden"; message: string }
  | { kind: "not-found" }
  | { kind: "bad-request"; message: string }
  | { kind: "locked"; holder: string }
  | { kind: "conflict"; contentHash: string }
  | { kind: "too-large"; message: string }
  | { kind: "unsupported-type"; message: string }
  | { kind: "server"; status: number; message: string }
  | { kind: "network"; cause: unknown };

export class ApiFailure extends Error {
  readonly error: ApiError;
  constructor(error: ApiError) {
    super(describe(error));
    this.error = error;
  }
}

function describe(e: ApiError): string {
  switch (e.kind) {
    case "unauthorized": return "Not signed in.";
    case "refused": return e.message;
    case "payment-required": return `Requires the ${e.entitlement} entitlement.`;
    case "forbidden": return e.message;
    case "not-found": return "Not found.";
    case "bad-request": return e.message;
    case "locked": return `${e.holder} is editing this.`;
    case "conflict": return "The file changed on the server.";
    case "too-large": return e.message;
    case "unsupported-type": return e.message;
    case "server": return e.message || `Server error (${e.status}).`;
    case "network": return "Could not reach the server.";
  }
}

/** Map an HTTP response to the taxonomy. `body` is the parsed JSON when the
 *  server sent any (Django's HTML error pages parse to null — treat those as
 *  bare status). */
export function classify(status: number, body: unknown): ApiError {
  const b = (body ?? {}) as Record<string, unknown>;
  const msg = typeof b.error === "string" ? b.error : "";
  switch (status) {
    case 401: return { kind: "unauthorized" };
    case 402: return {
      kind: "payment-required",
      entitlement: typeof b.entitlement === "string" ? b.entitlement : "",
      plansUrl: typeof b.plans_url === "string" ? b.plans_url : "",
    };
    case 403: return { kind: "forbidden", message: msg || "Not allowed." };
    case 501: return {
      kind: "refused",
      code: typeof b.code === "string" ? b.code : "unsupported",
      message: msg || "This deployment cannot do that.",
    };
    case 404: return { kind: "not-found" };
    case 400: return { kind: "bad-request", message: msg || "Bad request." };
    case 423: return {
      kind: "locked",
      holder: typeof b.locked_by === "string" ? b.locked_by
        : typeof b.holder === "string" ? b.holder : "",
    };
    case 409: {
      // TWO DIFFERENT 409s, told apart by shape rather than by status.
      //
      // The vault's save conflict carries `content_hash` — the file changed on
      // the server and the client must reconcile. Everything on `/api/v1/`
      // carries `code` — the server refused and said why, and there is nothing
      // to reconcile. Reading them as one would make a quota refusal look like
      // a stale buffer and offer the user a merge.
      if (typeof b.content_hash === "string") {
        return { kind: "conflict", contentHash: b.content_hash };
      }
      return {
        kind: "refused",
        code: typeof b.code === "string" ? b.code : "",
        message: msg || "Refused.",
      };
    }
    case 413: return { kind: "too-large", message: msg || "Too large." };
    case 415: return { kind: "unsupported-type", message: msg || "Unsupported file type." };
    default: return { kind: "server", status, message: msg };
  }
}
