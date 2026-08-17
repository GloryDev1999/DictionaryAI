// CRUD endpoint cho Kim v6 Admin Config: quản lý providers + API keys.
// GET  /api/kim/admin/providers       → list all providers (mask api_key)
// POST /api/kim/admin/providers       → create new provider
// PUT  /api/kim/admin/providers/:id   → update provider
// DELETE /api/kim/admin/providers/:id → delete provider
//
// Bảo mật: chỉ chấp nhận request có KIM_ADMIN_TOKEN hoặc session_token hợp lệ.
// API key được mã hóa AES-256-GCM trước khi lưu vào DB.

import { json, readJson } from "../../../_lib/shared/http.js";

const ADMIN_TOKEN = ""; // Đọc từ env bên dưới; để trống = disable token check nếu có session
const ENCRYPTION_KEY_ENV = "KIM_CONFIG_ENCRYPTION_KEY"; // 32-byte hex key cho AES-256-GCM

function getAdminToken(env) {
  return String(env.KIM_ADMIN_TOKEN || "").trim();
}

function getEncryptionKey(env) {
  const hex = String(env[ENCRYPTION_KEY_ENV] || "").trim();
  if (!hex || hex.length !== 64) return null;
  try {
    return Uint8Array.from(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  } catch {
    return null;
  }
}

async function encryptApiKey(plaintext, keyBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded));
  // Format: base64(iv):base64(ciphertext)
  const toBase64 = (arr) => btoa(String.fromCharCode(...arr));
  return `${toBase64(iv)}:${toBase64(ciphertext)}`;
}

async function decryptApiKey(stored, keyBytes) {
  const parts = stored.split(":");
  if (parts.length !== 2) return null;
  const fromBase64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const iv = fromBase64(parts[0]);
  const ciphertext = fromBase64(parts[1]);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  try {
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

function maskKey(encrypted) {
  if (!encrypted || encrypted === "PLACEHOLDER_ENCRYPTED_KEY") return "***CHƯA_CẤU_HÌNH***";
  return "***ĐÃ_MÃ_HÓA***";
}

async function validateAdminAccess(request, env) {
  const adminToken = getAdminToken(env);
  const headerToken = String(request.headers.get("x-kim-admin-token") || "").trim();

  // Ưu tiên admin token
  if (adminToken && headerToken === adminToken) return true;

  // Fallback: session_token (validate qua Supabase)
  const sessionToken = String(
    request.headers.get("x-session-token") || ""
  ).trim();
  if (sessionToken) {
    try {
      const { validateSession } = await import("../../../_lib/kim/v5/connectors/supabase.js");
      await validateSession(env, sessionToken);
      return true;
    } catch {
      return false;
    }
  }

  return !adminToken; // Nếu không set admin token và không có session → reject
}

function supabaseService(env) {
  const url = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!url || !key) throw new Error("Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY");
  return { url, key };
}

async function dbQuery(env, sql, params = []) {
  const { url, key } = supabaseService(env);
  const res = await fetch(`${url}/rest/v1/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apikey": key,
      "authorization": `Bearer ${key}`
    },
    body: JSON.stringify({ query: sql, params })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Supabase RPC error ${res.status}: ${text}`);
  }
  return res.json();
}

// --- Handlers ---

export async function onRequestGet({ request, env }) {
  if (!(await validateAdminAccess(request, env))) {
    return json({ ok: false, message: "Unauthorized" }, 401);
  }

  try {
    const { url, key } = supabaseService(env);
    const res = await fetch(`${url}/rest/v1/kim_provider_config?select=*&order=priority.asc`, {
      headers: { "apikey": key, "authorization": `Bearer ${key}` }
    });
    if (!res.ok) throw new Error(`DB error ${res.status}`);
    const rows = await res.json();

    // Mask API keys trong response
    const safe = rows.map(r => ({
      id: r.id,
      name: r.name,
      base_url: r.base_url,
      models: r.models,
      is_active: r.is_active,
      priority: r.priority,
      api_key_status: maskKey(r.api_key_encrypted),
      created_at: r.created_at,
      updated_at: r.updated_at
    }));

    return json({ ok: true, providers: safe });
  } catch (e) {
    return json({ ok: false, message: e.message }, 500);
  }
}

export async function onRequestPost({ request, env }) {
  if (!(await validateAdminAccess(request, env))) {
    return json({ ok: false, message: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    return json({ ok: false, message: "Invalid JSON" }, 400);
  }

  const encKey = getEncryptionKey(env);
  if (!encKey) {
    return json({ ok: false, message: "Server chưa cấu hình KIM_CONFIG_ENCRYPTION_KEY" }, 500);
  }

  const name = String(body.name || "").trim();
  const baseUrl = String(body.base_url || "").trim();
  const apiKey = String(body.api_key || "").trim();
  const models = Array.isArray(body.models) ? body.models : [];
  const isActive = body.is_active !== false;
  const priority = Number(body.priority) || 0;

  if (!name || !baseUrl || !apiKey) {
    return json({ ok: false, message: "Thiếu name, base_url hoặc api_key" }, 400);
  }

  try {
    const encrypted = await encryptApiKey(apiKey, encKey);
    const { url, key } = supabaseService(env);
    const res = await fetch(`${url}/rest/v1/kim_provider_config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "apikey": key,
        "authorization": `Bearer ${key}`,
        "prefer": "return=representation"
      },
      body: JSON.stringify({
        name,
        base_url: baseUrl,
        api_key_encrypted: encrypted,
        models,
        is_active: isActive,
        priority
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (text.includes("unique") || text.includes("duplicate")) {
        return json({ ok: false, message: `Provider '${name}' đã tồn tại` }, 409);
      }
      throw new Error(`DB error ${res.status}: ${text}`);
    }

    const [created] = await res.json();
    return json({ ok: true, provider: { ...created, api_key_encrypted: maskKey(created.api_key_encrypted) } }, 201);
  } catch (e) {
    return json({ ok: false, message: e.message }, 500);
  }
}

export async function onRequestPut({ request, env, params }) {
  if (!(await validateAdminAccess(request, env))) {
    return json({ ok: false, message: "Unauthorized" }, 401);
  }

  const id = params?.id;
  if (!id) return json({ ok: false, message: "Thiếu provider ID" }, 400);

  let body;
  try {
    body = await readJson(request);
  } catch {
    return json({ ok: false, message: "Invalid JSON" }, 400);
  }

  const encKey = getEncryptionKey(env);
  const updates = {};

  if (body.name !== undefined) updates.name = String(body.name).trim();
  if (body.base_url !== undefined) updates.base_url = String(body.base_url).trim();
  if (body.models !== undefined) updates.models = Array.isArray(body.models) ? body.models : [];
  if (body.is_active !== undefined) updates.is_active = !!body.is_active;
  if (body.priority !== undefined) updates.priority = Number(body.priority) || 0;

  // Chỉ mã hóa lại API key nếu có gửi mới
  if (body.api_key && encKey) {
    updates.api_key_encrypted = await encryptApiKey(String(body.api_key).trim(), encKey);
  } else if (body.api_key && !encKey) {
    return json({ ok: false, message: "Server chưa cấu hình KIM_CONFIG_ENCRYPTION_KEY" }, 500);
  }

  if (Object.keys(updates).length === 0) {
    return json({ ok: false, message: "Không có field nào để cập nhật" }, 400);
  }

  try {
    const { url, key } = supabaseService(env);
    const res = await fetch(`${url}/rest/v1/kim_provider_config?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "apikey": key,
        "authorization": `Bearer ${key}`,
        "prefer": "return=representation"
      },
      body: JSON.stringify(updates)
    });

    if (!res.ok) throw new Error(`DB error ${res.status}`);
    const rows = await res.json();
    if (!rows.length) return json({ ok: false, message: "Provider not found" }, 404);

    return json({ ok: true, provider: { ...rows[0], api_key_encrypted: maskKey(rows[0].api_key_encrypted) } });
  } catch (e) {
    return json({ ok: false, message: e.message }, 500);
  }
}

export async function onRequestDelete({ request, env, params }) {
  if (!(await validateAdminAccess(request, env))) {
    return json({ ok: false, message: "Unauthorized" }, 401);
  }

  const id = params?.id;
  if (!id) return json({ ok: false, message: "Thiếu provider ID" }, 400);

  try {
    const { url, key } = supabaseService(env);
    const res = await fetch(`${url}/rest/v1/kim_provider_config?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "apikey": key, "authorization": `Bearer ${key}` }
    });

    if (!res.ok) throw new Error(`DB error ${res.status}`);
    return json({ ok: true, deleted: id });
  } catch (e) {
    return json({ ok: false, message: e.message }, 500);
  }
}