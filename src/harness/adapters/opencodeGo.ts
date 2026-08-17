/**
 * opencode-go compatibility shim.
 *
 * The Go-tier gateway serves `gpt-5.6-luna` and `grok-4.5` through the
 * OpenAI **Responses** API, but pi-ai's installed opencode-go catalog routes
 * them through `chat/completions`, whose stream terminates with a bare
 * `{"choices":[]}` chunk and no `finish_reason` — every turn fails with
 * `TRANSPORT / Stream ended without finish_reason`.
 *
 * This module provisions one additive `opencode-go-responses` route in the
 * `llm-pi-ai` settings section (same api key, `/zen/go/v1/responses`,
 * cache retention disabled so no stateful session headers are sent) and
 * transparently repoints selections of the affected models to that route.
 */
import type { Context } from "@deepseek-ai/cordis";

export const OPENCODE_GO_RESPONSES_ROUTE = "opencode-go-responses";

/** Models the Go gateway only serves through the Responses API. */
const GO_RESPONSES_MODEL_IDS = new Set(["gpt-5.6-luna", "grok-4.5"]);

const GO_RESPONSES_MODEL_FACTS: Record<string, {
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  reasoningEfforts: Record<string, string>;
}> = {
  "gpt-5.6-luna": {
    name: "GPT 5.6 Luna",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    reasoningEfforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  },
  "grok-4.5": {
    name: "Grok 4.5",
    contextWindow: 500_000,
    maxTokens: 500_000,
    input: ["text", "image"],
    reasoningEfforts: { low: "low", medium: "medium", high: "high" },
  },
};

interface SettingsLike {
  writable?: boolean;
  describe(options?: { redactSecrets?: boolean }): { ns: string; value: unknown; revision?: number }[];
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
}

let provisioning: Promise<boolean> | undefined;

/** Map a model selection onto the Go Responses route when it is affected. */
export function normalizeOpencodeGoModel(provider: string | undefined, model: string | undefined): { provider: string; model: string } {
  if (provider === "opencode-go" && model !== undefined && GO_RESPONSES_MODEL_IDS.has(model)) {
    return { provider: OPENCODE_GO_RESPONSES_ROUTE, model };
  }
  return { provider: provider ?? "", model: model ?? "" };
}

/** Whether the model needs the Responses-route rewrite. */
export function opencodeGoModelUsesResponses(provider: string | undefined, model: string | undefined): boolean {
  return provider === "opencode-go" && model !== undefined && GO_RESPONSES_MODEL_IDS.has(model);
}

/** Idempotently add the additive Responses route to `llm-pi-ai` settings. */
export function ensureOpencodeGoResponsesRoute(ctx: Context, log: (message: string, error?: unknown) => void): Promise<boolean> {
  if (provisioning !== undefined) return provisioning;
  provisioning = (async () => {
    const llm = ctx.get("llm");
    if (llm === undefined) return false;
    const settings = ctx.get("settings") as SettingsLike | undefined;
    if (settings === undefined || settings.writable === false) return false;
    const descriptor = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === "llm-pi-ai");
    if (descriptor === undefined) return false;
    const value = (descriptor.value ?? {}) as { providers?: Record<string, { apiKeyEnv?: string }> };
    const providers = value.providers ?? {};
    if (providers[OPENCODE_GO_RESPONSES_ROUTE] !== undefined) return true;
    const goRoute = providers["opencode-go"];
    if (goRoute === undefined) return false;

    const patch = {
      providers: {
        [OPENCODE_GO_RESPONSES_ROUTE]: {
          apiKeyEnv: goRoute.apiKeyEnv ?? "OPENCODE_GO_API_KEY",
          api: "openai-responses",
          baseURL: "https://opencode.ai/zen/go/v1",
          // The Go gateway does not maintain stateful Responses sessions;
          // disabling cache retention keeps `session_id` headers off the wire.
          cacheRetention: "none",
          models: Object.entries(GO_RESPONSES_MODEL_FACTS).map(([id, facts]) => ({
            id,
            name: facts.name,
            contextWindow: facts.contextWindow,
            maxTokens: facts.maxTokens,
            input: facts.input,
            reasoningEfforts: facts.reasoningEfforts,
          })),
        },
      },
    };
    try {
      await settings.update("llm-pi-ai", patch, descriptor.revision);
      log(`provisioned ${OPENCODE_GO_RESPONSES_ROUTE} route for opencode-go Responses models`);
      return true;
    } catch (err) {
      log(`failed to provision ${OPENCODE_GO_RESPONSES_ROUTE} route`, err);
      return false;
    }
  })();
  void provisioning.then(() => {
    provisioning = undefined;
  });
  return provisioning;
}
