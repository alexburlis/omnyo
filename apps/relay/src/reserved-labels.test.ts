import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Deps, checkAvailability, claimHandle } from "./account/api.js";
import { openRelayDatabase, type RelayDatabase } from "./db.js";
import { sourceMigrationDirectories } from "./migrations.js";
import {
  brokenRelayLabelRule,
  isClaimableRelayLabel,
  labelSkeleton,
} from "./reserved-labels.js";

let database: RelayDatabase;

let deps: Deps;

beforeEach(() => {
  database = openRelayDatabase(":memory:", sourceMigrationDirectories());
  deps = {
    db: database.db,
    appUrl: "https://relay.test",
    serverUrlTemplate: "https://{label}.relay.test",
    closeTunnel: async () => {},
    recordRevocation: () => {},
    tunnelConnected: null,
  };
});

afterEach(() => {
  database.close();
});

describe("relay label rules", () => {
  it.each([
    "omny0",
    "0mny0",
    "omn-yo",
    "om-nyo",
    "ornnyo",
    "onmyo",
    "omny0-app",
    "slash-new",
    "slashnevv",
    "s1ashnew",
    "gith-ub",
    "githab",
    "g1thub",
    "glthub",
    "githud",
    "githab-login",
  ])("refuses the brand look-alike %s", (label) => {
    expect(brokenRelayLabelRule(label)).toBe("look-alike");
  });

  it.each([
    "sign-in",
    "log-in",
    "l0gin-page",
    "omnya-login",
    "claude-login",
    "openai-auth",
    "apple-id",
    "google-login",
    "anthropic-support",
  ])("refuses the service look-alike %s", (label) => {
    expect(brokenRelayLabelRule(label)).toBe("look-alike");
  });

  it.each([
    "googlelogin",
    "appleid",
    "apple-id-now",
    "mi-cro-soft",
    "m-i-c-r-o-s-o-f-t",
    "a-p-p-l-e",
    "9oogle",
    "gooogle",
    "g00gle-docs",
    "paypal",
    "pay-pal-help",
    "paypa1",
    "paypall",
    "anthrop1c",
    "cloudflare-tunnel",
    "clouclflare",
    "nnicrosoft",
    "myoauth",
    "bigpassword",
    "userlogout",
    "mysignin",
    "coolify-app",
    "hetznner",
    "c1aude-help",
    "open-a1-chat",
    "githubsecurity",
  ])("refuses the joined or mistyped look-alike %s", (label) => {
    expect(brokenRelayLabelRule(label)).toBe("look-alike");
  });

  it.each([
    ["12345", "digits-only"],
    ["1234567890", "digits-only"],
    ["alice-", "trailing-hyphen"],
    ["abcd", "too-short"],
    ["hello", "reserved"],
  ])("refuses %s as %s", (label, rule) => {
    expect(brokenRelayLabelRule(label)).toBe(rule);
  });

  it.each([
    "sawyer",
    "sawyer-desktop",
    "alice-work",
    "gitlab-runner",
    "harmony",
    "company",
    "omnibus",
    "unicorn",
    "bob-dev",
    "alice-2",
    "machine-abcdef01",
    "signing-desk",
    "designing",
    "assigning",
    "resigning",
    "claudia",
    "claudia-work",
    "claudette",
    "claudio-laptop",
    "clause-lab",
    "goggles",
    "cloudy-days",
    "cooling-tower",
    "applesauce",
    "pineapple",
    "stripes",
    "blogger",
    "logging",
    "catalog",
    "unicorn-farm",
    "hector",
    "hetty-desk",
    "micron-lab",
    "microscope",
    "annual-report",
    "channel-9",
    "maya-macbook",
    "tom-studio",
    "build-box-7",
    "personal-laptop",
    "ci-runner",
    "oscar-mini",
    "ben-pc-2",
    "dev-machine",
    "home-office",
    "work-station",
  ])("accepts the ordinary label %s", (label) => {
    expect(isClaimableRelayLabel(label)).toBe(true);
  });

  it("folds digit and letter look-alikes into one skeleton", () => {
    expect(labelSkeleton("0mn-y0")).toBe(labelSkeleton("omnyo"));
    expect(labelSkeleton("g1thub")).toBe(labelSkeleton("github"));
    expect(labelSkeleton("slashnevv")).toBe("slashnew");
    expect(labelSkeleton("ornnyo")).toBe("omnyo");
  });
});

describe("label availability", () => {
  it.each(["githab-login", "omny0-app", "sign-in", "s1ashnew", "log-in"])(
    "reports %s as reserved",
    async (label) => {
      expect(await checkAvailability(deps, label)).toEqual({
        available: false,
        reason: "invalid",
        error: "reserved",
      });
    },
  );

  it.each(["31415926", "alice-"])(
    "reports %s as malformed and refuses to claim it",
    async (label) => {
      database.sqlite
        .prepare(
          "INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u1', 'n', 'n@example.com', 1, 1)",
        )
        .run();

      expect(await checkAvailability(deps, label)).toEqual({
        available: false,
        reason: "invalid",
        error: "invalid-format",
      });
      expect(await claimHandle(deps, "u1", label)).toEqual({
        error: "invalid-format",
      });
    },
  );
});
