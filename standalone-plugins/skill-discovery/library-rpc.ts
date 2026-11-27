import { defineRpcContract } from "@omnyo/plugin-sdk";
import {
  applySchema,
  librarySchema,
  packExportInput,
  packExportResult,
  workspaceSchema,
} from "./library-contract";
import { packConfirmInput, packConfirmResult, packReviewInput, packReviewResult } from "./pack";

export const libraryRpc = defineRpcContract({
  libraryGet: { input: workspaceSchema, output: librarySchema },
  libraryApply: { input: applySchema, output: librarySchema },
  packReview: { input: packReviewInput, output: packReviewResult },
  packConfirm: { input: packConfirmInput, output: packConfirmResult },
  packExport: { input: packExportInput, output: packExportResult },
});
