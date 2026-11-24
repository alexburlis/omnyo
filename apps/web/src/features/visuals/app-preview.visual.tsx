import "./app.css";

import { AppMock } from "../../lab/app-mock/app-mock";

export const label =
  "The Omnyo window with a branch preview open in the built-in browser.";

export function Visual() {
  return (
    <div className="fv-app" aria-hidden="true">
      <div className="fv-app-art">
        <AppMock view="preview" />
      </div>
    </div>
  );
}
