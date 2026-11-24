import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  privateIosIdentityV1,
  validatePrivateIosBindingV1,
} = require("./identity-binding-v1.js");

const configured = require("../../../../scripts/private-ship.json").ios;

test("the release configuration matches the one Omnyo Apple binding", () => {
  assert.equal(validatePrivateIosBindingV1(configured), privateIosIdentityV1);
  assert.equal(configured.identityPhase, undefined);
  assert.equal(privateIosIdentityV1.bundleId, "com.omnyohq.app");
  assert.equal(privateIosIdentityV1.appId, "6831971255");
  assert.equal(
    privateIosIdentityV1.betaGroupId,
    "c4c1224f-5db5-4840-80b3-a8e26c960379",
  );
  assert.equal("ownedOrigin" in privateIosIdentityV1, false);
});

test("a release bound to another Apple app, group or profile is refused", () => {
  for (const [key, value] of [
    ["bundleId", "de.burlis.bb.private"],
    ["appId", "6822755337"],
    ["betaGroupId", "1383c68b-33b0-4974-91ce-29188ac7bceb"],
    ["profileId", "5595257RY3"],
    ["profileUuid", "eaef3911-9d15-4e8b-b429-1f2d0ecd47b5"],
    ["profileName", "BB Private AppStore 20261014"],
    ["teamId", "SYNTHETIC0"],
    ["signingIdentitySha1", "0".repeat(40)],
  ])
    assert.throws(
      () => validatePrivateIosBindingV1({ ...configured, [key]: value }),
      new RegExp(key, "u"),
    );
});
