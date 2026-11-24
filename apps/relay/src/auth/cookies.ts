export const AUTH_COOKIE_PREFIX = "__Host-omnyo";

export const SESSION_COOKIE_NAME = `${AUTH_COOKIE_PREFIX}.session_token`;

export const STATE_COOKIE_NAME = `${AUTH_COOKIE_PREFIX}.state`;

export const AUTH_COOKIE_ATTRIBUTES = {
  secure: true,
  path: "/",
  sameSite: "lax",
  httpOnly: true,
} as const;
