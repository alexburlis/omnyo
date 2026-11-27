import { z } from "zod";

function hasControls(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);

    return code <= 31 || (code >= 127 && code <= 159) || code === 8232 || code === 8233;
  });
}

export const singleLine = z
  .string()
  .refine((value) => !hasControls(value), "Use one line without control characters.")
  .transform((value) => value.trim().replace(/\s+/gu, " "));

export const titleSchema = singleLine.pipe(
  z
    .string()
    .min(1)
    .max(48)
    .refine((value) => value.split(" ").length <= 5, "Use 1–5 words for the title."),
);

export const nameInputSchema = z
  .object({
    title: titleSchema,
    tag: z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .nullable()
      .optional(),
  })
  .strict();

export function chatCount(count: number, more = false): string {
  return `${count}${more ? " or more chats" : count === 1 ? " chat" : " chats"}`;
}
