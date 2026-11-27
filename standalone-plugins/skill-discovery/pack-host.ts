import { experimental_defineHostEntry } from "@omnyo/plugin-sdk";
import { inspectPackDestination, installPackFiles } from "./pack-files.ts";
import { packHostContract } from "./pack-host-contract.ts";

export default experimental_defineHostEntry({
  contract: packHostContract,
  handlers: {
    inspect: inspectPackDestination,
    install: (input, context) => installPackFiles({ ...input, signal: context.signal }),
  },
});
