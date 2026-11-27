import type { z } from "zod";
import type { hostContract } from "../contract";

export type WorkflowMergeInput = z.infer<typeof hostContract.workflowMerge.input>;

export type WorkflowPlanInput = z.infer<typeof hostContract.workflowPlan.input>;

export type WorkflowPlan = z.infer<typeof hostContract.workflowPlan.output>;

export type WorkflowDeliveryInput = z.infer<typeof hostContract.workflowDeliver.input>;

export type WorkflowDelivery = z.infer<typeof hostContract.workflowDeliver.output>;

export type WorkflowVerification = z.infer<typeof hostContract.workflowVerify.output>;
