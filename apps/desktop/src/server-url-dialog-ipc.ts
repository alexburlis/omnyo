import { z } from "zod";

export const OMNYO_DESKTOP_SERVER_URL_DIALOG_SUBMIT_CHANNEL =
  "omnyo-desktop:server-url-dialog:submit";

export const OMNYO_DESKTOP_SERVER_URL_DIALOG_CANCEL_CHANNEL =
  "omnyo-desktop:server-url-dialog:cancel";

export const serverUrlDialogSubmitRequestSchema = z
  .object({
    url: z.string().max(4096),
  })
  .strict();

export const serverUrlDialogSubmitResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), message: z.string() }).strict(),
]);

export type ServerUrlDialogSubmitResponse = z.infer<
  typeof serverUrlDialogSubmitResponseSchema
>;
