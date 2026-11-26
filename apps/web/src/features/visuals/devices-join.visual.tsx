export const label =
  "The Add a machine dialog in Omnyo. It shows the setup code 7K2M-QW9D and a one-line install command, curl for macOS or Linux and a PowerShell command for Windows. The status changes from Waiting for the machine to connect to linux-box connected, then win-3090 connected.";

const SERVER = "https://you.omnyo.link/m/7K2M-QW9D";

function Status({ name }: { name: string }) {
  return (
    <span>
      <i className="fv-dot fv-dot--ok" />
      {name} connected
      <span className="dj-open">Open machine →</span>
    </span>
  );
}

function Waiting() {
  return (
    <span className="dj-wait">
      <i className="dt-spin" />
      Waiting for the machine to connect…
    </span>
  );
}

export function Visual() {
  return (
    <div className="fv fv-dt fv-dj" aria-hidden="true">
      <div className="dj-dialog">
        <p className="dj-title">Add a machine</p>
        <p className="dj-desc">
          Run this command on the machine you want to add. It installs Omnyo and
          keeps the machine connected to this server.
        </p>
        <div className="dj-box">
          <p className="dj-tabs">
            <span className="dj-tab">
              <i className="is-on dt-a" />
              <span>macOS or Linux</span>
            </span>
            <span className="dj-tab">
              <i className="is-on dt-b" />
              <span>Windows</span>
            </span>
            <span className="dj-ps dt-b">Run in PowerShell</span>
          </p>
          <p className="dj-code">
            <small>Setup code</small>
            <b>7K2M-QW9D</b>
          </p>
          <p className="dj-cmd">
            <span className="dt-swap">
              <span className="dt-a">curl -fsSL {SERVER} | sh</span>
              <span className="dt-b">irm {SERVER}.ps1 | iex</span>
            </span>
          </p>
          <p className="dj-foot">
            Command expires in 9:41
            <u>Copy full command</u>
            <span className="dj-copy">Copy</span>
          </p>
        </div>
        <p className="dj-status">
          <span className="dj-on-1">
            <Waiting />
          </span>
          <span className="dj-on-2">
            <Status name="linux-box" />
          </span>
          <span className="dj-on-3">
            <Waiting />
          </span>
          <span className="dj-on-4">
            <Status name="win-3090" />
          </span>
        </p>
        <p className="dj-note">
          The new machine will connect to the Omnyo server on macbook. Keep that
          computer on so the new machine can keep working.
        </p>
      </div>
    </div>
  );
}
