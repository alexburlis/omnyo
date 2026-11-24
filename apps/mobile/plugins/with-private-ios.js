const {
  withEntitlementsPlist,
  withXcodeProject,
} = require("expo/config-plugins");

const {
  privateIosIdentityV1: identity,
} = require("./ios-identity-handoff/identity-binding-v1");

module.exports = function withPrivateIos(config) {
  const profileName = process.env.OMNYO_PRIVATE_IOS_PROFILE_NAME;

  if (!profileName || profileName !== identity.profileName)
    throw new Error(
      "Private iOS requires the exact Omnyo provisioning profile name.",
    );

  return withXcodeProject(
    withEntitlementsPlist(config, (mod) => {
      mod.modResults["aps-environment"] = "production";
      delete mod.modResults["com.apple.developer.associated-domains"];

      return mod;
    }),
    (mod) => {
      const configurations = mod.modResults.pbxXCBuildConfigurationSection();

      for (const configuration of Object.values(configurations)) {
        if (
          configuration?.name !== "Release" ||
          configuration.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER?.replaceAll(
            '"',
            "",
          ) !== identity.bundleId
        )
          continue;

        Object.assign(configuration.buildSettings, {
          DEVELOPMENT_TEAM: identity.teamId,
          CODE_SIGN_STYLE: "Manual",
          '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"': identity.signingIdentitySha1,
          PROVISIONING_PROFILE_SPECIFIER: JSON.stringify(profileName),
        });
      }

      return mod;
    },
  );
};
