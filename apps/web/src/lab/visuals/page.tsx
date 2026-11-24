import "../../features/visuals/kit.css";
import "./styles.css";

import { type ComponentType, useEffect, useState } from "react";

interface VisualModule {
  label: string;
  Visual: ComponentType;
}

const MODULES = import.meta.glob<VisualModule>(
  "../../features/visuals/*.visual.tsx",
);

const ids = Object.keys(MODULES)
  .map((path) => path.split("/").at(-1)?.replace(".visual.tsx", "") ?? "")
  .sort();

function Sample({ id }: { id: string }) {
  const [entry, setEntry] = useState<VisualModule | null>(null);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = MODULES[`../../features/visuals/${id}.visual.tsx`];

    if (!load) return;

    load().then(
      (module) => {
        if (!cancelled) setEntry(module);
      },
      (error: unknown) => {
        if (!cancelled) setFailure(String(error));
      },
    );

    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <section className="lv-sample" data-visual={id}>
      <h2>{id}</h2>
      {failure ? <pre>{failure}</pre> : null}
      {entry ? (
        <div className="lv-sizes">
          {["hero", "wide", "card", "tall"].map((size) => (
            <div className={`lv-frame lv-frame--${size}`} key={size}>
              <div className="fv-box" role="img" aria-label={entry.label}>
                <entry.Visual />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export default function Page() {
  const only = new URLSearchParams(window.location.search).get("only");
  const shown = only ? ids.filter((id) => only.split(",").includes(id)) : ids;

  return (
    <main className="lab-visuals">
      {shown.map((id) => (
        <Sample id={id} key={id} />
      ))}
    </main>
  );
}
