import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { chromium } from "playwright";

// Serve the same relative paths as the Pages deployment, including its project prefix.
const root = new URL("../", import.meta.url);
const assets = new Set(["index.html", "styles.css", "api-test-form.css", "repository-link.css",
  "pages-app.js", "api-client.js", "fingerprint-core.js", "challenge-browser.js"]);
const bank = JSON.parse(await readFile(new URL("data/unified_bank.json", root), "utf8"));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const name = pathname.startsWith("/ModelTrace/") ? pathname.slice("/ModelTrace/".length) || "index.html" : null;
  const file = name === "data/unified_bank.json" ? name : assets.has(name) ? `static/${name}` : null;
  if (!file) return response.writeHead(404).end();
  try {
    const content = await readFile(new URL(file, root));
    const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css"
      : name.endsWith(".json") ? "application/json" : "text/html";
    response.writeHead(200, { "Content-Type": type }).end(content);
  } catch {
    response.writeHead(404).end();
  }
});
let browser;
let baseURL;
before(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}/ModelTrace/`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});

async function pageFor(t) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  // Tests must never contact a model provider or any external service.
  await page.route("**/*", route => route.request().url().startsWith(baseURL) ? route.continue() : route.abort());
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "page startup must not throw JavaScript errors");
  });
  return page;
}

async function ready(page) {
  await page.goto(baseURL);
  await page.locator("#regenerate:not([disabled])").waitFor();
  assert.equal(await page.locator("#analyze").isEnabled(), true);
  assert.equal(await page.locator("#challenge-list .challenge-item").count(), 3);
  assert.equal(await page.locator("#test-message").isVisible(), false);
  const responses = bank.models.reduce((total, model) => total + model.response_count, 0);
  assert.equal(await page.locator("#active-bank-badge").textContent(), `${bank.models.length} 个模型 · ${responses} 条指纹`);
}

test("Pages initializes the real HTML, modules and bank under its project URL", async t => {
  const page = await pageFor(t);
  await ready(page);
  await page.locator('[data-test-mode="api"]').click();
  assert.equal(await page.locator("#api-test-form button[type=submit]").isEnabled(), true);
});

test("Pages bypasses the stale unversioned entry script", async t => {
  const page = await pageFor(t);
  let staleHits = 0;
  // An old cached entry uses the pre-refactor element ID and crashes before bank loading.
  await page.route("**/pages-app.js", route => {
    staleHits++;
    return route.fulfill({ contentType: "text/javascript",
      body: 'document.getElementById("load-channel-models").addEventListener("click", () => {});' });
  });
  await ready(page);
  assert.equal(staleHits, 0, "the generated entry must not request the stale URL");
});

for (const [name, response, message] of [
  ["missing", { status: 404, body: "missing" }, "HTTP 404"],
  ["invalid JSON", { contentType: "application/json", body: "not JSON" }, "HTTP 服务或 GitHub Pages"],
]) {
  test(`Pages reports a ${name} bank instead of remaining in loading state`, async t => {
    const page = await pageFor(t);
    await page.route("**/data/unified_bank.json", route => route.fulfill(response));
    await page.goto(baseURL);
    await page.locator("#test-message.error").waitFor();
    assert.ok((await page.locator("#test-message").textContent()).includes(message));
    for (const selector of ["#regenerate", "#analyze", "#api-test-form button[type=submit]"]) {
      assert.equal(await page.locator(selector).isDisabled(), true);
    }
  });
}

test("API controls switch providers and load a filtered model catalog", async t => {
  const page = await pageFor(t);
  await ready(page);
  await page.locator('[data-test-mode="api"]').click();
  await page.locator("#test-api-key").fill("fixture-custom-key");
  await page.locator("#test-provider").selectOption("orcarouter");
  assert.equal(await page.locator("#test-api-key").inputValue(), "");
  assert.equal(await page.locator("#test-api-base").inputValue(), "https://api.orcarouter.ai/v1");
  await page.route("https://api.orcarouter.ai/v1/models", route => route.fulfill({ json: { data: [
    { id: "fixture-chat", supported_endpoint_types: ["openai"] },
    { id: "fixture-image", supported_endpoint_types: ["image-generation"] },
  ] } }));
  await page.locator("#test-api-key").fill("fixture-orca-key");
  await page.locator("#load-custom-models").click();
  await page.waitForFunction(() => document.getElementById("custom-channel-model-select").value === "fixture-chat");
  assert.deepEqual(await page.locator("#custom-channel-model-select option").allTextContents(), ["fixture-chat"]);
  await page.locator("#test-api-format").selectOption("anthropic");
  assert.equal(await page.locator("#custom-channel-model-select").inputValue(), "");
  await page.locator("#test-provider").selectOption("custom");
  assert.equal(await page.locator("#test-api-key").inputValue(), "");
  assert.equal(await page.locator("#test-api-base").inputValue(), "");
});
