import { createBrowserOmnyoSdk } from "@omnyo/sdk/browser";
import { fetchWithAppSurface } from "./app-surface";

const BASE_URL =
  typeof window === "undefined" ? "http://localhost" : window.location.origin;

const browserSdk = createBrowserOmnyoSdk({
  baseUrl: BASE_URL,
  fetch: fetchWithAppSurface,
});

export const sdk: typeof browserSdk = {
  ...browserSdk,
  threads: {
    ...browserSdk.threads,
    send(args) {
      return browserSdk.threads.send({
        ...args,
        messageSource: args.messageSource ?? { kind: "user" },
      });
    },
    queuedMessages: {
      ...browserSdk.threads.queuedMessages,
      create(args) {
        return browserSdk.threads.queuedMessages.create({
          ...args,
          messageSource: args.messageSource ?? { kind: "user" },
        });
      },
    },
  },
};

export { OmnyoHttpError } from "@omnyo/sdk/browser";
