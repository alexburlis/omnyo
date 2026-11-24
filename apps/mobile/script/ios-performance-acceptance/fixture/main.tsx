import { Provider } from "jotai";
import { createRoot } from "react-dom/client";
import { AcceptanceFixture } from "./timeline-fixture.js";
import { installFrameCollector } from "./numeric-frame-collector.js";
import "./fixture.css";

installFrameCollector();

createRoot(document.getElementById("root")!).render(
  <Provider>
    <AcceptanceFixture />
  </Provider>,
);
