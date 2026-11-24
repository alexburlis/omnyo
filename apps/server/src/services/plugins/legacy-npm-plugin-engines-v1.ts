import { z } from "zod";

export const legacyNpmPluginEnginesV1Schema = z
  .object({
    bb: z.string().optional(),
    bbPluginSdk: z.string().optional(),
    omnyo: z.string().optional(),
    omnyoPluginSdk: z.string().optional(),
  })
  .loose()
  .transform(
    (
      { bb: legacyCoreVersion, bbPluginSdk: legacySdkVersion, ...engines },
      context,
    ) => {
      for (const [legacy, canonical, key] of [
        [legacyCoreVersion, engines.omnyo, "omnyo"],
        [legacySdkVersion, engines.omnyoPluginSdk, "omnyoPluginSdk"],
      ] as const) {
        if (
          legacy !== undefined &&
          canonical !== undefined &&
          legacy !== canonical
        ) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "conflicting legacy and canonical engine requirements",
          });

          return z.NEVER;
        }
      }

      return {
        ...engines,
        ...(engines.omnyo === undefined && legacyCoreVersion !== undefined
          ? { omnyo: legacyCoreVersion }
          : {}),
        ...(engines.omnyoPluginSdk === undefined &&
        legacySdkVersion !== undefined
          ? { omnyoPluginSdk: legacySdkVersion }
          : {}),
      };
    },
  );
