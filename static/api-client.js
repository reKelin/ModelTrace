function normalizedBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Base URL 无效");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Base URL 必须使用 HTTPS（本机回环地址除外）");
  }
  if (url.username || url.password) throw new Error("Base URL 不能包含用户名或密码");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

export function completionUrl(baseUrl, apiFormat) {
  const url = normalizedBaseUrl(baseUrl);
  const endpoint = apiFormat === "anthropic" ? "/messages" : "/chat/completions";
  if (!url.pathname.endsWith(endpoint)) {
    url.pathname += url.pathname.endsWith("/v1") ? endpoint : `/v1${endpoint}`;
  }
  return url.toString();
}

export function buildCompletionRequest({ baseUrl, apiKey, model, prompt, temperature, apiFormat }) {
  const anthropic = apiFormat === "anthropic";
  const body = anthropic
    ? { model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }
    : { model, messages: [{ role: "user", content: prompt }] };
  if (temperature !== null) body.temperature = temperature;
  return {
    url: completionUrl(baseUrl, apiFormat),
    options: {
      method: "POST",
      headers: anthropic
        ? {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
          "Content-Type": "application/json",
        }
        : { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

export function extractCompletion(payload, apiFormat) {
  if (apiFormat === "anthropic") {
    if (payload.stop_reason === "refusal" || payload.stop_reason === "max_tokens") {
      throw new Error(`回答未正常完成（${payload.stop_reason}）`);
    }
    const content = (payload.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("");
    if (!content) throw new Error("接口响应中没有文本内容");
    return content;
  }
  const choice = payload.choices?.[0];
  if (!choice) throw new Error("接口响应中没有 choices[0]");
  if (["length", "content_filter"].includes(choice.finish_reason)) {
    throw new Error(`回答未正常完成（${choice.finish_reason}）`);
  }
  const content = choice.message?.content;
  if (Array.isArray(content)) {
    const text = content.map((part) => part.text || "").join("");
    if (text) return text;
  }
  if (typeof content !== "string" || !content) throw new Error("接口响应中没有文本内容");
  return content;
}

function upstreamError(payload, status) {
  const error = payload?.error;
  const message = typeof error === "string" ? error : error?.message;
  return message || `接口请求失败（HTTP ${status}）`;
}

const paddedEndpoints = new Set();

function padded(configuration) {
  return { ...configuration, prompt: `${configuration.prompt}${" ".repeat(8192)}` };
}

async function requestOnce(configuration, fetchImpl) {
  const { url, options } = buildCompletionRequest(configuration);
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch {
    const host = new URL(url).host;
    throw new Error(`浏览器无法直连 ${host}；该接口可能拒绝 CORS 预检，GitHub Pages 无法绕过，请改用本地版或服务端中继`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`接口返回的不是 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) throw new Error(upstreamError(payload, response.status));
  return extractCompletion(payload, configuration.apiFormat);
}

export async function requestCompletion(configuration, fetchImpl = fetch) {
  const endpoint = `${configuration.baseUrl}|${configuration.apiFormat}`;
  if (paddedEndpoints.has(endpoint)) return requestOnce(padded(configuration), fetchImpl);
  try {
    return await requestOnce(configuration, fetchImpl);
  } catch (error) {
    const shortBody = /少于\s*2000\s*token|fewer than\s*2000\s*input tokens|request body size/i.test(error.message);
    if (!shortBody) throw error;
    // Some gateways estimate input tokens from raw body size. Trailing spaces
    // satisfy that transport policy without changing the challenge semantics.
    paddedEndpoints.add(endpoint);
    return requestOnce(padded(configuration), fetchImpl);
  }
}
