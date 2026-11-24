import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";

import { captureServerError } from "./analytics/server-errors";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

const errorReportMiddleware = createMiddleware({ type: "request" }).server(
  async ({ next, pathname }) => {
    try {
      return await next();
    } catch (error) {
      captureServerError(error, "request", pathname);
      throw error;
    }
  },
);

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, errorReportMiddleware],
}));
