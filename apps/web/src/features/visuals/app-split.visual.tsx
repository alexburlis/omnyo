import "./app.css";

import { AppMock } from "../../lab/app-mock/app-mock";

export const label =
  "The Omnyo window with a Claude Code chat and a Codex chat side by side.";

export function Visual() {
  return (
    <div className="fv-app" aria-hidden="true">
      <div className="fv-app-art">
        <AppMock view="split" />
      </div>
    </div>
  );
}
