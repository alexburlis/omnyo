const assert = require("node:assert/strict");

const privateIosIdentityV1 = Object.freeze({
  bundleId: "com.omnyohq.app",
  displayName: "Omnyo",
  projectName: "Omnyo",
  slug: "omnyo-private",
  scheme: "omnyo",
  appId: "6831971255",
  betaGroupId: "c4c1224f-5db5-4840-80b3-a8e26c960379",
  teamId: "Z7T4C33A35",
  signingIdentitySha1: "8B772F4FCF813D0D1C8A98F791F2C82E164620AF",
  profileId: "PFTVSSLFGK",
  profileUuid: "0564bde4-1431-4bba-8872-bcbc1a5b43fd",
  profileName: "Omnyo AppStore Push",
  easProjectId: "34b8804e-6318-460f-bea2-3d875f7d4d3f",
});

const appleBindingKeys = [
  "bundleId",
  "appId",
  "betaGroupId",
  "teamId",
  "signingIdentitySha1",
  "profileId",
  "profileUuid",
  "profileName",
];

function validatePrivateIosBindingV1(ios) {
  for (const key of appleBindingKeys)
    assert.equal(
      ios[key],
      privateIosIdentityV1[key],
      `The private iOS ${key} differs from the Omnyo Apple binding.`,
    );

  return privateIosIdentityV1;
}

module.exports = {
  privateIosIdentityV1,
  validatePrivateIosBindingV1,
};
