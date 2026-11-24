import type { EnrollmentBootstrap } from "./enrollments.js";

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function manualEnrollmentCommand(
  bootstrap: EnrollmentBootstrap,
): string {
  const header = `X-Omnyo-Enrollment: ${bootstrap.credential}`;
  const installerUrl = new URL("/install.sh", bootstrap.serverUrl).href;

  return `curl -sS --fail-with-body -L --max-redirs 0 -H ${quote(header)} ${quote(installerUrl)} | sh`;
}

function quotePowerShell(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export function manualEnrollmentPowerShellCommand(
  bootstrap: EnrollmentBootstrap,
): string {
  const installerUrl = new URL("/install.ps1", bootstrap.serverUrl).href;

  return `irm -MaximumRedirection 0 -Headers @{ 'X-Omnyo-Enrollment' = ${quotePowerShell(bootstrap.credential)} } ${quotePowerShell(installerUrl)} | iex`;
}

export function windowsInstallerFailureScript(message: string): string {
  return `throw ${quotePowerShell(message)}\n`;
}

export function shellInstallerFailureScript(message: string): string {
  return `echo ${quote(message)} >&2\nexit 1\n`;
}

const TYPEABLE_URL = /^[A-Za-z0-9._~:/%-]+$/u;

export function shortEnrollmentUrl(
  serverUrl: string,
  code: string,
  platform: "posix" | "windows",
): string {
  const url = new URL(serverUrl);
  const prefix = url.pathname.replace(/\/+$/u, "");

  return `${url.origin}${prefix}/m/${code}${platform === "windows" ? ".ps1" : ""}`;
}

export function shortEnrollmentCommand(
  serverUrl: string,
  code: string,
): string {
  const url = shortEnrollmentUrl(serverUrl, code, "posix");

  return `curl -fsSL ${TYPEABLE_URL.test(url) ? url : quote(url)} | sh`;
}

export function shortEnrollmentPowerShellCommand(
  serverUrl: string,
  code: string,
): string {
  const url = shortEnrollmentUrl(serverUrl, code, "windows");

  return `irm ${TYPEABLE_URL.test(url) ? url : quotePowerShell(url)} | iex`;
}

export function enrolledWindowsInstallerScript(
  installer: string,
  bootstrap: EnrollmentBootstrap,
): string {
  if (/^'@/mu.test(installer)) {
    throw new Error(
      "The Windows machine installer cannot contain a line that starts with '@",
    );
  }

  return [
    "$ErrorActionPreference = 'Stop'",
    "$omnyoNode = Get-Command node.exe -ErrorAction SilentlyContinue",
    "if ($null -eq $omnyoNode) { throw 'omnyo-app requires Node.js 22.19 or newer (22.19, 24, and 26 are tested), but node is not on PATH.' }",
    "$omnyoInstaller = Join-Path ([IO.Path]::GetTempPath()) ('omnyo-install-machine-' + [guid]::NewGuid().ToString('N') + '.mjs')",
    "[IO.File]::WriteAllText($omnyoInstaller, @'",
    installer.replace(/\r?\n$/u, ""),
    "'@, (New-Object Text.UTF8Encoding $false))",
    `$env:OMNYO_ENROLLMENT = ${quotePowerShell(JSON.stringify(bootstrap))}`,
    "try {",
    "  & $omnyoNode.Source $omnyoInstaller --bootstrap-env OMNYO_ENROLLMENT",
    '  if ($LASTEXITCODE -ne 0) { throw "Omnyo machine setup failed with exit code $LASTEXITCODE." }',
    "} finally {",
    "  Remove-Item Env:OMNYO_ENROLLMENT -ErrorAction SilentlyContinue",
    "  Remove-Item -LiteralPath $omnyoInstaller -Force -ErrorAction SilentlyContinue",
    "}",
    "",
  ].join("\n");
}

export function enrolledInstallerScript(
  script: string,
  bootstrap: EnrollmentBootstrap,
): string {
  return `export OMNYO_ENROLLMENT=${quote(JSON.stringify(bootstrap))}\nset -- --bootstrap-env OMNYO_ENROLLMENT\n${script}`;
}
