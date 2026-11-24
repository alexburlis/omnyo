export interface AccountProblem {
  kind: "signed-out" | "failed";
  title: string;
  detail: string;
  raw: string;
}

const OAUTH_REFRESH_FAILURE =
  /^OAuth refresh failed with HTTP (\d{3})\.\s*(.*)$/s;

const SIGNED_OUT =
  /invalid_grant|refresh_token_\w+|token_(?:expired|revoked|invalidated)|unauthori[sz]ed|\bHTTP 401\b|sign in again|log ?in again|login is unavailable/i;

const PLAIN_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/refresh_token_expired|token_expired/i, "login expired"],
  [/refresh_token_reused/i, "login was used up elsewhere"],
  [
    /refresh_token_(?:invalidated|revoked)|token_(?:revoked|invalidated)/i,
    "login was revoked",
  ],
  [/invalid_grant/i, "login expired or was revoked"],
  [/unauthori[sz]ed|\bHTTP 401\b/i, "provider rejected the login"],
];

export function rpcErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.replace(/^(?:HTTP \d{3}:\s*)+/, "").trim();
}

function trimSentence(text: string): string {
  return text.trim().replace(/\.$/, "");
}

export function accountProblem(
  error: string,
  canSignInAgain: boolean,
): AccountProblem {
  const raw = error.trim();
  const refreshFailure = OAUTH_REFRESH_FAILURE.exec(raw);

  if (canSignInAgain && (refreshFailure !== null || SIGNED_OUT.test(raw))) {
    const reason = PLAIN_REASONS.find(([pattern]) => pattern.test(raw))?.[1];
    const providerReason = trimSentence(refreshFailure?.[2] ?? raw);

    return {
      kind: "signed-out",
      title: "Signed out",
      detail:
        reason ??
        (providerReason.length > 0
          ? providerReason
          : `HTTP ${refreshFailure?.[1]}`),
      raw,
    };
  }

  return {
    kind: "failed",
    title: "Unavailable",
    detail: trimSentence(raw),
    raw,
  };
}
