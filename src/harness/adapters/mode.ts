/**
 * Profile (mode) information. The launcher does not export a dedicated env
 * var, so we parse argv and fall back to enumerating $DSH_HOME/profiles.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function detectProfile(argv: readonly string[] = process.argv): string | undefined {
  for (const arg of argv) {
    if (arg === "--profile") {
      return argv[argv.indexOf(arg) + 1];
    }
    if (arg.startsWith("--profile=")) return arg.slice("--profile=".length);
  }
  return undefined;
}

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

const IGNORED_PROFILE_DIRS = new Set(["node_modules"]);

/** Profile directories under $DSH_HOME/profiles (skips non-profile dirs). */
export function listProfiles(): string[] {
  const dir = join(dshHome(), "profiles");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !IGNORED_PROFILE_DIRS.has(e.name) && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export interface ModeSummary {
  profile?: string;
  profiles: string[];
  note: string;
}

export function modeSummary(): ModeSummary {
  const profile = detectProfile();
  const profiles = listProfiles();
  return {
    profile,
    profiles,
    note: profile
      ? `current profile: ${profile}`
      : "profile unknown \u2014 the launcher does not export it to plugins",
  };
}
