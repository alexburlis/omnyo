const p = await browser.getPage("orca-visual-ui-proof");

const fixtureUrl = __ORCA_FIXTURE_URL__;

const results = [];

const errors = [];

const deniedOrigins = [];

p.on("pageerror", (error) => errors.push(error.message));

await p.setRequestInterception(true);

p.on("request", async (request) => {
  const url = new URL(request.url());

  if (
    url.origin === new URL(fixtureUrl).origin ||
    ["data:", "blob:"].includes(url.protocol)
  )
    await request.continue();
  else {
    deniedOrigins.push(url.origin);
    await request.abort();
  }
});

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function clickButton(scope, text) {
  const buttons = await p.$$(`${scope} button`);

  for (const button of buttons) {
    if (
      await button.evaluate(
        (node, expected) => node.textContent.trim() === expected,
        text,
      )
    ) {
      await button.click();

      return;
    }
  }

  throw new Error(`Missing fixture button: ${text}`);
}

for (const viewport of [
  {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
]) {
  await p.setViewport(viewport);
  await p.goto(fixtureUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  await p.waitForFunction(() => globalThis.__orcaVisualProof?.ready === true, {
    timeout: 10000,
  });
  await p.waitForSelector('#glance-ui a[data-glance-thread="thr_origin"]', {
    timeout: 5000,
  });

  const initial = await p.evaluate(() =>
    globalThis.__orcaVisualProof.calls.filter(
      (call) => call.method === "attachments.read",
    ),
  );

  ensure(initial.length === 0, "The Lines overview eagerly read image bytes");

  await clickButton("#visual-ui", "Annotate");
  await p.waitForSelector(
    '#visual-ui img[alt="Frozen browser view for annotation"]',
    { timeout: 3000 },
  );

  const point = await p.$eval(
    '#visual-ui img[alt="Frozen browser view for annotation"]',
    (node) => {
      const bounds = node.getBoundingClientRect();
      const scale = Math.min(bounds.width / 900, bounds.height / 600);

      return {
        x: bounds.left + (bounds.width - 900 * scale) / 2 + 300 * scale,
        y: bounds.top + (bounds.height - 600 * scale) / 2 + 165 * scale,
        letterboxed: Math.abs(bounds.width / bounds.height - 1.5) > 0.01,
      };
    },
  );

  ensure(point.letterboxed, "The fixture did not exercise image letterboxing");

  if (viewport.hasTouch) await p.touchscreen.tap(point.x, point.y);
  else await p.mouse.click(point.x, point.y);
  await p.waitForFunction(
    () =>
      document.querySelector(
        '#visual-ui select[aria-label="Element to annotate"]',
      )?.value === "element-confirm",
    { timeout: 2000 },
  );
  await p.fill(
    '#visual-ui textarea[aria-label="Visual note"]',
    "Make the confirmation clearer",
  );
  await clickButton("#visual-ui", "Add note to chat");
  await p.waitForFunction(
    () =>
      globalThis.__orcaVisualProof.state.drafts.thr_origin.attachments
        .length === 1,
    { timeout: 3000 },
  );

  const saved = await p.evaluate(() => {
    const proof = globalThis.__orcaVisualProof;

    return {
      origin: proof.state.drafts.thr_origin,
      foreign: proof.state.drafts.thr_foreign,
      uploads: proof.calls.filter(
        (call) => call.method === "attachments.upload",
      ),
      requests: proof.calls.filter((call) =>
        ["observe", "inspect"].includes(call.method),
      ),
    };
  });

  ensure(
    saved.origin.text.includes('"targetId":"target-displayed"'),
    "The annotation lost the displayed target",
  );
  ensure(
    saved.origin.attachments[0].sourceProjectId === "project_origin",
    "The capture did not become a project-owned attachment",
  );
  ensure(
    saved.foreign.text === "Existing draft" &&
      saved.foreign.attachments.length === 0,
    "The focused foreign composer was modified",
  );
  ensure(
    saved.uploads.length === 1 &&
      saved.uploads[0].projectId === "project_origin" &&
      saved.uploads[0].bytes > 0,
    "The real SDK multipart upload used the wrong owner",
  );
  ensure(
    saved.requests.every(
      (call) =>
        call.input.targetId === "target-displayed" &&
        call.input.threadId === "thr_origin",
    ),
    "The UI routed an observation to the wrong target or thread",
  );

  await p.evaluate(() => {
    globalThis.__orcaVisualProof.state.stale = true;
  });
  await p.fill(
    '#visual-ui textarea[aria-label="Visual note"]',
    "Keep this unsent note",
  );
  await clickButton("#visual-ui", "Add note to chat");
  await p.waitForSelector('#visual-ui [role="alert"]', { timeout: 3000 });

  const stale = await p.evaluate(() => ({
    note: document.querySelector("#visual-ui textarea").value,
    attachments:
      globalThis.__orcaVisualProof.state.drafts.thr_origin.attachments.length,
    error: document.querySelector('#visual-ui [role="alert"]').textContent,
  }));

  ensure(
    stale.note === "Keep this unsent note" &&
      stale.attachments === 1 &&
      stale.error.includes("stale"),
    "Stale capture handling lost the unsent note or uploaded stale pixels",
  );
  await clickButton("#visual-ui", "Refresh selection");
  await p.waitForFunction(
    () => globalThis.__orcaVisualProof.state.observation === 2,
    { timeout: 3000 },
  );
  await clickButton("#visual-ui", "Phone");
  await p.waitForFunction(
    () =>
      !document.querySelector(
        '#visual-ui img[alt="Frozen browser view for annotation"]',
      ),
    { timeout: 3000 },
  );

  const preset = await p.evaluate(() =>
    globalThis.__orcaVisualProof.calls
      .filter((call) => call.method === "viewport")
      .at(-1),
  );

  ensure(
    preset.input.targetId === "target-displayed" &&
      preset.input.preset === "phone",
    "The responsive control lost exact-target affinity",
  );
  await clickButton("#visual-ui", "Annotate");
  await p.waitForSelector('#visual-ui textarea[aria-label="Visual note"]', {
    timeout: 3000,
  });
  ensure(
    (await p.$eval("#visual-ui textarea", (node) => node.value)) ===
      "Keep this unsent note",
    "Viewport changes discarded the unsent note",
  );
  await p.shot({ type: "jpeg", maxEdge: 1200, quality: 75 });

  await clickButton("#glance-ui", "Cards");
  await p.$eval("#glance-ui", (node) =>
    node.scrollIntoView({ block: "start" }),
  );
  await p.waitForSelector('#glance-ui img[alt="Updated layout preview"]', {
    timeout: 3000,
  });
  await p.waitForFunction(
    () =>
      document.querySelector('#glance-ui img[alt="Updated layout preview"]')
        ?.naturalWidth === 900,
    { timeout: 3000 },
  );

  const visibleReads = await p.evaluate(() =>
    globalThis.__orcaVisualProof.calls.filter(
      (call) => call.method === "attachments.read",
    ),
  );

  ensure(
    visibleReads.length === 1 &&
      visibleReads[0].projectId === "project_artifact" &&
      visibleReads[0].path === "uploads/result.png",
    "The cross-project result preview used ambient thread ownership or loaded offscreen bytes",
  );
  await p.click('#glance-ui button[aria-label="Open Updated layout preview"]');
  await p.waitForSelector('[role="dialog"]', { visible: true, timeout: 3000 });

  const overlay = await p.evaluate(() => ({
    title: document.querySelector('[role="dialog"] h2')?.textContent,
    hidden: document
      .querySelector("[data-qa-root]")
      .getAttribute("aria-hidden"),
    inert: document.querySelector("[data-qa-root]").inert,
    images: document.querySelectorAll('[role="dialog"] img').length,
  }));

  ensure(
    overlay.title === "Updated layout" &&
      overlay.images === 1 &&
      overlay.hidden === null &&
      !overlay.inert,
    "The real core image viewer failed or hid the app root",
  );
  await p.keyboard.press("Escape");
  await p.waitForFunction(() => !document.querySelector('[role="dialog"]'), {
    timeout: 3000,
  });
  await p.waitForFunction(
    () => !document.querySelector('[data-testid="image-lightbox-exit"]'),
    { timeout: 3000 },
  );
  ensure(
    (await p.evaluate(() =>
      document.activeElement?.getAttribute("aria-label"),
    )) === "Open Updated layout preview",
    "Closing the image viewer did not restore focus",
  );
  await p.shot({ type: "jpeg", maxEdge: 1200, quality: 75 });
  await p.$eval("#lazy-ui", (node) => node.scrollIntoView({ block: "start" }));
  await p.waitForSelector('#lazy-ui img[alt="Offscreen result preview"]', {
    timeout: 3000,
  });
  await p.click('#glance-ui a[data-glance-thread="thr_origin"]');

  const attention = await p.evaluate(() => ({
    navigated: globalThis.__orcaVisualProof.state.navigated,
    markSeen: globalThis.__orcaVisualProof.state.markSeen,
    changed:
      document.querySelector('#glance-ui [aria-label="Changed"]') !== null,
    answers: Array.from(document.querySelectorAll("#glance-ui button")).filter(
      (button) => /^(Yes|Continue|Approve)$/u.test(button.textContent.trim()),
    ).length,
  }));

  ensure(
    attention.navigated.length === 1 &&
      attention.navigated[0] === "thr_origin" &&
      attention.markSeen === 0 &&
      attention.changed &&
      attention.answers === 0,
    "Visual results changed native attention/read semantics",
  );
  await clickButton("#glance-ui", "Close result views");
  await p.waitForFunction(
    () =>
      globalThis.__orcaVisualProof.urls.created.every((url) =>
        globalThis.__orcaVisualProof.urls.revoked.includes(url),
      ),
    { timeout: 3000 },
  );

  const final = await p.evaluate(() => ({
    reads: globalThis.__orcaVisualProof.calls.filter(
      (call) => call.method === "attachments.read",
    ),
    urlCount: globalThis.__orcaVisualProof.urls.created.length,
    noHorizontalOverflow:
      document.documentElement.scrollWidth <= window.innerWidth + 1,
    coarse: matchMedia("(pointer:coarse)").matches,
    dpr: devicePixelRatio,
  }));

  ensure(
    final.reads.length === 2 &&
      final.reads[1].projectId === "project_offscreen",
    "Offscreen reads did not remain lazy",
  );
  ensure(
    final.urlCount === 2 && final.noHorizontalOverflow,
    "Image URLs leaked or the narrow page overflowed",
  );
  results.push({
    viewport,
    letterboxed: point.letterboxed,
    touches: final.coarse,
    dpr: final.dpr,
    lazyImageReads: final.reads.length,
    nativeAttentionPreserved: true,
    ownedComposer: true,
    staleNotesPreserved: true,
    imageUrlsReleased: final.urlCount,
  });
}

ensure(errors.length === 0, `Browser errors: ${errors.join("; ")}`);

ensure(deniedOrigins.length === 0, "The fixture attempted an external request");

console.log(
  JSON.stringify({
    passed: true,
    results,
    browserErrors: errors,
    deniedOrigins,
    surface:
      "Actual local components and browser; schema-validated RPC fixtures and real SDK transport with synthetic fetch responses",
  }),
);
