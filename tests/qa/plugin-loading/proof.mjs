import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const pluginId = "loading-proof";

const panelPath = `/plugins/${pluginId}/proof`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function source(version, background = false, portalImport = "named") {
  return `${background ? "await new Promise(resolve=>setTimeout(resolve,1200));" : ""}const {react:R,pluginSdkApp:S}=globalThis.__omnyoPluginRuntime;
const e=R.createElement;const version=${JSON.stringify(version)};const portal=${portalImport === "default" ? "globalThis.__omnyoPluginRuntime.reactDom.default.createPortal" : "globalThis.__omnyoPluginRuntime.reactDom.createPortal"};
function Section(){const rpc=S.useRpc();const state=S.usePluginResource({key:['snapshot'],load:()=>rpc.call('snapshot',null)});return e('section',{'data-proof-section':'snapshot','data-ready':state.status==='success'},e('h2',null,'Issues'),state.data?e('button',{'data-proof-action':'issues',onClick:()=>{document.body.dataset.proofClicked='yes'}},state.data.label):e('p',{role:'status'},'Loading issues'));}
function Page(){const [draft,setDraft]=R.useState('');const [modal,setModal]=R.useState(false);R.useEffect(()=>{const counts=globalThis.__loadingProofEffects??={};const row=counts[${JSON.stringify(version)}]??={attach:0,dispose:0,active:0};row.attach++;row.active++;return ()=>{row.dispose++;row.active--;};},[]);return e('div',{'data-proof-page':${JSON.stringify(version)},style:{height:'100%',display:'grid',gridTemplateRows:'64px 1fr'}},e('header',null,e('h1',null,'Loading proof ${version}')),${background ? "e('input',{'aria-label':'Background focus target'})" : "e('div',null,e('input',{'aria-label':'Local panel draft',value:draft,onChange:event=>setDraft(event.target.value)}),e('button',{onClick:()=>setModal(true)},'Open proof modal'),modal&&portal(e('section',{role:'dialog','aria-label':'Proof modal','data-proof-portal':version,style:{position:'fixed',left:100,top:100,width:400,height:200,background:'white',zIndex:9999}},e('input',{'aria-label':'Modal focus target',autoFocus:true}),e('button',{onClick:()=>setModal(false)},'Close proof modal')),document.body),e(Section),e(Section))"});}
export default S.definePluginApp(app=>{globalThis.__loadingProofActivations??={};globalThis.__loadingProofActivations[${JSON.stringify(version)}]=(globalThis.__loadingProofActivations[${JSON.stringify(version)}]??0)+1;app.slots.navPanel({id:'proof',title:${JSON.stringify(background ? "Background proof" : "Loading proof")},path:'proof',icon:'ListTodo',component:Page});});`;
}

function summary(id, version, code) {
  return {
    id,
    name: id,
    icon: "ListTodo",
    version: "0.0.0",
    source: `/fixture/${id}`,
    rootDir: `/fixture/${id}`,
    provenance: "direct",
    isOrphanedBuiltin: false,
    publisherLabel: null,
    sourceDisplay: "Local browser fixture",
    updateState: { outcome: "pinned" },
    enabled: true,
    description: "Local browser fixture",
    screenshots: [],
    collections: [],
    iconUrl: null,
    status: "running",
    statusDetail: null,
    handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
    services: [],
    schedules: [],
    cliCommand: null,
    capabilities: [],
    hasSettings: false,
    logoUrl: null,
    logoDarkUrl: null,
    providerIds: [],
    icons: {},
    app: {
      hasApp: true,
      bundle: {
        jsUrl: `/api/v1/plugin-app-assets/proof-${id}-${version}/app.js`,
        cssUrl: `/api/v1/plugin-app-assets/proof-${id}-${version}/app.css`,
        jsBytes: Buffer.byteLength(code),
        hash: `proof-${id}-${version}`,
        sdkMajor: 0,
        sdkVersion: "0.6.42",
        compatible: true,
      },
    },
  };
}

async function geometry(page) {
  return page
    .locator('[data-testid="plugin-panel-body"]:visible')
    .boundingBox();
}

function stable(before, after) {
  assert.ok(
    before && after,
    "Plugin panel body exists in pending and ready states",
  );

  for (const key of ["x", "y", "width", "height"])
    assert.ok(
      Math.abs(before[key] - after[key]) <= 1,
      `${key} shifted: ${before[key]} -> ${after[key]}`,
    );
}

export async function runPluginLoadingProof({
  browser,
  origin,
  output,
  appBuild,
  validateRegistry,
  notifyChanged,
}) {
  const result = {
    fixtureOnly: true,
    proofSha256: createHash("sha256")
      .update(await readFile(new URL(import.meta.url)))
      .digest("hex"),
    appBuild,
    browserVersion: browser.version(),
    scenarios: [],
    errors: [],
    cleanup: false,
  };

  try {
    for (const networkDelayMs of [0, 350]) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      });

      await context.route(
        (url) => url.origin !== origin,
        (route) => route.abort(),
      );
      context.setDefaultTimeout(5000);
      const portalImport = networkDelayMs === 350 ? "default" : "named";
      let version = "A";
      const requests = [];
      const errors = [];

      const scenario = {
        networkDelayMs,
        portalImport,
        requests,
        pageErrors: errors,
      };

      result.scenarios.push(scenario);
      let release;

      let gate = new Promise((resolve) => {
        release = resolve;
      });

      let releaseAssets;

      const assetsReady = new Promise((resolve) => {
        releaseAssets = resolve;
      });

      try {
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        await page.route(/\/api\/v1\/plugins(?:\?.*)?$/, async (route) => {
          const response = await route.fetch();
          const body = await response.json();

          const plugins = [
            summary(pluginId, version, source(version, false, portalImport)),
            summary(
              "loading-background",
              "A",
              source("background", true, portalImport),
            ),
          ];

          await route.fulfill({
            response,
            json: validateRegistry({ ...body, plugins }),
          });
        });
        await page.route(
          /\/api\/v1\/plugin-app-assets\/proof-.*\/app\.(js|css)$/,
          async (route) => {
            const path = new URL(route.request().url()).pathname;
            const request = { kind: "asset", path, startedAt: Date.now() };
            requests.push(request);
            await assetsReady;
            await delay(networkDelayMs);

            if (path.endsWith(".css")) {
              await delay(250);
              request.finishedAt = Date.now();

              return route.fulfill({
                status: 200,
                contentType: "text/css",
                body: "[data-proof-page] header{min-height:64px}[data-proof-section]{min-height:100px}",
              });
            }

            const background = path.includes("loading-background");

            const code = source(
              background ? "background" : version,
              background,
              portalImport,
            );

            await route.fulfill({
              status: 200,
              contentType: "text/javascript",
              body: code,
            });
          },
        );
        await page.route(
          /\/api\/v1\/plugins\/loading-proof\/rpc\/snapshot$/,
          async (route) => {
            requests.push({ kind: "snapshot", version, startedAt: Date.now() });
            await gate;
            await delay(networkDelayMs);
            await route.fulfill({
              status: 200,
              json: { ok: true, result: { label: `3 issues ${version}` } },
            });
          },
        );
        const started = Date.now();
        await page.goto(origin + panelPath, { waitUntil: "domcontentloaded" });
        await page
          .getByRole("status", { name: "Loading plugin panel" })
          .waitFor({ timeout: 5000 });
        const pending = await geometry(page);
        releaseAssets();
        await page
          .locator('[data-proof-page="A"]')
          .waitFor({ state: "attached", timeout: 5000 });
        assert.equal(
          await page.locator('[data-proof-page="A"]').isVisible(),
          false,
          "Cold data remains covered until all sections are ready",
        );
        assert.equal(
          await page.evaluate(
            () => globalThis.__loadingProofActivations.background,
          ),
          undefined,
          "Active page publishes before an unrelated slow module settles",
        );
        const beforeData = await geometry(page);
        stable(pending, beforeData);
        assert.equal(
          await page
            .locator('[data-proof-section][data-ready="false"]')
            .count(),
          2,
        );

        await page.waitForFunction(
          () =>
            Array.from(document.styleSheets).some((sheet) =>
              sheet.href?.includes("proof-loading-proof"),
            ),
          undefined,
          { timeout: 5000 },
        );

        const sectionBoxes = await page
          .locator("[data-proof-section]")
          .evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().toJSON()),
          );

        const cssRequest = requests.find(
          (row) =>
            row.kind === "asset" &&
            row.path.includes("loading-proof") &&
            row.path.endsWith(".css"),
        );

        const snapshotRequest = requests.find((row) => row.kind === "snapshot");
        assert.ok(
          snapshotRequest,
          "Data request starts while content is covered",
        );
        assert.ok(
          cssRequest &&
            (!cssRequest.finishedAt ||
              snapshotRequest.startedAt < cssRequest.finishedAt),
          "Styles and data load concurrently",
        );
        release();
        await page
          .locator('[data-proof-section][data-ready="true"]')
          .first()
          .waitFor({ timeout: 5000 });
        assert.equal(
          await page.locator('[data-proof-section][data-ready="true"]').count(),
          2,
        );
        const headerUsableMs = Date.now() - started;
        const allVisibleUsableMs = Date.now() - started;

        const readySectionBoxes = await page
          .locator("[data-proof-section]")
          .evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().toJSON()),
          );

        for (let index = 0; index < sectionBoxes.length; index++)
          stable(sectionBoxes[index], readySectionBoxes[index]);
        stable(pending, await geometry(page));
        await page.locator('[data-proof-action="issues"]').first().click();
        assert.equal(
          await page.evaluate(() => document.body.dataset.proofClicked),
          "yes",
        );
        assert.equal(
          requests.filter((row) => row.kind === "snapshot").length,
          1,
          "Concurrent sections share one request",
        );
        await page
          .getByRole("textbox", { name: "Local panel draft" })
          .fill("retained local draft");
        await page
          .getByRole("button", { name: "Background proof", exact: true })
          .first()
          .click();
        await page
          .locator('[data-proof-page="background"]')
          .waitFor({ timeout: 5000 });
        assert.equal(
          new URL(page.url()).pathname,
          "/plugins/loading-background/proof",
        );
        assert.equal(
          await page.locator('[data-proof-portal="A"]').isVisible(),
          false,
          "Hidden plugin portal leaves the visible page",
        );
        await page
          .getByRole("textbox", { name: "Background focus target" })
          .fill("other page usable");
        assert.equal(
          await page.evaluate(() =>
            document.activeElement?.getAttribute("aria-label"),
          ),
          "Background focus target",
        );
        await page.waitForFunction(
          () => globalThis.__loadingProofEffects.A.active === 0,
          undefined,
          { timeout: 5000 },
        );

        const effectsWhileAway = await page.evaluate(
          () => globalThis.__loadingProofEffects,
        );

        assert.equal(
          effectsWhileAway.A.active,
          0,
          "Hidden page effects disconnect",
        );
        const returned = Date.now();
        await page
          .getByRole("button", { name: "Loading proof", exact: true })
          .first()
          .click();
        await page
          .locator('[data-proof-section][data-ready="true"]')
          .first()
          .waitFor({ timeout: 5000 });
        const warmUsableMs = Date.now() - returned;
        assert.equal(new URL(page.url()).pathname, panelPath);
        assert.equal(
          await page
            .getByRole("textbox", { name: "Local panel draft" })
            .inputValue(),
          "retained local draft",
          "Warm navigation preserves local React state",
        );
        assert.equal(
          await page.evaluate(() => globalThis.__loadingProofEffects.A.active),
          1,
          "Only the visible page effect is active",
        );
        assert.equal(
          requests.filter((row) => row.kind === "snapshot").length,
          1,
          "Warm navigation reuses the resource",
        );

        await page
          .getByRole("button", { name: /^Settings/ })
          .first()
          .click();
        await page.waitForURL((url) => url.pathname.startsWith("/settings"));
        await page.waitForFunction(
          () => globalThis.__loadingProofEffects.A.active === 0,
          undefined,
          { timeout: 5000 },
        );
        await page
          .getByRole("button", { name: /^Settings/ })
          .first()
          .click();
        await page
          .getByRole("textbox", { name: "Local panel draft" })
          .waitFor({ timeout: 5000 });
        assert.equal(
          await page
            .getByRole("textbox", { name: "Local panel draft" })
            .inputValue(),
          "retained local draft",
          "Ordinary settings round trip preserves local state",
        );
        await page
          .getByRole("button", { name: "Open proof modal", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Proof modal" })
          .waitFor({ timeout: 5000 });
        await page
          .getByRole("button", { name: "Background proof", exact: true })
          .first()
          .click();
        await page
          .locator('[data-proof-page="background"]')
          .waitFor({ timeout: 5000 });
        assert.equal(
          await page.locator('[data-proof-portal="A"]').isVisible(),
          false,
          "Open portal is removed when its panel hides",
        );
        await page
          .getByRole("textbox", { name: "Background focus target" })
          .fill("portal does not intercept");
        assert.equal(
          await page.evaluate(() =>
            document.activeElement?.getAttribute("aria-label"),
          ),
          "Background focus target",
        );
        await page
          .getByRole("button", { name: "Loading proof", exact: true })
          .first()
          .click();
        await page
          .locator('[data-proof-section][data-ready="true"]')
          .first()
          .waitFor({ timeout: 5000 });
        assert.equal(
          await page.getByRole("dialog", { name: "Proof modal" }).isVisible(),
          false,
          "Modal is closed on warm return",
        );
        assert.equal(
          requests.filter((row) => row.kind === "snapshot").length,
          1,
          "Portal teardown retains shared reads",
        );

        if (
          !(await page.getByRole("dialog", { name: "Proof modal" }).isVisible())
        )
          await page
            .getByRole("button", { name: "Open proof modal", exact: true })
            .click();
        await page
          .getByRole("button", { name: /^Settings/ })
          .first()
          .click();
        await page.waitForURL((url) => url.pathname.startsWith("/settings"));
        assert.equal(
          await page.locator('[data-proof-portal="A"]').isVisible(),
          false,
          "Settings is not covered by the hidden plugin portal",
        );

        const generalLink = page.getByRole("link", {
          name: "General",
          exact: true,
        });

        await generalLink.focus();
        assert.equal(
          await generalLink.evaluate(
            (element) => element === document.activeElement,
          ),
          true,
          "Settings focus is usable after portal departure",
        );
        await page.waitForFunction(
          () => globalThis.__loadingProofEffects.A.active === 0,
          undefined,
          { timeout: 5000 },
        );
        await page
          .getByRole("button", { name: /^Settings/ })
          .first()
          .click();
        await page
          .getByRole("textbox", { name: "Local panel draft" })
          .waitFor({ timeout: 5000 });
        assert.equal(new URL(page.url()).pathname, panelPath);
        assert.equal(
          await page.getByRole("dialog", { name: "Proof modal" }).isVisible(),
          false,
          "Settings return closes the modal",
        );
        assert.equal(
          requests.filter((row) => row.kind === "snapshot").length,
          1,
          "Settings portal teardown retains shared reads",
        );

        if (await page.getByRole("dialog", { name: "Proof modal" }).isVisible())
          await page
            .getByRole("button", { name: "Close proof modal", exact: true })
            .click();
        version = "B";
        gate = new Promise((resolve) => {
          release = resolve;
        });
        notifyChanged();
        await page
          .locator('[data-proof-page="B"]')
          .waitFor({ state: "attached", timeout: 5000 });
        assert.equal(
          await page.locator('[data-proof-action="issues"]').count(),
          0,
          "Old generation data is not reused",
        );
        stable(pending, await geometry(page));
        release();
        await page
          .getByRole("button", { name: "3 issues B", exact: true })
          .first()
          .waitFor({ timeout: 5000 });
        assert.equal(
          requests.filter((row) => row.kind === "snapshot").length,
          2,
          "Generation replacement loads exactly once",
        );

        const activations = await page.evaluate(
          () => globalThis.__loadingProofActivations,
        );

        assert.equal(activations.A, 1);
        assert.equal(activations.B, 1);
        assert.equal(activations.background, 1);
        assert.deepEqual(errors, []);
        Object.assign(scenario, {
          networkDelayMs,
          headerUsableMs,
          allVisibleUsableMs,
          warmUsableMs,
          pending,
          sectionBoxes,
          readySectionBoxes,
          ready: await geometry(page),
          activations,
          effectsWhileAway,
          portalHiddenOnDeparture: true,
          portalClosedOnReturn: true,
          localDraftPreservedWithoutPortal: true,
          effectsAtCompletion: await page.evaluate(
            () => globalThis.__loadingProofEffects,
          ),
          requests,
        });
      } finally {
        releaseAssets();
        release();
        await context.unrouteAll({ behavior: "ignoreErrors" });
        await context.close();
      }
    }
  } catch (error) {
    result.errors.push(String(error));
    throw error;
  } finally {
    result.cleanup = true;
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  }

  return result;
}
