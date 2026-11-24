import { nativeWorkflowEligibility } from "./native-workflow-eligibility.js";
import { completeWorkflowCli } from "./workflow-cli.js";
import { workflowHostContract } from "./workflow-contract.js";
import { defineRpcContract } from "@omnyo/plugin-sdk";
import { experimental_defineHostEntry } from "@omnyo/plugin-sdk/host";
import {
  CLAUDE_PREDICTIONS_RETIRED,
  composerPredictionHostContract,
} from "./prediction-contract.js";
import { predictNative } from "./prediction-runner.js";

export default experimental_defineHostEntry({
  contract: defineRpcContract({
    ...composerPredictionHostContract,
    ...workflowHostContract,
  }),
  handlers: {
    workflowModelCapabilities: (input, context) =>
      nativeWorkflowEligibility(input, context.signal),
    workflowModelComplete: (input, context) =>
      completeWorkflowCli(input, context.signal),
    predict: (input, context) => predictNative(input, context.signal),
    predictClaude: () => {
      throw new Error(CLAUDE_PREDICTIONS_RETIRED);
    },
  },
});
