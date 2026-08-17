// Kim v6 — CF-native Orchestrator (không cần VPS/bridge)
// POST /api/kim/search-dsh { message, query_embedding?, image_data_url? }
// Pipeline 4 tầng chạy trực tiếp trên Cloudflare Pages Functions:
//   1. Vision Analyst → phân tích ảnh
//   2. Vector Search → pgvector similarity (nếu có query_embedding)
//   3. Metadata Synthesizer → tổng hợp vision + vector neighbors
//   4. Reranker → Top 5 cuối cùng
//
// Kích hoạt: KIM_V6_ENABLED=true trên Cloudflare Pages env vars.
// Không bật flag → trả 503, frontend fallback về /api/kim/search (Kim v5).

import { validateSession } from "../../_lib/kim/v5/connectors/supabase.js";
import { json, readJson } from "../../_lib/shared/http.js";
import { callJson } from "../../_lib/kim/v6/apiRotator.js";

// Reuse existing Supabase RPC helpers from Kim v5
import { rpc } from "../../_lib/kim/v5/connectors/supabase.js";

export async function onRequestPost({ request, env }) {
  const enabled = /^(1|true|yes|on)$/i.test(String(env.KIM_V6_ENABLED || ""));
  if (!enabled) {
    return json(
      { ok: false, user_message: "Kim v6 chưa được kích hoạt." },
      503
    );
  }

  let body;
  try {
    body = await readJson(request, { maxBytes: 8_000_000 });
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
  const imageDataUrl = String(body?.image_data_url || "").trim();
  const queryEmbedding = body?.query_embedding; // array of numbers from browser DINOv2

  if (!message && !imageDataUrl) {
    return json({ ok: false, user_message: "Cần message hoặc image_data_url." }, 400);
  }

  const pipelineLog = [];
  const t0 = Date.now();

  try {
    // ── TIER 1: Vision Analyst (nếu có ảnh) ──────────────────────────
    let visionFeatures = null;
    if (imageDataUrl && imageDataUrl.startsWith("data:image/")) {
      const [mime, base64Data] = splitDataUrl(imageDataUrl);
      const visionResult = await callJson(env, "vision", [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Phân tích ảnh linh kiện công nghiệp này. Trả JSON:
{"object_family":string|null,"dominant_colors":string[],"geometry":string[],"hole_count":number|null,"visible_features":string[],"material_look":string|null,"orientation_cues":string[],"search_terms":string[],"uncertainties":string[]}`,
            },
            { type: "image_url", image_url: { url: `data:${mime};base64,${base64Data}` } },
          ],
        },
      ], { temperature: 0.1, maxTokens: 2048, responseFormat: { type: "json_object" } });

      visionFeatures = visionResult.json || { raw: visionResult.content };
      pipelineLog.push({ tier: "vision", model: visionResult.modelUsed, provider: visionResult.providerUsed });
    }

    // ── TIER 2: Vector Search (nếu có embedding) ────────────────────
    let vectorNeighbors = [];
    if (Array.isArray(queryEmbedding) && queryEmbedding.length > 0) {
      try {
        const rows = await rpc(
          env,
          "match_catalogue_image_vectors",
          {
            p_query_embedding: `[${queryEmbedding.join(",")}]`,
            p_embedding_model: "onnx-community/dinov2-small",
            p_embedding_model_version: "ef1fb10",
            p_preprocess_version: "kim_canon_v2",
            p_embedding_profile: "cls_l2_v1",
            p_match_count: 20,
          }
        );
        vectorNeighbors = Array.isArray(rows) ? rows : [];
        pipelineLog.push({ tier: "vector", count: vectorNeighbors.length });
      } catch (e) {
        pipelineLog.push({ tier: "vector", error: e.message });
      }
    }

    // Nếu chỉ có text message (không ảnh, không embedding) → dùng LLM trả lời trực tiếp
    if (!visionFeatures && vectorNeighbors.length === 0 && message) {
      const chatResult = await callJson(env, "orchestrator", [
        {
          role: "system",
          content: "Bạn là Thư ký Kim của hệ thống Catalogue AI (DictionaryAI). Trả lời ngắn gọn bằng tiếng Việt.",
        },
        { role: "user", content: message },
      ], { temperature: 0.2, maxTokens: 2048 });

      return json({
        ok: true,
        engine: "kim-v6",
        answer: chatResult.content,
        pipeline_log: pipelineLog,
        elapsed_ms: Date.now() - t0,
      });
    }

    // ── TIER 3: Metadata Synthesizer ────────────────────────────────
    let refinedFeatures = null;
    if (visionFeatures && vectorNeighbors.length > 0) {
      const synthPrompt = `Tổng hợp đặc điểm từ 2 nguồn để tinh chỉnh:
NGUỒN 1 — Vision: ${JSON.stringify(visionFeatures)}
NGUỒN 2 — Vector neighbors metadata: ${JSON.stringify(vectorNeighbors.slice(0, 10))}
Trả JSON: {"refined_object_family":string|null,"refined_hole_count":number|null,"refined_geometry":string[],"refined_material":string|null,"distinguishing_marks":string[],"confidence_level":"high"|"medium"|"low","disambiguation_notes":string,"suggested_codes":string[]}`;

      const synthResult = await callJson(env, "synthesizer", [
        { role: "user", content: synthPrompt },
      ], { temperature: 0.15, maxTokens: 2048, responseFormat: { type: "json_object" } });

      refinedFeatures = synthResult.json || { raw: synthResult.content };
      pipelineLog.push({ tier: "synthesize", model: synthResult.modelUsed, provider: synthResult.providerUsed });
    }

    // ── TIER 4: Reranker → Top 5 ────────────────────────────────────
    let top5 = [];
    const candidatesForRerank = vectorNeighbors.length > 0 ? vectorNeighbors : [];

    if (candidatesForRerank.length > 0) {
      const rerankPrompt = `Xếp hạng ứng viên tìm kiếm linh kiện.
ĐẶC ĐIỂM ẢNH: ${JSON.stringify(visionFeatures || {})}
TINH CHỈNH: ${JSON.stringify(refinedFeatures || {})}
ỨNG VIÊN: ${JSON.stringify(candidatesForRerank.slice(0, 20))}
Trả JSON: {"top5":[{"rank":number,"code":string,"record_id":string,"similarity_score":number,"match_reason":string,"confidence":"high"|"medium"|"low","evidence_summary":string}],"analysis_notes":string,"ambiguous":boolean}`;

      const rerankResult = await callJson(env, "orchestrator", [
        { role: "user", content: rerankPrompt },
      ], { temperature: 0.05, maxTokens: 4096, responseFormat: { type: "json_object" } });

      const reranked = rerankResult.json || {};
      top5 = Array.isArray(reranked.top5) ? reranked.top5 : [];
      pipelineLog.push({ tier: "rerank", model: rerankResult.modelUsed, provider: rerankResult.providerUsed, top5_count: top5.length });
    } else if (visionFeatures) {
      // Chỉ có vision, không có vector → trả features làm kết quả
      top5 = [{ rank: 1, note: "Chỉ có phân tích ảnh, chưa có vector search", features: visionFeatures }];
    }

    // Build user-friendly answer
    const answerParts = [];
    if (top5.length > 0 && top5[0].code) {
      answerParts.push(`Tìm thấy ${top5.length} kết quả phù hợp nhất:`);
      for (const item of top5.slice(0, 5)) {
        answerParts.push(`• ${item.code} — ${item.match_reason || ""} (${item.confidence || "?"})`);
      }
    } else if (visionFeatures) {
      answerParts.push("Đã phân tích ảnh nhưng chưa tìm được kết quả khớp trong vector base.");
    } else {
      answerParts.push("Không đủ dữ liệu để tìm kiếm. Vui lòng cung cấp ảnh hoặc mô tả chi tiết hơn.");
    }

    return json({
      ok: true,
      engine: "kim-v6",
      answer: answerParts.join("\n"),
      top5,
      vision_features: visionFeatures,
      refined_features: refinedFeatures,
      pipeline_log: pipelineLog,
      elapsed_ms: Date.now() - t0,
    });

  } catch (e) {
    console.error("[kim-v6-search]", e.message);
    return json({
      ok: false,
      engine: "kim-v6",
      user_message: `Lỗi pipeline: ${e.message}`,
      code: e.code,
      pipeline_log: pipelineLog,
      elapsed_ms: Date.now() - t0,
    }, 500);
  }
}

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl));
  if (!m) throw new Error("Invalid data URL format");
  return [m[1], m[2]];
}

