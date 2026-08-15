/**
 * Dynamic Cordis domain: the web exposes 12 dynamicCordisRunner methods; the
 * panel protocol only makes sense with a browser client, so Telegram mirrors
 * the read-only inventory and hands over guidance for the rest.
 */
import type { Context } from "@deepseek-ai/cordis";

export interface DynamicCordisRow {
  pluginId: string;
  packageId?: string;
  status?: string;
  [key: string]: unknown;
}

interface DynamicCordisRunnerLike {
  inventory(): DynamicCordisRow[];
}

function runnerOf(ctx: Context): DynamicCordisRunnerLike | undefined {
  return ctx.get("dynamicCordisRunner") as DynamicCordisRunnerLike | undefined;
}

export function listDynamicCordis(ctx: Context): DynamicCordisRow[] {
  const runner = runnerOf(ctx);
  if (!runner) return [];
  try {
    return runner.inventory();
  } catch {
    return [];
  }
}
