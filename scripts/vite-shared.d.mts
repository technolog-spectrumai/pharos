// Types for vite-shared.mjs — see that file for what each one is for.

export interface SourceAlias {
  find: RegExp;
  replacement: string;
}

export function sourceAliases(
  name: string,
  srcDir: string,
  options?: { components?: boolean; entry?: string },
): SourceAlias[];

export interface TauriDevServer {
  port: number;
  strictPort: true;
  headers: Record<string, string>;
  host: string | false;
  hmr: { protocol: "ws"; host: string; port: number } | undefined;
  watch: { ignored: string[] };
}

export function tauriDevServer(options: { port: number; host?: string }): TauriDevServer;
