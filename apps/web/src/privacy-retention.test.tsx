import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { Route } from "./routes/privacy";

function renderPolicyText() {
  const Page = Route.options.component;

  if (Page === undefined) throw new Error("The privacy route has no page");

  return renderToStaticMarkup(<Page />)
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ");
}

it("states the backup bound as a count of copies, not a number of days each", () => {
  const text = renderPolicyText();

  expect(text).toContain("keeps the 7 newest copies");
  expect(text).toContain("keeps the 7 newest archives");
  expect(text).toContain("can take longer");
  expect(text).toContain("about 14 more days");
  expect(text).not.toContain("keeps each archive for 7 days");
  expect(text).not.toContain("up to 14 more days");
});

it("says that sign-in and connection records outlive an account deletion", () => {
  expect(renderPolicyText()).toContain(
    "Records of your sign-ins and connections, with their IP addresses and your GitHub user ID, stay until they are 90 days old.",
  );
});

it("says that the relay logs the address of a refused edge connection", () => {
  expect(renderPolicyText()).toContain(
    "When the relay refuses a connection that does not come from our proxy, it logs the address that connected.",
  );
});

it("says which records of the revocation log stay and which go after 30 days", () => {
  const text = renderPolicyText();

  expect(text).toContain("It drops revocations and deletions after 30 days.");
  expect(text).toContain(
    "keeps the latest record of each released address, and the latest suspension or lifted suspension of each account, with no time limit.",
  );
  expect(text).not.toContain("GitHub user IDs for 30 days");
});
