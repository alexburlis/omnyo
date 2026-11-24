import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { openUrlInExternalBrowser } from "@/lib/url-open-routing";

const UPSTREAM_REPOSITORY_URL = "https://github.com/get-bb/bb";

export function UpstreamCredit() {
  return (
    <p data-upstream-credit className="text-xs text-muted-foreground">
      Omnyo is built on{" "}
      <a
        href={UPSTREAM_REPOSITORY_URL}
        target="_blank"
        rel="noreferrer"
        className={`rounded-sm text-foreground underline decoration-border underline-offset-2 outline-none hover:decoration-foreground focus-visible:ring-1 focus-visible:ring-ring ${CONTROL_HOVER_TRANSITION}`}
        onClick={(event) => {
          event.preventDefault();
          openUrlInExternalBrowser(UPSTREAM_REPOSITORY_URL);
        }}
      >
        bb
      </a>
      , the MIT-licensed open-source project by its original authors.
    </p>
  );
}
