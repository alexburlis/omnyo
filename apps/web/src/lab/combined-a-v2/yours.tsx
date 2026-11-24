import "./yours.css";

import type { CSSProperties } from "react";

import { at } from "../open-5/page";
import { STREAM_REACH_SPAN } from "../open-5/particles";

const TITLE = [
  { text: "Your machines.", start: -0.72 },
  { text: "Your server.", start: -0.62 },
  { text: "Fully private.", start: -0.52 },
] as const;

const REACH_FROM = -0.12;

const REACH_SPAN = 0.7;

const NODES = [
  { label: "Your devices", detail: "Phone, laptop, desktop", at: 0 },
  { label: "Your server", detail: "Keeps every chat", at: 0.5 },
  { label: "Your AI provider", detail: "On your own plan", at: 1 },
] as const;

const ROUTE =
  "Your chats stay on a server you run. Prompts go straight to the AI provider you already use.";

const FACTS = [
  "Free",
  "Open source",
  "Uses your Claude Code and Codex subscriptions",
  "No account needed on your own machines",
] as const;

const ORB_LIT = -0.34;

const TRACK_SIZE: CSSProperties = {
  height: STREAM_REACH_SPAN * 2,
  marginTop: -STREAM_REACH_SPAN,
};

const nodeStyle = (index: number, along: number) =>
  ({
    "--show": -0.46 + index * 0.05,
    "--arrive": index === 0 ? ORB_LIT : REACH_FROM + along * REACH_SPAN,
  }) as CSSProperties;

function Yours() {
  return (
    <section className="yours yours--route" data-scene="yours">
      <div
        className="pin yours-pin"
        style={
          {
            "--reach-from": REACH_FROM,
            "--reach-span": REACH_SPAN,
          } as CSSProperties
        }
      >
        <p className="act-label">Where your code goes</p>
        <h2 className="yours-title">
          {TITLE.map((line) => (
            <span className="k" key={line.text} style={at(line.start, 0.14)}>
              {line.text}
            </span>
          ))}
        </h2>
        <div className="route" aria-hidden="true">
          <span className="route-line" />
          <span
            className="route-track"
            data-anchor="stream"
            style={TRACK_SIZE}
          />
          <span className="route-head">
            <i />
          </span>
          {NODES.map((node, index) => (
            <span
              className={`route-node route-node--${index}`}
              key={node.label}
              style={nodeStyle(index, node.at)}
            >
              <b>{node.label}</b>
              <small>{node.detail}</small>
            </span>
          ))}
        </div>
        <div className="route-foot">
          <p className="body route-copy k" style={at(0.6, 0.12)}>
            {ROUTE}
          </p>
          <ul className="route-facts k" style={at(0.66, 0.12)}>
            {FACTS.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export { Yours };
