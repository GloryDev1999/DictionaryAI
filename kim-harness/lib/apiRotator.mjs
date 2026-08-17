// API Rotator — Multi-provider, auto-rotate, cooldown, streaming passthrough.
// Không khóa cứng endpoint.
// Ưu tiên đọc config: (1) env KIM_PROVIDERS → (2) Supabase table kim_provider_config → (3) fallback single provider.
// Mỗi provider: { name, baseURL, apiKeyEnv|apiKey, models: [{id, roles[], contextWindow?}] }
// Roles: "vision" | "orchestrator" | "synthesizer" | "fallback" | "lightweight"

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_RETRIES = 3;
const DB_CACHE_TTL_MS = 5 * 60_000;

const modelState = new Map();
let dbCache = null;

async function fetchProvidersFromDb() {
  if (dbCache && Date.now() - dbCache.fetchedAt < DB_CACHE_TTL_MS) {
    return dbCache.providers;
  }
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/rest/v1/kim_provider_config?is_active=eq.true&order=priority.asc`, {
      headers: { "apikey": key, "authorization": `Bearer ${key}` }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const encKeyHex = String(process.env.KIM_CONFIG_ENCRYPTION_KEY || "").trim();
    let encKeyBytes = null;
    if (encKeyHex && encKeyHex.length === 64) {
      try { encKeyBytes = Uint8Array.from(encKeyHex.match(/.{2}/g).map(b => parseInt(b, 16))); } catch {}
    }
    const providers = [];
    for (const row of rows) {
      let apiKey = "";
      if (encKeyBytes && row.api_key_encrypted && row.api_key_encrypted.includes(":")) {
        try {
          const parts = row.api_key_encrypted.split(":");
          const fromBase64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
          const iv = fromBase64(parts[0]);
          const ciphertext = fromBase64(parts[1]);
          const cryptoKey = await crypto.subtle.importKey("raw", encKeyBytes, "AES-GCM", false, ["decrypt"]);
          const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
          apiKey = new TextDecoder().decode(decrypted);
        } catch { apiKey = ""; }
      }
      if (apiKey) {
        providers.push({
          name: row.name,
          baseURL: row.base_url,
          apiKey,
          models: Array.isArray(row.models) ? row.models : [],
          priority: row.priority || 0
        });
      }
    }
    if (providers.length > 0) {
      dbCache = { providers, fetchedAt: Date.now() };
      return providers;
    }
    return null;
  } catch { return null; }
}

function parseProvidersSync() {
  const raw = String(process.env.KIM_PROVIDERS || "");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) {
    throw new Error(`KIM_PROVIDERS không phải JSON hợp lệ: ${e.message}`);
  }
}

async function resolveProviders() {
  const envProviders = parseProvidersSync();
  if (envProviders) return envProviders;
  const dbProviders = await fetchProvidersFromDb();
  if (dbProviders) return dbProviders;
  const baseURL = String(process.env.KIM_LLM_BASE_URL || "https://api.xkiro.com/v1");
  const apiKeyEnv = String(process.env.KIM_LLM_API_KEY_ENV || "KIM_LLM_API_KEY");
  const defaultModel = String(process.env.KIM_LLM_MODEL || "qwen/qwen3.8-max");
  return [{ name: "default", baseURL, apiKeyEnv, models: [{ id: defaultModel, roles: ["orchestrator", "vision", "synthesizer", "fallback"] }] }];
}

function getDefaultProviders() {
  const envProviders = parseProvidersSync();
  if (envProviders) return envProviders;
  const baseURL = String(process.env.KIM_LLM_BASE_URL || "https://api.xkiro.com/v1");
  const apiKeyEnv = String(process.env.KIM_LLM_API_KEY_ENV || "KIM_LLM_API_KEY");
  const defaultModel = String(process.env.KIM_LLM_MODEL || "qwen/qwen3.8-max");
  return [{ name: "default", baseURL, apiKeyEnv, models: [{ id: defaultModel, roles: ["orchestrator", "vision", "synthesizer", "fallback"] }] }];
}

function getApiKey(provider) {
  if (provider.apiKey) return provider.apiKey;
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

function buildCandidates(providers, role) {
  const candidates = [];
  for (const provider of providers) {
    for (const model of provider.models || []) {
      const roles = model.roles || ["fallback"];
      if (roles.includes(role) || roles.includes("fallback")) {
        const cooledDown = isCooledDown(provider.name, model.id);
        candidates.push({ provider, model, priority: roles.includes(role) ? 0 : 1, cooledDown });
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

export function selectModels(role) {
  return buildCandidates(getDefaultProviders(), role);
}

export async function callWithRotation(role, body, options = {}) {
  const { stream = false, signal, maxRetries = MAX_RETRIES } = options;
  const providers = await resolveProviders();
  const candidates = buildCandidates(providers, role);
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
    try { apiKey = getApiKey(provider); } catch (e) { lastError = e; continue; }
    const url = `${provider.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const requestBody = { ...body, model: model.id };
    if (stream) requestBody.stream = true;
    try {
      const res = await fetch(url, {
        method: "POST", signal,
        headers: { "content-type": "application/json", "authorization": `Bearer ${apiKey}` },
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
        return { stream: res.body, modelUsed: model.id, providerUsed: provider.name, contentType: res.headers.get("content-type") };
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
  const e = new Error(`Tất cả ${attempts} model cho role "${role}" đều thất bại. Lỗi cuối: ${lastError?.message || "unknown"}`);
  e.code = lastError?.code || "KIM_ALL_MODELS_FAILED";
  e.cause = lastError;
  throw e;
}

export async function callJson(role, messages, options = {}) {
  const { temperature = 0.1, maxTokens = 4096, responseFormat, signal } = options;
  const body = { messages, temperature, max_tokens: maxTokens };
  if (responseFormat) body.response_format = responseFormat;
  const result = await callWithRotation(role, body, { stream: false, signal });
  const content = result.data?.choices?.[0]?.message?.content || "";
  let json = null;
  if (responseFormat?.type === "json_object" || content.trim().startsWith("{")) {
    try { json = JSON.parse(content); } catch {}
  }
  return { content, json, modelUsed: result.modelUsed, providerUsed: result.providerUsed };
}

export function getRotatorStatus() {
  const providers = getDefaultProviders();
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
