/**
 * Commands domain (web Typert commands/list + commands/execute, reached on
 * the web through session.prompt slash dispatch) over ctx.commands.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { fail, ok, type AdapterResult } from "./types.js";

export interface CommandEntry {
  name: string;
  description: string;
  input?: string;
}

interface CommandsServiceLike {
  list(agent: Agent): readonly { name: string; description: string; input?: { hint?: string } }[];
  execute(agent: Agent, line: string, signal: AbortSignal): Promise<{ kind: "success" | "error"; text?: string; message?: string } | undefined>;
}

function commandsOf(ctx: Context): CommandsServiceLike | undefined {
  return ctx.get("commands") as CommandsServiceLike | undefined;
}

export function listCommands(ctx: Context, agent: Agent): CommandEntry[] {
  const commands = commandsOf(ctx);
  if (!commands) return [];
  try {
    return commands.list(agent).map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.input?.hint === undefined ? {} : { input: command.input.hint }),
    }));
  } catch {
    return [];
  }
}

export async function executeCommand(ctx: Context, agent: Agent, line: string): Promise<AdapterResult> {
  const commands = commandsOf(ctx);
  if (!commands) return fail("commands service is unavailable in this profile");
  try {
    const execution = await commands.execute(agent, line, new AbortController().signal);
    if (execution === undefined) return fail(`unknown or malformed slash command: ${line}`);
    if (execution.kind === "error") return fail(execution.message ?? "command failed");
    return ok(execution.text ?? "command executed");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
