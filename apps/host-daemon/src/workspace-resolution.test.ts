import { expect, it } from "vitest";
import { CommandDispatchError } from "./command-errors.js";
import { workspaceResolutionFailureFromError } from "./workspace-resolution.js";

it.each(["EACCES", "EPERM"])(
  "preserves permission failures wrapped by a read subprocess (%s)",
  (code) => {
    expect(
      workspaceResolutionFailureFromError({
        error: new CommandDispatchError(code, "Access denied"),
        workspacePath: "/unavailable-workspace",
      }),
    ).toEqual({
      code: "permission_denied",
      message: "Access denied",
      workspacePath: "/unavailable-workspace",
    });
  },
);
