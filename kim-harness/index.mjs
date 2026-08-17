// dsh-plugin-kim v6 — Thư ký Kim trên DeepSeek Harness.
// 4-tier pipeline: Vision Analyst → Vector Encoder → Metadata Synthesizer → Orchestrator
// API Rotator: đa provider, tự động xoay vòng, không khóa cứng endpoint.

import { defineTool } from "@deepseek-ai/dsh-tools";
import { rpcAnon, rpcService, restService, validateSession, adminToken } from "./lib/supabase.mjs";
import { activeProfile, sameProfile, l2Normalize, assertVector, vectorLiteral } from "./lib/vectorProfile.mjs";
import {
  fetchImageAsDataUrl, encodeImage, describeImage,
  synthesizeMetadata, orchestrateRerank, getRotatorStatus
} from "./lib/image.mjs";

export const name = "dsh-plugin-kim";
export const inject = ["tools"];

const JSON_STRING_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }]
};

function jsonResult(value) {
  return JSON.stringify(value, null, 2);
}

async function resolveImageDataUrl({ image_data_url, image_path }, signal) {
  if (image_data_url) return image_data_url;
  if (image_path) return fetchImageAsDataUrl(image_path, { signal });
  const e = new Error("Cần image_data_url hoặc image_path.");
  e.code = "KIM_IMAGE_INPUT_MISSING";
  throw e;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function apply(ctx) {

  // ==================================================================
  // 1. kim_catalogue_search — Tìm metadata catalogue (giữ nguyên)
  // ==================================================================
  ctx.tools.register(defineTool({
    name: "kim_catalogue_search",
    description:
      "Tìm kiếm metadata catalogue DictionaryAI theo văn bản (mã linh kiện, mô tả tiếng Việt, đặc điểm). " +
      "Trả về danh sách bản ghi catalogue với code, part_id, identifying_features, đường dẫn ảnh.",
    parameters: {
      search: { type: "string", required: true, description: "Từ khóa hoặc câu mô tả cần tìm." },
      usage_side: { type: "string", description: "Lọc phía sử dụng; mặc định 'all'." },
      view_mode: { type: "string", description: "Lọc chế độ xem; mặc định 'all'." },
      limit: { type: "number", description: "Số bản ghi tối đa (1-100, mặc định 50)." },
      offset: { type: "number", description: "Phân trang, mặc định 0." },
      session_token: { type: "string", description: "Session token; bỏ trống dùng KIM_ADMIN_SESSION_TOKEN." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      const token = args.session_token || adminToken();
      await validateSession(token, exec.signal);
      const rows = await rpcAnon("app_search_catalogue", {
        p_session_token: token,
        p_search: String(args.search || ""),
        p_usage_side: args.usage_side || "all",
        p_view_mode: args.view_mode || "all",
        p_limit: clampInt(args.limit, 50, 1, 100),
        p_offset: clampInt(args.offset, 0, 0, 100000)
      }, exec.signal);
      return jsonResult({ ok: true, count: Array.isArray(rows) ? rows.length : 0, rows });
    }
  }));

  // ==================================================================
  // 2. kim_vector_search — Vector search pgvector (giữ nguyên)
  // ==================================================================
  ctx.tools.register(defineTool({
    name: "kim_vector_search",
    description:
      "Tìm linh kiện tương tự bằng ảnh: encode ảnh (DINOv2 cls_l2_v1) rồi tra vector base " +
      "catalogue_image_vectors qua match_catalogue_image_vectors.",
    parameters: {
      image_data_url: { type: "string", description: "Ảnh query dạng base64 data URL." },
      image_path: { type: "string", description: "Object key ảnh trong catalogue hoặc URL." },
      top_k: { type: "number", description: "Số kết quả tối đa (1-100, mặc định 30)." },
      min_similarity: { type: "number", description: "Ngưỡng similarity tối thiểu, mặc định 0.55." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      const imageDataUrl = await resolveImageDataUrl(args, exec.signal);
      const { embedding, profile } = await encodeImage(imageDataUrl, { signal: exec.signal });
      const active = activeProfile();
      if (!sameProfile(active, profile)) {
        const e = new Error(`Profile mismatch: ${JSON.stringify(profile)} vs ${JSON.stringify(active)}`);
        e.code = "KIM_VECTOR_PROFILE_MISMATCH";
        throw e;
      }
      const vector = l2Normalize(embedding);
      assertVector(vector, active);
      const hits = await rpcService("match_catalogue_image_vectors", {
        p_query_embedding: vectorLiteral(vector),
        p_embedding_model: active.model,
        p_embedding_model_version: active.model_version,
        p_preprocess_version: active.preprocess_version,
        p_embedding_profile: active.profile,
        p_match_count: clampInt(args.top_k, 30, 1, 100)
      }, exec.signal);
      const min = Number(args.min_similarity ?? Number(process.env.KIM_VECTOR_MIN || 0.55));
      const rows = (Array.isArray(hits) ? hits : []).filter(h => Number(h?.similarity || 0) >= min);
      return jsonResult({ ok: true, profile: active, total_hits: hits?.length || 0, above_threshold: rows.length, hits: rows });
    }
  }));

  // ==================================================================
  // 3. kim_vector_upsert — Upsert embedding (giữ nguyên)
  // ==================================================================
  ctx.tools.register(defineTool({
    name: "kim_vector_upsert",
    description: "Encode ảnh và upsert vào vector base catalogue_image_vectors.",
    parameters: {
      record_id: { type: "string", required: true, description: "ID bản ghi catalogue." },
      object_key: { type: "string", required: true, description: "Object key ảnh trong R2." },
      asset_type: { type: "string", required: true, description: "thumb | front | back | detail | compare." },
      image_data_url: { type: "string", description: "Ảnh dạng base64 data URL." },
      image_path: { type: "string", description: "Đường dẫn/URL ảnh." },
      is_active: { type: "boolean", description: "Kích hoạt vector ngay; mặc định true." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      const allowed = new Set(["thumb", "front", "back", "detail", "compare"]);
      if (!allowed.has(args.asset_type)) {
        const e = new Error(`asset_type phải là: ${[...allowed].join(", ")}`);
        e.code = "KIM_ASSET_TYPE_INVALID";
        throw e;
      }
      const imageDataUrl = await resolveImageDataUrl(args, exec.signal);
      const { embedding, profile } = await encodeImage(imageDataUrl, { signal: exec.signal });
      const active = activeProfile();
      if (!sameProfile(active, profile)) {
        const e = new Error("Embedding profile mismatch.");
        e.code = "KIM_VECTOR_PROFILE_MISMATCH";
        throw e;
      }
      const vector = l2Normalize(embedding);
      assertVector(vector, active);
      const row = {
        record_id: String(args.record_id), asset_type: args.asset_type,
        object_key: String(args.object_key), embedding: vectorLiteral(vector),
        embedding_model: active.model, embedding_model_version: active.model_version,
        preprocess_version: active.preprocess_version, embedding_profile: active.profile,
        is_active: args.is_active !== false
      };
      await restService("catalogue_image_vectors", {
        method: "POST", prefer: "resolution=merge-duplicates", body: row, signal: exec.signal
      });
      return jsonResult({ ok: true, upserted: { record_id: row.record_id, asset_type: row.asset_type } });
    }
  }));

  // ==================================================================
  // 4. kim_vector_lifecycle — Bật/tắt vector (giữ nguyên)
  // ==================================================================
  ctx.tools.register(defineTool({
    name: "kim_vector_lifecycle",
    description: "Kích hoạt hoặc vô hiệu hóa vector của bản ghi catalogue.",
    parameters: {
      record_id: { type: "string", required: true, description: "ID bản ghi." },
      is_active: { type: "boolean", required: true, description: "true/false." },
      asset_type: { type: "string", description: "Chỉ áp dụng cho loại ảnh này." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      let query = `?record_id=eq.${encodeURIComponent(args.record_id)}`;
      if (args.asset_type) query += `&asset_type=eq.${encodeURIComponent(args.asset_type)}`;
      await restService("catalogue_image_vectors", {
        method: "PATCH", query, body: { is_active: args.is_active === true }, signal: exec.signal
      });
      return jsonResult({ ok: true, record_id: args.record_id, is_active: args.is_active === true });
    }
  }));

  // ==================================================================
  // 5. kim_image_describe — TẦNG 1: Vision Analyst (NÂNG CẤP)
  //    Dùng API Rotator, tự động xoay model vision
  // ==================================================================
  ctx.tools.register(defineTool({
    name: "kim_image_describe",
    description:
      "[Vision Analyst] Phân tích ảnh linh kiện bằng model vision qua API Rotator. " +
      "Trích xuất họ vật thể, màu, số lỗ, hình dạng, chất liệu, đặc điểm phân biệt. " +
      "Tự động chọn model tốt nhất, xoay vòng khi hết quota.",
    parameters: {
      image_data_url: { type: "string", description: "Ảnh dạng base64 data URL." },
      image_path: { type: "string", description: "Object key hoặc URL ảnh." },
      user_note: { type: "string", description: "Ghi chú bổ sung." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      const imageDataUrl = await resolveImageDataUrl(args, exec.signal);
      const observation = await describeImage(imageDataUrl, { userNote: args.user_note || "", signal: exec.signal });
      return jsonResult({ ok: true, observation });
    }
  }));

  // ==================================================================
  // 6. kim_image_fetch — Lấy ảnh từ media base (giữ nguyên)
  // ==================================================================
  ctx.tools.register(defineTool({
    name: "kim_image_fetch",
    description: "Kiểm tra và nạp ảnh từ KIM_MEDIA_BASE_URL.",
    parameters: {
      image_path: { type: "string", required: true, description: "Object key hoặc URL." },
      max_bytes: { type: "number", description: "Giới hạn byte, mặc định 4MB." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      const dataUrl = await fetchImageAsDataUrl(args.image_path, {
        maxBytes: clampInt(args.max_bytes, 4_000_000, 1024, 12_000_000), signal: exec.signal
      });
      const mime = /^data:([^;]+);/.exec(dataUrl)?.[1] || "unknown";
      const bytes = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
      return jsonResult({ ok: true, path: args.image_path, content_type: mime, approx_bytes: bytes });
    }
  }));

  // ==================================================================
  // 7. kim_synthesize — TẦNG 3: Metadata Synthesizer (MỚI)
  // ==================================================================
  ctx.tools.register(defineTool({
    name: "kim_synthesize",
    description:
      "[Metadata Synthesizer] Tổng hợp vision analysis + vector neighbors metadata → refined features. " +
      "Giúp tinh chỉnh đặc điểm nhận dạng khi ảnh bị ánh sáng biến thiên hoặc nhiều mã giống nhau. " +
      "Cần truyền vision_observation (từ kim_image_describe) và vector_neighbors (từ kim_vector_search).",
    parameters: {
      vision_observation: { type: "string", required: true, description: "JSON output từ kim_image_describe." },
      vector_neighbors: { type: "string", required: true, description: "JSON array hits từ kim_vector_search." },
      user_query: { type: "string", description: "Câu hỏi/mô tả gốc của người dùng." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      let vision, neighbors;
      try { vision = JSON.parse(args.vision_observation); } catch { vision = { raw: args.vision_observation }; }
      try { neighbors = JSON.parse(args.vector_neighbors); } catch { neighbors = []; }
      const synthesis = await synthesizeMetadata(
        { visionObservation: vision, vectorNeighbors: neighbors, userQuery: args.user_query || "" },
        { signal: exec.signal }
      );
      return jsonResult({ ok: true, synthesis });
    }
  }));

  // ==================================================================
  // 8. kim_rerank — TẦNG 4: Orchestrator/Reranker (MỚI)
  // ==================================================================
  ctx.tools.register(defineTool({
    name: "kim_rerank",
    description:
      "[Orchestrator] Rerank candidates bằng reasoning model để chọn Top 5 chính xác nhất. " +
      "Tổng hợp evidence từ vision, synthesis, vector scores. Penalize false positive. " +
      "Cần truyền vision_observation, synthesis (từ kim_synthesize), và candidates (từ kim_vector_search).",
    parameters: {
      query: { type: "string", required: true, description: "Câu hỏi/mô tả gốc." },
      vision_observation: { type: "string", required: true, description: "JSON từ kim_image_describe." },
      synthesis: { type: "string", required: true, description: "JSON từ kim_synthesize." },
      candidates: { type: "string", required: true, description: "JSON array candidates từ kim_vector_search." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      let vision, synth, cands;
      try { vision = JSON.parse(args.vision_observation); } catch { vision = {}; }
      try { synth = JSON.parse(args.synthesis); } catch { synth = {}; }
      try { cands = JSON.parse(args.candidates); } catch { cands = []; }
      const ranking = await orchestrateRerank(
        { query: args.query, visionObservation: vision, synthesis: synth, candidates: cands },
        { signal: exec.signal }
      );
      return jsonResult({ ok: true, ranking });
    }
  }));

  // ==================================================================
  // 9. kim_rotator_status — Debug: xem trạng thái API rotation (MỚI)
  // ==================================================================
  ctx.tools.register(defineTool({
    name: "kim_rotator_status",
    description:
      "Xem trạng thái API Rotator: model nào đang active, model nào bị cooldown, " +
      "thời gian còn lại trước khi retry. Dùng để debug khi gặp lỗi rate limit.",
    parameters: {},
    output: JSON_STRING_OUTPUT,
    async execute(_args, _exec) {
      return jsonResult({ ok: true, models: getRotatorStatus() });
    }
  }));
}