const { existsSync } = require("node:fs");

const { resolve } = require("node:path");

const {
  privateIosIdentityV1: identity,
} = require("./plugins/ios-identity-handoff/identity-binding-v1");

module.exports = ({ config }) => {
  const variant = process.env.OMNYO_MOBILE_VARIANT ?? "production";

  if (!["production", "dev", "private"].includes(variant)) {
    throw new Error("OMNYO_MOBILE_VARIANT must be production, dev or private");
  }

  if (variant === "private") {
    const version = process.env.OMNYO_PRIVATE_IOS_VERSION;
    const buildNumber = process.env.OMNYO_PRIVATE_IOS_BUILD;

    if (!version || !/^\d+\.\d+\.\d+$/u.test(version)) {
      throw new Error("OMNYO_PRIVATE_IOS_VERSION must be X.Y.Z");
    }

    if (!buildNumber || !/^[1-9]\d*$/u.test(buildNumber)) {
      throw new Error("OMNYO_PRIVATE_IOS_BUILD must be a positive integer");
    }

    return {
      ...config,
      name: identity.displayName,
      slug: identity.slug,
      scheme: identity.scheme,
      owner: undefined,
      version,
      extra: {
        ...config.extra,
        eas: { projectId: identity.easProjectId },
        omnyoMobileVariant: variant,
      },
      plugins: ["./plugins/with-private-ios", ...config.plugins],
      ios: {
        ...config.ios,
        bundleIdentifier: identity.bundleId,
        buildNumber,
        appleTeamId: identity.teamId,
        associatedDomains: [],
      },
      android: {
        ...config.android,
        package: "com.omnyohq.app",
        googleServicesFile: undefined,
        intentFilters: [],
      },
    };
  }

  const isDev = variant === "dev";

  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON
    ? resolve(process.env.GOOGLE_SERVICES_JSON)
    : resolve(__dirname, "google-services.json");

  if (
    !isDev &&
    process.env.GOOGLE_SERVICES_JSON &&
    !existsSync(googleServicesFile)
  ) {
    throw new Error(
      "GOOGLE_SERVICES_JSON must point to an existing Firebase configuration file",
    );
  }

  return {
    ...config,
    extra: { ...config.extra, omnyoMobileVariant: variant },
    ...(isDev
      ? {
          name: "Omnyo dev",
          icon: "./assets/icon-dev.png",
          web: { ...config.web, favicon: "./assets/favicon-dev.png" },
          plugins: config.plugins.map((plugin) =>
            Array.isArray(plugin) && plugin[0] === "expo-splash-screen"
              ? [
                  plugin[0],
                  {
                    ...plugin[1],
                    image: "./assets/splash-logo-dev.png",
                    dark: {
                      ...plugin[1].dark,
                      image: "./assets/splash-logo-dev.png",
                    },
                  },
                ]
              : plugin,
          ),
        }
      : {}),
    android: {
      ...config.android,
      ...(isDev
        ? {
            package: "app.getbb.mobile.dev",
            googleServicesFile: undefined,
            intentFilters: [],
            adaptiveIcon: {
              ...config.android.adaptiveIcon,
              foregroundImage: "./assets/android-icon-foreground-dev.png",
            },
          }
        : existsSync(googleServicesFile)
          ? { googleServicesFile }
          : {}),
    },
  };
};
