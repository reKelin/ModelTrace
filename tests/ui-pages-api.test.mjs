import assert from "node:assert/strict";
import test from "node:test";

import { buildCompletionRequest, completionUrl, extractCompletion, requestCompletion } from "../static/api-client.js";

test("completion URL accepts a base URL or a complete endpoint", () => {
  assert.equal(completionUrl("https://example.test/v1", "openai"), "https://example.test/v1/chat/completions");
  assert.equal(completionUrl("https://example.test/v1/messages", "anthropic"), "https://example.test/v1/messages");
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
  assert.equal(extractCompletion({ content: [{ type: "text", text: "anthropic" }] }, "anthropic"), "anthropic");
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
