/**
 * Downloads domain (web ApiProxy downloads.sessionLog GET). Telegram cannot
 * carry files over 50 MB, so we stream the same ZIP through the web's own
 * export seam and either send it as a document or hand over the guidance.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { fail, ok, type AdapterResult } from "./types.js";

export const TELEGRAM_DOCUMENT_LIMIT_BYTES = 50 * 1024 * 1024;

interface ExportDepsLike {
  sessionQuery?: unknown;
  sessionPersistence?: unknown;
  attachments?: unknown;
  sessions?: unknown;
}

type StreamZip = (deps: ExportDepsLike, root: unknown, sessionId: string, includeDescendants: boolean, level: number, signal: AbortSignal) => ReadableStream<Uint8Array>;

async function loadExportSeam(): Promise<{ streamSessionLogZip: StreamZip; sessionLogExportDeps(ctx: Context): ExportDepsLike; flushLiveSessionLog(deps: ExportDepsLike, id: string, signal: AbortSignal): Promise<void> } | undefined> {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@deepseek-ai/dsh-host-apiproxy/package.json");
    const moduleUrl = pathToFileURL(pkg.replace(/package\.json$/, "lib/types/session-export.js")).href;
    const seam = (await import(moduleUrl)) as {
      streamSessionLogZip: StreamZip;
      sessionLogExportDeps(ctx: Context): ExportDepsLike;
      flushLiveSessionLog(deps: ExportDepsLike, id: string, signal: AbortSignal): Promise<void>;
    };
    if (typeof seam.streamSessionLogZip !== "function") return undefined;
    return seam;
  } catch {
    return undefined;
  }
}

export interface SessionLogExport {
  result: AdapterResult;
  buffer?: Uint8Array;
}

/** sessionLog download: same ZIP the web serves, buffered for Telegram. */
export async function exportSessionLog(ctx: Context, sessionId: string, includeDescendants: boolean): Promise<SessionLogExport> {
  const seam = await loadExportSeam();
  if (!seam) {
    return {
      result: fail(
        `session log ZIP is served by the web profile \u2014 this profile cannot build the archive. Open the web UI's session download for ${sessionId}.`,
      ),
    };
  }
  const deps = seam.sessionLogExportDeps(ctx);
  if (!deps.sessionPersistence) return { result: fail("session persistence is unavailable in this profile \u2014 the session log cannot be exported") };
  const signal = new AbortController().signal;
  try {
    await seam.flushLiveSessionLog(deps, sessionId, signal);
    const raw = await (deps.sessionPersistence as { readRaw(id: string, signal?: AbortSignal): Promise<unknown> }).readRaw(sessionId, signal);
    if (raw === undefined) return { result: fail(`session ${sessionId} not found`) };
    const stream = seam.streamSessionLogZip(deps, raw, sessionId, includeDescendants, 6, signal);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > TELEGRAM_DOCUMENT_LIMIT_BYTES) {
          void reader.cancel().catch(() => {});
          return {
            result: fail(
              `session log ZIP exceeds the 50 MB Telegram limit (${Math.round(total / 1024 / 1024)} MB so far) \u2014 download it from the web UI instead.`,
            ),
          };
        }
        chunks.push(value);
      }
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return { result: ok(`\u{1F4E6} ${sessionId}.zip \u00B7 ${Math.round(buffer.byteLength / 1024)} KB`), buffer };
  } catch (err) {
    return { result: fail(err instanceof Error ? err.message : String(err)) };
  }
}

export { SessionId };
