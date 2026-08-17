/**
 * Model browsing over ctx.llm. Runtime switching is owned by the harness
 * entry point (ModelSelectionRef), so v0.1 shows the catalog + current
 * selection and explains how to switch instead of faking a write path.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-llm";

export interface ModelEntry {
  id: string;
  name: string;
}

export interface ModelsSummary {
  providers: { id: string; name: string; models: ModelEntry[] }[];
  current: { provider?: string; model?: string };
}

export async function modelsSummary(ctx: Context): Promise<ModelsSummary> {
  const llm = ctx.get("llm") as
    | {
        listProviders(): { id: string; name: string }[];
        listModels(provider: string): Promise<{ id: string; name: string }[]>;
      }
    | undefined;
  if (!llm) return { providers: [], current: {} };
  const providers = await Promise.all(
    llm.listProviders().map(async (p) => {
      let models: ModelEntry[] = [];
      try {
        models = (await llm.listModels(p.id)).map((m) => ({ id: m.id, name: m.name }));
      } catch {
        /* an offline adapter must not hide the rest of the catalog */
      }
      return { id: p.id, name: p.name, models };
    }),
  );
  const agent = ctx.agents?.list()[0];
  return {
    providers,
    current: { provider: agent?.options.provider, model: agent?.options.model },
  };
}
