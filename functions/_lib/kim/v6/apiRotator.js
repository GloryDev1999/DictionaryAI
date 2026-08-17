// API Rotator — Cloudflare Workers/Pages compatible version.
// Dùng Web Crypto API (không Node crypto), fetch providers từ Supabase hoặc env.
// Auto-rotate khi 429/quota, cooldown per-model, streaming passthrough.
//
// Ưu tiên config: (1) env KIM_PROVIDERS → (2) Supabase table kim_provider_config → (3) fallback
// Roles: "vision" | "orchestrator" | "synthesizer" | "fallback" | "lightweight"

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_RETRIES = 3;
const DB_CACHE_TTL_MS = 5 * 60_000;

// In-memory state (per-isolate, resets on cold start — acceptable for rotation)
const modelCooldowns = new Map();
let dbCache = null; // { providers, fetchedAt }

/**
 * Decrypt AES-256-GCM encrypted API key.
 * Format: base64(iv):base64(ciphertext+tag)
 * Uses Web Crypto API (available in CF Workers).
 */
async function decryptApiKey(encryptedStr, encKeyHex) {
  if (!encryptedStr || !encryptedStr.includes(":")) return null;
  if (!encKeyHex || encKeyHex.length !== 64) return null;

  try {
    const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const encKeyBytes = Uint8Array.from(encKeyHex.match(/.{2}/g), (b) => parseInt(b, 16));

    const parts = encryptedStr.split(":");
    const iv = fromBase64(parts[0]);
    const ciphertextWithTag = fromBase64(parts[1]);

    const cryptoKey = await crypto.subtle.importKey("raw", encKeyBytes, "AES-GCM", false, ["decrypt"]);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertextWithTag);
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

/**
 * Fetch providers from Supabase table kim_provider_config.
 * Returns null if not configured or error.
 */
async function fetchProvidersFromDb(env) {
  if (dbCache && Date.now() - dbCache.fetchedAt < DB_CACHE_TTL_MS) {
    return dbCache.providers;
  }

  const url = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) return null;

  try {
    const res = await fetch(`${url}/rest/v1/kim_provider_config?is_active=eq.true&order=priority.asc`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const encKeyHex = String(env.KIM_CONFIG_ENCRYPTION_KEY || "").trim();
    const providers = [];

    for (const row of rows) {
      let apiKey = "";
      if (row.api_key_encrypted && row.api_key_encrypted !== "PLACEHOLDER_ENCRYPTED_KEY") {
        apiKey = await decryptApiKey(row.api_key_encrypted, encKeyHex);
      }
      if (!apiKey) continue;

      providers.push({
        name: row.name,
        baseURL: row.base_url,
        apiKey, // plaintext in-memory only
        models: Array.isArray(row.models) ? row.models : [],
        priority: row.priority || 0,
      });
    }

    if (providers.length > 0) {
      dbCache = { providers, fetchedAt: Date.now() };
      return providers;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse providers from env var KIM_PROVIDERS (JSON array).
 */
function parseProvidersFromEnv(env) {
  const raw = String(env.KIM_PROVIDERS || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Resolve apiKeyEnv to actual keys
    return parsed.map((p) => ({
      ...p,
      apiKey: p.apiKey || String(env[p.apiKeyEnv] || env.XKIRO_API_KEY || "").trim(),
    }));
  } catch {
    return null;
  }
}

/**
 * Build fallback single provider from legacy env vars.
 */
function buildFallbackProvider(env) {
  const baseURL = String(env.KIM_LLM_BASE_URL || "https://api.xkiro.com/v1");
  const apiKey = String(env.KIM_LLM_API_KEY || env.XKIRO_API_KEY || "").trim();
  const defaultModel = String(env.KIM_LLM_MODEL || "qwen/qwen3.8-max");
  return [
    {
      name: "default",
      baseURL,
      apiKey,
      models: [{ id: defaultModel, roles: ["orchestrator", "vision", "synthesizer", "fallback"] }],
      priority: 0,
    },
  ];
}

/**
 * Resolve providers: env → Supabase DB → fallback.
 */
export async function resolveProviders(env) {
  const envProviders = parseProvidersFromEnv(env);
  if (envProviders && envProviders.length > 0) return envProviders;

  const dbProviders = await fetchProvidersFromDb(env);
  if (dbProviders && dbProviders.length > 0) return dbProviders;

  return buildFallbackProvider(env);
}

function isCooledDown(providerName, modelId) {
  const key = `${providerName}/${modelId}`;
  const until = modelCooldowns.get(key);
  return until ? Date.now() < until : false;
}

function setCooldown(providerName, modelId, retryAfterMs) {
  const key = `${providerName}/${modelId}`;
  const ms = Math.max(retryAfterMs || DEFAULT_COOLDOWN_MS, 5000);
  modelCooldowns.set(key, Date.now() + ms);
}

/**
 * Select candidate models for a given role, sorted by priority and cooldown status.
 */
export function selectCandidates(providers, role) {
  const candidates = [];
  for (const provider of providers) {
    for (const model of provider.models || []) {
      const roles = model.roles || ["fallback"];
      if (roles.includes(role) || roles.includes("fallback")) {
        candidates.push({
          provider,
          model,
          isPrimary: roles.includes(role),
          cooledDown: isCooledDown(provider.name, model.id),
        });
      }
    }
  }
  candidates.sort((a, b) => {
    if (a.cooledDown !== b.cooledDown) return a.cooledDown ? 1 : -1;
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return (a.provider.priority || 0) - (b.provider.priority || 0);
  });
  return candidates;
}

/**
 * Call LLM with automatic rotation across providers/models.
 * @param {string} role - "vision" | "orchestrator" | "synthesizer" | "fallback" | "lightweight"
 * @param {object} body - OpenAI chat/completions request body (model field will be overridden)
 * @param {object} options - { stream, signal, maxRetries }
 * @returns {{ data?, stream?, modelUsed, providerUsed }}
 */
export async function callWithRotation(env, role, body, options = {}) {
  const { stream = false, signal, maxRetries = MAX_RETRIES } = options;
  const providers = await resolveProviders(env);
  const candidates = selectCandidates(providers, role);

  if (candidates.length === 0) {
    throw Object.assign(new Error(`Không có model nào cho role "${role}".`), { code: "KIM_NO_MODEL_AVAILABLE" });
  }

  let lastError = null;
  let attempts = 0;

  for (const candidate of candidates) {
    if (attempts >= maxRetries) break;
    attempts++;

    const { provider, model } = candidate;
    if (!provider.apiKey) {
      lastError = new Error(`Missing API key for ${provider.name}`);
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
          authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get("retry-after");
        const retryMs = retryAfter ? Number(retryAfter) * 1000 : DEFAULT_COOLDOWN_MS;
        setCooldown(provider.name, model.id, retryMs);
        lastError = Object.assign(new Error(`Rate limited: ${provider.name}/${model.id}`), { code: "KIM_RATE_LIMITED" });
        continue;
      }

      if (res.status === 402 || res.status === 403) {
        setCooldown(provider.name, model.id, 300_000);
        lastError = Object.assign(new Error(`Quota/auth error: ${provider.name}/${model.id} HTTP ${res.status}`), { code: "KIM_QUOTA_EXHAUSTED" });
        continue;
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        lastError = Object.assign(new Error(`${provider.name}/${model.id} HTTP ${res.status}: ${errText.slice(0, 200)}`), { code: "KIM_API_ERROR" });
        continue;
      }

      if (stream) {
        return {
          stream: res.body,
          modelUsed: model.id,
          providerUsed: provider.name,
          contentType: res.headers.get("content-type"),
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

  throw Object.assign(
    new Error(`Tất cả ${attempts} model cho role "${role}" thất bại. Lỗi cuối: ${lastError?.message || "unknown"}`),
    { code: lastError?.code || "KIM_ALL_MODELS_FAILED", cause: lastError }
  );
}

/**
 * Convenience: call LLM and parse JSON response.
 */
export async function callJson(env, role, messages, options = {}) {
  const { temperature = 0.1, maxTokens = 4096, responseFormat, signal } = options;
  const body = { messages, temperature, max_tokens: maxTokens };
  if (responseFormat) body.response_format = responseFormat;

  const result = await callWithRotation(env, role, body, { stream: false, signal });
  const content = result.data?.choices?.[0]?.message?.content || "";

  let json = null;
  if (responseFormat?.type === "json_object" || content.trim().startsWith("{")) {
    try {
      json = JSON.parse(content);
    } catch {
      // Not valid JSON
    }
  }

  return { content, json, modelUsed: result.modelUsed, providerUsed: result.providerUsed };
}

/**
 * Get current rotation status for debugging.
 */
export async function getRotatorStatus(env) {
  const providers = await resolveProviders(env);
  const status = [];
  for (const provider of providers) {
    for (const model of provider.models || []) {
      const key = `${provider.name}/${model.id}`;
      const until = modelCooldowns.get(key);
      status.push({
        provider: provider.name,
        model: model.id,
        roles: model.roles || ["fallback"],
        cooledDown: until ? Date.now() < until : false,
        cooldownRemainingMs: until ? Math.max(0, until - Date.now()) : 0,
      });
    }
  }
  return status;
}

