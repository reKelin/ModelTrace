import assert from "node:assert/strict";
import test from "node:test";

import { buildCompletionRequest, completionUrl, extractCompletion } from "../static/api-client.js";

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
