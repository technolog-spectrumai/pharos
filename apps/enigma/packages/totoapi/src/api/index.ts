// The API surface, one barrel.
export { createClient, normalizeServerUrl } from "./client";
export type { ApiClient } from "./client";
export { ApiFailure, classify } from "./errors";
export type { ApiError } from "./errors";
export { tauriFetch } from "./transport";
export { TOKEN_PREFIX, looksLikeToken, verify } from "./auth";
export type { Dimensions, PoolReading } from "./auth";
export * from "./capsules";
export * from "./workspaces";
