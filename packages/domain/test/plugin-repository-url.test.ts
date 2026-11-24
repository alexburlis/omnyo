import { describe, expect, it } from "vitest";
import { pluginRepositoryUrl } from "../src/plugin-manifest.js";

describe("pluginRepositoryUrl", () => {
  it.each([
    [
      "an npm repository object with a GitHub directory",
      {
        type: "git",
        url: "git+https://github.com/get-bb/bb.git",
        directory: "plugins/git",
      },
      "https://github.com/get-bb/bb/tree/HEAD/plugins/git",
    ],
    [
      "a commit pinned with a URL fragment",
      {
        type: "git",
        url: "git+https://github.com/get-bb/bb.git#b9084d150d7e9e956f15f13cb06e058b042b9f25",
        directory: "plugins/provider-acp-next",
      },
      "https://github.com/get-bb/bb/tree/b9084d150d7e9e956f15f13cb06e058b042b9f25/plugins/provider-acp-next",
    ],
    [
      "a repository without a directory",
      "https://github.com/gtramontina/bb-plugin-chime.git",
      "https://github.com/gtramontina/bb-plugin-chime",
    ],
    [
      "the GitHub shorthand",
      "github:swairshah/bb-handsfree",
      "https://github.com/swairshah/bb-handsfree",
    ],
    [
      "an scp-style GitHub remote",
      {
        url: "git@github.com:example/omnyo-plugins.git",
        directory: "glance",
      },
      "https://github.com/example/omnyo-plugins/tree/HEAD/glance",
    ],
    [
      "npm's git+ssh form",
      "git+ssh://git@github.com/acme/plugins.git",
      "https://github.com/acme/plugins",
    ],
    [
      "npm's git+ssh form with a colon",
      "git+ssh://git@github.com:acme/plugins.git",
      "https://github.com/acme/plugins",
    ],
    [
      "a URL with credentials, without exposing them",
      {
        url: "git+https://user:ghp_secret@github.com/acme/plugins.git",
        directory: "chime",
      },
      "https://github.com/acme/plugins/tree/HEAD/chime",
    ],
    [
      "a non-GitHub host, which has no portable tree path",
      { url: "https://gitlab.com/acme/plugins.git", directory: "chime" },
      "https://gitlab.com/acme/plugins",
    ],
  ])("links %s", (_label, repository, expected) => {
    expect(pluginRepositoryUrl(repository)).toBe(expected);
  });

  it.each([
    ["no repository", undefined],
    ["an insecure URL", "http://github.com/acme/plugin"],
    ["an unsupported shape", { type: "git" }],
    ["an unparseable URL", "not a url"],
  ])("shows no link for %s", (_label, repository) => {
    expect(pluginRepositoryUrl(repository)).toBeNull();
  });
});
