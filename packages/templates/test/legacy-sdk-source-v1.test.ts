import { expect, it } from "vitest";
import { rewriteLegacySdkSourceV1 } from "../src/legacy-plugin-sdk-layout-v1.js";

it("upgrades exact SDK imports and public member names while preserving user bindings and opaque prose", () => {
  const source =
    'import type { BbPluginApi } from "@get-bb/plugin-sdk"; const prose = "@bb/plugin-sdk"; export default function plugin(bb: BbPluginApi) { return bb; }';

  const result = rewriteLegacySdkSourceV1("plugin.ts", source);
  expect(result.text).toBe(
    'import type { PluginApi as BbPluginApi } from "@omnyo/plugin-sdk"; const prose = "@bb/plugin-sdk"; export default function plugin(bb: BbPluginApi) { return bb; }',
  );
  expect(rewriteLegacySdkSourceV1("plugin.ts", result.text).text).toBe(
    result.text,
  );
});

it("renames only namespace members bound to the exact SDK import", () => {
  const source =
    'import * as sdk from "@get-bb/plugin-sdk/app"; sdk.useBbNavigate(); function other(sdk: { useBbNavigate(): void }) { sdk.useBbNavigate(); }';

  expect(rewriteLegacySdkSourceV1("plugin.ts", source).text).toBe(
    'import * as sdk from "@omnyo/plugin-sdk/app"; sdk.experimental_useAppNavigate(); function other(sdk: { useBbNavigate(): void }) { sdk.useBbNavigate(); }',
  );
});

it("refuses malformed user source before returning any rewritten output", () => {
  expect(() =>
    rewriteLegacySdkSourceV1(
      "plugin.ts",
      'import { BbPluginApi from "@get-bb/plugin-sdk";',
    ),
  ).toThrow(/Cannot parse/);
});
