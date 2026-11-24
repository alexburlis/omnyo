#!/bin/sh

set -eu

usage() {
  cat >&2 <<'EOF'
Usage: install.sh --bootstrap-env <NAME> [--host-daemon-port <port>]
       install.sh --adopt --data-dir <path> [--host-daemon-port <port>] [--artifact-path <tgz> --artifact-sha256 <sha256>]
       install.sh --start|--stop|--uninstall --host-id <host-id> [--server-url <url>] [--data-dir <path>]

Machines enroll from a private bootstrap bundle. Get the one-line command that
carries it from Settings -> Machines -> Add a machine, or from
`omnyo machine create --provider manual`. Use the existing private coordinator address.
--adopt installs the service for a data directory that is already enrolled,
such as the one a server move leaves behind, reading its machine ID from
auth.json and its server address and credentials from config.json.
By default, the installer assigns this enrolled daemon its own local API port.
The paired artifact options install only the verified local package, without a download fallback.
EOF
  exit 2
}

bootstrap_env=
host_id=
server_url=
requested_host_daemon_port=
lifecycle_action=
requested_data_dir=
adopt=no
adopted_identity=
reconnect=no
recorded_data_dir=
artifact_path=
artifact_sha256=

CURL_CONNECT_TIMEOUT_SECONDS=10
PACKAGE_DOWNLOAD_TIMEOUT_SECONDS=300
PACKAGE_DOWNLOAD_RETRIES=3
DAEMON_WAIT_ATTEMPTS=60
WAIT_PROGRESS_EVERY_ATTEMPTS=5

use_color=no
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  use_color=yes
fi

color() {
  color_code=$1
  shift
  if [ "$use_color" = yes ]; then
    printf '\033[%sm%s\033[0m' "$color_code" "$*"
  else
    printf '%s' "$*"
  fi
}

bold() {
  color 1 "$1"
}

cyan() {
  color 36 "$1"
}

dim() {
  color 2 "$1"
}

green() {
  color 32 "$1"
}

red() {
  color 31 "$1"
}

yellow() {
  color 33 "$1"
}

log() {
  printf '  %s  %s\n' "$1" "$2"
}

log_error() {
  printf '  %s  %s\n' "$1" "$2" >&2
}

active_step() {
  log "$(dim "○")" "$1"
}

complete_step() {
  log "$(green "✓")" "$1"
}

warning_step() {
  log_error "$(yellow "!")" "$1"
}

fail_step() {
  log_error "$(red "✗")" "$1"
}

detail() {
  log " " "$(dim "$1")"
}

ready_row() {
  ready_label=$(printf '%-7s' "$1")
  log " " "$(dim "$ready_label") $2"
}

legacy_installation_owners_v1() {
  node -e '
    function importLegacyInstallationOwnersV1() {
      return { machineRoot: ".bb-machines", darwinPrefix: "app.getbb.host-daemon.", linuxPrefix: "bb-host-daemon-", dataEnv: "BB_DATA_DIR", runtimeBin: "bb-app" };
    }
    process.stdout.write(JSON.stringify(importLegacyInstallationOwnersV1()));
  '
}

run_lifecycle() {
  case "$host_id" in *[!A-Za-z0-9_-]*|'') fail_step "Invalid machine host ID."; exit 2 ;; esac
  lifecycle_data_dir=${requested_data_dir:-${OMNYO_DATA_DIR:-}}
  legacy_owners=$(legacy_installation_owners_v1)
  installation=$(node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const [home, requested, hostId, expectedServer, oldJson] = process.argv.slice(1);
    const old = JSON.parse(oldJson);
    const root = path.join(home, ".omnyo-machines");
    const roots = [root, path.join(home, old.machineRoot)].filter((candidate) => fs.existsSync(candidate));
    let candidates;
    if (requested) candidates = [path.resolve(requested)];
    else {
      candidates = roots.flatMap((directory) => fs.readdirSync(directory).map((name) => path.join(directory, name)));
    }
    if (roots.some((directory) => fs.lstatSync(directory).isSymbolicLink())) throw new Error("Refusing a symlinked installer-owned root");
    const canonicalRoots = roots.map((directory) => fs.realpathSync(directory));
    const matches = [];
    for (const candidate of candidates) {
      let auth;
      try { auth = JSON.parse(fs.readFileSync(path.join(candidate, "auth.json"), "utf8")); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (auth.hostId !== hostId) {
        if (requested) throw new Error("Machine data directory belongs to another host.");
        continue;
      }
      const dataDir = fs.realpathSync(candidate);
      if (!canonicalRoots.includes(path.dirname(dataDir)) || fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error("Refusing a machine data directory outside its installer-owned root.");
      }
      const config = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
      const serverUrl = new URL(config.serverUrl).href.replace(/\/+$/u, "");
      if (expectedServer && serverUrl !== new URL(expectedServer).href.replace(/\/+$/u, "")) {
        throw new Error("Machine data directory belongs to another server.");
      }
      matches.push({ dataDir, serverUrl, legacyOwner: !fs.existsSync(root) || path.dirname(dataDir) !== fs.realpathSync(root) });
    }
    if (matches.length > 1) throw new Error("Host identity matches multiple machine installations; specify --data-dir.");
    if (matches.length === 0) process.exit(3);
    process.stdout.write(JSON.stringify(matches[0]));
  ' "$HOME" "$lifecycle_data_dir" "$host_id" "$server_url" "$legacy_owners") || {
    lifecycle_status=$?
    if [ "$lifecycle_status" -eq 3 ]; then
      if [ "$lifecycle_action" = start ]; then fail_step "Machine installation was not found."; exit 1; fi
      return 0
    fi
    exit "$lifecycle_status"
  }
  data_dir=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).dataDir)' "$installation")
  legacy_owner=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).legacyOwner ? "yes" : "no")' "$installation")
  if [ "$lifecycle_action" = start ] && [ "$legacy_owner" = yes ]; then
    fail_step "This old installation cannot start. Remove it with --uninstall, then enroll this machine again."
    exit 1
  fi
  server_url=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).serverUrl)' "$installation")
  host_daemon_port=$(sed -n '1p' "$data_dir/host-daemon-port")
  case "$host_daemon_port" in *[!0-9]*|'') fail_step "Refusing an invalid daemon port."; exit 1 ;; esac
  if [ "$host_daemon_port" -lt 1024 ] || [ "$host_daemon_port" -gt 65535 ] || [ "$host_daemon_port" -eq 38886 ] || [ "$host_daemon_port" -eq 38887 ]; then
    fail_step "Refusing an invalid or default daemon port."
    exit 1
  fi
  lifecycle_server_host=$(node -e 'process.stdout.write(new URL(process.argv[1]).host.replace(/[^a-zA-Z0-9.-]/gu, "-"))' "$server_url")
  lifecycle_slug=$(printf '%s-%s' "$lifecycle_server_host" "$host_id" | tr '.' '-')
  systemd_scope=--user
  if [ "$platform" = darwin ]; then
    service_name="app.omnyo.host-daemon.$lifecycle_slug"
    service_file="$HOME/Library/LaunchAgents/$service_name.plist"
    system_service_file=
  else
    service_name="omnyo-host-daemon-$lifecycle_slug.service"
    service_file="$HOME/.config/systemd/user/$service_name"
    system_service_file="$data_dir/systemd/$service_name"
  fi
  if [ ! -e "$service_file" ] && { [ -z "$system_service_file" ] || [ ! -e "$system_service_file" ]; }; then
    discovered_service_file=$(OMNYO_LIFECYCLE_DATA_DIR="$data_dir" node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      const [platform, home, oldJson] = process.argv.slice(1);
      const old = JSON.parse(oldJson);
      const dataDir = process.env.OMNYO_LIFECYCLE_DATA_DIR;
      const escaped = dataDir.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'"'"'", "&apos;");
      const systemd = dataDir.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%");
      const directories = platform === "darwin"
        ? ["app.omnyo.host-daemon.", old.darwinPrefix].map((prefix) => [path.join(home, "Library", "LaunchAgents"), prefix, ".plist"])
        : [path.join(home, ".config", "systemd", "user"), path.join(dataDir, "systemd")].flatMap((directory) => ["omnyo-host-daemon-", old.linuxPrefix].map((prefix) => [directory, prefix, ".service"]));
      const matches = [];
      for (const [directory, prefix, suffix] of directories) {
        let names;
        try { names = fs.readdirSync(directory); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        for (const name of names.sort()) {
          if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
          const candidate = path.join(directory, name);
          if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) continue;
          const service = fs.readFileSync(candidate, "utf8");
          if (["OMNYO_DATA_DIR", old.dataEnv].some((name) => service.includes(`<key>${name}</key><string>${escaped}</string>`) || service.includes(`Environment="${name}=${systemd}"`))) matches.push(candidate);
        }
      }
      if (matches.length > 1) {
        process.stderr.write(`Machine data directory ${dataDir} is referenced by several services: ${matches.join(", ")}\n`);
        process.exit(1);
      }
      if (matches.length === 1) process.stdout.write(matches[0]);
    ' "$platform" "$HOME" "$legacy_owners") || { fail_step "Machine data directory is referenced by several services."; exit 1; }
    if [ -n "$discovered_service_file" ]; then
      service_name=${discovered_service_file##*/}
      if [ "$platform" = darwin ]; then
        service_name=${service_name%.plist}
        service_file=$discovered_service_file
      else
        service_file="$HOME/.config/systemd/user/$service_name"
        system_service_file="$data_dir/systemd/$service_name"
      fi
    fi
  fi
  if [ -n "$system_service_file" ] && [ -f "$system_service_file" ]; then
    [ "$(id -u)" -eq 0 ] || { fail_step "Machine system service requires root."; exit 1; }
    [ ! -e "$service_file" ] || { fail_step "Machine has both user and system services."; exit 1; }
    [ ! -L "${system_service_file%/*}" ] || { fail_step "Refusing a symlinked machine system service directory."; exit 1; }
    service_file=$system_service_file
    systemd_scope=--system
  fi
  if [ -e "$service_file" ]; then
    [ ! -L "$service_file" ] || { fail_step "Machine service belongs to another installation."; exit 1; }
    OMNYO_LIFECYCLE_DATA_DIR="$data_dir" node -e '
      const fs = require("node:fs");
      const service = fs.readFileSync(process.argv[1], "utf8");
      const old = JSON.parse(process.argv[2]);
      const dataDir = process.env.OMNYO_LIFECYCLE_DATA_DIR;
      const escaped = dataDir.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'"'"'", "&apos;");
      const systemd = dataDir.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%");
      if (!["OMNYO_DATA_DIR", old.dataEnv].some((name) => service.includes(`<key>${name}</key><string>${escaped}</string>`) || service.includes(`Environment="${name}=${systemd}"`))) {
        process.stderr.write(`Machine service does not reference ${dataDir}.\n`);
        process.exit(1);
      }
    ' "$service_file" "$legacy_owners" || { fail_step "Machine service belongs to another installation."; exit 1; }
  fi
  daemon_matches() {
    node -e '
      const [port, hostId, serverUrl] = process.argv.slice(1);
      void fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(750) })
        .then(async (response) => {
          const status = await response.json();
          const normalize = (value) => new URL(String(value)).href.replace(/\/+$/u, "");
          process.exit(status.hostId === hostId && normalize(status.serverUrl) === normalize(serverUrl) ? 0 : 1);
        }).catch(() => process.exit(1));
    ' "$host_daemon_port" "$host_id" "$server_url" >/dev/null 2>&1
  }
  pid_file="$data_dir/install-daemon.pid"
  daemon_pid=
  if [ -f "$pid_file" ]; then daemon_pid=$(sed -n '1p' "$pid_file"); fi
  owned_pid() {
    [ -n "$daemon_pid" ] || return 1
    case "$daemon_pid" in *[!0-9]*|'0'|'1') fail_step "Invalid installed daemon PID."; exit 1 ;; esac
    daemon_command=$(ps -p "$daemon_pid" -o command= 2>/dev/null) || return 1
    launcher="$data_dir/npm/bin/omnyo-app"
    if [ "$legacy_owner" = yes ]; then
      legacy_runtime_bin=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runtimeBin)' "$legacy_owners")
      launcher="$data_dir/npm/bin/$legacy_runtime_bin"
    fi
    case " $daemon_command " in *" $launcher "*" host-daemon "*" --host-daemon-port $host_daemon_port "*" --server-url $server_url "*) return 0 ;; esac
    fail_step "Recorded daemon PID belongs to another process."
    exit 1
  }
  if [ "$lifecycle_action" = start ]; then
    if ! node --input-type=module -e '
      const { pathToFileURL } = await import("node:url");
      const { assertInstallationStateForStart } = await import(pathToFileURL(process.argv[1]));
      assertInstallationStateForStart(process.argv[2]);
    ' "$data_dir/npm/lib/node_modules/omnyo-app/dist/state-admission.mjs" "$data_dir"; then
      fail_step "The installed state owner refused startup before profile writes."
      exit 1
    fi
    rm -f "$data_dir/machine-suspended"
    if daemon_matches; then return 0; fi
    if [ -f "$service_file" ]; then
      if [ "$platform" = darwin ]; then
        launchctl bootstrap "gui/$(id -u)" "$service_file"
      else
        systemctl "$systemd_scope" enable "$service_file" >/dev/null
        systemctl "$systemd_scope" start "$service_name"
      fi
    elif ! owned_pid; then
      OMNYO_APP_NPM_PREFIX="$data_dir/npm" OMNYO_DATA_DIR="$data_dir" nohup "$data_dir/npm/bin/omnyo-app" host-daemon --auto-update --supervise --host-daemon-port "$host_daemon_port" --server-url "$server_url" >"$data_dir/install-daemon.log" 2>&1 &
      daemon_pid=$!
      (umask 077 && printf '%s\n' "$daemon_pid" >"$pid_file")
    fi
    lifecycle_attempt=0
    while [ "$lifecycle_attempt" -lt 80 ]; do
      if daemon_matches; then return 0; fi
      lifecycle_attempt=$((lifecycle_attempt + 1))
      sleep 0.25
    done
    fail_step "Machine daemon did not start within 20 seconds."
    exit 1
  fi
  if [ -f "$service_file" ]; then
    if [ "$platform" = darwin ]; then
      launchctl bootout "gui/$(id -u)" "$service_file" >/dev/null 2>&1 || true
    elif [ "$lifecycle_action" = uninstall ]; then
      systemctl "$systemd_scope" disable --now "$service_name"
    else
      systemctl "$systemd_scope" stop "$service_name"
    fi
  fi
  if owned_pid; then kill "$daemon_pid"; fi
  lifecycle_attempt=0
  while [ "$lifecycle_attempt" -lt 80 ]; do
    if ! daemon_matches && ! owned_pid; then break; fi
    lifecycle_attempt=$((lifecycle_attempt + 1))
    sleep 0.25
  done
  [ "$lifecycle_attempt" -lt 80 ] || { fail_step "Machine daemon did not stop within 20 seconds."; exit 1; }
  rm -f "$pid_file"
  if [ "$lifecycle_action" = uninstall ]; then
    if [ -f "$service_file" ]; then rm -f "$service_file"; fi
    if [ "$platform" = linux ]; then systemctl "$systemd_scope" daemon-reload; fi
    node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true })' "$data_dir"
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bootstrap-env|--host-id|--server-url|--host-daemon-port|--data-dir|--artifact-path|--artifact-sha256)
      [ "$#" -ge 2 ] || usage
      [ -n "$2" ] || usage
      case "$1" in
        --bootstrap-env) bootstrap_env=$2 ;;
        --host-id) host_id=$2 ;;
        --server-url) server_url=$2 ;;
        --host-daemon-port) requested_host_daemon_port=$2 ;;
        --data-dir) requested_data_dir=$2 ;;
        --artifact-path) [ -z "$artifact_path" ] || usage; artifact_path=$2 ;;
        --artifact-sha256) [ -z "$artifact_sha256" ] || usage; artifact_sha256=$2 ;;
      esac
      shift 2
      ;;
    --start|--stop|--uninstall)
      [ -z "$lifecycle_action" ] || usage
      lifecycle_action=${1#--}
      shift
      ;;
    --adopt)
      [ "$adopt" = no ] || usage
      adopt=yes
      shift
      ;;
    -h|--help) usage ;;
    *)
      fail_step "Unknown option: $1"
      usage
      ;;
  esac
done

if [ -n "$artifact_path$artifact_sha256" ]; then
  if [ "$adopt" != yes ] || [ -z "$artifact_path" ] || [ -z "$artifact_sha256" ] || [ -n "$lifecycle_action" ]; then
    fail_step "Local artifact installation requires --adopt, --artifact-path and --artifact-sha256 together."
    exit 2
  fi
fi

if [ -n "$lifecycle_action" ]; then
  [ -z "$bootstrap_env$requested_host_daemon_port" ] || usage
  [ "$adopt" = no ] || usage
elif [ "$adopt" = yes ]; then
  [ -z "$bootstrap_env$host_id$server_url" ] || usage
  [ -n "$requested_data_dir" ] || usage
else
  [ -n "$bootstrap_env" ] || usage
  if [ -n "$host_id$server_url" ]; then usage; fi
  host_id=$(node -e '
    const name = process.argv[1];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) process.exit(2);
    try {
      const bundle = JSON.parse(process.env[name]);
      if (typeof bundle.hostId !== "string" || !bundle.hostId) process.exit(2);
      process.stdout.write(bundle.hostId);
    } catch { process.exit(2); }
  ' "$bootstrap_env") || usage
  server_url=$(node -e '
    try {
      const bundle = JSON.parse(process.env[process.argv[1]]);
      const url = new URL(bundle.serverUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) process.exit(2);
      process.stdout.write(url.href.replace(/\/$/u, ""));
    } catch { process.exit(2); }
  ' "$bootstrap_env") || usage
  reconnect=$(node -e 'process.stdout.write(JSON.parse(process.env[process.argv[1]]).reconnect === true ? "yes" : "no")' "$bootstrap_env")
  recorded_data_dir=$(node -e 'const dir = JSON.parse(process.env[process.argv[1]]).dataDir; process.stdout.write(typeof dir === "string" ? dir : "")' "$bootstrap_env")
  bootstrap_payload=$(node -e 'process.stdout.write(process.env[process.argv[1]])' "$bootstrap_env")
  unset "$bootstrap_env"
fi
if [ "$adopt" = no ]; then
  [ -n "$host_id" ] || usage
  if [ -z "$lifecycle_action" ]; then [ -n "$server_url" ] || usage; fi
fi
printf '\n  %s\n\n' "$(bold "Omnyo machine setup")"
if [ "$adopt" = no ]; then
  active_step "Setting up this machine as $host_id for $server_url"
fi

case "$(uname -s)" in
  Darwin) platform=darwin ;;
  Linux) platform=linux ;;
  *)
    fail_step "Omnyo machine installation supports macOS and Linux only."
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  fail_step "omnyo-app requires Node.js 22.19 or newer (22.19, 24, and 26 are tested), but node is not on PATH."
  exit 1
fi
node_version=$(node -p 'process.versions.node')
# Open-ended floor rather than an allow-list of tested majors: Pi only requires
# >=22.19, and a closed list turns every future release line into a hard
# install failure on the day it ships.
node_supported=$(node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = major > 22 || (major === 22 && minor >= 19);
  process.exit(supported ? 0 : 1);
' && echo yes || echo no)
if [ "$node_supported" != yes ]; then
  fail_step "Node.js $node_version is too old; omnyo-app requires Node.js 22.19 or newer (22.19, 24, and 26 are tested)."
  exit 1
fi
node_bin=$(node -p 'process.execPath')

if [ -n "$artifact_path" ]; then
  if ! node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const crypto = require("node:crypto");
    const [file, expected] = process.argv.slice(1);
    try {
      const info = fs.lstatSync(file);
      if (!path.isAbsolute(file) || !info.isFile() || info.isSymbolicLink() || !/^[a-f0-9]{64}$/u.test(expected)) process.exit(1);
      const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      process.exit(actual === expected ? 0 : 1);
    } catch { process.exit(1); }
  ' "$artifact_path" "$artifact_sha256"; then
    fail_step "The local artifact path or SHA-256 verification failed before installation."
    exit 1
  fi
fi

if [ -z "${HOME:-}" ]; then
  HOME=$(node -e 'const home = require("node:os").homedir(); if (!require("node:path").isAbsolute(home)) process.exit(1); process.stdout.write(home);')
  export HOME
fi

if [ -n "$lifecycle_action" ]; then
  run_lifecycle
  exit 0
fi

systemd_host=no
if [ "$platform" = linux ] &&
   [ "$(ps -p 1 -o comm= 2>/dev/null | tr -d '[:space:]')" = systemd ] &&
   ! systemd-detect-virt --container --quiet >/dev/null 2>&1; then
  systemd_host=yes
fi
systemd_scope=--user
if [ "$systemd_host" = yes ] && [ "$(id -u)" = 0 ]; then
  systemd_scope=--system
fi
if [ "${OMNYO_INSTALL_SKIP_SERVICE:-0}" != 1 ] && [ "$platform" = linux ] &&
   [ "$systemd_scope" = --user ] && ! systemctl --user show-environment >/dev/null 2>&1; then
  user_runtime_dir=$(loginctl show-user "$(id -u)" --property=RuntimePath --value 2>/dev/null || true)
  case "$user_runtime_dir" in
    /*)
      XDG_RUNTIME_DIR=$user_runtime_dir
      export XDG_RUNTIME_DIR
      unset DBUS_SESSION_BUS_ADDRESS
      ;;
  esac
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    if [ "$systemd_host" = yes ]; then
      fail_step "The systemd user bus is unavailable; the Omnyo host-daemon service was not installed."
      detail "Run the installer from a systemd user session, then retry. To run without a persistent service, set OMNYO_INSTALL_SKIP_SERVICE=1; the daemon will not start after a reboot." >&2
      exit 1
    fi
    OMNYO_INSTALL_SKIP_SERVICE=1
  fi
fi

if [ "$adopt" = yes ]; then
  if ! adopted_identity=$(node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const dataDir = path.resolve(process.argv[1]);
    const fail = (message) => {
      process.stdout.write(message);
      process.exit(1);
    };
    const readJson = (name, missing) => {
      const file = path.join(dataDir, name);
      let text;
      try { text = fs.readFileSync(file, "utf8"); }
      catch { fail(missing); }
      try { return JSON.parse(text); }
      catch { fail(`${file} is not valid JSON.`); }
    };
    const auth = readJson("auth.json", `${dataDir} has no machine credentials to adopt (auth.json is missing).`);
    const config = readJson("config.json", `${dataDir} has no server address to adopt (config.json is missing).`);
    const configFile = path.join(dataDir, "config.json");
    if (typeof auth?.hostId !== "string" || auth.hostId.length === 0) fail(`${path.join(dataDir, "auth.json")} has no machine ID.`);
    let url;
    try { url = new URL(config?.serverUrl); }
    catch { fail(`${configFile} has no server address.`); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(`${configFile} has an unusable server address.`);
    const headers = config.serverHeaders ?? (typeof config.machineCredential === "string" ? { "x-omnyo-connect-machine": config.machineCredential } : {});
    if (typeof headers !== "object" || headers === null || Array.isArray(headers) || !Object.values(headers).every((value) => typeof value === "string")) fail(`${configFile} has invalid server headers.`);
    process.stdout.write(JSON.stringify({ dataDir, hostId: auth.hostId, serverUrl: url.href.replace(/\/$/u, ""), headers }));
  ' "$requested_data_dir"); then
    fail_step "$adopted_identity"
    exit 1
  fi
  host_id=$(OMNYO_ADOPTED_IDENTITY="$adopted_identity" node -e 'process.stdout.write(JSON.parse(process.env.OMNYO_ADOPTED_IDENTITY).hostId)')
  server_url=$(OMNYO_ADOPTED_IDENTITY="$adopted_identity" node -e 'process.stdout.write(JSON.parse(process.env.OMNYO_ADOPTED_IDENTITY).serverUrl)')
  adopted_data_dir=$(OMNYO_ADOPTED_IDENTITY="$adopted_identity" node -e 'process.stdout.write(JSON.parse(process.env.OMNYO_ADOPTED_IDENTITY).dataDir)')
  active_step "Setting up this machine as $host_id for $server_url"
fi

require_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    fail_step "omnyo-app installation requires npm."
    exit 1
  fi
}

server_host=$(node -e '
  const url = new URL(process.argv[1]);
  process.stdout.write(url.host.replace(/[^a-zA-Z0-9.-]/gu, "-"));
' "$server_url" 2>/dev/null) || {
  fail_step "Could not parse the server URL $server_url."
  exit 1
}
host_slug=$(printf '%s' "$host_id" | tr -c 'a-zA-Z0-9_.-' '-')
service_slug=$(printf '%s-%s' "$server_host" "$host_slug" | tr '.' '-')

if [ "$adopt" = yes ]; then
  data_dir=$adopted_data_dir
else
  data_dir=${OMNYO_DATA_DIR:-${recorded_data_dir:-"$HOME/.omnyo-machines/$server_host"}}
  installed_host_id=$(node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const read = (name) => {
      try { return fs.readFileSync(path.join(process.argv[1], name), "utf8"); }
      catch { return ""; }
    };
    let hostId = read("host-id").trim();
    if (!hostId) {
      try { hostId = JSON.parse(read("auth.json")).hostId; }
      catch {}
    }
    process.stdout.write(typeof hostId === "string" ? hostId : "");
  ' "$data_dir")
  if [ -n "$installed_host_id" ] && [ "$installed_host_id" != "$host_id" ]; then
    fail_step "$data_dir on this computer belongs to machine $installed_host_id, not $host_id."
    if [ "$reconnect" = yes ]; then
      detail "Run this command on the computer where machine $host_id runs." >&2
    else
      detail "To add another machine on this computer, rerun the command with OMNYO_DATA_DIR set to a new directory." >&2
    fi
    exit 1
  fi
  if [ "$reconnect" = yes ] && [ "$installed_host_id" != "$host_id" ]; then
    fail_step "Machine $host_id is not installed in $data_dir on this computer."
    detail "Run this command on the computer where machine $host_id runs." >&2
    exit 1
  fi
fi
data_dir=$(node -e '
  const fs = require("node:fs"), path = require("node:path");
  const requested = path.resolve(process.argv[1]);
  if (/[\x00-\x1f\x7f]/u.test(requested)) throw new Error("The installation profile contains control characters");
  let existing = requested;
  const missing = [];
  while (!fs.existsSync(existing)) {
    missing.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error("The installation parent cannot be resolved");
    existing = parent;
  }
  if (existing === requested && fs.lstatSync(existing).isSymbolicLink()) throw new Error("Refusing a symlinked installation profile");
  process.stdout.write(path.join(fs.realpathSync(existing), ...missing));
' "$data_dir") || { fail_step "The installation profile cannot be resolved before writes."; exit 1; }

assert_installer_state() {
if ! node --input-type=module -e '
  const fs = await import("node:fs");
  const path = await import("node:path");
  const net = await import("node:net");
  const [requested, home] = process.argv.slice(1);
  const dataDir = path.resolve(requested);
  function assertLegacyInstallerStateV1() {
    const legacyRoots = [".bb", ".bb-dev", ".bb-machines"];
    if (dataDir.split(path.sep).some((part) => legacyRoots.includes(part))) throw new Error("An old worker profile cannot be reused. Remove it with --uninstall, then enroll this machine again");
    const oldDefault = path.join(home, ".bb-machines", path.basename(dataDir));
    if (process.env.OMNYO_DATA_DIR === undefined && fs.existsSync(oldDefault)) throw new Error("An old worker profile still exists. Remove it with --uninstall, then enroll this machine again");
    for (const name of ["bb.db", "bb.db-wal", "bb.db-shm"]) if (fs.existsSync(path.join(dataDir, name))) throw new Error("The existing database is from an old worker. Remove it with --uninstall, then enroll this machine again");
  }
  function assertLegacyInstallerEnvironmentV1() {
    const oldDataDir = process.env.BB_DATA_DIR;
    if (oldDataDir !== undefined && oldDataDir !== process.env.OMNYO_DATA_DIR) throw new Error("BB_DATA_DIR names an old worker profile. Unset it, remove that profile with --uninstall, then enroll this machine again");
  }
  assertLegacyInstallerEnvironmentV1();
  assertLegacyInstallerStateV1();
  let cursor = path.parse(dataDir).root;
  for (const part of dataDir.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, part);
    const info = fs.lstatSync(cursor, { throwIfNoEntry: false });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new Error("The installation profile path is not an owned directory");
  }
  const read = (name) => {
    try { return fs.readFileSync(path.join(dataDir, name), "utf8"); }
    catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  };
  const config = read("config.json");
  if (config !== undefined && Object.hasOwn(JSON.parse(config), "stateMigration")) throw new Error("This profile came from a state migration and cannot be reused. Remove it with --uninstall, then enroll this machine again");
  for (const name of ["server-maintenance-hold.json", "machine-suspended", "daemon.lock", "daemon.lock.lock"]) if (fs.existsSync(path.join(dataDir, name))) throw new Error("An existing profile owner or maintenance hold blocks installation");
  const recordedPid = read("install-daemon.pid");
  if (recordedPid !== undefined) {
    const pid = Number(recordedPid.trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("The existing daemon owner is uncertain");
    try { process.kill(pid, 0); throw new Error("An existing daemon requires its maintenance owner before installation"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const xml = dataDir.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'"'"'", "&apos;");
  const systemd = dataDir.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("%", "%%");
  function importLegacyServiceDataDirsV1(text) {
    return [...text.matchAll(/<key>BB_DATA_DIR<\/key>\s*<string>([^<]*)<\/string>|Environment="BB_DATA_DIR=((?:\\.|[^"])*)"/gu)].map((match) => match[1] ?? match[2]);
  }
  function isLegacyServiceOwnerV1(name) {
    return name.startsWith("app.getbb.host-daemon.") || name.startsWith("bb-host-daemon-");
  }
  const matchesProfile = (text) => {
    if ([dataDir, xml, systemd].some((value) => text.includes(value))) return true;
    const current = [...text.matchAll(/<key>OMNYO_DATA_DIR<\/key>\s*<string>([^<]*)<\/string>|Environment="OMNYO_DATA_DIR=((?:\\.|[^"])*)"/gu)].map((match) => match[1] ?? match[2]);
    return [...current, ...importLegacyServiceDataDirsV1(text)].some((value) => {
      const decoded = value.replaceAll("&quot;", "\"").replaceAll("&apos;", "'"'"'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&").replaceAll("%%", "%").replaceAll("\\\"", "\"").replaceAll("\\\\", "\\");
      try { return path.isAbsolute(decoded) && fs.realpathSync(decoded) === dataDir; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    });
  };
  for (const directory of [path.join(home, "Library", "LaunchAgents"), path.join(home, ".config", "systemd", "user"), path.join(dataDir, "systemd")]) {
    const info = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!info) continue;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The existing service owner directory is uncertain");
    for (const name of fs.readdirSync(directory)) {
      if (!/\.(?:plist|service)$/u.test(name)) continue;
      const file = path.join(directory, name);
      const knownOwner = name.startsWith("app.omnyo.host-daemon.") || name.startsWith("omnyo-host-daemon-") || isLegacyServiceOwnerV1(name);
      let info;
      try { info = fs.statSync(file); }
      catch (error) { if (error.code === "ENOENT" && !knownOwner) continue; throw error; }
      if (!info.isFile() || info.size > 1048576) {
        if (knownOwner) throw new Error("The existing service owner is uncertain");
        continue;
      }
      const text = fs.readFileSync(file, "utf8");
      if (matchesProfile(text)) throw new Error("The machine service already has an owner. Remove it with --uninstall, then enroll this machine again");
    }
  }
  const recordedPort = read("host-daemon-port");
  if (recordedPort !== undefined) {
    const port = Number(recordedPort.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The existing daemon port owner is uncertain");
    const busy = await new Promise((resolve, reject) => {
      const socket = net.createConnection({host:"127.0.0.1",port});
      socket.setTimeout(750);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); reject(new Error("The existing daemon port owner is uncertain")); });
      socket.once("error", (error) => { socket.destroy(); if (error.code === "ECONNREFUSED") resolve(false); else reject(error); });
    });
    if (busy) throw new Error("An existing daemon requires its maintenance owner before installation");
  }
' "$data_dir" "$HOME"; then
  fail_step "Installation refused before profile writes; use the existing maintenance owner."
  exit 1
fi
}
assert_installer_state

machine_npm_prefix="$data_dir/npm"
app_runtime_native_modules="better-sqlite3,node-pty,@parcel/watcher"
app_runtime_allow_scripts="--allow-scripts=$app_runtime_native_modules"

valid_port() {
  node -e '
    const rawPort = process.argv[1];
    const port = Number(rawPort);
    process.exit(String(port) === rawPort && Number.isInteger(port) && port >= 1 && port <= 65535 ? 0 : 1);
  ' "$1"
}

port_is_available() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen({ host: "127.0.0.1", port: Number(process.argv[1]), exclusive: true }, () => {
      server.close((error) => process.exit(error ? 1 : 0));
    });
  ' "$1" >/dev/null 2>&1
}

daemon_status_matches() {
  node -e '
    const [port, expectedHostId, expectedServerUrl, requireConnected] = process.argv.slice(1);
    const normalize = (value) => {
      const url = new URL(String(value));
      if (url.hostname === "localhost") url.hostname = "127.0.0.1";
      return url.href.replace(/\/$/u, "");
    };
    void (async () => {
      const response = await fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(750),
      });
      if (!response.ok) process.exit(1);
      const status = await response.json();
      const matches =
        status &&
        typeof status === "object" &&
        status.hostId === expectedHostId &&
        normalize(status.serverUrl) === normalize(expectedServerUrl) &&
        (requireConnected !== "yes" || status.connected === true);
      process.exit(matches ? 0 : 1);
    })().catch(() => process.exit(1));
  ' "$1" "$host_id" "$server_url" "$2" >/dev/null 2>&1
}

wait_for_daemon_connection() {
  wait_subject=$1
  active_step "Waiting for $wait_subject to connect (up to about 2 minutes)"
  attempts=0
  while [ "$attempts" -lt "$DAEMON_WAIT_ATTEMPTS" ]; do
    if daemon_status_matches "$host_daemon_port" yes; then
      return 0
    fi
    attempts=$((attempts + 1))
    report_wait_progress "$attempts" "$wait_subject"
    sleep 1
  done
  return 1
}

report_wait_progress() {
  progress_attempt=$1
  progress_subject=$2
  if [ $((progress_attempt % WAIT_PROGRESS_EVERY_ATTEMPTS)) -eq 0 ]; then
    active_step "Still waiting for $progress_subject ($progress_attempt/$DAEMON_WAIT_ATTEMPTS checks)"
  fi
}

find_available_host_daemon_port() {
  candidate_port=38888
  while [ "$candidate_port" -le 65535 ]; do
    if port_is_available "$candidate_port"; then
      printf '%s\n' "$candidate_port"
      return 0
    fi
    candidate_port=$((candidate_port + 1))
  done
  fail_step "Could not find an available host-daemon port."
  return 1
}

host_daemon_port_file="$data_dir/host-daemon-port"
host_daemon_port=
if [ -n "$requested_host_daemon_port" ]; then
  if ! valid_port "$requested_host_daemon_port"; then
    fail_step "--host-daemon-port must be an integer between 1 and 65535."
    exit 2
  fi
  if ! port_is_available "$requested_host_daemon_port" && \
     ! daemon_status_matches "$requested_host_daemon_port" no; then
    fail_step "Host daemon local API port $requested_host_daemon_port is already in use."
    detail "Choose another value for --host-daemon-port and rerun this command." >&2
    exit 1
  fi
  host_daemon_port=$requested_host_daemon_port
elif [ -f "$host_daemon_port_file" ]; then
  stored_host_daemon_port=$(sed -n '1p' "$host_daemon_port_file")
  if valid_port "$stored_host_daemon_port" && \
     { port_is_available "$stored_host_daemon_port" || daemon_status_matches "$stored_host_daemon_port" no; }; then
    host_daemon_port=$stored_host_daemon_port
  else
    warning_step "Stored host-daemon port $stored_host_daemon_port is unavailable; assigning a new port."
  fi
fi

if [ -z "$host_daemon_port" ]; then
  host_daemon_port=$(find_available_host_daemon_port)
fi
complete_step "Using local host-daemon port $host_daemon_port"

package_url="${server_url%/}/install/omnyo-app.tgz"
package_dir=$(mktemp -d "${TMPDIR:-/tmp}/omnyo-app.XXXXXX")
trap 'rm -rf "$package_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
package_file="$package_dir/omnyo-app.tgz"
access_config="$package_dir/access.curl"
: > "$access_config"
chmod 600 "$access_config"
if [ -n "$bootstrap_env" ]; then
  OMNYO_ENROLLMENT="$bootstrap_payload" node -e 'for (const [name,value] of Object.entries(JSON.parse(process.env.OMNYO_ENROLLMENT).headers ?? {})) console.log("header = " + JSON.stringify(name + ": " + value))' > "$access_config"
elif [ "$adopt" = yes ]; then
  OMNYO_ADOPTED_IDENTITY="$adopted_identity" node -e 'for (const [name,value] of Object.entries(JSON.parse(process.env.OMNYO_ADOPTED_IDENTITY).headers)) console.log("header = " + JSON.stringify(name + ": " + value))' > "$access_config"
fi
package_headers="$package_dir/headers"
host_artifact_digest_file="$data_dir/host-artifact.sha256"
# curl's numeric meter shows bytes, rate, percentage, and ETA without the
# animated ASCII bar. Keep redirected installs quiet while preserving errors.
curl_output_mode=--progress-meter
if [ ! -t 2 ]; then
  curl_output_mode=--silent
fi
if [ -n "$artifact_path" ]; then
  if ! node -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const [source, target, expected] = process.argv.slice(1);
    try {
      const info = fs.lstatSync(source);
      if (!info.isFile() || info.isSymbolicLink()) process.exit(1);
      const bytes = fs.readFileSync(source);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== expected) process.exit(1);
      fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    } catch { process.exit(1); }
  ' "$artifact_path" "$package_file" "$artifact_sha256"; then
    rm -rf "$package_dir"
    fail_step "The local artifact changed before installation."
    exit 1
  fi
  printf 'x-omnyo-artifact-sha256: %s\n' "$artifact_sha256" >"$package_headers"
  package_status=200
  complete_step "Using the verified local omnyo-app package"
else
  active_step "Downloading the server's omnyo-app package (timeout: 5 minutes)"
  package_status=$(curl --config "$access_config" "$curl_output_mode" --show-error \
    --max-redirs 0 \
    --connect-timeout "$CURL_CONNECT_TIMEOUT_SECONDS" \
    --max-time "$PACKAGE_DOWNLOAD_TIMEOUT_SECONDS" \
    --retry "$PACKAGE_DOWNLOAD_RETRIES" \
    --dump-header "$package_headers" \
    --output "$package_file" \
    --write-out '%{http_code}' \
    "$package_url") || package_status=000
fi

package_digest=$(node -e '
  const fs = require("node:fs");
  try {
    const headers = fs.readFileSync(process.argv[1], "utf8");
    const matches = [...headers.matchAll(/^x-omnyo-artifact-sha256:\s*([a-f0-9]{64})\s*$/gimu)];
    const digest = matches.at(-1)?.[1];
    if (digest) process.stdout.write(digest);
  } catch {}
' "$package_headers")

if [ "$package_status" -ge 400 ] && [ "$package_status" -le 599 ]; then
  package_error=$(node -e '
    const fs = require("node:fs");
    try {
      if (fs.statSync(process.argv[1]).size > 16384) process.exit(0);
      const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (body && typeof body.message === "string") {
        process.stdout.write(body.message.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 2000));
      }
    } catch {}
  ' "$package_file")
  if [ -n "$package_error" ]; then
    detail "Server: $package_error" >&2
  fi
fi

app_runtime=
app_runtime_npm_prefix=
if [ "$package_status" -ge 200 ] && [ "$package_status" -lt 300 ]; then
  if [ -z "$package_digest" ]; then
    fail_step "The private host artifact has no valid SHA-256 binding."
    exit 1
  fi
  if [ -n "$package_digest" ]; then
    downloaded_digest=$(node -e '
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"));
    ' "$package_file")
    if [ "$downloaded_digest" != "$package_digest" ]; then
      rm -rf "$package_dir"
      fail_step "The downloaded Omnyo host artifact failed SHA-256 verification."
      detail "Expected $package_digest but received $downloaded_digest." >&2
      exit 1
    fi
  fi
  admission_dir="$package_dir/admission"
  mkdir -p "$admission_dir"
  if ! tar -xzf "$package_file" -C "$admission_dir" package/dist/state-admission.mjs package/package.json; then
    fail_step "The verified runtime does not contain installer state admission."
    exit 1
  fi
  if [ -L "$admission_dir/package/dist/state-admission.mjs" ] || [ ! -f "$admission_dir/package/dist/state-admission.mjs" ]; then
    fail_step "The installer state admission entry is not a regular file."
    exit 1
  fi
  if ! node --input-type=module -e '
    const { pathToFileURL } = await import("node:url");
    const { lstatSync, readFileSync } = await import("node:fs");
    const packageInfo = lstatSync(process.argv[3]);
    if (!packageInfo.isFile() || packageInfo.isSymbolicLink() || packageInfo.nlink !== 1 || packageInfo.size > 65536) throw new Error("The runtime package manifest is not a regular bounded file");
    const metadata = JSON.parse(readFileSync(process.argv[3], "utf8"));
    if (metadata.name !== "omnyo-app" || typeof metadata.version !== "string" || !metadata.version) throw new Error("The runtime artifact does not identify the selected Omnyo package");
    const info = lstatSync(process.argv[1]);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Installer state admission requires a regular private file");
    const { assertInstallationState } = await import(pathToFileURL(process.argv[1]));
    assertInstallationState(process.argv[2]);
  ' "$admission_dir/package/dist/state-admission.mjs" "$data_dir" "$admission_dir/package/package.json"; then
    fail_step "Installation state admission refused before profile writes."
    exit 1
  fi
  assert_installer_state
(umask 077; mkdir -p "$data_dir/logs")
canonical_data_dir=$(node -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$data_dir")
machine_npm_prefix="$canonical_data_dir/npm"
app_runtime_native_modules="better-sqlite3,node-pty,@parcel/watcher"
app_runtime_allow_scripts="--allow-scripts=$app_runtime_native_modules"
host_daemon_port_temp="$host_daemon_port_file.$$.tmp"
(umask 077 && printf '%s\n' "$host_daemon_port" >"$host_daemon_port_temp")
mv "$host_daemon_port_temp" "$host_daemon_port_file"
  require_npm
  complete_step "Downloaded the server's omnyo-app package"
  active_step "Installing the server's omnyo-app build"
  rm -f "$host_artifact_digest_file"
  if ! npm install -g "$app_runtime_allow_scripts" --prefix "$machine_npm_prefix" "$package_file"; then
    rm -rf "$package_dir"
    fail_step "Could not install omnyo-app for this machine. Check the npm error above, then rerun this command."
    exit 1
  fi
  app_runtime_npm_prefix=$machine_npm_prefix
  complete_step "Installed the server's omnyo-app build"

else
  rm -rf "$package_dir"
  fail_step "Could not download the server's omnyo-app package from $package_url (HTTP $package_status)."
  exit 1
fi
rm -rf "$package_dir"

if [ -n "$app_runtime_npm_prefix" ]; then
  app_runtime="$app_runtime_npm_prefix/bin/omnyo-app"
  if [ ! -x "$app_runtime" ]; then
    fail_step "npm installed omnyo-app, but did not create the expected executable at $app_runtime."
    exit 1
  fi
  # Fail loudly if npm skipped the native add-on install scripts (npm >= 12
  # allowScripts policy, or ignore-scripts=true in an npmrc). Without this
  # check the join only fails later, in the daemon, with a raw stack trace.
  app_runtime_root="$app_runtime_npm_prefix/lib/node_modules/omnyo-app"
  if ! node -e '
    const root = process.argv[1];
    require(root + "/node_modules/node-pty");
    require(root + "/node_modules/@parcel/watcher");
  ' "$app_runtime_root" >/dev/null 2>&1; then
    fail_step "npm installed omnyo-app, but its host native add-ons (node-pty, @parcel/watcher) did not load."
    detail "npm did not run their install scripts. Check the npm warnings above. If they mention allowScripts or ignore-scripts, rerun this command with: npm_config_allow_scripts=$app_runtime_native_modules npm_config_ignore_scripts=false" >&2
    exit 1
  fi
  if [ "$package_status" -ge 200 ] && [ "$package_status" -lt 300 ] && [ -n "$package_digest" ]; then
    host_artifact_digest_temp="$host_artifact_digest_file.$$.tmp"
    (umask 077 && printf '%s\n' "$package_digest" >"$host_artifact_digest_temp")
    mv "$host_artifact_digest_temp" "$host_artifact_digest_file"
  fi
fi

cli="${app_runtime%/*}/omnyo"
if [ ! -x "$cli" ]; then
  fail_step "The installed build does not provide the machine enrollment CLI."
  exit 1
fi
mkdir -p "$HOME/.local/bin"
if [ ! -e "$HOME/.local/bin/omnyo" ] && [ ! -L "$HOME/.local/bin/omnyo" ]; then
  shim_file=$(mktemp "$HOME/.local/bin/.omnyo-machine.XXXXXX")
  node -e '
    const fs = require("node:fs");
    const [file, nodeDir, cli, dataDir] = process.argv.slice(1);
    const apostrophe = String.fromCharCode(39);
    const quote = (value) => apostrophe + value.replaceAll(apostrophe, apostrophe + "\\" + apostrophe + apostrophe) + apostrophe;
    const code = "#!/bin/sh\nPATH=" + quote(nodeDir) + ":\"$PATH\"\nexport PATH\n" +
      "if [ -n \"${OMNYO_DATA_DIR:-}\" ]; then\n" +
      "  if [ ! -x \"$OMNYO_DATA_DIR/npm/bin/omnyo\" ]; then\n" +
      "    printf \"The selected profile has no verified Omnyo CLI.\\n\" >&2\n    exit 1\n  fi\n" +
      "  exec \"$OMNYO_DATA_DIR/npm/bin/omnyo\" \"$@\"\nfi\n" +
      "OMNYO_DATA_DIR=" + quote(dataDir) + "\nexport OMNYO_DATA_DIR\nexec " + quote(cli) + " \"$@\"\n";
    fs.writeFileSync(file, code);
    fs.chmodSync(file, 0o755);
  ' "$shim_file" "${node_bin%/*}" "$cli" "$data_dir"
  if ! ln "$shim_file" "$HOME/.local/bin/omnyo" 2>/dev/null; then
    rm -f "$shim_file"
    fail_step "The machine CLI binding changed during installation."
    exit 1
  fi
  rm -f "$shim_file"
fi

if [ "$adopt" = no ]; then
  OMNYO_ENROLLMENT="$bootstrap_payload" OMNYO_DATA_DIR="$data_dir" "$cli" machine enroll --bootstrap-env OMNYO_ENROLLMENT
  bootstrap_payload=
fi

auth_matches_host() {
  node -e '
    const fs = require("node:fs");
    const [dataDir, expectedHost] = process.argv.slice(1);
    const auth = JSON.parse(fs.readFileSync(`${dataDir}/auth.json`, "utf8"));
    process.exit(auth.hostId === expectedHost ? 0 : 1);
  ' "$data_dir" "$host_id" 2>/dev/null
}

already_joined=no
if [ -f "$data_dir/auth.json" ]; then
  if ! auth_matches_host; then
    fail_step "$data_dir already holds credentials for a different host, not $host_id."
    detail "If this machine was removed from the server, delete $data_dir and rerun this command." >&2
    exit 1
  fi
  if [ -f "$data_dir/config.json" ] && node -e '
    const fs = require("node:fs");
    const [dataDir, expectedServer] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(`${dataDir}/config.json`, "utf8"));
    const normalize = (value) => {
      const url = new URL(String(value));
      if (url.hostname === "localhost") url.hostname = "127.0.0.1";
      return url.href.replace(/\/+$/, "");
    };
    process.exit(normalize(config.serverUrl) === normalize(expectedServer) ? 0 : 1);
  ' "$data_dir" "$server_url" 2>/dev/null; then
    already_joined=yes
    complete_step "This machine is already joined to $server_url as $host_id"
  fi
fi

if [ "$already_joined" != yes ]; then
  fail_step "The verified enrollment CLI did not establish this machine identity."
  exit 1
fi

if [ "${OMNYO_INSTALL_SKIP_SERVICE:-0}" = 1 ]; then
  if daemon_status_matches "$host_daemon_port" no; then
    fail_step "An existing daemon requires its maintenance owner before installation."
    exit 1
  fi
  daemon_log="$data_dir/install-daemon.log"
  active_step "Starting the host daemon"
  detail "Host daemon output is logged to $daemon_log"
  OMNYO_APP_NPM_PREFIX="$app_runtime_npm_prefix" OMNYO_DATA_DIR="$data_dir" nohup "$app_runtime" host-daemon \
    --auto-update \
    --supervise \
    --host-daemon-port "$host_daemon_port" \
    --server-url "$server_url" >"$daemon_log" 2>&1 &
  daemon_pid=$!
  echo "$daemon_pid" >"$data_dir/install-daemon.pid"
  if ! wait_for_daemon_connection "the host daemon"; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
    fail_step "The Omnyo host daemon did not connect to $server_url."
    detail "See $daemon_log" >&2
    exit 1
  fi
  complete_step "Host daemon connected"
  warning_step "Service installation skipped; supervised daemon PID $daemon_pid will not start after a reboot."
  exit 0
fi
rm -f "$data_dir/install-daemon.pid"

active_step "Installing the persistent Omnyo host daemon service"

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\\\&apos;/g"
}

systemd_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/%/%%/g'
}

if [ "$platform" = darwin ]; then
  service_dir="$HOME/Library/LaunchAgents"
  service_label="app.omnyo.host-daemon.$service_slug"
  service_file="$service_dir/$service_label.plist"
  mkdir -p "$service_dir"
  escaped_node_bin=$(xml_escape "$node_bin")
  escaped_app_runtime=$(xml_escape "$app_runtime")
  escaped_app_runtime_npm_prefix=$(xml_escape "$app_runtime_npm_prefix")
  escaped_server=$(xml_escape "$server_url")
  escaped_data_dir=$(xml_escape "$data_dir")
  if [ -e "$service_file" ] || [ -L "$service_file" ]; then
    fail_step "The machine service already has an owner. Remove it with --uninstall, then enroll this machine again."
    exit 1
  fi
  (set -C; cat >"$service_file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$service_label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$escaped_node_bin</string>
    <string>$escaped_app_runtime</string>
    <string>host-daemon</string>
    <string>--auto-update</string>
    <string>--host-daemon-port</string>
    <string>$host_daemon_port</string>
    <string>--server-url</string>
    <string>$escaped_server</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OMNYO_APP_NPM_PREFIX</key><string>$escaped_app_runtime_npm_prefix</string>
    <key>OMNYO_DATA_DIR</key><string>$escaped_data_dir</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$escaped_data_dir/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$escaped_data_dir/logs/launchd.log</string>
</dict>
</plist>
EOF
  )
  if ! launchctl_error=$(launchctl bootstrap "gui/$(id -u)" "$service_file" 2>&1); then
    fail_step "Could not register the Omnyo host-daemon launch agent $service_label."
    [ -z "$launchctl_error" ] || detail "launchctl: $launchctl_error" >&2
    exit 1
  fi
  if ! wait_for_daemon_connection "the launch agent"; then
    fail_step "The Omnyo host-daemon launch agent started but did not connect to $server_url."
    if [ -d "$data_dir/daemon.lock.lock" ]; then
      detail "Another daemon may be using $data_dir. Check for another Omnyo launch agent using this data directory." >&2
    fi
    detail "See $data_dir/logs/host-daemon-stdio.log for the startup error and $data_dir/logs/launchd.log for launch agent output." >&2
    exit 1
  fi
  complete_step "Installed and started the launch agent"
  printf '\n'
  log "$(green "●")" "$(bold "Omnyo machine is ready")"
  printf '\n'
  ready_row "server" "$(cyan "$server_url")"
  ready_row "daemon" "http://127.0.0.1:$host_daemon_port"
  ready_row "data" "$data_dir"
  ready_row "service" "$service_file"
  printf '\n'
  detail "Uninstall: launchctl bootout gui/$(id -u) '$service_file' && rm '$service_file'"
else
  service_dir="$HOME/.config/systemd/user"
  service_target=default.target
  if [ "$systemd_scope" = --system ]; then
    service_dir="$canonical_data_dir/systemd"
    service_target=multi-user.target
    owned_launcher="$canonical_data_dir/npm/bin/omnyo-app"
    if [ "$app_runtime" != "$owned_launcher" ]; then
      fail_step "The verified runtime is outside this installation owner."
      exit 1
    fi
  fi
  service_name="omnyo-host-daemon-$service_slug"
  service_file="$service_dir/$service_name.service"
  mkdir -p "$service_dir"
  escaped_node_bin=$(systemd_escape "$node_bin")
  escaped_app_runtime=$(systemd_escape "$app_runtime")
  escaped_app_runtime_npm_prefix=$(systemd_escape "$app_runtime_npm_prefix")
  escaped_server=$(systemd_escape "$server_url")
  escaped_data_dir=$(systemd_escape "$data_dir")
  if [ -e "$service_file" ] || [ -L "$service_file" ]; then
    fail_step "The machine service already has an owner. Remove it with --uninstall, then enroll this machine again."
    exit 1
  fi
  (set -C; cat >"$service_file" <<EOF
[Unit]
Description=Omnyo host daemon for $server_host
After=network-online.target
Wants=network-online.target

[Service]
ExecStart="$escaped_node_bin" "$escaped_app_runtime" host-daemon --auto-update --host-daemon-port "$host_daemon_port" --server-url "$escaped_server"
Environment="OMNYO_APP_NPM_PREFIX=$escaped_app_runtime_npm_prefix"
Environment="OMNYO_DATA_DIR=$escaped_data_dir"
Restart=always
RestartSec=2

[Install]
WantedBy=$service_target
EOF
  )
  systemctl "$systemd_scope" daemon-reload
  enable_unit="$service_name.service"
  if [ "$systemd_scope" = --system ]; then enable_unit="$service_file"; fi
  if ! systemctl_error=$(systemctl "$systemd_scope" enable "$enable_unit" 2>&1); then
    fail_step "The Omnyo host-daemon systemd service could not be enabled."
    [ -z "$systemctl_error" ] || detail "systemctl: $systemctl_error" >&2
    detail "Inspect it with: journalctl $systemd_scope -u $service_name.service" >&2
    exit 1
  fi
  if ! systemctl_error=$(systemctl "$systemd_scope" start "$service_name.service" 2>&1); then
    fail_step "The Omnyo host-daemon systemd service was enabled, but it could not be restarted."
    [ -z "$systemctl_error" ] || detail "systemctl: $systemctl_error" >&2
    detail "Inspect it with: journalctl $systemd_scope -u $service_name.service" >&2
    exit 1
  fi
  if ! wait_for_daemon_connection "the systemd service"; then
    fail_step "The Omnyo host-daemon systemd service started but did not connect to $server_url."
    detail "Inspect it with: journalctl $systemd_scope -u $service_name.service" >&2
    exit 1
  fi
  complete_step "Installed and started the systemd service ($systemd_scope)"
  printf '\n'
  log "$(green "●")" "$(bold "Omnyo machine is ready")"
  printf '\n'
  ready_row "server" "$(cyan "$server_url")"
  ready_row "daemon" "http://127.0.0.1:$host_daemon_port"
  ready_row "data" "$data_dir"
  ready_row "service" "$service_file"
  printf '\n'
  if [ "$systemd_scope" = --system ]; then
    detail "Starts automatically when this machine boots."
  else
    detail "Starts with your systemd user session."
  fi
  detail "Uninstall: systemctl $systemd_scope disable --now $service_name.service && rm '$service_file' && systemctl $systemd_scope daemon-reload"
fi
