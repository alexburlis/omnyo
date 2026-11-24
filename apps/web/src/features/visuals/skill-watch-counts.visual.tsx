import "./speed.css";

export const label =
  "Mac test with three workspaces. Two shared a skills folder, which used one native watch. Once idle, zero skill readers remained running.";

export function Visual() {
  return (
    <div className="fv fv-speed" aria-hidden="true">
      <ul className="fv-speed-grid">
        {[
          ["3", "Workspaces in the test"],
          ["2", "Using the shared folder"],
          ["1", "Watch on the shared folder"],
          ["0", "Skill readers running after idle"],
        ].map(([value, caption]) => (
          <li className="fv-panel" key={caption}>
            <p className="fv-speed-value">{value}</p>
            <p className="fv-speed-caption">{caption}</p>
          </li>
        ))}
      </ul>
      <p className="fv-speed-note">Local macOS test · November 2026</p>
    </div>
  );
}
