export function publicBetaCollectionPlugins(env = process.env) {
  if (env.OMNYO_DESKTOP_RELEASE_CHANNEL !== "public-beta") return [];

  return [
    {
      name: "public-beta-no-collection-defaults",
      setup(builder) {
        builder.onLoad(
          {
            filter: /[\\/]packages[\\/]config[\\/]src[\\/]default-sentry\.ts$/,
          },
          () => ({
            contents:
              'export const DEFAULT_OMNYO_SENTRY_DSN = ""; export const PUBLIC_BETA_COLLECTION_DISABLED = true;',
            loader: "ts",
          }),
        );
      },
    },
  ];
}
