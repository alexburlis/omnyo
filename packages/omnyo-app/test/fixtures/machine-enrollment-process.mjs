import { enrollMachine } from "../../../../apps/cli/src/commands/machine-enrollment.ts";

const env = {
  OMNYO_DATA_DIR: process.env.OMNYO_DATA_DIR,
  OMNYO_ENROLLMENT: process.env.OMNYO_ENROLLMENT,
  PATH: "/nonexistent",
};

await enrollMachine(
  { bootstrapEnv: "OMNYO_ENROLLMENT" },
  {
    env,
    fetchFn: async () =>
      Response.json(
        { hostId: "host_synthetic", hostKey: "synthetic-host-key" },
        { status: 201 },
      ),
    homeDir: process.env.OMNYO_DATA_DIR,
  },
);
