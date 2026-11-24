import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import Tick02Icon from "@hugeicons/core-free-icons/Tick02Icon";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { sendSiteUsage } from "../analytics/usage";

import type { ExploreLink } from "../explore/catalog";
import { RelatedLinks } from "../explore/ExploreParts";
import { GetArrow, PlatformGlyph } from "../landing/download";

import { SiteFooter, SiteNav } from "../landing/site-chrome";
import { copyPlainText } from "../lib/copy-plain-text";
import {
  canonicalWorkflowListingUrl,
  workflowAttachmentPath,
  workflowCompatibilityLine,
  workflowGalleryPath,
  workflowListingPath,
  type PublicWorkflowListing,
  type WorkflowReleaseSummary,
} from "./catalog";
import { describeWeeklyCron } from "./schedule";
import { WorkflowRun } from "./WorkflowRun";
import { WeekPicker } from "./WorkflowWeek";

const LINK_COPIED = "Link copied.";

const COPIED_BUTTON_MS = 2400;

function ShareButton({ url }: { url: string }) {
  const [status, setStatus] = useState("");
  const [showCopied, setShowCopied] = useState(false);

  useEffect(() => {
    if (!showCopied) return;

    const timer = window.setTimeout(
      () => setShowCopied(false),
      COPIED_BUTTON_MS,
    );

    return () => window.clearTimeout(timer);
  }, [showCopied]);

  async function copyLink() {
    const copied = await copyPlainText(url);

    setStatus(
      copied ? LINK_COPIED : "Copy this address to share the workflow.",
    );
    setShowCopied(copied);
  }

  const failed = status !== "" && status !== LINK_COPIED;

  return (
    <>
      <button
        type="button"
        className="wf-share"
        data-copied={showCopied || undefined}
        onClick={copyLink}
      >
        <HugeiconsIcon
          icon={showCopied ? Tick02Icon : Link01Icon}
          className="wf-share-icon"
          aria-hidden
        />
        <span>{showCopied ? "Link copied" : "Copy link"}</span>
      </button>
      <p
        className={failed ? "wf-copy-status" : "wf-copy-status wf-sr"}
        role="status"
      >
        {status}
      </p>
      {failed ? (
        <a className="wf-canonical" href={url}>
          {url}
        </a>
      ) : null}
    </>
  );
}

function DraftStage({ listing }: { listing: PublicWorkflowListing }) {
  const { preview } = listing;
  const firstDay = preview.days[0];

  return (
    <section className="wf-section wf-stage" aria-labelledby="wf-draft-heading">
      <div className="wf-stage-head">
        <p className="wf-label">Example output</p>
        <h2 id="wf-draft-heading">Read Monday’s post</h2>
        <p className="wf-stage-lead">
          Each day arrives as a complete Markdown draft. Before delivery, an
          independent reviewer compares the draft with your product facts. Check
          the claims yourself before publishing.
        </p>
      </div>
      <div className="wf-stage-grid">
        <article className="wf-doc" aria-labelledby="wf-doc-title">
          <p className="wf-doc-meta">
            <span>Illustrative draft</span>
            {firstDay ? (
              <span>
                {firstDay.day} · {firstDay.format}
              </span>
            ) : null}
          </p>
          <h3 id="wf-doc-title">{preview.draft.title}</h3>
          {preview.draft.paragraphs.map((paragraph) => (
            <p key={paragraph}>{paragraph}</p>
          ))}
        </article>
        <div className="wf-stage-side">
          <aside className="wf-review" aria-labelledby="wf-review-title">
            <p className="wf-label">Example review</p>
            <h3 id="wf-review-title">A claim worth catching</h3>
            <p className="wf-review-claim">
              <del>“{preview.review.originalClaim}”</del>
            </p>
            <p className="wf-review-evidence">{preview.review.evidence}</p>
            <p className="wf-review-decision">{preview.review.decision}</p>
            <p className="wf-review-revision">
              <span className="wf-label">Revised</span>
              <ins>{preview.review.revision}</ins>
            </p>
          </aside>
          <aside className="wf-facts" aria-labelledby="wf-facts-title">
            <p className="wf-label" id="wf-facts-title">
              Supplied facts for this example
            </p>
            <ul>
              {preview.evidence.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </section>
  );
}

function Requirements({
  listing,
  release,
}: {
  listing: PublicWorkflowListing;
  release: WorkflowReleaseSummary;
}) {
  const weekly = describeWeeklyCron(release.schedule.cron);

  return (
    <section
      className="wf-section wf-requirements"
      aria-labelledby="wf-requirements-heading"
    >
      <div className="wf-section-head">
        <p className="wf-label">Requirements</p>
        <h2 id="wf-requirements-heading">Before the first run</h2>
        <p className="wf-section-lead">
          The imported copy starts with its schedule off. Review the
          instructions and inputs in Omnyo before confirming a run.
        </p>
      </div>
      <dl className="wf-req-grid">
        <div>
          <dt>App</dt>
          <dd>{workflowCompatibilityLine(listing.compatibility)}</dd>
        </div>
        <div>
          <dt>Drafting</dt>
          <dd>
            Sign in to Codex or Claude Code in Omnyo and choose a model. Omnyo
            sends it your brief and sources to write and review the drafts.
          </dd>
        </div>
        <div>
          <dt>Sources</dt>
          <dd>
            Bring notes about your product and who uses it. Optionally connect
            OpenSEO to select keywords already saved for your site. Reading
            those keywords uses zero OpenSEO credits.
          </dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd>
            {weekly ? <strong>{weekly}</strong> : null}
            <span>
              <code>{release.schedule.cron}</code> · {release.schedule.tz}
            </span>
            <span>Disabled on import; review the schedule in Omnyo.</span>
          </dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{listing.outputSummary}</dd>
        </div>
      </dl>
      <div className="wf-req-lists">
        <div>
          <h3 className="wf-label">
            Inputs you can edit · {release.inputs.length}
          </h3>
          <ul className="wf-inputs">
            {release.inputs.map((input) => (
              <li key={input.id}>{input.label}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="wf-label">Workflow capabilities</h3>
          <ul className="wf-capabilities">
            {release.capabilities.map((capability) => (
              <li key={capability}>
                <code>{capability}</code>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Handoff({
  attachment,
  release,
}: {
  attachment: string;
  release: WorkflowReleaseSummary;
}) {
  return (
    <section
      id="get-workflow"
      className="wf-section wf-handoff"
      aria-labelledby="wf-get-heading"
    >
      <div className="wf-handoff-main">
        <p className="wf-label">Your editable copy</p>
        <h2 id="wf-get-heading">Set up your first week</h2>
        <p className="wf-section-lead">
          Open this workflow in Omnyo to review it and choose your project.
        </p>
        <details className="wf-release">
          <summary>
            Workflow revision {release.revision} · File verification
          </summary>
          <p className="wf-label">SHA-256</p>
          <code>{release.sha256}</code>
          <a href={attachment} download>
            Download workflow file
          </a>
          <p>
            The file URL is pinned to this revision. Already downloaded copies
            stay under the recipient’s control.
          </p>
        </details>
      </div>
      <ol className="wf-handoff-paths">
        <li>
          <h3>1. Open Omnyo on your Mac</h3>
          <p>
            On an Apple silicon Mac, open Weekly Content Feed Setup and select
            Install &amp; open workflow. On the welcome screen, finish setup and
            create a project for your startup. The installer opens the workflow
            for review when you finish.
          </p>
        </li>
        <li>
          <h3>2. Import your copy</h3>
          <p>
            Already have Omnyo? Update to the version listed above, then select
            Open in Omnyo. Review the shared workflow and choose your project.
            If you need one, select Add a project. Then select Save copy and
            choose sources.
          </p>
        </li>
        <li>
          <h3>3. Give the writer a brief</h3>
          <p>
            Your copy opens on Start with product notes. Enter your startup,
            audience and one product fact per line. Seven distinct facts give
            each day an initial focus. Preview the week to check those topics.
          </p>
          <p>
            Already have saved keywords? Select Import keywords I already have
            in OpenSEO. Connect your site and choose the keywords to use.
          </p>
          <p>
            When you’re ready to generate drafts, choose your connected Codex or
            Claude Code model and select Approve inputs for generation.
          </p>
        </li>
        <li>
          <h3>4. Read your first week</h3>
          <p>
            Select Run now. Pick a day to read its draft and check its claims
            against your product notes. Select Enable schedule when you want
            another batch each week. Scheduled runs reuse your approved inputs.
          </p>
        </li>
      </ol>
    </section>
  );
}

export function WorkflowListing({
  listing,
  release,
  related,
}: {
  listing: PublicWorkflowListing;
  release: WorkflowReleaseSummary;
  related: readonly ExploreLink[];
}) {
  const [selectedDay, setSelectedDay] = useState(0);
  const [handoff, setHandoff] = useState<"open" | "install" | null>(null);
  const canonicalUrl = canonicalWorkflowListingUrl(listing.slug);
  const attachment = workflowAttachmentPath(listing.slug, release.sha256);
  const openLink = `omnyo://workflows/import/${release.sha256.slice(0, 32)}`;
  const path = workflowListingPath(listing.slug);

  useEffect(() => {
    sendSiteUsage({ name: "listing_open", kind: "workflow" });
  }, [listing.slug]);

  return (
    <div className="wf-page">
      <SiteNav current="workflows" path={path} />
      <main id="main-content" className="wf-main">
        <div className="wf-hero">
          <header className="wf-hero-copy">
            <nav className="wf-crumbs" aria-label="Breadcrumb">
              <a href={workflowGalleryPath}>Workflows</a>
              <span aria-hidden="true">/</span>
              <span>
                {listing.category} · {listing.cadence}
              </span>
            </nav>
            <h1>{listing.title}</h1>
            <p className="wf-lead">{listing.description}</p>
            {listing.credit ? (
              <p className="wf-credit">{listing.credit}</p>
            ) : null}
            <ul className="wf-hero-facts">
              <li>
                <PlatformGlyph id="mac" />
                {workflowCompatibilityLine(listing.compatibility)}
              </li>
              <li>Requires connected Codex or Claude Code</li>
              <li>Optional connector: OpenSEO saved keywords</li>
              <li>
                <a href="#wf-draft-heading">Example draft</a>
              </li>
            </ul>
            <p className="wf-hero-output">{listing.outputSummary}</p>
            <div className="wf-actions wf-mac-action">
              <a
                className="wf-get"
                href={listing.installerPath}
                download
                onClick={() => {
                  sendSiteUsage({ name: "install_intent", kind: "workflow" });
                  setHandoff("install");
                }}
              >
                <span>Install Omnyo with this workflow</span>
                <GetArrow kind="down" />
              </a>
            </div>
            <p className="wf-install-hint wf-mac-action">
              Already installed?{" "}
              <a
                href={openLink}
                onClick={() => {
                  sendSiteUsage({ name: "install_intent", kind: "workflow" });
                  setHandoff("open");
                }}
              >
                Open in Omnyo
              </a>
              {" · "}
              <a href="#get-workflow">Setup steps</a>
            </p>
            {handoff === "open" && (
              <p className="wf-install-hint" role="status">
                If Omnyo didn’t open, use the installer above. It opens this
                workflow after setup.
              </p>
            )}
            {handoff === "install" && (
              <p className="wf-install-hint" role="status">
                Open Weekly Content Feed Setup from your download, then select
                Install &amp; open workflow.
              </p>
            )}
            <p className="wf-install-hint wf-other-device">
              Copy this link and open it on an Apple silicon Mac to install the
              workflow.
            </p>
            <ShareButton url={canonicalUrl} />
          </header>
          <WeekPicker
            week={listing.preview}
            context={listing.preview.context}
            selected={selectedDay}
            onSelect={setSelectedDay}
          />
        </div>
        <DraftStage listing={listing} />
        <WorkflowRun {...release.candidateBudget} />
        <Requirements listing={listing} release={release} />
        <Handoff attachment={attachment} release={release} />
        <RelatedLinks links={related} />
        <p className="wf-top-link">
          <a href="#main-content">Back to top ↑</a>
        </p>
      </main>
      <SiteFooter current={path} />
    </div>
  );
}
