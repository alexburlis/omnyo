import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { verifyNativeSignature } from "../native-signature.ts";

// Requires the signed artifacts from `pnpm native:build`; configure them through the environment.
const artifacts = process.env.OMNYO_DESKTOP_HELPER_ARTIFACTS;

const teamId = process.env.OMNYO_DESKTOP_HELPER_TEAM_ID;

const bundleId = process.env.OMNYO_DESKTOP_HELPER_BUNDLE_ID ?? "dev.omnyo.desktop-helper";

const skip =
  artifacts && teamId
    ? false
    : "Set OMNYO_DESKTOP_HELPER_ARTIFACTS and OMNYO_DESKTOP_HELPER_TEAM_ID";

const helper = join(artifacts ?? "", "Omnyo Desktop Helper.app");

test(
  "signed task helper and fixture satisfy the expected bundle and team",
  { timeout: 10_000, skip },
  async () => {
    await verifyNativeSignature(helper, bundleId, teamId);
    await verifyNativeSignature(
      join(artifacts, "Omnyo Desktop Helper Fixture.app"),
      `${bundleId}.fixture`,
      teamId,
    );
  },
);

test(
  "signed helper rejects another bundle or signing team",
  { timeout: 10_000, skip },
  async () => {
    await assert.rejects(verifyNativeSignature(helper, `${bundleId}.different`, teamId));
    await assert.rejects(verifyNativeSignature(helper, bundleId, "WRONGTEAM0"));
  },
);
