import { z } from "zod";
import { safeAreaInsetsSchema } from "./handshake.js";

const bridgeResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

const appPathSchema = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !/[\\\u0000-\u001f\u007f]/u.test(value),
    "path must be app-relative without backslashes or control characters",
  );

export function parseAppPath(value: unknown): string | null {
  const parsed = appPathSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

export const shellToPageEventSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("safe-area"), safeArea: safeAreaInsetsSchema })
    .strict(),
  z.object({ type: z.literal("resume") }).strict(),
  z.object({ type: z.literal("navigate"), path: appPathSchema }).strict(),
  z
    .object({
      type: z.literal("response"),
      id: z.string().min(1).max(64),
      response: bridgeResponseSchema,
    })
    .strict(),
]);

export type ShellToPageEvent = z.infer<typeof shellToPageEventSchema>;

export type BridgeResponse = z.infer<typeof bridgeResponseSchema>;

export function parseShellToPageEvent(value: unknown): ShellToPageEvent | null {
  const parsed = shellToPageEventSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}
