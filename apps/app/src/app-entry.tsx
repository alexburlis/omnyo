import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { AppToaster } from "./components/AppToaster";
import { registerProviderCliInstallQueryClient } from "./components/provider-cli/provider-cli-install-store";
import { initializePreferredTheme } from "./hooks/useTheme";
import { initializeFavicon } from "./lib/favicon-color-preference";
import { installForeignDomMutationGuard } from "./lib/foreign-dom-mutation-guard";
import { installAppQueryClientBrowserEvents } from "./lib/query-client";
import { appQueryClient } from "./lib/app-query-client";
import { startAppBootCache } from "./lib/app-boot";
import { applyCachedAppThemeCss } from "./lib/themes";
import { recoverInterruptedComposerSubmissions } from "./lib/composer-submission-journal";
import { startSendOutbox } from "./lib/send-outbox/send-outbox";
import { restoreFailedPromptDraft } from "./hooks/usePromptDraftStorage";
import {
  getPendingThreadDraftTransfers,
  resolvePendingThreadDraftScope,
} from "./lib/pending-chat-creations";
import { appToast } from "./components/ui/app-toast";
import { movePendingChatDraft } from "./lib/pending-chat-draft-transfer";
import {
  createRootErrorHandler,
  installWebErrorReporting,
} from "./lib/web-error-reporting";
import "./app.css";

const viewport = document.querySelector<HTMLMetaElement>(
  'meta[name="viewport"]',
);

if (viewport) viewport.content += ", maximum-scale=1, user-scalable=no";

installForeignDomMutationGuard();

Error.stackTraceLimit = 50;

installAppQueryClientBrowserEvents(appQueryClient);

registerProviderCliInstallQueryClient(appQueryClient);

initializePreferredTheme();

applyCachedAppThemeCss();

initializeFavicon();

const recoveredSubmissions = recoverInterruptedComposerSubmissions(
  (scope, draft) =>
    restoreFailedPromptDraft(resolvePendingThreadDraftScope(scope), draft, {
      requirePersistence: true,
    }),
);

for (const { from, to } of getPendingThreadDraftTransfers()) {
  if (from.kind === "thread")
    movePendingChatDraft(from.projectId, from.threadId, to);
}

if (recoveredSubmissions.recovered > 0) {
  appToast.warning("Interrupted messages were restored to their drafts.", {
    description:
      "Check the destination and chat history before sending again; delivery was not confirmed.",
  });
}

if (recoveredSubmissions.failed > 0) {
  appToast.error("Could not restore interrupted messages.", {
    description: "The saved input is retained. Reload to try again.",
  });
}

installWebErrorReporting(appQueryClient);

void startSendOutbox(appQueryClient).catch((error: unknown) => {
  appToast.error("Could not load messages waiting to send.", {
    description:
      error instanceof Error
        ? error.message
        : "They are kept on this device. Reload to try again.",
  });
});

function renderApp(): void {
  createRoot(document.getElementById("root")!, {
    onUncaughtError: createRootErrorHandler((error, errorInfo) => {
      console.error(
        "[Omnyo] uncaught render error — the app root was torn down",
        error,
        errorInfo.componentStack,
      );
    }),
    onCaughtError: createRootErrorHandler((error) => {
      console.error(error);
    }),
    onRecoverableError: createRootErrorHandler((error) => {
      console.error(error);
    }),
  }).render(
    <StrictMode>
      <AppErrorBoundary>
        <QueryClientProvider client={appQueryClient}>
          <BrowserRouter useTransitions={false}>
            <App />
            <AppToaster />
          </BrowserRouter>
        </QueryClientProvider>
      </AppErrorBoundary>
    </StrictMode>,
  );
}

startAppBootCache(appQueryClient).then(renderApp, (error: unknown) => {
  console.error("[Omnyo] The saved startup copy could not be prepared", error);
  renderApp();
});
