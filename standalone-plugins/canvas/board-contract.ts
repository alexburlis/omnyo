import { z } from "zod";

export const boardReferenceSchema = z.union([
  z.object({ threadId: z.string().min(1) }).strict(),
  z.object({ sectionId: z.string().regex(/^sec_[a-z0-9_-]+$/u) }).strict(),
]);

export const boardAddressSchema = z
  .object({
    threadId: z.string().min(1).optional(),
    board: boardReferenceSchema.optional(),
  })
  .refine(
    (input) => (input.threadId === undefined) !== (input.board === undefined),
    "Supply exactly one board reference or legacy threadId",
  );

export type BoardAddress = z.infer<typeof boardAddressSchema>;

export function boardAddressKey(input: BoardAddress): string {
  const reference = boardReferenceSchema.parse(input.board ?? { threadId: input.threadId });

  return "sectionId" in reference ? reference.sectionId : reference.threadId;
}
