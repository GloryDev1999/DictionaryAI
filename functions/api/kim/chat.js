// Kim v6 — Chat hỏi đáp tổng quát (RAG trên dữ liệu catalogue)
// POST /api/kim/chat { message, history? }
// Dùng qwen/qwen3.8-max (role "orchestrator" qua API Rotator) để trả lời
// MỌI câu hỏi liên quan đến dữ liệu hệ thống — không chỉ tra cứu mã hàng.
//
// Luồng:
//   1. Validate session (Supabase app_me)
//   2. RAG: tìm bản ghi catalogue liên quan bằng chính câu hỏi (app_search_catalogue)
//   3. Gọi LLM orchestrator với context dữ liệu → trả lời tiếng Việt
//
// Không khóa cứng model: apiRotator tự xoay vòng provider theo cấu hình
// trong Supabase table kim_provider_config (hoặc env KIM_PROVIDERS).

import { validateSession, searchCatalogue } from "../../_lib/kim/v5/connectors/supabase.js";
import { json, readJson } from "../../_lib/shared/http.js";
import { callJson } from "../../_lib/kim/v6/apiRotator.js";

const SYSTEM_PROMPT = `Bạn là Thư ký Kim của hệ thống Catalogue AI (DictionaryAI) — trợ lý tra cứu linh kiện công nghiệp (bushing, bạc lót, cao su...).

Bạn được cung cấp dữ liệu catalogue trích xuất trực tiếp từ database của hệ thống. Nguyên tắc:
1. Chỉ trả lời dựa trên dữ liệu được cung cấp; KHÔNG bịa mã linh kiện hay đặc điểm không có trong dữ liệu.
2. Nếu dữ liệu không đủ, nói rõ "em chưa tìm thấy dữ liệu phù hợp" và gợi ý cách hỏi khác.
3. Ngoài tra cứu mã hàng, bạn có thể giải thích đặc điểm, so sánh các mã, hướng dẫn cách tra cứu, mô tả cấu trúc catalogue — miễn là dựa trên dữ liệu được cho.
4. Trả lời bằng tiếng Việt, ngắn gọn, lễ phép (gọi người dùng là "anh"), nêu mã linh kiện (code) khi liên quan.`;

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await readJson(request, { maxBytes: 1_000_000 });
  } catch {
    return json({ ok: false, user_message: "JSON body không hợp lệ." }, 400);
  }

  const token = String(body?.session_token || request.headers.get("x-session-token") || "");
  try {
    await validateSession(env, token);
  } catch (e) {
    return json({ ok: false, user_message: e?.message || "Session không hợp lệ." }, 401);
  }

  const message = String(body?.message || "").trim().slice(0, 4000);
  if (!message) {
    return json({ ok: false, user_message: "Cần câu hỏi cho Thư ký Kim." }, 400);
  }

  try {
    // ── RAG: lấy bản ghi catalogue liên quan đến câu hỏi ───────────────
    const rows = await searchCatalogue(env, token, { search: message, limit: 15 });
    const context = (rows || []).map(r => ({
      code: r.code || r.part_id || null,
      part_id: r.part_id || null,
      identifying_features: r.identifying_features || null,
      usage_side: r.usage_side || null,
      view_mode: r.view_mode || null,
      description: r.description || r.notes || null
    }));

    // ── Lịch sử hội thoại (tối đa 8 tin gần nhất) ────────────────────
    const history = Array.isArray(body?.history)
      ? body.history.slice(-8).map(h => ({
          role: h?.role === "user" ? "user" : "assistant",
          content: String(h?.text || "").slice(0, 1500)
        }))
      : [];

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      {
        role: "user",
        content:
          `Câu hỏi: ${message}\n\n` +
          `DỮ LIỆU CATALOGUE (${context.length} bản ghi liên quan nhất):\n` +
          JSON.stringify(context, null, 2)
      }
    ];

    // Role "orchestrator" → qwen/qwen3.8-max là lựa chọn ưu tiên trong rotator
    const result = await callJson(env, "orchestrator", messages, {
      temperature: 0.3,
      maxTokens: 2048
    });

    return json({
      ok: true,
      answer: result.content,
      sources_count: context.length,
      model_used: result.modelUsed,
      provider_used: result.providerUsed
    });
  } catch (e) {
    console.error("[kim-chat]", e.message);
    return json(
      { ok: false, user_message: "Thư ký Kim chưa thể trả lời lúc này. Anh thử lại nhé.", code: e.code },
      502
    );
  }
}