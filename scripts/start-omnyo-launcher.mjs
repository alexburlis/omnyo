import { runNativeModulePreflight } from "./start-omnyo.mjs";

const { runApp: runOmnyoApp, runLauncherEntry } =
  await import("../packages/omnyo-app/src/launcher.ts");

runLauncherEntry(() =>
  runOmnyoApp(process.argv.slice(2), {
    beforeServerStart: () => runNativeModulePreflight({ checkOnly: true }),
    worktreePolicy: null,
  }),
);
