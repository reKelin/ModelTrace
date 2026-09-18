import { analyzeGlobalOutputs, parseNumbers } from "./fingerprint-core.js";
import { generateChallenges } from "./challenge-browser.js";
import { loadModels, requestCompletion } from "./api-client.js";

const state = { bank: null, challenges: [] };
const byId = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function setMessage(text, type = "error") {
  const element = byId("test-message");
  element.textContent = text;
  element.className = `message ${type}`;
  element.hidden = !text;
}

function activateMode(name) {
  document.querySelectorAll("[data-test-mode]").forEach((item) => item.classList.toggle("active", item.dataset.testMode === name));
  document.querySelectorAll(".mode-panel").forEach((item) => item.classList.toggle("active", item.id === `test-${name}`));
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  button.textContent = "已复制";
  window.setTimeout(() => { button.textContent = "复制提示词"; }, 1000);
}

function renderChallenges() {
  byId("result").hidden = true;
  byId("challenge-list").innerHTML = state.challenges.map((challenge, index) => `
    <article class="challenge-item">
      <div class="challenge-header">
        <strong>挑战 ${index + 1}</strong>
        <span>${challenge.expected_count} 个数字</span>
        <button type="button" data-copy="${index}">复制提示词</button>
      </div>
      <div class="challenge-columns">
        <div><label>发送给待测模型</label><pre>${escapeHtml(challenge.prompt)}</pre></div>
        <div><label for="output-${index}">粘贴完整输出</label><textarea id="output-${index}" spellcheck="false" placeholder="保留文字、标点、代码块和完整数字序列"></textarea></div>
      </div>
    </article>
  `).join("");
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => copyText(state.challenges[Number(button.dataset.copy)].prompt, button));
  });
}

function regenerate() {
  state.challenges = generateChallenges(3);
  setMessage("");
  renderChallenges();
}

function renderResult(payload) {
  const diagnostics = payload.diagnostics.map((item, index) => `
    <span class="diagnostic ${item.accepted ? "accepted" : "rejected"}">挑战 ${index + 1}: ${item.parsed_numbers} 个数字 · ${item.accepted ? "计入" : "忽略"}</span>
  `).join("");
  const rows = payload.results.map((item, index) => `
    <tr class="${index === 0 ? "winner" : ""}">
      <td>${index + 1}</td>
      <td><strong>${escapeHtml(item.display_name)}</strong></td>
      <td>${escapeHtml(item.family_name)}</td>
      <td><div class="probability-cell"><span><i style="width:${item.probability * 100}%"></i></span><strong>${percent(item.probability)}</strong></div></td>
      <td>${percent(item.profile_similarity)}</td>
    </tr>
  `).join("");
  const result = byId("result");
  result.innerHTML = `
    <div class="result-summary">
      <div><span>最可能模型</span><strong>${escapeHtml(payload.prediction_name)}</strong></div>
      <div><span>统一库概率</span><strong>${percent(payload.probability)}</strong></div>
      <div><span>模型家族</span><strong>${escapeHtml(payload.family_prediction_name)} · ${percent(payload.family_probability)}</strong></div>
      <div><span>有效查询</span><strong>${payload.used_outputs}/3</strong></div>
    </div>
    <div class="diagnostics">${diagnostics}</div>
    <div class="table-wrap"><table><thead><tr><th>排序</th><th>候选模型</th><th>家族</th><th>归因概率</th><th>分布相似度</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="result-guidance" role="note" aria-label="结果说明">
      <p>本工具仅对指纹库内的模型进行归因；若待测模型不在指纹库中，得到任何结果都有可能。</p>
      <p>Claude Code 的系统提示词会影响模型偏好，测试结果存在较大偏差，建议不要在 Claude Code 中测试。</p>
    </div>
  `;
  result.hidden = false;
  result.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function analyze() {
  const button = byId("analyze");
  button.disabled = true;
  byId("result").hidden = true;
  setMessage("正在浏览器本地计算……", "working");
  await new Promise((resolve) => requestAnimationFrame(resolve));
  try {
    const outputs = state.challenges.map((challenge, index) => ({
      text: byId(`output-${index}`).value,
      expected_count: challenge.expected_count,
    }));
    renderResult(analyzeGlobalOutputs(outputs, state.bank));
    setMessage("");
  } catch (error) {
    setMessage(error.message || "无法完成归因。", "error");
  } finally {
    button.disabled = false;
  }
}

function renderApiProgress(states, status) {
  const valid = states.filter((value) => value === "done").length;
  const attempted = states.filter((value) => ["done", "unused", "invalid", "error"].includes(value)).length;
  byId("api-test-progress").hidden = false;
  byId("api-progress-status").textContent = status;
  byId("api-progress-count").textContent = `有效 ${valid}/3 · 已尝试 ${attempted}/${states.length}`;
  byId("api-progress-fill").style.width = `${(valid / 3) * 100}%`;
  byId("api-progress-steps").innerHTML = states.map((value, index) => {
    const labels = { pending: "等待", working: "请求中", done: "有效", unused: "未采用", invalid: "数字不足", error: "接口失败", skipped: "无需调用" };
    return `<span class="progress-step ${value}"><b>${index + 1}</b>挑战 ${index + 1} · ${labels[value]}</span>`;
  }).join("");
}

async function testViaApi(event) {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  byId("result").hidden = true;
  setMessage("");
  const maxAttempts = Math.min(12, Math.max(3, Number(byId("test-attempts").value) || 6));
  const concurrency = Math.min(6, Math.max(1, Number(byId("test-concurrency").value) || 3));
  const target = 3;
  const challenges = generateChallenges(maxAttempts);
  const states = challenges.map(() => "pending");
  const outputs = [];
  const errors = [];
  const temperatureValue = byId("test-temperature").value.trim();
  const configuration = {
    baseUrl: byId("test-api-base").value.trim(),
    apiKey: byId("test-api-key").value,
    model: byId("test-api-model").value.trim(),
    apiFormat: byId("test-api-format").value,
    temperature: temperatureValue === "" ? null : Number(temperatureValue),
  };
  renderApiProgress(states, "已生成独立挑战，准备调用模型");

  let nextIndex = 0;
  async function worker() {
    while (outputs.length < target && nextIndex < challenges.length) {
      const index = nextIndex;
      nextIndex += 1;
      states[index] = "working";
      renderApiProgress(states, `并发 ${concurrency} · 当前已有 ${outputs.length}/${target} 份有效回答`);
      try {
        const text = await requestCompletion({ ...configuration, prompt: challenges[index].prompt });
        const parsedNumbers = parseNumbers(text).length;
        const minimumNumbers = Math.max(80, Math.ceil(challenges[index].expected_count * 0.55));
        if (parsedNumbers >= minimumNumbers && outputs.length < target) {
          outputs.push({ index, text, expected_count: challenges[index].expected_count });
          states[index] = "done";
        } else if (parsedNumbers >= minimumNumbers) {
          states[index] = "unused";
        } else {
          errors.push(`尝试 ${index + 1}: 有效数字 ${parsedNumbers}/${minimumNumbers}`);
          states[index] = "invalid";
        }
      } catch (error) {
        errors.push(`尝试 ${index + 1}: ${error.message}`);
        states[index] = "error";
      }
      renderApiProgress(states, `当前已有 ${outputs.length}/${target} 份有效回答`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, challenges.length) }, () => worker()));

  if (outputs.length === target) states.forEach((value, index) => { if (value === "pending") states[index] = "skipped"; });
  if (!outputs.length) {
    renderApiProgress(states, `${maxAttempts} 次尝试后仍没有可用回答`);
    setMessage(`没有获得可分析输出。${errors[0] || ""}`);
    button.disabled = false;
    return;
  }
  outputs.sort((left, right) => left.index - right.index);
  renderApiProgress(states, `测试完成：${outputs.length}/${target} 份有效回答进入归因`);
  renderResult(analyzeGlobalOutputs(outputs, state.bank));
  setMessage(errors.length ? `部分尝试未计入：${errors[0]}` : "", errors.length ? "error" : "success");
  button.disabled = false;
}

async function loadChannelModels() {
  const button = byId("load-channel-models");
  button.disabled = true;
  setMessage("正在读取渠道模型目录……", "working");
  try {
    const models = await loadModels({
      baseUrl: byId("test-api-base").value.trim(),
      apiKey: byId("test-api-key").value,
      apiFormat: byId("test-api-format").value,
    });
    const input = byId("test-api-model");
    const select = byId("channel-model-select");
    const selected = models.includes(input.value.trim()) ? input.value.trim() : models[0];
    select.innerHTML = `${models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")}<option value="">手动填写…</option>`;
    select.value = selected;
    input.value = selected;
    input.hidden = true;
    select.hidden = false;
    setMessage(`已加载 ${models.length} 个模型，并选中 ${selected}。`, "success");
  } catch (error) {
    setMessage(error.message || "模型目录加载失败。", "error");
  } finally {
    button.disabled = false;
  }
}

async function initialize() {
  try {
    const response = await fetch("./data/unified_bank.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`指纹库加载失败（HTTP ${response.status}）`);
    state.bank = await response.json();
    const responseCount = state.bank.models.reduce((sum, model) => sum + model.response_count, 0);
    byId("topbar-bank-count").textContent = `${state.bank.models.length} 个候选模型`;
    byId("active-bank-badge").textContent = `${state.bank.models.length} 个模型 · ${responseCount} 条指纹`;
    byId("regenerate").disabled = false;
    byId("analyze").disabled = false;
    regenerate();
  } catch (error) {
    setMessage(`${error.message}。请通过 HTTP 服务或 GitHub Pages 打开本页面。`, "error");
  }
}

byId("regenerate").addEventListener("click", regenerate);
byId("analyze").addEventListener("click", analyze);
byId("api-test-form").addEventListener("submit", testViaApi);
byId("load-channel-models").addEventListener("click", loadChannelModels);
byId("channel-model-select").addEventListener("change", (event) => {
  const input = byId("test-api-model");
  if (event.target.value) input.value = event.target.value;
  else {
    event.target.hidden = true;
    input.hidden = false;
    input.focus();
  }
});
document.querySelectorAll("[data-test-mode]").forEach((button) => button.addEventListener("click", () => activateMode(button.dataset.testMode)));
initialize();
