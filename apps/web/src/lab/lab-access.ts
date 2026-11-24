import { notFound } from "@tanstack/react-router";

export function requireLabPreview() {
  if (import.meta.env.PROD) throw notFound();
}
