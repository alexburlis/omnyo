import { refreshDiagnosticSchema, type RefreshDiagnostic } from "../contract";

const errorMetadataSchema = refreshDiagnosticSchema
  .pick({
    status: true,
    stage: true,
    name: true,
    code: true,
  })
  .extend({
    status: refreshDiagnosticSchema.shape.status.catch(null),
    stage: refreshDiagnosticSchema.shape.stage.catch("unknown"),
    name: refreshDiagnosticSchema.shape.name.catch("Other"),
    code: refreshDiagnosticSchema.shape.code
      .optional()
      .transform((value) => value ?? null)
      .catch("unknown"),
  })
  .strip();

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Parse the untrusted RPC rejection at this boundary.
export function captureRefreshFailure(error: unknown, startedAt: number) {
  const parsed = errorMetadataSchema.safeParse(error);

  const metadata = parsed.success
    ? parsed.data
    : { status: null, stage: "unknown" as const, name: "Other" as const, code: null };

  const asset = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;

  const clientBundle = asset
    ? (/\/([a-zA-Z0-9_-]{1,96}\.js)(?:\?.*)?$/u.exec(asset)?.[1] ?? null)
    : null;

  const pluginBundle = /\/plugin-app-assets\/([a-f0-9]{16})\//u.exec(import.meta.url)?.[1] ?? null;

  const visibility = refreshDiagnosticSchema.shape.visibility.safeParse(document.visibilityState);

  const diagnostic: RefreshDiagnostic = {
    id: crypto.randomUUID(),
    occurredAt: Date.now(),
    elapsedMs: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - startedAt))),
    ...metadata,
    online: navigator.onLine,
    visibility: visibility.success ? visibility.data : "unknown",
    clientBundle,
    pluginBundle,
  };

  return { error, diagnostic: refreshDiagnosticSchema.parse(diagnostic) };
}
