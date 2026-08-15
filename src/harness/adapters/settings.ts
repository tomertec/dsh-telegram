/**
 * Settings domain (web ApiProxy settings.describe/openDocument/update/replace/
 * mutate) over ctx.settings. Secrets stay redacted, same as the web.
 */
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";

export interface SettingsNamespaceView {
  ns: string;
  value: unknown;
  base?: unknown;
  user?: unknown;
  applies: "live" | "restart";
  secrets: { path: string[]; set: boolean }[];
  revision: number;
}

export interface SettingsDescription {
  writable: boolean;
  hasDocument: boolean;
  documentPath?: string;
  namespaces: SettingsNamespaceView[];
  error?: string;
}

interface SettingsDescriptorLike {
  ns: string;
  value: unknown;
  base?: unknown;
  user?: unknown;
  applies: "live" | "restart";
  secrets?: { path: string[]; set: boolean }[];
  revision?: number;
}

interface SettingsProviderLike {
  writable?: boolean;
  documentPath?: string;
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptorLike[];
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>;
  mutate(ns: string, ops: readonly { op: "set" | "unset"; path: string[]; value?: unknown }[], expectedRevision?: number): Promise<void>;
}

function settingsOf(ctx: Context): SettingsProviderLike | undefined {
  return ctx.get("settings") as SettingsProviderLike | undefined;
}

export function describeSettings(ctx: Context): SettingsDescription {
  const settings = settingsOf(ctx);
  if (!settings) return { writable: false, hasDocument: false, namespaces: [] };
  try {
    return {
      writable: settings.writable ?? true,
      hasDocument: settings.documentPath !== undefined,
      ...(settings.documentPath === undefined ? {} : { documentPath: settings.documentPath }),
      namespaces: settings.describe({ redactSecrets: true }).map((descriptor) => ({
        ns: String(descriptor.ns),
        value: descriptor.value,
        ...(descriptor.base === undefined ? {} : { base: descriptor.base }),
        ...(descriptor.user === undefined ? {} : { user: descriptor.user }),
        applies: descriptor.applies,
        secrets: descriptor.secrets ?? [],
        revision: descriptor.revision ?? 0,
      })),
    };
  } catch (err) {
    return { writable: false, hasDocument: false, namespaces: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateSettings(ctx: Context, ns: string, patch: object, expectedRevision?: number): Promise<AdapterResult & { view?: SettingsNamespaceView }> {
  const settings = settingsOf(ctx);
  if (!settings) return fail("settings service is unavailable in this profile");
  try {
    await settings.update(ns, patch, expectedRevision);
    const view = describeSettings(ctx).namespaces.find((n) => n.ns === ns);
    return { ok: true, text: `\u2699\uFE0F ${ns} updated`, ...(view === undefined ? {} : { view }) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function replaceSettings(ctx: Context, ns: string, section: object, expectedRevision?: number): Promise<AdapterResult & { view?: SettingsNamespaceView }> {
  const settings = settingsOf(ctx);
  if (!settings) return fail("settings service is unavailable in this profile");
  try {
    await settings.replace(ns, section, expectedRevision);
    const view = describeSettings(ctx).namespaces.find((n) => n.ns === ns);
    return { ok: true, text: `\u2699\uFE0F ${ns} replaced`, ...(view === undefined ? {} : { view }) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function mutateSettings(
  ctx: Context,
  ns: string,
  ops: { op: "set" | "unset"; path: string[]; value?: unknown }[],
  expectedRevision?: number,
): Promise<AdapterResult & { view?: SettingsNamespaceView }> {
  const settings = settingsOf(ctx);
  if (!settings) return fail("settings service is unavailable in this profile");
  try {
    await settings.mutate(ns, ops, expectedRevision);
    const view = describeSettings(ctx).namespaces.find((n) => n.ns === ns);
    return { ok: true, text: `\u2699\uFE0F ${ns} mutated`, ...(view === undefined ? {} : { view }) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
