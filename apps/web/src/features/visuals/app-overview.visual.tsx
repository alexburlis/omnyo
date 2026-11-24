import "./app.css";

import { AppMock } from "../../lab/app-mock/app-mock";

export const label =
  "The Omnyo window: every chat in one sidebar, marked working, waiting or done.";

export function Visual() {
  return (
    <div className="fv-app" aria-hidden="true">
      <div className="fv-app-art">
        <AppMock view="overview" />
      </div>
    </div>
  );
}
