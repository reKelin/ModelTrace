import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildCompletionRequest, completionUrl, extractCompletion, loadModels, modelsUrl, requestCompletion } from "../static/api-client.js";

test("channel models use a native select instead of an unreliable datalist", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../static/index.html", import.meta.url), "utf8"),
    readFile(new URL("../static/pages-app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /<select id="channel-model-select"/);
  assert.doesNotMatch(html, /<datalist/);
  assert.match(app, /byId\("channel-model-select"\)\.addEventListener\("change"/);
});

test("automatic testing has a fixed retry budget and updates every valid result", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../static/index.html", import.meta.url), "utf8"),
    readFile(new URL("../static/pages-app.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /test-attempts|test-concurrency/);
  assert.match(app, /const maxAttempts = 10;/);
  assert.match(app, /const concurrency = 3;/);
  assert.match(app, /if \(shouldRetry\) await worker\(\);/);
  assert.match(app, /renderResult\(analyzeGlobalOutputs\(currentOutputs, state\.bank\)/);
});

test("completion URL accepts a base URL or a complete endpoint", () => {
  assert.equal(completionUrl("https://example.test/v1", "openai"), "https://example.test/v1/chat/completions");
  assert.equal(completionUrl("https://example.test", "openai-responses"), "https://example.test/v1/responses");
  assert.equal(completionUrl("https://example.test/v1/messages", "anthropic"), "https://example.test/v1/messages");
  assert.equal(modelsUrl("https://example.test/v1/chat/completions"), "https://example.test/v1/models");
  assert.throws(() => completionUrl("http://example.test/v1", "openai"), /HTTPS/);
});

test("OpenAI request sends the key only in the authorization header", () => {
  const request = buildCompletionRequest({
    baseUrl: "https://example.test/v1",
    apiKey: "secret-key",
    model: "model-a",
    prompt: "prompt",
    temperature: null,
    apiFormat: "openai",
  });
  assert.equal(request.options.headers.Authorization, "Bearer secret-key");
  assert.equal(request.url.includes("secret-key"), false);
  assert.equal(request.options.body.includes("secret-key"), false);
});

test("completion text is extracted from both supported formats", () => {
  assert.equal(extractCompletion({ choices: [{ message: { content: "openai" } }] }, "openai"), "openai");
  assert.equal(extractCompletion({ output: [{ content: [{ type: "output_text", text: "responses" }] }] }, "openai-responses"), "responses");
  assert.equal(extractCompletion({ content: [{ type: "text", text: "anthropic" }] }, "anthropic"), "anthropic");
});

test("Responses requests use the Responses body shape", () => {
  const request = buildCompletionRequest({
    baseUrl: "https://example.test",
    apiKey: "secret-key",
    model: "model-a",
    prompt: "prompt",
    temperature: null,
    apiFormat: "openai-responses",
  });
  assert.equal(request.url, "https://example.test/v1/responses");
  assert.deepEqual(JSON.parse(request.options.body), { model: "model-a", input: "prompt", max_output_tokens: 4096 });
});

test("channel model discovery uses the normalized models endpoint", async () => {
  let captured;
  const models = await loadModels({
    baseUrl: "https://example.test",
    apiKey: "secret-key",
    apiFormat: "openai",
  }, async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "z-model" }, { id: "a-model" }] }) };
  });
  assert.equal(captured.url, "https://example.test/v1/models");
  assert.equal(captured.options.headers.Authorization, "Bearer secret-key");
  assert.deepEqual(models, ["a-model", "z-model"]);
});

test("short-body gateways are retried once with semantics-neutral padding", async () => {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "This key does not accept requests with fewer than 2000 input tokens (judged by request body size)." }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    };
  };
  const text = await requestCompletion({
    baseUrl: "https://example.test/v1",
    apiKey: "secret-key",
    model: "model-a",
    prompt: "prompt",
    temperature: null,
    apiFormat: "openai",
  }, fetchImpl);
  assert.equal(text, "ok");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages[0].content.startsWith("prompt"), true);
  assert.equal(requests[1].messages[0].content.length >= 8198, true);

  const laterRequests = [];
  await requestCompletion({
    baseUrl: "https://example.test/v1",
    apiKey: "secret-key",
    model: "model-a",
    prompt: "next",
    temperature: null,
    apiFormat: "openai",
  }, async (_url, options) => {
    laterRequests.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
    };
  });
  assert.equal(laterRequests.length, 1);
  assert.equal(laterRequests[0].messages[0].content.length >= 8196, true);
});

test("browser transport failures explain the static-hosting limitation", async () => {
  await assert.rejects(
    requestCompletion({
      baseUrl: "https://example.test/v1",
      apiKey: "secret-key",
      model: "model-a",
      prompt: "prompt",
      temperature: null,
      apiFormat: "openai",
    }, async () => { throw new TypeError("Failed to fetch"); }),
    /CORS.*GitHub Pages/,
  );
});
