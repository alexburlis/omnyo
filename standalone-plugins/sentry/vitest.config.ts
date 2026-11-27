import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "contract",
          include: [
            "tests/intake.test.ts",
            "tests/diagnostics-release.test.ts",
            "tests/workflow-machine.test.ts",
            "tests/workflow.test.ts",
            "tests/workflow-install.test.ts",
            "tests/workflow-webhook.test.ts",
            "tests/project-workflow.test.ts",
            "tests/runner.test.ts",
            "tests/monitoring.test.ts",
            "tests/publication.test.ts",
            "tests/server.test.ts",
            "tests/lifecycle.integration.test.ts",
            "tests/interrupted-solvers.integration.test.ts",
            "tests/submission-authority.integration.test.ts",
            "tests/runtime-install.test.ts",
            "tests/missing-project.test.ts",
          ],
          testTimeout: 15000,
        },
      },
      {
        test: {
          name: "host",
          include: [
            "tests/host.test.ts",
            "tests/workflow-host.test.ts",
            "tests/coordinator-workspace.test.ts",
            "tests/repository-discovery.test.ts",
            "tests/publication.integration.test.ts",
            "tests/host-lifecycle.integration.test.ts",
            "tests/verifier.integration.test.ts",
            "tests/teardown.integration.test.ts",
          ],
          testTimeout: 20000,
        },
      },
      {
        test: {
          name: "ui",
          include: [
            "tests/project-setup.test.tsx",
            "tests/ui.test.tsx",
            "tests/badge.test.tsx",
            "tests/badge-loading.test.tsx",
            "tests/responsive-ui.test.tsx",
            "tests/callback-ui.test.tsx",
            "tests/settings-summary.test.tsx",
          ],
          environment: "jsdom",
          testTimeout: 15000,
        },
      },
    ],
  },
});
