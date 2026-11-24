import { spawn, spawnSync } from "node:child_process";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import {
  enrolledInstallerScript,
  enrolledWindowsInstallerScript,
  manualEnrollmentCommand,
  manualEnrollmentPowerShellCommand,
  shellInstallerFailureScript,
  shortEnrollmentCommand,
  shortEnrollmentPowerShellCommand,
  windowsInstallerFailureScript,
} from "./manual-enrollment-command.js";
import type { EnrollmentBootstrap } from "./enrollments.js";

const bootstrap: EnrollmentBootstrap = {
  hostId: "host_test",
  credential: "short-lived-code",
  serverUrl: "https://omnyo.example",
  expiresAt: Date.now() + 60_000,
  headers: { "x-access": "private'$value" },
};

it("passes the exact bootstrap and arguments to the installer without shell expansion", ({
  skip,
}) => {
  skip(
    process.platform === "win32",
    "the enrollment command is a POSIX sh pipeline",
  );

  const script = enrolledInstallerScript(
    'printf "%s\\n%s\\n%s" "$1" "$2" "$OMNYO_ENROLLMENT"',
    bootstrap,
  );

  const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe(
    `--bootstrap-env\nOMNYO_ENROLLMENT\n${JSON.stringify(bootstrap)}`,
  );
});

it("builds the transient curl command from the enrollment bootstrap", () => {
  expect(manualEnrollmentCommand(bootstrap)).toBe(
    "curl -sS --fail-with-body -L --max-redirs 0 -H 'X-Omnyo-Enrollment: short-lived-code' 'https://omnyo.example/install.sh' | sh",
  );
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function runShell(
  command: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", () => resolve({ stdout, stderr }));
  });
}

it("does not follow redirects while carrying the enrollment credential, even when .curlrc enables them", async ({
  skip,
}) => {
  skip(
    process.platform === "win32",
    "the enrollment command is a POSIX sh pipeline",
  );
  const sinkRequests: string[] = [];

  const sink = createServer((request, response) => {
    sinkRequests.push(String(request.headers["x-omnyo-enrollment"] ?? ""));
    response.end("echo leaked\n");
  });

  const origin = createServer((_request, response) => {
    response.writeHead(302, { location: `${sinkUrl}/install.sh` });
    response.end();
  });

  let sinkUrl = "";

  await listen(sink);
  await listen(origin);
  sinkUrl = `http://127.0.0.1:${port(sink)}`;

  const command = manualEnrollmentCommand({
    ...bootstrap,
    serverUrl: `http://127.0.0.1:${port(origin)}`,
  });

  const directory = mkdtempSync(join(tmpdir(), "omnyo-enrollment-command-"));

  try {
    const plain = await runShell(command, {
      HOME: directory,
      CURL_HOME: directory,
    });

    writeFileSync(join(directory, ".curlrc"), "location\n");

    const withCurlrc = await runShell(command, {
      HOME: directory,
      CURL_HOME: directory,
    });

    expect(sinkRequests).toEqual([]);
    expect(plain.stderr).toContain("Maximum (0) redirects followed");
    expect(withCurlrc.stderr).toContain("Maximum (0) redirects followed");
    expect(plain.stdout + withCurlrc.stdout).not.toContain("leaked");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    sink.close();
    origin.close();
  }
});

it("builds the transient PowerShell command from the enrollment bootstrap", () => {
  expect(manualEnrollmentPowerShellCommand(bootstrap)).toBe(
    "irm -MaximumRedirection 0 -Headers @{ 'X-Omnyo-Enrollment' = 'short-lived-code' } 'https://omnyo.example/install.ps1' | iex",
  );
  expect(
    manualEnrollmentPowerShellCommand({ ...bootstrap, credential: "it's" }),
  ).toContain("'X-Omnyo-Enrollment' = 'it''s'");
});

it("wraps the Windows installer and its bootstrap in literal PowerShell strings", () => {
  const script = enrolledWindowsInstallerScript(
    "console.log('$env:USERNAME `n');\n",
    bootstrap,
  );

  const lines = script.split("\n");
  const start = lines.indexOf("[IO.File]::WriteAllText($omnyoInstaller, @'");
  expect(lines[start + 1]).toBe("console.log('$env:USERNAME `n');");
  expect(lines[start + 2]).toBe("'@, (New-Object Text.UTF8Encoding $false))");
  expect(lines[start + 3]).toBe(
    `$env:OMNYO_ENROLLMENT = '${JSON.stringify(bootstrap).replaceAll("'", "''")}'`,
  );
  expect(script).toContain(
    "& $omnyoNode.Source $omnyoInstaller --bootstrap-env OMNYO_ENROLLMENT",
  );
  expect(script).toContain("Remove-Item Env:OMNYO_ENROLLMENT");
});

it("refuses a Windows installer that would end the PowerShell here-string early", () => {
  expect(() =>
    enrolledWindowsInstallerScript("first\n'@ + injected\n", bootstrap),
  ).toThrow("cannot contain a line that starts with '@");
});

it("reports a Windows enrollment failure as a PowerShell error", () => {
  expect(windowsInstallerFailureScript("can't enroll")).toBe(
    "throw 'can''t enroll'\n",
  );
});

it("prints the server's enrollment error and stops before running the installer", ({
  skip,
}) => {
  skip(
    process.platform === "win32",
    "the enrollment command is a POSIX sh pipeline",
  );
  const directory = mkdtempSync(join(tmpdir(), "omnyo-enrollment-command-"));

  try {
    const curl = join(directory, "curl");
    writeFileSync(
      curl,
      "#!/bin/sh\nprintf '%s\\n' \"echo 'This enrollment command has already been used.' >&2\" 'exit 1'\nexit 22\n",
    );
    chmodSync(curl, 0o755);

    const result = spawnSync("sh", ["-c", manualEnrollmentCommand(bootstrap)], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [directory, process.env.PATH].join(delimiter),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already been used");
    expect(result.stderr).not.toContain("Syntax error");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("builds typeable short commands that keep the scheme and any path prefix", () => {
  expect(shortEnrollmentCommand("https://omnyo.example", "AB12-CD34")).toBe(
    "curl -fsSL https://omnyo.example/m/AB12-CD34 | sh",
  );
  expect(
    shortEnrollmentPowerShellCommand("https://omnyo.example", "AB12-CD34"),
  ).toBe("irm https://omnyo.example/m/AB12-CD34.ps1 | iex");
  expect(
    shortEnrollmentCommand("https://omnyo.example/base/", "AB12-CD34"),
  ).toBe("curl -fsSL https://omnyo.example/base/m/AB12-CD34 | sh");
  expect(shortEnrollmentCommand("https://omnyo.example/a$b", "AB12-CD34")).toBe(
    "curl -fsSL 'https://omnyo.example/a$b/m/AB12-CD34' | sh",
  );
  expect(
    shortEnrollmentPowerShellCommand("https://omnyo.example/a$b", "AB12-CD34"),
  ).toBe("irm 'https://omnyo.example/a$b/m/AB12-CD34.ps1' | iex");
});

it("shows a short-code refusal and exits 1 when piped through curl -fsSL", async ({
  skip,
}) => {
  skip(
    process.platform === "win32",
    "the short command is a POSIX sh pipeline",
  );

  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/x-shellscript" });
    response.end(shellInstallerFailureScript("This setup code can't be used."));
  });

  await listen(server);

  try {
    const result = await runShell(
      `${shortEnrollmentCommand(`http://127.0.0.1:${port(server)}`, "AB12-CD34")}; echo "status=$?"`,
      {},
    );

    expect(result.stderr).toContain("This setup code can't be used.");
    expect(result.stdout).toContain("status=1");
  } finally {
    server.close();
  }
});
