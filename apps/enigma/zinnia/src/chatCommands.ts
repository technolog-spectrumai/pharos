// Pluggable, FORUM/relay-only chat commands.
//
// The relay channel runs every composed line through this registry before sending it
// as a chat message; if a handler matches, it consumes the line instead. The P2P
// channel never registers commands. This is the modular seam for future features:
//   - `@system:write/bucket/dir/file.png` → upload an image to the vault
//   - `@system:read/…`                    → display a vault image without uploading
//   - (and other relay-only powers, e.g. "save conversation as JSON")
// Nothing is registered yet — ship empty so behaviour is unchanged.

export interface ChatCommandContext {
  /** Push a system line into the relay chat (info/error). */
  system: (content: string, kind?: "system_info" | "system_error") => void;
  /** The relay room slug the command runs against. */
  room: string;
}

export interface ChatCommandHandler {
  /** True if this handler owns the input (so no chat message is sent). */
  match: (text: string) => boolean;
  /** Handle the input. */
  run: (text: string, ctx: ChatCommandContext) => Promise<void> | void;
}

/** Relay-only command handlers. Future `@system:` handlers register here. */
export const relayCommandHandlers: ChatCommandHandler[] = [];

/** Run the first matching relay command; returns true if one consumed the input. */
export async function runChatCommand(text: string, ctx: ChatCommandContext): Promise<boolean> {
  for (const handler of relayCommandHandlers) {
    if (handler.match(text)) {
      await handler.run(text, ctx);
      return true;
    }
  }
  return false;
}
