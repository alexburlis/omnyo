"use strict";

const fs = require("node:fs");

const path = require("node:path");

const crypto = require("node:crypto");

const https = require("node:https");

const { app, net, session } = require("electron");

const [profile, output] = process.argv.slice(2);

if (
  process.argv[1] !== "--omnyo-electron-trust-probe" ||
  process.argv.length !== 4 ||
  !profile ||
  !output ||
  !path.isAbsolute(profile) ||
  !path.isAbsolute(output)
) {
  throw new Error("Requires absolute owned profile and result paths");
}

if (process.versions.electron !== "44.9.3")
  throw new Error("Unexpected Electron version");

for (const name of [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_OPTIONS",
]) {
  if (process.env[name]) throw new Error(`Unreviewed trust override: ${name}`);
}

if (!fs.existsSync(profile) || fs.readdirSync(profile).length !== 0) {
  throw new Error("Profile must be an existing empty owned directory");
}

app.setPath("userData", profile);

app.setPath("sessionData", profile);

app.commandLine.appendSwitch("disable-background-networking");

if (process.platform === "darwin") app.setActivationPolicy("prohibited");

const targets = [
  { url: "https://pypi.org/", expected: "accepted" },
  { url: "https://registry.npmjs.org/next", expected: "accepted" },
  {
    url: "https://dv-g3b-emudhra.we-have-a-problem.com/",
    expected: "certificate-rejected",
  },
  {
    url: "https://dv-g3b-aaa-emudhra.we-have-a-problem.com/",
    expected: "certificate-rejected",
  },
];

const nodeCertificateErrors = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_REVOKED",
]);

const chromiumCertificateErrors = new Set([
  "net::ERR_CERT_AUTHORITY_INVALID",
  "net::ERR_CERT_REVOKED",
  "net::ERR_CERT_KNOWN_INTERCEPTION_BLOCKED",
]);

async function sha256(file) {
  const hash = crypto.createHash("sha256");

  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);

  return hash.digest("hex");
}

function nodeProbe(target) {
  return new Promise((resolve) => {
    let finished = false;
    let request;

    const timer = setTimeout(() => {
      request?.destroy();
      finish({ outcome: "transport-failed", code: "PROBE_TIMEOUT" });
    }, 40000);

    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stack: "node-https", ...target, ...result });
    }

    request = https.get(target.url, { agent: false }, (response) => {
      response.resume();
      finish({ outcome: "accepted", statusCode: response.statusCode });
    });
    request.once("error", (error) =>
      finish({
        outcome: nodeCertificateErrors.has(error.code)
          ? "certificate-rejected"
          : "transport-failed",
        code: error.code || "UNKNOWN",
      }),
    );
  });
}

function chromiumProbe(target, isolatedSession) {
  return new Promise((resolve) => {
    let finished = false;
    const request = net.request({ url: target.url, session: isolatedSession });

    const timer = setTimeout(() => {
      request.abort();
      finish({ outcome: "transport-failed", code: "PROBE_TIMEOUT" });
    }, 40000);

    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ stack: "chromium-net", ...target, ...result });
    }

    request.once("response", (response) => {
      response.on("data", () => {});
      finish({ outcome: "accepted", statusCode: response.statusCode });
    });
    request.once("redirect", () => {
      request.abort();
      finish({ outcome: "transport-failed", code: "UNEXPECTED_REDIRECT" });
    });
    request.once("error", (error) => {
      const code = error.message;
      finish({
        outcome: chromiumCertificateErrors.has(code)
          ? "certificate-rejected"
          : "transport-failed",
        code,
      });
    });
    request.end();
  });
}

app
  .whenReady()
  .then(async () => {
    app.dock?.hide();
    const executable = fs.realpathSync(process.execPath);

    const framework = path.join(
      path.dirname(executable),
      "..",
      "Frameworks",
      "Electron Framework.framework",
      "Versions",
      "A",
      "Electron Framework",
    );

    const result = {
      startedAt: new Date().toISOString(),
      versions: process.versions,
      executable,
      executableSHA256: await sha256(executable),
      frameworkSHA256: fs.existsSync(framework)
        ? await sha256(framework)
        : null,
      isolatedProfile: profile,
      customCertificateVerification: false,
      rows: [],
    };

    const isolatedSession = session.fromPartition(
      `security-trust-${process.pid}`,
      { cache: false },
    );

    for (const target of targets) {
      result.rows.push(
        ...(await Promise.all([
          nodeProbe(target),
          chromiumProbe(target, isolatedSession),
        ])),
      );
    }

    result.passed = result.rows.every(
      (row) =>
        row.outcome === row.expected &&
        (row.expected !== "accepted" ||
          (row.statusCode >= 200 && row.statusCode < 300)),
    );
    result.finishedAt = new Date().toISOString();
    fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
      mode: 0o600,
    });
    app.exit(result.passed ? 0 : 1);
  })
  .catch((error) => {
    fs.writeFileSync(
      output,
      `${JSON.stringify({ passed: false, failure: String(error) })}\n`,
      { mode: 0o600 },
    );
    app.exit(1);
  });
