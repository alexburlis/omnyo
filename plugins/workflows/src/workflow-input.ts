import type { PluginApi } from "@omnyo/plugin-sdk";
import { resolveWorkflowPlacement } from "./placement.js";
import {
  resolveWorkflowSource,
  type ResolvedWorkflowSource,
  type WorkflowSourceContext,
  type WorkflowSourceInput,
} from "./source-resolution.js";
import {
  validateWorkflowSource,
  type WorkflowValidationSummary,
} from "./workflow-validation.js";

interface PreparedWorkflowSource extends ResolvedWorkflowSource {
  validation: WorkflowValidationSummary;
}

export async function prepareWorkflowSource(
  api: PluginApi,
  context: WorkflowSourceContext,
  input: WorkflowSourceInput,
): Promise<PreparedWorkflowSource> {
  const resolved = await resolveWorkflowSource(input, context, {
    async getThreadEnvironmentId(threadId) {
      const thread = await api.sdk.threads.get({ threadId });

      return thread.environmentId;
    },
    async getEnvironment(environmentId) {
      const environment = await api.sdk.environments.get({ environmentId });

      return {
        id: environment.id,
        projectId: environment.projectId,
        hostId: environment.hostId,
        path: environment.path,
      };
    },
    readFile(input) {
      return api.sdk.files.read(input);
    },
  });

  const validation = await validateWorkflowSource(
    resolved.source,
    resolved.environmentId,
    {
      async validateEnvironment(environmentId) {
        await resolveWorkflowPlacement(
          api.sdk,
          context.projectId,
          environmentId,
        );
      },
      listProviders(environmentId) {
        return api.sdk.providers.list({ environmentId });
      },
      loadModels(environmentId, providerId) {
        return api.sdk.providers.models({ environmentId, providerId });
      },
    },
  );

  return { ...resolved, validation };
}
