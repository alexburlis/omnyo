import { lstatSync, readdirSync } from "node:fs";
import { pathExistsRefusingLinks } from "./database-sidecars.js";

export function isLegacyStateRootPopulatedV1(path: string): boolean {
  if (!pathExistsRefusingLinks(path)) return false;

  if (!lstatSync(path).isDirectory())
    throw new Error("State migration requires a profile directory");

  return readdirSync(path).length > 0;
}
