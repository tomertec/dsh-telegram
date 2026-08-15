/**
 * Credentials domain (web ApiProxy credentials.describe/set/unset) over
 * ctx.credentials. Values never ride back — describe only reports
 * configured/source/writable, exactly like the web.
 */
import type { Context } from "@deepseek-ai/cordis";
import { fail, ok, type AdapterResult } from "./types.js";

export interface CredentialView {
  ref: string;
  configured: boolean;
  source?: string;
  writable: boolean;
}

interface CredentialProviderLike {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

function credentialsOf(ctx: Context): CredentialProviderLike | undefined {
  return ctx.get("credentials") as CredentialProviderLike | undefined;
}

export async function describeCredential(ctx: Context, ref: string): Promise<AdapterResult & { view?: CredentialView }> {
  const credentials = credentialsOf(ctx);
  if (!credentials) return fail("credentials service is unavailable in this profile");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return fail("credential ref must be a POSIX shell identifier");
  try {
    const info = await credentials.describe(ref);
    return {
      ok: true,
      text: `\u{1F511} ${ref}: ${info.configured ? `configured (${info.source ?? "unknown source"})` : "not configured"} \u00B7 writable: ${info.writable}`,
      view: { ref, ...info },
    };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function setCredential(ctx: Context, ref: string, value: string): Promise<AdapterResult> {
  const credentials = credentialsOf(ctx);
  if (!credentials) return fail("credentials service is unavailable in this profile");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return fail("credential ref must be a POSIX shell identifier");
  if (!value) return fail("credential value must not be empty (use unset to remove)");
  try {
    await credentials.set(ref, value);
    return ok(`\u{1F511} ${ref} stored \u2014 the value itself never rides back`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export async function unsetCredential(ctx: Context, ref: string): Promise<AdapterResult> {
  const credentials = credentialsOf(ctx);
  if (!credentials) return fail("credentials service is unavailable in this profile");
  try {
    await credentials.unset(ref);
    return ok(`\u{1F511} ${ref} removed`);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
