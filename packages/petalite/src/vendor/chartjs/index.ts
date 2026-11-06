// Chart.js 4.5.1, vendored (README.md here). The UMD build attaches itself to
// globalThis.Chart when it runs as a plain module, which is how Vite and Vitest
// load a .js file outside node_modules.
import "./chart.umd.min.js";

/** The parts of Chart.js the apps use. */
export interface ChartInstance {
  data: { labels?: unknown[]; datasets: { data: unknown[] }[] };
  options: Record<string, unknown>;
  update(mode?: string): void;
  destroy(): void;
}
export type ChartConstructor = new (item: HTMLCanvasElement, config: Record<string, unknown>) => ChartInstance;

export const CHART_JS_VERSION = "4.5.1";
export const Chart = (globalThis as unknown as { Chart: ChartConstructor }).Chart;
