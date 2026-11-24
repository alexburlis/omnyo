import "./devices.css";

import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { Mark } from "../open-5/page";

interface Chat {
  title: string;
  agent: string;
}

type MachineId = "book" | "mini" | "tower" | "box";

interface Machine {
  id: MachineId;
  name: string;
  spec: string;
  note: string;
  chat: Chat;
}

type Phase = "move" | "tap" | "out" | "over" | "run";

const ASK = {
  title: "Fine-tune eval run",
  agent: "Claude Code",
  question: "Run the full eval on the 3090?",
  reply: "Yes, run it",
} as const;

const MACHINES: readonly Machine[] = [
  {
    id: "book",
    name: "MacBook",
    spec: "Laptop",
    note: "Works fine. Keep it awake while you are out.",
    chat: { title: "Add CSV export", agent: "Claude Code" },
  },
  {
    id: "mini",
    name: "Mac mini",
    spec: "Desktop",
    note: "Small, quiet and always on.",
    chat: { title: "Date parser tests", agent: "Codex" },
  },
  {
    id: "tower",
    name: "Windows desktop",
    spec: "RTX 3090",
    note: "Hosts the server and runs the GPU jobs.",
    chat: ASK,
  },
  {
    id: "box",
    name: "Linux server",
    spec: "Always on",
    note: "A dedicated box or VM that never sleeps.",
    chat: { title: "Weekday issue triage", agent: "Codex" },
  },
];

const GPU = 2;

const machineAt = (index: number) => {
  const machine = MACHINES[index];

  if (!machine) throw new Error(`No machine at index ${index}`);

  return machine;
};

const PHONE = -1;

const PHONE_CHATS: readonly Chat[] = [
  { title: "Add CSV export", agent: "Claude Code" },
  { title: "Date parser tests", agent: "Codex" },
  { title: "Weekday issue triage", agent: "Codex" },
];

const MOVE_MS = 1100;

const TAP_MS = 800;

const RUN_MS = 2300;

const legMs = (from: number, to: number) => 280 + 190 * Math.abs(to - from);

const FIGURE_LABEL =
  "Diagram: an iPhone steers four computers that form one Omnyo setup, a MacBook, a Mac mini, a Windows desktop with an RTX 3090 and a Linux server. Each computer runs agents, and the Omnyo server role moves from one computer to the next to show that any of them can host it. Answering a question on the phone starts an eval run on the 3090.";

const ROLES = [
  {
    glyph: "server",
    title: "Any one can be the server",
    detail: "Mac, Windows or Linux",
  },
  {
    glyph: "agents",
    title: "Every one runs agents",
    detail: "Claude Code and Codex",
  },
  {
    glyph: "phone",
    title: "Your phone steers them all",
    detail: "iPhone app or any browser",
  },
] as const;

type GlyphKind = MachineId | "phone" | "agents" | "server";

const GLYPHS: Record<Exclude<GlyphKind, "server">, ReactNode> = {
  book: (
    <>
      <rect x="4.5" y="5.5" width="15" height="10.5" rx="1.4" />
      <path d="M2.5 18.5h19" />
    </>
  ),
  mini: (
    <>
      <path d="M6.2 9.5 7.4 7h9.2l1.2 2.5" />
      <rect x="3.5" y="9.5" width="17" height="7.5" rx="2" />
      <path d="M16.5 13.25h.01" />
    </>
  ),
  tower: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="1.6" />
      <circle cx="12" cy="9" r="2.2" />
      <path d="M9.5 15.5h5" />
    </>
  ),
  box: (
    <>
      <rect x="3.5" y="5.5" width="17" height="5.5" rx="1.2" />
      <rect x="3.5" y="13" width="17" height="5.5" rx="1.2" />
      <path d="M7 8.25h.01M7 15.75h.01" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="2.5" width="10" height="19" rx="2.4" />
      <path d="M11 18.5h2" />
    </>
  ),
  agents: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 10 2.5 2L7 14M12 14.5h5" />
    </>
  ),
};

const order = (index: number) => ({ "--dv-i": index }) as CSSProperties;

function Glyph({ kind }: { kind: GlyphKind }) {
  return (
    <span className={`dv-glyph dv-glyph--${kind}`} aria-hidden="true">
      {kind === "server" ? (
        <Mark />
      ) : (
        <svg viewBox="0 0 24 24">{GLYPHS[kind]}</svg>
      )}
    </span>
  );
}

function Named({
  kind,
  index,
  children,
}: {
  kind: GlyphKind;
  index: number;
  children: ReactNode;
}) {
  return (
    <span className="dv-named" style={order(index)}>
      <Glyph kind={kind} />
      {children}
    </span>
  );
}

function Swap({ scope }: { scope: "phone" | "tower" }) {
  return (
    <span className={`dv-swap dv-swap--${scope}`}>
      <em className="is-need">Needs you</em>
      <em className="is-run">Running</em>
    </span>
  );
}

function SwapDot({ scope }: { scope: "phone" | "tower" }) {
  return (
    <span className={`dv-swap dv-swap--${scope} dv-swap-dot`}>
      <i className="dv-dot dv-dot--need is-need" />
      <i className="dv-dot dv-dot--run is-run" />
    </span>
  );
}

function Phone({ server }: { server: string }) {
  return (
    <div className="dv-phone">
      <div className="dv-screen">
        <div className="dv-status">
          <span>9:41</span>
          <i className="dv-island" />
          <span className="dv-bars">
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="dv-app-head">
          <b>Chats</b>
          <i className="dv-new">+</i>
        </div>
        <div className="dv-ask">
          <i className="dv-ask-ring dv-swap--phone is-need" />
          <div className="dv-ask-top">
            <SwapDot scope="phone" />
            <b>{ASK.title}</b>
          </div>
          <div className="dv-ask-meta">
            <span>{ASK.agent}</span>
            <Swap scope="phone" />
          </div>
          <p className="dv-ask-q">{ASK.question}</p>
          <div className="dv-compose">
            <span className="dv-compose-text">
              <em className="dv-reply">{ASK.reply}</em>
              <em className="dv-hint">Reply</em>
            </span>
            <span className="dv-send">
              <i className="dv-ripple" />
              <svg viewBox="0 0 16 16">
                <path d="M8 13V3m0 0L4 7m4-4 4 4" />
              </svg>
            </span>
            <i className="dv-finger" />
          </div>
        </div>
        <ul className="dv-list">
          {PHONE_CHATS.map((chat) => (
            <li key={chat.title}>
              <i className="dv-dot dv-dot--run" />
              <b>{chat.title}</b>
              <span>{chat.agent}</span>
            </li>
          ))}
        </ul>
        <div className="dv-new-chat">
          <span>Server</span>
          <em>
            <i className="dv-dot dv-dot--run" />
            <span className="dv-phone-server" key={server}>
              {server}
            </span>
          </em>
        </div>
        <i className="dv-home" />
      </div>
    </div>
  );
}

function MacBook() {
  return (
    <span className="dv-hw dv-hw--book">
      <svg viewBox="0 0 220 140">
        <rect
          className="dv-body"
          x="24"
          y="3"
          width="172"
          height="116"
          rx="9"
        />
        <rect
          className="dv-glass"
          x="31"
          y="10"
          width="158"
          height="102"
          rx="3"
        />
        <rect
          className="dv-notch"
          x="102"
          y="10"
          width="16"
          height="5"
          rx="2.5"
        />
        <path
          className="dv-body"
          d="M3 120H217V125Q217 133 208 133H12Q3 133 3 125Z"
        />
        <path
          className="dv-faint"
          d="M92 120V122Q92 124 94 124H126Q128 124 128 122V120"
        />
      </svg>
      <span className="dv-mac-screen">
        <span className="dv-mac-side">
          <i />
          <i className="is-on" />
          <i />
          <i />
        </span>
        <span className="dv-mac-main">
          <i />
          <i />
          <i />
          <i className="dv-mac-type" />
        </span>
      </span>
    </span>
  );
}

function MacMini() {
  return (
    <span className="dv-hw dv-hw--mini">
      <svg viewBox="0 0 200 88">
        <path
          className="dv-top"
          d="M32 7Q34 4 38 4H162Q166 4 168 7L186 36H14Z"
        />
        <path
          className="dv-body"
          d="M14 36H186V68Q186 76 178 76H22Q14 76 14 68Z"
        />
        <path
          className="dv-faint-fill"
          d="M46 76H154V79Q154 81 152 81H48Q46 81 46 79Z"
        />
        <rect
          className="dv-faint"
          x="28"
          y="53"
          width="9"
          height="3.6"
          rx="1.8"
        />
        <rect
          className="dv-faint"
          x="41"
          y="53"
          width="9"
          height="3.6"
          rx="1.8"
        />
        <circle className="dv-faint" cx="56" cy="54.8" r="1.9" />
      </svg>
      <i className="dv-led" />
    </span>
  );
}

function Tower() {
  return (
    <span className="dv-hw dv-hw--tower">
      <i className="dv-gpu-glow" />
      <svg viewBox="0 0 144 180">
        <path className="dv-top" d="M128 5L139 12V166L128 171Z" />
        <rect className="dv-body" x="4" y="4" width="125" height="167" rx="7" />
        <rect
          className="dv-glass"
          x="12"
          y="12"
          width="109"
          height="151"
          rx="4"
        />
        <rect
          className="dv-faint"
          x="19"
          y="19"
          width="80"
          height="94"
          rx="2"
        />
        <rect className="dv-body" x="38" y="31" width="32" height="32" rx="5" />
        {[78, 83, 88, 93].map((x) => (
          <rect
            className="dv-faint-fill"
            key={x}
            x={x}
            y="27"
            width="2.4"
            height="36"
            rx="1"
          />
        ))}
        <rect className="dv-gpu" x="16" y="77" width="101" height="29" rx="4" />
        <rect
          className="dv-top"
          x="12"
          y="125"
          width="109"
          height="38"
          rx="1"
        />
        <path className="dv-faint" d="M24 137H52M24 143H52M24 149H52" />
        <rect
          className="dv-faint-fill"
          x="12"
          y="171"
          width="20"
          height="4"
          rx="2"
        />
        <rect
          className="dv-faint-fill"
          x="100"
          y="171"
          width="20"
          height="4"
          rx="2"
        />
      </svg>
      <i className="dv-gpu-edge" />
      <i className="dv-fan dv-fan--cpu" />
      <i className="dv-fan dv-fan--a" />
      <i className="dv-fan dv-fan--b" />
      <i className="dv-fan dv-fan--c" />
      <i className="dv-power" />
    </span>
  );
}

function Box() {
  return (
    <span className="dv-hw dv-hw--box">
      <svg viewBox="0 0 200 96">
        <path
          className="dv-top"
          d="M26 8Q28 5 32 5H168Q172 5 174 8L188 26H12Z"
        />
        <rect
          className="dv-body"
          x="12"
          y="26"
          width="176"
          height="58"
          rx="6"
        />
        <rect
          className="dv-glass"
          x="22"
          y="34"
          width="116"
          height="42"
          rx="3"
        />
        {[27, 54, 81, 108].map((x) => (
          <g key={x}>
            <rect
              className="dv-faint"
              x={x}
              y="38"
              width="23"
              height="34"
              rx="2"
            />
            <rect
              className="dv-faint-fill"
              x={x + 4}
              y="64"
              width="15"
              height="3"
              rx="1.5"
            />
          </g>
        ))}
        <path className="dv-faint" d="M152 58H176M152 64H176M152 70H176" />
        <rect
          className="dv-faint-fill"
          x="24"
          y="84"
          width="22"
          height="4"
          rx="2"
        />
        <rect
          className="dv-faint-fill"
          x="154"
          y="84"
          width="22"
          height="4"
          rx="2"
        />
      </svg>
      <i className="dv-box-led dv-box-led--a" />
      <i className="dv-box-led dv-box-led--b" />
    </span>
  );
}

const HARDWARE: Record<MachineId, () => ReactNode> = {
  book: MacBook,
  mini: MacMini,
  tower: Tower,
  box: Box,
};

function useCluster() {
  const ref = useRef<HTMLElement>(null);
  const [server, setServer] = useState(0);
  const [phase, setPhase] = useState<Phase>("move");
  const [playing, setPlaying] = useState(false);
  const [manual, setManual] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const stage = ref.current;

    if (!stage) return;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => setReduced(motion.matches);

    syncMotion();
    motion.addEventListener("change", syncMotion);
    stage.classList.add("is-armed");

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        stage.classList.toggle("is-playing", entry.isIntersecting);
        setPlaying(entry.isIntersecting);

        if (entry.isIntersecting) stage.classList.add("is-in");
        else setManual(false);
      },
      { rootMargin: "0px 0px -18% 0px" },
    );

    observer.observe(stage);

    return () => {
      observer.disconnect();
      motion.removeEventListener("change", syncMotion);
    };
  }, []);

  useEffect(() => {
    if (!playing || reduced) return;

    const next = (): [number, Phase, number] => {
      switch (phase) {
        case "move":
          return [server, "tap", MOVE_MS];
        case "tap":
          return [server, "out", TAP_MS];
        case "out":
          return [
            server,
            server === GPU ? "run" : "over",
            legMs(PHONE, server),
          ];
        case "over":
          return [server, "run", legMs(server, GPU)];
        case "run":
          return manual
            ? [server, "tap", RUN_MS]
            : [(server + 1) % MACHINES.length, "move", RUN_MS];
      }
    };

    const [nextServer, nextPhase, wait] = next();

    const timer = window.setTimeout(() => {
      setServer(nextServer);
      setPhase(nextPhase);
    }, wait);

    return () => window.clearTimeout(timer);
  }, [playing, reduced, phase, server, manual]);

  const choose = (index: number) => {
    setManual(true);
    setServer(index);
    setPhase(reduced ? "run" : "move");
  };

  return {
    ref,
    server,
    phase: reduced ? "run" : phase,
    choose,
  };
}

function Packets({ server, phase }: { server: number; phase: Phase }) {
  const at =
    phase === "out"
      ? server
      : phase === "over" || phase === "run"
        ? GPU
        : PHONE;

  const duration =
    phase === "out"
      ? legMs(PHONE, server)
      : phase === "over"
        ? legMs(server, GPU)
        : 0;

  return (
    <>
      {MACHINES.map((machine, index) =>
        index === server ? null : (
          <i
            className="dv-beat"
            key={`${server}-${machine.id}`}
            style={
              {
                "--from": index,
                "--to": server,
                "--beat": `${1.6 + Math.abs(index - server) * 0.5}s`,
                "--wait": `${-index * 0.7}s`,
              } as CSSProperties
            }
          />
        ),
      )}
      <i
        className="dv-packet"
        style={{ "--at": at, "--dur": `${duration}ms` } as CSSProperties}
      />
    </>
  );
}

function Cluster() {
  const { ref, server, phase, choose } = useCluster();
  const host = machineAt(server);

  return (
    <figure
      className="dv-stage"
      ref={ref}
      data-phase={phase}
      data-server={host.id}
      aria-label={FIGURE_LABEL}
    >
      <div className="dv-phone-col dv-in" style={order(0)} aria-hidden="true">
        <Phone server={host.name} />
        <p className="dv-cap">Your phone or any browser</p>
      </div>
      <div className="dv-cluster" style={{ "--srv": server } as CSSProperties}>
        <div className="dv-wires" aria-hidden="true">
          <i className="dv-rail" />
          <i className="dv-rail-more" />
          <p className="dv-link-label dv-in" style={order(1)}>
            Omnyo connect
            <br />
            Tailscale · LAN
          </p>
          <Packets server={server} phase={phase} />
          <span className="dv-crown">
            <span className="dv-crown-label">Omnyo server</span>
            <span className="dv-crown-disc">
              <i className="dv-crown-ping" />
              <Mark />
            </span>
          </span>
        </div>
        <ul className="dv-machines">
          {MACHINES.map((machine, index) => {
            const Hardware = HARDWARE[machine.id];
            const isServer = index === server;

            return (
              <li
                className={`dv-machine dv-machine--${machine.id} dv-in ${isServer ? "is-server" : ""}`}
                key={machine.id}
                style={order(index + 2)}
              >
                <button
                  type="button"
                  className="dv-pick"
                  aria-pressed={isServer}
                  aria-label={`Host the server on the ${machine.name}`}
                  onClick={() => choose(index)}
                >
                  <i className="dv-drop" aria-hidden="true" />
                  <i className="dv-junction" aria-hidden="true" />
                  <span className="dv-hw-slot" aria-hidden="true">
                    <i className="dv-host-glow" />
                    <Hardware />
                  </span>
                  <span className="dv-meta" aria-hidden="true">
                    <strong>{machine.name}</strong>
                    <span className="dv-role">
                      <span>{machine.spec}</span>
                      <em
                        className="dv-role-now"
                        key={isServer ? "host" : "agents"}
                      >
                        {isServer ? "Server + agents" : "Runs agents"}
                      </em>
                    </span>
                    {index === GPU ? (
                      <span className="dv-chip dv-chip--ask">
                        <i className="dv-chip-ring dv-swap--tower is-need" />
                        <SwapDot scope="tower" />
                        <b>{machine.chat.title}</b>
                        <span className="dv-chip-agent">
                          {machine.chat.agent}
                          <Swap scope="tower" />
                        </span>
                      </span>
                    ) : (
                      <span className="dv-chip">
                        <i className="dv-dot dv-dot--run" />
                        <b>{machine.chat.title}</b>
                        <span className="dv-chip-agent">
                          {machine.chat.agent}
                        </span>
                      </span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          <li className="dv-machine dv-machine--more dv-in" style={order(6)}>
            <a className="dv-more" href="/features/devices">
              <i className="dv-junction" aria-hidden="true" />
              <span className="dv-more-plus" aria-hidden="true">
                +
              </span>
              <span className="dv-more-copy">
                <strong>Add another</strong>
                <span>Mac, Windows or Linux</span>
              </span>
            </a>
          </li>
        </ul>
        <p className="dv-caption dv-in" style={order(7)}>
          <span className="dv-caption-now" key={host.id}>
            <b>Server on the {host.name}.</b> {host.note}
          </span>
          <span className="dv-caption-hint">
            Pick a machine to host the server.
          </span>
        </p>
      </div>
    </figure>
  );
}

function Devices() {
  return (
    <section
      className="band devices"
      data-flow
      data-progress="local"
      data-wipe="stage"
      data-act="Every device"
    >
      <header className="band-head">
        <p className="act-label">Every device</p>
        <h2 className="h2 devices-title">
          <Named kind="book" index={0}>
            MacBook
          </Named>
          ,{" "}
          <Named kind="mini" index={1}>
            Mac mini
          </Named>{" "}
          and a 3090 in your{" "}
          <Named kind="tower" index={2}>
            Windows desktop
          </Named>
          ?{" "}
          <span className="devices-answer">
            Use all of them. Run every chat from your{" "}
            <Named kind="phone" index={3}>
              phone
            </Named>
            .
          </span>
        </h2>
        <ul className="devices-roles">
          {ROLES.map((role, index) => (
            <li key={role.title} style={order(index + 4)}>
              <Glyph kind={role.glyph} />
              <span>
                <b>{role.title}</b>
                <span>{role.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </header>
      <Cluster />
      <p className="band-links">
        <a href="/features/devices">How machines connect</a>
        <a href="/features/mobile-remote-control">
          Remote control from your phone
        </a>
        <a href="/features/dev-servers">Dev servers and previews</a>
      </p>
    </section>
  );
}

export { Devices };
