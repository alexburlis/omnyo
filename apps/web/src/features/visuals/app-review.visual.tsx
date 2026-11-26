import { AppMock } from "../../lab/app-mock/app-mock";

export const label =
  "The Omnyo window: a Codex chat reviewing the branch a Claude Code chat built.";

export function Visual() {
  return (
    <div className="fv-app" aria-hidden="true">
      <div className="fv-app-art">
        <AppMock view="review" />
      </div>
    </div>
  );
}
