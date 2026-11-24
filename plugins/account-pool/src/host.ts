import { nativeWorkflowEligibility } from "./native-workflow-eligibility.js";
import { completeWorkflowCli } from "./workflow-cli.js";
import { workflowHostContract } from "./workflow-contract.js";
import { experimental_defineHostEntry } from "@omnyo/plugin-sdk/host";

export default experimental_defineHostEntry({
  contract: workflowHostContract,
  handlers: {
    workflowModelCapabilities: (input, context) =>
      nativeWorkflowEligibility(input, context.signal),
    workflowModelComplete: (input, context) =>
      completeWorkflowCli(input, context.signal),
  },
});
