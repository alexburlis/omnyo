import { readFileSync } from "node:fs";

const required = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8")
  .trim()
  .replace(/^v/, "")
  .split(".")[0];

const current = process.versions.node.split(".")[0];

if (current !== required) {
  console.error(
    `Chat Topics tests need Node ${required} (.nvmrc), but this is Node ${process.versions.node}. ` +
      `The better-sqlite3 test binding is built for Node ${required} and cannot load here, ` +
      `so the tests would fail and hang. Run \`nvm use\` in chat-topics and retry.`,
  );
  process.exit(1);
}
