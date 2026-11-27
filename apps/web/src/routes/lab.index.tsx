import { Link, createFileRoute } from "@tanstack/react-router";

import { LAB_DESIGNS } from "../lab/designs";
import { requireLabPreview } from "../lab/lab-access";

export const Route = createFileRoute("/lab/")({
  beforeLoad: requireLabPreview,
  head: () => ({
    meta: [
      { title: "Omnyo landing lab" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: LabIndexRoute,
});

const GROUPS = [
  { id: "open", label: "Open concepts" },
  { id: "cinematic-o", label: "Cinematic, built around the 3D O" },
  { id: "combined", label: "Combined directions" },
  { id: "tools", label: "Working tools" },
] as const;

function LabIndexRoute() {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: "#0b0b0c",
        color: "#ededed",
        fontFamily: "system-ui, sans-serif",
        padding: "48px 40px",
      }}
    >
      <h1 style={{ fontSize: 28, fontWeight: 600, margin: "0 0 32px" }}>
        Omnyo landing lab
      </h1>
      {GROUPS.map((group) => (
        <section key={group.id} style={{ marginBottom: 40 }}>
          <h2 style={{ fontSize: 15, opacity: 0.6, margin: "0 0 14px" }}>
            {group.label}
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 16,
            }}
          >
            {LAB_DESIGNS.filter((design) => design.group === group.id).map(
              (design) => (
                <Link
                  key={design.slug}
                  to="/lab/$design"
                  params={{ design: design.slug }}
                  style={{
                    display: "block",
                    padding: "18px 20px",
                    border: "1px solid #2a2a2e",
                    borderRadius: 12,
                    color: "inherit",
                    textDecoration: "none",
                  }}
                >
                  <strong style={{ display: "block", fontSize: 17 }}>
                    {design.title}
                  </strong>
                  <span style={{ opacity: 0.6, fontSize: 14 }}>
                    {design.territory}
                  </span>
                </Link>
              ),
            )}
          </div>
        </section>
      ))}
    </main>
  );
}
