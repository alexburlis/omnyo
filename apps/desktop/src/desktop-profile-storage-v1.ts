export async function initializeDesktopProfileStorageV1(input: {
  storageName: string;
  applicationName: string;
  encryption: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
  };
  initializeCookies(): Promise<void>;
  setDisplayName(value: string): void;
}): Promise<void> {
  if (input.storageName === input.applicationName) return;

  if (!input.encryption.isEncryptionAvailable())
    throw new Error(
      "The desktop protected store is unavailable; its profile was preserved",
    );
  input.encryption.encryptString(
    "desktop profile storage owner initialization",
  );
  await input.initializeCookies();
  input.setDisplayName(input.applicationName);
}
