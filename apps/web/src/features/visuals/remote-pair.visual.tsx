import "./remote-pair.css";

export const label =
  "Pairing a phone with Omnyo connect: Settings → Mobile on the computer shows a QR code and the one-time pairing code K7QP-3M9X, counting down from 10 minutes. On the iPhone, the code is typed in, Pair is pressed and the phone shows Paired with Omnyo connect, with the server saved.";

const SIZE = 21;

const finder = (x: number, y: number) => {
  for (const [ox, oy] of [
    [0, 0],
    [SIZE - 7, 0],
    [0, SIZE - 7],
  ] as const) {
    const dx = x - ox;
    const dy = y - oy;

    if (dx >= 0 && dx < 7 && dy >= 0 && dy < 7) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));

      return ring !== 2;
    }

    if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) return false;
  }

  return null;
};

const QR_PATH = (() => {
  let seed = 7;
  let path = "";

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const fixed = finder(x, y);
      const dark = fixed ?? seed % 7 < 3;

      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }
  }

  return path;
})();

const SECONDS = [
  "9:59",
  "9:58",
  "9:57",
  "9:56",
  "9:55",
  "9:54",
  "9:53",
  "9:52",
  "9:51",
];

export function Visual() {
  return (
    <div className="fv fv-remote-pair" aria-hidden="true">
      <section className="fv-remote-pair-settings">
        <h3>Mobile</h3>
        <div className="fv-remote-pair-card">
          <p className="fv-remote-pair-title">
            <b>Pair your phone</b>
            <span>Done</span>
          </p>
          <div className="fv-remote-pair-body">
            <svg viewBox="-1 -1 23 23" className="fv-remote-pair-qr">
              <path d={QR_PATH} />
            </svg>
            <div>
              <p className="fv-remote-pair-hint">
                Scan this with the Omnyo mobile app, or enter the code by hand.
              </p>
              <p className="fv-remote-pair-code">K7QP-3M9X</p>
              <p className="fv-remote-pair-timer">
                Code expires in{" "}
                <span className="fv-remote-pair-clock">
                  <span>
                    {SECONDS.map((value) => (
                      <span key={value}>{value}</span>
                    ))}
                  </span>
                </span>
              </p>
              <p className="fv-remote-pair-small">This code works once.</p>
            </div>
          </div>
        </div>
      </section>
      <div className="fv-remote-pair-phone">
        <div className="fv-remote-pair-screen">
          <div className="fv-remote-pair-form">
            <b>Pair with Omnyo connect</b>
            <p>Scan or type a pairing code from Omnyo Settings → Mobile.</p>
            <span className="fv-remote-pair-field">
              <span>K7QP-3M9X</span>
              <i />
            </span>
            <span className="fv-remote-pair-button">
              <span className="is-idle">Pair</span>
              <span className="is-busy">Pairing…</span>
            </span>
          </div>
          <div className="fv-remote-pair-done">
            <svg viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6.2" />
              <path d="m5.4 8.2 1.8 1.8 3.5-3.7" />
            </svg>
            <b>Paired with Omnyo connect</b>
            <p className="fv-remote-pair-server">
              <span>studio-mac</span>
              <small>kai.omnyo.link</small>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
