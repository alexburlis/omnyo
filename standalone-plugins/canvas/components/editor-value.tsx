import type { JsonValue } from "@omnyo/plugin-sdk";
import { z } from "zod";

export const errorSchema = z
  .instanceof(Error)
  .catch(new Error("The change could not be completed."));

export function failureText(failure: Error): string {
  return failure instanceof z.ZodError
    ? (failure.issues[0]?.message ?? "Check the edited values.")
    : failure instanceof Error
      ? failure.message
      : "The change could not be completed.";
}

export function FieldValue({ value }: { value: JsonValue | undefined }) {
  const string = z.string().safeParse(value);
  const content = string.success ? string.data : (JSON.stringify(value, null, 2) ?? "—");

  return content.length > 500 ? (
    <>
      <pre>{content.slice(0, 280)}…</pre>
      <details>
        <summary>Read all {content.length.toLocaleString()} characters</summary>
        <pre>{content}</pre>
      </details>
    </>
  ) : (
    <pre>{content}</pre>
  );
}
