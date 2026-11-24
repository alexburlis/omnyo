import { createServerFn } from "@tanstack/react-start";

import { publicMacDownload } from "./mac-download.server";

export const getPublicMacDownload = createServerFn({ method: "GET" }).handler(
  publicMacDownload,
);
