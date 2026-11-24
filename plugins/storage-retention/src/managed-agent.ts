import type { PluginApi } from "@omnyo/plugin-sdk";
import { managedOwnerRequestSchema } from "./managed-contract.js";
import type { ManagedService } from "./managed-service.js";

export function registerManagedAgent(api: PluginApi, service: ManagedService) {
  api.agents.registerTool({
    name: "ManagedScratch",
    description:
      "Allocate fresh managed scratch or record the native owner's keep/release decision. Release records a proposal; it removes nothing. Administrative review and policy changes are separate account actions.",
    parameters: managedOwnerRequestSchema,
    async execute(input, ctx) {
      try {
        const state = await service.owner(input, ctx);

        return JSON.stringify({
          message:
            input.request.action === "release"
              ? "The release decision was recorded. Nothing was removed. Cleanup still requires settled consumers, policy or review, and host safety checks."
              : "The managed scratch request completed.",
          ...state,
        });
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        };
      }
    },
  });
  api.agents.configure(() => ({
    tools: ["ManagedScratch"],
    skills: ["storage-retention"],
    instructions:
      "Use ManagedScratch for fresh disposable intermediates with a stable request key, disposition, role, finite byte budget, free-space reserve and immutable restore-input references. Existing directories cannot be enrolled. Admission is not an OS quota. Stop production at the budget and request a native extension. Register consuming chats. After consumers stop, copy keepers outside the allocation and release with the success, failure or cancellation outcome, keeper paths and removal conditions. Release removes nothing; the storage-retention skill explains review and the seven-day restore period.",
  }));
}
