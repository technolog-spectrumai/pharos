// One error taxonomy for every API call, constructed in one place from
// (status, body). Callers switch on `kind`, never on a status code — that is
// what keeps a server-side wording change from breaking client logic.
export type ApiError =
  | { kind: "unauthorized" }
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
    case 404: return { kind: "not-found" };
    case 400: return { kind: "bad-request", message: msg || "Bad request." };
    case 423: return {
      kind: "locked",
      holder: typeof b.locked_by === "string" ? b.locked_by
        : typeof b.holder === "string" ? b.holder : "",
    };
    case 409: return {
      kind: "conflict",
      contentHash: typeof b.content_hash === "string" ? b.content_hash : "",
    };
    case 413: return { kind: "too-large", message: msg || "Too large." };
    case 415: return { kind: "unsupported-type", message: msg || "Unsupported file type." };
    default: return { kind: "server", status, message: msg };
  }
}
