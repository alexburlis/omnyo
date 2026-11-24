import { expoSecureStorage } from "./expo-secure-storage";
import { createMigratingSessionCacheV1 } from "./legacy-session-storage-v1";

export const nativeSessionCache =
  createMigratingSessionCacheV1(expoSecureStorage);
