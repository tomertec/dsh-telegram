/**
 * Skill domain (web ApiProxy skill.list) over ctx.skills.
 */
import type { Context } from "@deepseek-ai/cordis";

export interface SkillEntry {
  name: string;
  description: string;
  whenToUse?: string;
  source: string;
  provider: string;
  modelInvocable: boolean;
  userInvocable: boolean;
}

interface SkillSummaryLike {
  name: string;
  description: string;
  whenToUse?: string;
  source: string;
  provider: string;
  invocation?: { model?: boolean; user?: boolean } | { modelInvocable?: boolean; userInvocable?: boolean };
}

interface SkillRegistryLike {
  list(options?: Record<string, unknown>): Promise<SkillSummaryLike[]>;
}

function skillsOf(ctx: Context): SkillRegistryLike | undefined {
  return ctx.get("skills") as SkillRegistryLike | undefined;
}

export async function listSkills(ctx: Context, sessionId?: string): Promise<SkillEntry[]> {
  const skills = skillsOf(ctx);
  if (!skills) return [];
  try {
    // Web skill.list is addressed by session: the host resolves the
    // session's project root and returns its user-invocable catalog.
    // Structural fallback: registries that take no options still work.
    const summaries = await skills.list(sessionId === undefined ? undefined : { sessionId });
    return summaries.map((skill) => {
      const invocation = skill.invocation as { model?: boolean; user?: boolean } | { modelInvocable?: boolean; userInvocable?: boolean } | undefined;
      const modelInvocable =
        "model" in (invocation ?? {}) ? (invocation as { model?: boolean }).model !== false : (invocation as { modelInvocable?: boolean } | undefined)?.modelInvocable ?? true;
      const userInvocable =
        "user" in (invocation ?? {}) ? (invocation as { user?: boolean }).user !== false : (invocation as { userInvocable?: boolean } | undefined)?.userInvocable ?? true;
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        source: skill.source,
        provider: skill.provider,
        modelInvocable,
        userInvocable,
      };
    });
  } catch {
    return [];
  }
}
