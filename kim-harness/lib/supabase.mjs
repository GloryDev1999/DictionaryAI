// Connector Supabase dùng chung cho các tool của Thư ký Kim.
// Tái sử dụng đúng các RPC mà DictionaryAI đã định nghĩa:
//  - app_me                 : xác thực session token
//  - app_search_catalogue   : tìm kiếm metadata catalogue
//  - match_catalogue_image_vectors : vector search (chỉ service_role)

function baseUrl(env = process.env) {
  return String(env.SUPABASE_URL || "").replace(/\/+$/, "");
}

function requireSupabase(env) {
  const url = baseUrl(env);
  const anon = String(env.SUPABASE_ANON_KEY || "");
  if (!url || !anon) {
    const e = new Error("Thiếu SUPABASE_URL hoặc SUPABASE_ANON_KEY trong môi trường của profile kim.");
    e.code = "KIM_SUPABASE_NOT_CONFIGURED";
    throw e;
  }
  return { url, anon };
}

async function rpc({ url, key }, fn, args, signal) {
  const res = await fetch(`${url}/rest/v1/rpc/${encodeURIComponent(fn)}`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "apikey": key,
      "authorization": `Bearer ${key}`
    },
    body: JSON.stringify(args || {})
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(data?.message || `Supabase RPC ${fn} HTTP ${res.status}`);
    e.status = res.status;
    e.details = data;
    throw e;
  }
  return data;
}

/** RPC bằng anon key (các hàm app_* công khai). */
export async function rpcAnon(fn, args = {}, signal) {
  const { url, anon } = requireSupabase();
  return rpc({ url, key: anon }, fn, args, signal);
}

/** RPC bằng service_role key (match_catalogue_image_vectors). */
export async function rpcService(fn, args = {}, signal) {
  const { url, anon } = requireSupabase();
  const service = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!service) {
    const e = new Error("Thiếu SUPABASE_SERVICE_ROLE_KEY — RPC vector yêu cầu quyền service_role.");
    e.code = "KIM_SERVICE_ROLE_MISSING";
    throw e;
  }
  return rpc({ url, key: service }, fn, args, signal);
}

/** REST trực tiếp bằng service_role (upsert/patch bảng catalogue_image_vectors). */
export async function restService(table, { method = "GET", query = "", body, prefer, signal } = {}) {
  const { url } = requireSupabase();
  const service = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (!service) {
    const e = new Error("Thiếu SUPABASE_SERVICE_ROLE_KEY cho thao tác quản trị vector.");
    e.code = "KIM_SERVICE_ROLE_MISSING";
    throw e;
  }
  const res = await fetch(`${url}/rest/v1/${encodeURIComponent(table)}${query}`, {
    method,
    signal,
    headers: {
      "content-type": "application/json",
      "apikey": service,
      "authorization": `Bearer ${service}`,
      ...(prefer ? { prefer } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

  const text = await res.text().catch(() => "");
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = new Error(data?.message || `Supabase REST ${table} HTTP ${res.status}`);
    e.status = res.status;
    e.details = data ?? text;
    throw e;
  }
  return data;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return text; }
}

/** Xác thực session token người dùng qua app_me (dùng cho quản trị cần token). */
export async function validateSession(token, signal) {
  const data = await rpcAnon("app_me", { p_session_token: token }, signal);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.ok) {
    const e = new Error(row?.message || "Session không hợp lệ hoặc đã hết hạn.");
    e.status = 401;
    throw e;
  }
  return row;
}

/** Token quản trị cấu hình sẵn cho agent (KIM_ADMIN_SESSION_TOKEN). */
export function adminToken() {
  const token = String(process.env.KIM_ADMIN_SESSION_TOKEN || "").trim();
  if (!token) {
    const e = new Error("Thiếu KIM_ADMIN_SESSION_TOKEN — thao tác này cần session quản trị.");
    e.code = "KIM_ADMIN_TOKEN_MISSING";
    throw e;
  }
  return token;
}