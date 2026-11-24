import "./shared-skill-updates.css";

export const label =
  "One watch on a shared skills folder. An edit to review/SKILL.md updates the API and website skill lists.";

export function Visual() {
  return (
    <div className="fv fv-skill-watch" aria-hidden="true">
      <div className="fv-skill-source">
        <span className="fv-eyebrow">Shared skills folder</span>
        <strong>review/SKILL.md</strong>
      </div>
      <ul className="fv-skill-branches">
        {["api", "website"].map((name) => (
          <li key={name}>
            <b>{name}</b>
            <span>Skill list updated</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
