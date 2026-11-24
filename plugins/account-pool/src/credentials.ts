import { z } from "zod";

const jwtPayloadSchema = z.record(z.string(), z.json());

export const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";

export const CHATGPT_PROFILE_CLAIM = "https://api.openai.com/profile";

export function codexAccessTokenExpiresAt(token: string): number | null {
  const payload = token.split(".")[1];

  if (payload === undefined) return null;

  try {
    const parsed = jwtPayloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );

    return parsed.success && typeof parsed.data.exp === "number"
      ? Math.round(parsed.data.exp * 1_000)
      : null;
  } catch {
    return null;
  }
}
