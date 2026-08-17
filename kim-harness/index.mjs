// dsh-plugin-kim — Thư ký Kim chạy trên DeepSeek Harness.
// Đăng ký bộ tool quản lý vector base (Supabase pgvector) và đọc hiểu ảnh.
// Mọi cấu hình kết nối đọc từ biến môi trường (profile kim nạp .env lúc boot).

import { defineTool } from "@deepseek-ai/dsh-tools";
import { rpcAnon, rpcService, restService, validateSession, adminToken } from "./lib/supabase.mjs";
import { activeProfile, sameProfile, l2Normalize, assertVector, vectorLiteral } from "./lib/vectorProfile.mjs";
import { fetchImageAsDataUrl, encodeImage, describeImage } from "./lib/image.mjs";

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
  // ------------------------------------------------------------------
  // 1. Tìm kiếm metadata catalogue (RPC app_search_catalogue)
  // ------------------------------------------------------------------
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

      const rows = await rpcAnon(
        "app_search_catalogue",
        {
          p_session_token: token,
          p_search: String(args.search || ""),
          p_usage_side: args.usage_side || "all",
          p_view_mode: args.view_mode || "all",
          p_limit: clampInt(args.limit, 50, 1, 100),
          p_offset: clampInt(args.offset, 0, 0, 100000)
        },
        exec.signal
      );

      return jsonResult({ ok: true, count: Array.isArray(rows) ? rows.length : 0, rows });
    }
  }));

  // ------------------------------------------------------------------
  // 2. Tìm kiếm bằng ảnh qua vector base (pgvector HNSW)
  // ------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "kim_vector_search",
    description:
      "Tìm linh kiện tương tự bằng ảnh: encode ảnh (DINOv2 profile cls_l2_v1) rồi tra vector base " +
      "catalogue_image_vectors qua match_catalogue_image_vectors. Nhận image_data_url hoặc image_path " +
      "(object key R2 / URL qua KIM_MEDIA_BASE_URL).",
    parameters: {
      image_data_url: { type: "string", description: "Ảnh query dạng base64 data URL (jpeg/png/webp)." },
      image_path: { type: "string", description: "Object key ảnh trong catalogue hoặc URL đầy đủ." },
      top_k: { type: "number", description: "Số kết quả tối đa (1-100, mặc định 30)." },
      min_similarity: { type: "number", description: "Ngưỡng similarity tối thiểu, mặc định 0.55." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      const imageDataUrl = await resolveImageDataUrl(args, exec.signal);
      const { embedding, profile } = await encodeImage(imageDataUrl, { signal: exec.signal });

      const active = activeProfile();
      if (!sameProfile(active, profile)) {
        const e = new Error(
          `Profile embedding trả về (${JSON.stringify(profile)}) không khớp active profile (${JSON.stringify(active)}).`
        );
        e.code = "KIM_VECTOR_PROFILE_MISMATCH";
        throw e;
      }

      const vector = l2Normalize(embedding);
      assertVector(vector, active);

      const hits = await rpcService(
        "match_catalogue_image_vectors",
        {
          p_query_embedding: vectorLiteral(vector),
          p_embedding_model: active.model,
          p_embedding_model_version: active.model_version,
          p_preprocess_version: active.preprocess_version,
          p_embedding_profile: active.profile,
          p_match_count: clampInt(args.top_k, 30, 1, 100)
        },
        exec.signal
      );

      const min = Number(args.min_similarity ?? Number(process.env.KIM_VECTOR_MIN || 0.55));
      const rows = (Array.isArray(hits) ? hits : []).filter(h => Number(h?.similarity || 0) >= min);

      return jsonResult({
        ok: true,
        profile: active,
        total_hits: Array.isArray(hits) ? hits.length : 0,
        above_threshold: rows.length,
        min_similarity: min,
        hits: rows
      });
    }
  }));

  // ------------------------------------------------------------------
  // 3. Upsert embedding vào vector base (quản trị, service_role)
  // ------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "kim_vector_upsert",
    description:
      "Quản trị vector base: encode ảnh của một bản ghi catalogue và upsert vào bảng " +
      "catalogue_image_vectors (đúng profile đang hoạt động). Dùng khi thêm/đổi ảnh linh kiện.",
    parameters: {
      record_id: { type: "string", required: true, description: "ID bản ghi catalogue." },
      object_key: { type: "string", required: true, description: "Object key ảnh trong R2." },
      asset_type: { type: "string", required: true, description: "thumb | front | back | detail | compare." },
      image_data_url: { type: "string", description: "Ảnh dạng base64 data URL (hoặc dùng image_path)." },
      image_path: { type: "string", description: "Đường dẫn/URL ảnh thay cho data URL." },
      is_active: { type: "boolean", description: "Kích hoạt vector ngay; mặc định true." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      const allowed = new Set(["thumb", "front", "back", "detail", "compare"]);
      if (!allowed.has(args.asset_type)) {
        const e = new Error(`asset_type phải là một trong: ${[...allowed].join(", ")}.`);
        e.code = "KIM_ASSET_TYPE_INVALID";
        throw e;
      }

      const imageDataUrl = await resolveImageDataUrl(args, exec.signal);
      const { embedding, profile } = await encodeImage(imageDataUrl, { signal: exec.signal });
      const active = activeProfile();
      if (!sameProfile(active, profile)) {
        const e = new Error("Embedding endpoint trả về profile khác active profile; từ chối upsert để tránh lẫn profile.");
        e.code = "KIM_VECTOR_PROFILE_MISMATCH";
        throw e;
      }

      const vector = l2Normalize(embedding);
      assertVector(vector, active);

      const row = {
        record_id: String(args.record_id),
        asset_type: args.asset_type,
        object_key: String(args.object_key),
        embedding: vectorLiteral(vector),
        embedding_model: active.model,
        embedding_model_version: active.model_version,
        preprocess_version: active.preprocess_version,
        embedding_profile: active.profile,
        is_active: args.is_active !== false
      };

      await restService("catalogue_image_vectors", {
        method: "POST",
        prefer: "resolution=merge-duplicates",
        body: row,
        signal: exec.signal
      });

      return jsonResult({ ok: true, upserted: { record_id: row.record_id, asset_type: row.asset_type, profile: active } });
    }
  }));

  // ------------------------------------------------------------------
  // 4. Bật/tắt vector trong base (lifecycle)
  // ------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "kim_vector_lifecycle",
    description:
      "Quản trị vector base: kích hoạt hoặc vô hiệu hóa (is_active) vector của một bản ghi catalogue, " +
      "có thể giới hạn theo asset_type. Vector vô hiệu không còn xuất hiện trong kết quả tìm kiếm ảnh.",
    parameters: {
      record_id: { type: "string", required: true, description: "ID bản ghi catalogue." },
      is_active: { type: "boolean", required: true, description: "true để kích hoạt, false để vô hiệu." },
      asset_type: { type: "string", description: "Chỉ áp dụng cho loại ảnh này; bỏ trống áp dụng mọi loại." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      let query = `?record_id=eq.${encodeURIComponent(args.record_id)}`;
      if (args.asset_type) query += `&asset_type=eq.${encodeURIComponent(args.asset_type)}`;

      await restService("catalogue_image_vectors", {
        method: "PATCH",
        query,
        body: { is_active: args.is_active === true },
        signal: exec.signal
      });

      return jsonResult({ ok: true, record_id: args.record_id, asset_type: args.asset_type || "*", is_active: args.is_active === true });
    }
  }));

  // ------------------------------------------------------------------
  // 5. Đọc hiểu ảnh (Gemini vision) — trích đặc điểm cấu trúc
  // ------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "kim_image_describe",
    description:
      "Đọc hiểu ảnh linh kiện bằng vision model: trích họ vật thể, màu, số lỗ, hình dạng, chất liệu, " +
      "đặc điểm phân biệt và gợi ý search terms. Dùng để xây truy vấn tìm kiếm hoặc đối chiếu ứng viên.",
    parameters: {
      image_data_url: { type: "string", description: "Ảnh dạng base64 data URL (hoặc dùng image_path)." },
      image_path: { type: "string", description: "Object key ảnh trong catalogue hoặc URL đầy đủ." },
      user_note: { type: "string", description: "Ghi chú bổ sung của người dùng về ảnh." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      const imageDataUrl = await resolveImageDataUrl(args, exec.signal);
      const observation = await describeImage(imageDataUrl, { userNote: args.user_note || "", signal: exec.signal });
      return jsonResult({ ok: true, observation });
    }
  }));

  // ------------------------------------------------------------------
  // 6. Lấy ảnh từ media base (kiểm tra khả dụng + metadata)
  // ------------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "kim_image_fetch",
    description:
      "Kiểm tra và nạp ảnh từ KIM_MEDIA_BASE_URL (proxy /api/media của DictionaryAI): xác nhận ảnh tồn tại, " +
      "trả kiểu nội dung và kích thước. Ảnh quá lớn hoặc lỗi tải sẽ báo lỗi rõ ràng.",
    parameters: {
      image_path: { type: "string", required: true, description: "Object key ảnh trong catalogue hoặc URL đầy đủ." },
      max_bytes: { type: "number", description: "Giới hạn kích thước byte, mặc định 4MB." }
    },
    output: JSON_STRING_OUTPUT,
    async execute(args, exec) {
      const dataUrl = await fetchImageAsDataUrl(args.image_path, {
        maxBytes: clampInt(args.max_bytes, 4_000_000, 1024, 12_000_000),
        signal: exec.signal
      });

      const mime = /^data:([^;]+);/.exec(dataUrl)?.[1] || "unknown";
      const bytes = Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);

      return jsonResult({ ok: true, path: args.image_path, content_type: mime, approx_bytes: bytes });
    }
  }));
}