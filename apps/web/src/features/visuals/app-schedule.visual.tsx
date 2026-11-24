import "./app.css";

import { AppMock } from "../../lab/app-mock/app-mock";

export const label =
  "The Omnyo automations list with a weekday issue triage schedule.";

export function Visual() {
  return (
    <div className="fv-app" aria-hidden="true">
      <div className="fv-app-art">
        <AppMock view="schedule" />
      </div>
    </div>
  );
}
