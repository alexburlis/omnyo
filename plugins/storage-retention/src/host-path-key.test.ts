import { getHostPathComparisonKey } from "@omnyo/domain";
import { expect, it } from "vitest";
import { hostPathComparisonKey } from "./host-path-key.js";

const paths = [
  "/Users/developer/worktrees/omnyo/lane",
  "/Users/developer//worktrees/./omnyo/../omnyo/lane/",
  "/Users/developer/Lane",
  "/",
  "C:\\Users\\Developer\\Lane",
  "c:/Users/developer/lane/",
  "C:",
  "C:\\",
  "D:\\work\\..\\Repo\\.\\lane",
  "\\\\Server\\Share\\Folder\\Lane",
  "//server/share/folder//lane/",
  "\\\\server\\share",
  "relative/lane",
  "",
];

it("keys host paths exactly like the shared domain parser it stands in for", () => {
  for (const path of paths) {
    expect(hostPathComparisonKey(path), path).toBe(
      getHostPathComparisonKey(path),
    );
  }
});
