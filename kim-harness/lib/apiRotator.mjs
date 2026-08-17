// API Rotator — Multi-provider, auto-rotate, cooldown, streaming passthrough.
// Không khóa cứng endpoint. Đọc config từ env KIM_PROVIDERS (JSON array).
// Mỗi provider: { name, baseURL, apiKeyEnv, models: [{id, roles[], contextWindow?}] }
// Roles: "vision" | "orchestrator" | "synthesizer" | "fallback" | "lightweight"

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_RETRIES = 3;

const modelState = new Map();

function parseProviders() {
  const raw = String(process.env.KIM_PROVIDERS || "");
  if (!raw) {
    const baseURL = String(process.env.KIM_LLM_BASE_URL || "https://api.xkiro.com/v1");
    const apiKeyEnv = String(process.env.KIM_LLM_API_KEY_ENV || "KIM_LLM_API_KEY");
    const defaultModel = String(process.env.KIM_LLM_MODEL || "qwen/qwen3.8-max");
    return [{
      name: "default",
      baseURL,
      apiKeyEnv,
      models: [{ id: defaultModel, roles: ["orchestrator", "vision", "synthesizer", "fallback"] }]
    }];
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`KIM_PROVIDERS không phải JSON hợp lệ: ${e.message}`);
  }
}

function getApiKey(provider) {
  const envName = provider.apiKeyEnv || "KIM_LLM_API_KEY";
  const key = String(process.env[envName] || "").trim();
  if (!key) {
    const fallback = String(process.env.XKIRO_API_KEY || "").trim();
    if (fallback) return fallback;
    throw new Error(`Thiếu API key: env ${envName} chưa được set.`);
  }
  return key;
}

function isCooledDown(providerName, modelId) {
  const key = `${providerName}/${modelId}`;
  const state = modelState.get(key);
  if (!state) return false;
  return Date.now() < state.cooldownUntil;
}

function setCooldown(providerName, modelId, retryAfterMs) {
  const key = `${providerName}/${modelId}`;
  const ms = Math.max(retryAfterMs || DEFAULT_COOLDOWN_MS, 5000);
  modelState.set(key, { cooldownUntil: Date.now() + ms });
}

export function selectModels(role) {
  const providers = parseProviders();
  const candidates = [];

  for (const provider of providers) {
    for (const model of provider.models || []) {
      const roles = model.roles || ["fallback"];
      if (roles.includes(role) || roles.includes("fallback")) {
        const cooledDown = isCooledDown(provider.name, model.id);
        candidates.push({
          provider,
          model,
          priority: roles.includes(role) ? 0 : 1,
          cooledDown
        });
      }
    }
  }

  candidates.sort((a, b) => {
    if (a.cooledDown !== b.cooledDown) return a.cooledDown ? 1 : -1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return 0;
  });

  return candidates.filter(c => !c.cooledDown).concat(candidates.filter(c => c.cooledDown));
}

export async function callWithRotation(role, body, options = {}) {
  const { stream = false, signal, maxRetries = MAX_RETRIES } = options;
  const candidates = selectModels(role);

  if (candidates.length === 0) {
    const e = new Error(`Không có model nào khả dụng cho role "${role}". Kiểm tra KIM_PROVIDERS.`);
    e.code = "KIM_NO_MODEL_AVAILABLE";
    throw e;
  }

  let lastError = null;
  let attempts = 0;

  for (const candidate of candidates) {
    if (attempts >= maxRetries) break;
    attempts++;

    const { provider, model } = candidate;
    let apiKey;
    try {
      apiKey = getApiKey(provider);
    } catch (e) {
      lastError = e;
      continue;
    }

    const url = `${provider.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const requestBody = { ...body, model: model.id };
    if (stream) requestBody.stream = true;

    try {
      const res = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const retryMs = retryAfter ? Number(retryAfter) * 1000 : DEFAULT_COOLDOWN_MS;
        setCooldown(provider.name, model.id, retryMs);
        lastError = new Error(`Rate limited on ${provider.name}/${model.id}`);
        lastError.code = "KIM_RATE_LIMITED";
        continue;
      }

      if (res.status === 402 || res.status === 403) {
        setCooldown(provider.name, model.id, 300_000);
        lastError = new Error(`Quota/auth error on ${provider.name}/${model.id}: HTTP ${res.status}`);
        lastError.code = "KIM_QUOTA_EXHAUSTED";
        continue;
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        lastError = new Error(`${provider.name}/${model.id} HTTP ${res.status}: ${errBody.slice(0, 200)}`);
        lastError.code = "KIM_API_ERROR";
        continue;
      }

      if (stream) {
        return {
          stream: res.body,
          modelUsed: model.id,
          providerUsed: provider.name,
          contentType: res.headers.get("content-type")
        };
      }

      const data = await res.json();
      return { data, modelUsed: model.id, providerUsed: provider.name };

    } catch (e) {
      if (e.name === "AbortError") throw e;
      lastError = e;
      setCooldown(provider.name, model.id, DEFAULT_COOLDOWN_MS);
      continue;
    }
  }

  const e = new Error(
    `Tất cả ${attempts} model cho role "${role}" đều thất bại. Lỗi cuối: ${lastError?.message || "unknown"}`
  );
  e.code = lastError?.code || "KIM_ALL_MODELS_FAILED";
  e.cause = lastError;
  throw e;
}

export async function callJson(role, messages, options = {}) {
  const { temperature = 0.1, maxTokens = 4096, responseFormat, signal } = options;

  const body = {
    messages,
    temperature,
    max_tokens: maxTokens
  };
  if (responseFormat) body.response_format = responseFormat;

  const result = await callWithRotation(role, body, { stream: false, signal });
  const content = result.data?.choices?.[0]?.message?.content || "";

  let json = null;
  if (responseFormat?.type === "json_object" || content.trim().startsWith("{")) {
    try {
      json = JSON.parse(content);
    } catch {
      // Not valid JSON, return raw content
    }
  }

  return { content, json, modelUsed: result.modelUsed, providerUsed: result.providerUsed };
}

export function getRotatorStatus() {
  const providers = parseProviders();
  const status = [];
  for (const provider of providers) {
    for (const model of provider.models || []) {
      const key = `${provider.name}/${model.id}`;
      const state = modelState.get(key);
      status.push({
        provider: provider.name,
        model: model.id,
        roles: model.roles || ["fallback"],
        cooledDown: state ? Date.now() < state.cooldownUntil : false,
        cooldownRemainingMs: state ? Math.max(0, state.cooldownUntil - Date.now()) : 0
      });
    }
  }
  return status;
}