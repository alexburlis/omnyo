import "vitest";
import type { DesktopProtectedStoreBindingV2 } from "../src/desktop-protected-store-closed-v2.js";
import type { ClosedProtectedStoreFixtureMetadataV2 } from "./desktop-protected-store-closed-v2.test.js";
import type {
  NativeProfileFixtureMetadataV2,
  NativeNamespaceFixtureMetadataV1,
  NativeIdentityFixtureMetadataV1,
  NativeQueryMatchMatrixMetadataV1,
} from "./desktop-profile-adoption-native-v2.test.js";

declare module "vitest" {
  interface TaskMeta {
    artifact?: Pick<
      DesktopProtectedStoreBindingV2["reader"],
      "path" | "sha256"
    >;
    nativeFixture?: ClosedProtectedStoreFixtureMetadataV2;
    nativeProfileV2?: NativeProfileFixtureMetadataV2;
    nativeNamespaceV1?: NativeNamespaceFixtureMetadataV1;
    nativeIdentityV1?: NativeIdentityFixtureMetadataV1;
    nativeQueryMatchMatrixV1?: NativeQueryMatchMatrixMetadataV1;
  }
}
