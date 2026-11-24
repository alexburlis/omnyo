import Globe02Icon from "@hugeicons/core-free-icons/Globe02Icon";
import { HugeiconsIcon } from "@hugeicons/react";

import { PlatformGlyph } from "../landing/download";
import { platformHref } from "../landing/platforms";
import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { explorePath, type ExploreItem, type ExploreLink } from "./catalog";
import {
  CopyStatus,
  RelatedLinks,
  canonicalItemUrl,
  itemByline,
  useCopyStatus,
} from "./ExploreParts";

export function ExplorePluginPage({
  item,
  plugin,
  capabilities,
  availability,
  related,
}: {
  item: ExploreItem;
  plugin: { displayName: string; author: { name: string; url: string | null } };
  capabilities: readonly string[];
  availability: string;
  related: readonly ExploreLink[];
}) {
  const { status, copy } = useCopyStatus();
  const canonicalUrl = canonicalItemUrl(item);
  const install = item.cta.kind === "find-in-omnyo" ? item.cta.install : null;

  useEffect(() => {
    sendSiteUsage({ name: "listing_open", kind: "connector" });
  }, [item.slug]);

  return (
    <>
      <SiteNav current="explore" path={item.path} />
      <div className="wrap ex-page">
        <main id="main-content">
          <a className="ex-back" href={explorePath}>
            ← Explore
          </a>
          <header className="ex-detail-header ex-plugin-header">
            <span className="ex-plugin-mark" aria-hidden="true">
              <HugeiconsIcon icon={Globe02Icon} />
            </span>
            <p className="ex-eyebrow">{itemByline(item)}</p>
            <h1>{item.title}</h1>
            <p className="ex-lead">{item.summary}</p>
            <div className="ex-actions">
              <a
                className="btn btn-primary"
                href="#find-in-omnyo"
                onClick={() =>
                  sendSiteUsage({ name: "install_intent", kind: "connector" })
                }
              >
                Find in Omnyo
              </a>
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() =>
                  copy({
                    text: canonicalUrl,
                    copied: "Link copied.",
                    failed: "Copy this address to share the plugin.",
                    fallbackUrl: canonicalUrl,
                  })
                }
              >
                Copy link
              </button>
            </div>
            <CopyStatus status={status} />
            <p className="ex-small">{availability}</p>
          </header>
          <section className="ex-section" aria-labelledby="ex-does-heading">
            <h2 id="ex-does-heading">What it does</h2>
            <ul className="ex-list">
              {capabilities.map((capability) => (
                <li key={capability}>{capability}</li>
              ))}
            </ul>
          </section>
          <section
            id="find-in-omnyo"
            className="ex-section ex-handoff"
            aria-labelledby="ex-find-heading"
          >
            <h2 id="ex-find-heading">Find it in Omnyo</h2>
            <ol className="ex-steps">
              <li>In Omnyo, open Plugins, then Installed plugins.</li>
              <li>
                Find {plugin.displayName}. If it is turned off, turn it on.
              </li>
            </ol>
            {install ? (
              <>
                <p>
                  Not in the list? Open Browse plugins, then Omnyo Official, or
                  run this command and confirm the install:
                </p>
                <pre className="ex-command">
                  <code>{install}</code>
                </pre>
              </>
            ) : null}
            <div className="ex-handoff-new">
              <h3>New to Omnyo?</h3>
              <p>Install Omnyo for Mac. {plugin.displayName} comes with it.</p>
              <a
                className="get-btn get-btn--md"
                href={platformHref("mac")}
                onClick={() =>
                  sendSiteUsage({ name: "download_click", os: "mac" })
                }
              >
                <PlatformGlyph id="mac" />
                <span>Download Omnyo for Mac</span>
              </a>
            </div>
          </section>
          <p className="ex-credit">
            Made by{" "}
            {plugin.author.url ? (
              <a href={plugin.author.url}>{plugin.author.name}</a>
            ) : (
              plugin.author.name
            )}{" "}
            and part of the Omnyo Official plugins.
          </p>
          <RelatedLinks links={related} />
        </main>
      </div>
      <SiteFooter current={item.path} />
    </>
  );
}

import { useEffect } from "react";
import { sendSiteUsage } from "../analytics/usage";
