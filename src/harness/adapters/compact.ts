/**
 * Manual compaction through the host-provided `ctx.compaction` engine — the
 * exact seam `/compact` uses, so behavior stays consistent with the harness.
 */
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-compaction";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-session";
import { fail, ok, type AdapterResult } from "./types.js";

export async function compactCurrent(ctx: Context, agentId?: string): Promise<AdapterResult> {
  const agents = ctx.agents?.list() ?? [];
  const agent = agentId !== undefined ? agents.find((a) => a.id === agentId) : agents[0];
  if (!agent) return fail("No live agent in this session.");
  if (agent.status !== "idle") return fail("The agent is busy \u2014 compacting is only available while it is idle.");
  if (!ctx.compaction) return fail("The compaction service is unavailable in this profile.");
  try {
    const controller = new AbortController();
    const result = await ctx.compaction.compactNow(agent, controller.signal);
    if (result === null) return ok("No compactable history yet.");
    return ok(`\u{1F9F9} Compacted ${result.shadowedSeqs.length} items (~${result.shadowedTokenCount} tokens).`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
