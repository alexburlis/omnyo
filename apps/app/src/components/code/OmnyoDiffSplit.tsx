import { defineSplit } from "@/lib/define-split";
import { DiffLoadingSkeleton } from "./code-loading-skeletons";
import type { OmnyoDiffProps } from "./code-rendering";

export const OmnyoDiffSplit = defineSplit<OmnyoDiffProps>({
  id: "omnyo-diff",
  load: () => import("./OmnyoDiff").then((module) => module.default),
  loading: () => <DiffLoadingSkeleton />,
});
