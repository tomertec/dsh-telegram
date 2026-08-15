/**
 * LLM domain (web ApiProxy llm.providers/models/discoverModels + the catalog
 * shape behind session.models) over ctx.llm.
 */
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";

export interface ModelEntry {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: { id: string; name: string; description?: string }[];
    defaultEffort?: string;
  };
}

export interface ModelGroup {
  id: string;
  name: string;
  models: ModelEntry[];
}

export interface ModelCatalog {
  groups: ModelGroup[];
  failures: { provider: string; message: string }[];
  current: { provider?: string; model?: string; reasoningEffort?: string };
}

interface LlmLike {
  listProviders(): { id: string; name: string }[];
  listModels(provider: string): Promise<{ id: string; name: string; description?: string }[]>;
  resolveModelInfo(provider: string, model: string): Promise<{
    reasoning?: { efforts: { id: string; name: string; description?: string }[]; defaultEffort?: string };
  }>;
  discoverModels(
    settingsNs: string,
    request: { provider?: string; baseURL?: string; api?: string; apiKey?: string; signal?: AbortSignal },
  ): Promise<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }[]>;
}

function llmOf(ctx: Context): LlmLike | undefined {
  return ctx.get("llm") as LlmLike | undefined;
}

/** Build the web's exact model catalog shape (groups + failures). */
export async function modelCatalog(ctx: Context, current?: { provider?: string; model?: string; reasoningEffort?: string }): Promise<ModelCatalog> {
  const llm = llmOf(ctx);
  if (!llm) return { groups: [], failures: [], current: current ?? {} };
  const groups: ModelGroup[] = [];
  const failures: { provider: string; message: string }[] = [];
  for (const provider of llm.listProviders()) {
    try {
      const models = await llm.listModels(provider.id);
      const entries: ModelEntry[] = [];
      for (const model of models) {
        let reasoning: ModelEntry["reasoning"];
        try {
          const resolved = await llm.resolveModelInfo(provider.id, model.id);
          reasoning = resolved.reasoning;
        } catch {
          /* offline adapter must not hide the rest of the catalog */
        }
        entries.push({
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(reasoning === undefined ? {} : { reasoning }),
        });
      }
      groups.push({ id: provider.id, name: provider.name, models: entries });
    } catch (err) {
      failures.push({ provider: provider.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { groups, failures, current: current ?? {} };
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/** llm.discoverModels: interrogate a draft endpoint, never storing the key. */
export async function discoverModels(
  ctx: Context,
  settingsNs: string,
  request: { provider?: string; baseURL?: string; api?: string; apiKey?: string },
): Promise<AdapterResult & { models?: DiscoveredModel[] }> {
  const llm = llmOf(ctx);
  if (!llm) return fail("llm service is unavailable in this profile");
  try {
    const models = await llm.discoverModels(settingsNs, request);
    const lines = models.map((model) => `${model.id}${model.name === undefined ? "" : ` \u00B7 ${model.name}`}${model.contextWindow === undefined ? "" : ` \u00B7 ctx ${model.contextWindow}`}`);
    return { ok: true, text: `\u{1F50D} ${models.length} model(s) discovered:\n${lines.join("\n").slice(0, 3500)}`, models };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
