// Thư ký Kim thế hệ mới — endpoint proxy tới dịch vụ DSH (profile `kim`).
// Hoàn toàn additive: endpoint riêng /api/kim/search-dsh, không đụng Kim v5 cũ.
//
// Kích hoạt bằng biến môi trường trên Cloudflare Pages:
//   KIM_DSH_PROXY_ENABLED=true
//   KIM_DSH_BRIDGE_URL=http://<host chạy bridge>:3090
//   KIM_BRIDGE_TOKEN=<token bảo vệ bridge, nếu có>
//
// Frontend chuyển sang gọi endpoint này khi muốn dùng Kim-DSH;
// không bật flag thì endpoint trả 503 và app tiếp tục dùng /api/kim/search cũ.

import { validateSession } from "../../_lib/kim/v5/connectors/supabase.js";
import { json, readJson } from "../../_lib/shared/http.js";

export async function onRequestPost({ request, env }) {
  const bridgeUrl = String(env.KIM_DSH_BRIDGE_URL || "");
  const enabled = /^(1|true|yes|on)$/i.test(String(env.KIM_DSH_PROXY_ENABLED || ""));

  if (!enabled || !bridgeUrl) {
    return json({
      ok: false,
      user_message: "Thư ký Kim (DSH) chưa được kích hoạt cho môi trường này."
    }, 503);
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    return json({ ok: false, user_message: "JSON body không hợp lệ." }, 400);
  }

  const token = String(
    body?.session_token ||
    request.headers.get("x-session-token") ||
    ""
  );

  try {
    await validateSession(env, token);
  } catch (error) {
    return json({ ok: false, user_message: error?.message || "Session không hợp lệ." }, 401);
  }

  const message = String(body?.message || "").trim().slice(0, 4000);
  if (!message) {
    return json({ ok: false, user_message: "Cần câu hỏi cho Thư ký Kim." }, 400);
  }

  let res;
  try {
    res = await fetch(`${bridgeUrl.replace(/\/+$/, "")}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.KIM_BRIDGE_TOKEN ? { "x-kim-bridge-token": env.KIM_BRIDGE_TOKEN } : {})
      },
      body: JSON.stringify({ message })
    });
  } catch (error) {
    console.error("Kim DSH bridge unreachable", { message: error?.message });
    return json({
      ok: false,
      user_message: "Chưa kết nối được dịch vụ Thư ký Kim. Anh thử lại sau nhé."
    }, 502);
  }

  const data = await res.json().catch(() => null);
  if (!data) {
    return json({ ok: false, user_message: "Thư ký Kim trả về dữ liệu không hợp lệ." }, 502);
  }

  return json({
    ok: !!data.ok,
    engine: "kim-dsh",
    answer: data.answer || null,
    user_message: data.ok
      ? (data.answer || "Thư ký Kim đã xử lý.")
      : (data.user_message || data.message || "Thư ký Kim xử lý chưa thành công.")
  });
}