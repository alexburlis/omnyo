import type { FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { CREDENTIAL_COPY_SECRET_NAME } from "../credential-copy.js";

export async function storedCopy(host: FakePluginHost): Promise<unknown> {
  const value = await host.api.experimental_secrets.get(
    CREDENTIAL_COPY_SECRET_NAME,
  );

  return value === undefined ? undefined : JSON.parse(value);
}
