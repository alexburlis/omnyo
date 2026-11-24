export type SecretVaultErrorCode =
  | "key_unavailable"
  | "key_missing"
  | "wrong_vault"
  | "corrupt"
  | "record_invalid";

export class SecretVaultError extends Error {
  readonly code: SecretVaultErrorCode;

  constructor(
    code: SecretVaultErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SecretVaultError";
    this.code = code;
  }
}

export function clipDiagnostic(text: string): string {
  const trimmed = text.trim();

  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
}
