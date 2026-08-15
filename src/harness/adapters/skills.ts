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

export async function listSkills(ctx: Context): Promise<SkillEntry[]> {
  const skills = skillsOf(ctx);
  if (!skills) return [];
  try {
    const summaries = await skills.list();
    return summaries.map((skill) => {
      const invocation = skill.invocation as { model?: boolean; user?: boolean } | undefined;
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        source: skill.source,
        provider: skill.provider,
        modelInvocable: invocation?.model ?? true,
        userInvocable: invocation?.user ?? true,
      };
    });
  } catch {
    return [];
  }
}
