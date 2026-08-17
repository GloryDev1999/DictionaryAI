// Đọc hiểu ảnh cho Thư ký Kim v6:
//  - encodeImage: ảnh -> embedding (endpoint ngoài, giữ nguyên DINOv2)
//  - fetchImageAsDataUrl: lấy ảnh qua KIM_MEDIA_BASE_URL
//  - describeImage: Vision Analyst tier — dùng API Rotator, không khóa cứng Gemini
//  - synthesizeMetadata: Metadata Synthesizer tier — vector neighbors → refined features

import { activeProfile } from "./vectorProfile.mjs";
import { callJson, getRotatorStatus } from "./apiRotator.mjs";

export async function fetchImageAsDataUrl(pathOrUrl, { maxBytes = 4_000_000, signal } = {}) {
  const base = String(process.env.KIM_MEDIA_BASE_URL || "").replace(/\/+$/, "");
  const url = /^https?:\/\//.test(pathOrUrl)
    ? pathOrUrl
    : base
      ? `${base}/${String(pathOrUrl).replace(/^\/+/, "")}`
      : String(pathOrUrl);

  if (!/^https?:\/\//.test(url)) {
    const e = new Error("Không phân giải được địa chỉ ảnh; cần KIM_MEDIA_BASE_URL hoặc URL đầy đủ.");
    e.code = "KIM_IMAGE_URL_INVALID";
    throw e;
  }

  const res = await fetch(url, { signal });
  if (!res.ok) {
    const e = new Error(`Tải ảnh thất bại HTTP ${res.status}: ${url}`);
    e.code = "KIM_IMAGE_FETCH_FAILED";
    throw e;
  }

  const buffer = new Uint8Array(await res.arrayBuffer());
  if (buffer.length > maxBytes) {
    const e = new Error(`Ảnh vượt ${maxBytes} byte.`);
    e.code = "KIM_IMAGE_TOO_LARGE";
    throw e;
  }

  const contentType = res.headers.get("content-type")?.split(";")[0] || "image/webp";
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

export async function encodeImage(imageDataUrl, { signal } = {}) {
  const endpoint = String(process.env.KIM_EMBEDDING_ENDPOINT || "");
  if (!endpoint) {
    const e = new Error("Thiếu KIM_EMBEDDING_ENDPOINT để encode ảnh.");
    e.code = "KIM_EMBEDDING_NOT_CONFIGURED";
    throw e;
  }

  const profile = activeProfile();
  const res = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(process.env.KIM_EMBEDDING_BEARER_TOKEN
        ? { authorization: `Bearer ${process.env.KIM_EMBEDDING_BEARER_TOKEN}` }
        : {})
    },
    body: JSON.stringify({ image_data_url: imageDataUrl, profile })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(data?.embedding)) {
    const e = new Error(data?.error || `Embedding endpoint HTTP ${res.status}`);
    e.code = "KIM_EMBEDDING_FAILED";
    throw e;
  }
  return { embedding: data.embedding, profile };
}

// ============================================================
// TẦNG 1: VISION ANALYST — Bốc tách đặc điểm từ ảnh
// Dùng API Rotator, tự động xoay model vision khi hết quota
// ============================================================

const VISION_SYSTEM_PROMPT = `Bạn là chuyên gia nhận diện linh kiện công nghiệp (Vision Analyst).
Phân tích ảnh này để tra cứu catalogue linh kiện. Tập trung vào đặc điểm CẤU TRÚC có thể quan sát được:
- Họ vật thể (bushing, bạc lót, cao su, vòng đệm, clip, gờ...)
- Màu chủ đạo và màu phụ
- Số lỗ/gờ/rãnh nếu thấy rõ (đếm chính xác nếu có thể)
- Hình dạng tổng thể (tròn, oval, chữ nhật, bất đối xứng...)
- Chất liệu nhìn thấy (cao su, nhựa, kim loại, composite...)
- Gờ viền/flange, ngàm, móc cài
- Đặc điểm phân biệt duy nhất (vết khía, logo, dấu khuôn, texture...)
- Hướng/chế độ chụp (front, back, side, angled...)

KHÔNG suy đoán kích thước tuyệt đối khi không có thước tham chiếu.
Nếu ánh sáng kém hoặc góc chụp khó, ghi rõ vào uncertainties.

Trả JSON đúng schema:
{
  "object_family": string|null,
  "dominant_colors": string[],
  "geometry": string[],
  "hole_count": number|null,
  "visible_features": string[],
  "material_look": string|null,
  "orientation_cues": string[],
  "distinguishing_marks": string[],
  "search_terms": string[],
  "confidence": number,
  "uncertainties": string[]
}`;

/**
 * Vision Analyst: phân tích ảnh bằng model vision qua API Rotator.
 * Tự động chọn model tốt nhất cho role "vision", fallback khi hết quota.
 */
export async function describeImage(imageDataUrl, { userNote = "", signal } = {}) {
  const [mime, base64] = splitDataUrl(imageDataUrl);

  const messages = [
    { role: "system", content: VISION_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: userNote ? `Phân tích ảnh linh kiện này. Ghi chú: ${userNote}` : "Phân tích ảnh linh kiện này." },
        { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } }
      ]
    }
  ];

  const result = await callJson("vision", messages, {
    temperature: 0.1,
    maxTokens: 2048,
    responseFormat: { type: "json_object" },
    signal
  });

  const observation = result.json || { raw: result.content, parse_error: true };
  observation._model_used = result.modelUsed;
  observation._provider_used = result.providerUsed;

  return observation;
}

// ============================================================
// TẦNG 3: METADATA SYNTHESIZER
// Tổng hợp vector neighbors + vision output → refined features
// ============================================================

const SYNTHESIZER_SYSTEM_PROMPT = `Bạn là Metadata Synthesizer cho hệ thống tra cứu linh kiện.
Nhiệm vụ: tổng hợp thông tin từ (1) kết quả phân tích ảnh và (2) metadata của các linh kiện tương tự
đã tìm thấy trong vector base, để tạo ra bộ đặc điểm TINH CHỈNH chính xác hơn.

Nguyên tắc:
- Nếu vision analyst và metadata neighbors ĐỒNG THUẬN về một đặc điểm → confidence cao
- Nếu MÂU THUẪN → ghi cả hai phía vào uncertainties, ưu tiên metadata (vì đã được kiểm chứng)
- Bổ sung đặc điểm mà vision bỏ sót nhưng nhiều neighbors đều có
- Loại bỏ đặc điểm vision báo nhưng không neighbor nào xác nhận (có thể do ánh sáng/bóng)

Trả JSON:
{
  "refined_object_family": string|null,
  "refined_colors": string[],
  "refined_hole_count": number|null,
  "refined_geometry": string[],
  "refined_material": string|null,
  "refined_mounting_features": string[],
  "distinguishing_marks": string[],
  "confidence_boosted_features": string[],
  "conflicting_features": string[],
  "uncertainties": string[],
  "synthesis_notes": string
}`;

/**
 * Metadata Synthesizer: tinh chỉnh đặc điểm từ vision + vector neighbors.
 */
export async function synthesizeMetadata({ visionObservation, vectorNeighbors, userQuery = "" }, { signal } = {}) {
  const neighborSummary = (vectorNeighbors || []).slice(0, 10).map((n, i) => ({
    rank: i + 1,
    code: n.code || n.record_id,
    similarity: n.similarity || n.vector_similarity,
    identifying_features: n.identifying_features,
    confusing_note: n.confusing_note,
    usage_side: n.usage_side,
    part_id: n.part_id
  }));

  const messages = [
    { role: "system", content: SYNTHESIZER_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        query: userQuery,
        vision_analysis: visionObservation,
        vector_neighbors: neighborSummary,
        neighbor_count: vectorNeighbors?.length || 0
      })
    }
  ];

  const result = await callJson("synthesizer", messages, {
    temperature: 0.15,
    maxTokens: 2048,
    responseFormat: { type: "json_object" },
    signal
  });

  const synthesis = result.json || { raw: result.content, parse_error: true };
  synthesis._model_used = result.modelUsed;
  synthesis._provider_used = result.providerUsed;

  return synthesis;
}

// ============================================================
// TẦNG 4: ORCHESTRATOR / RERANKER
// Reasoning + Function Calling để quyết định Top 5 cuối cùng
// ============================================================

const ORCHESTRATOR_SYSTEM_PROMPT = `Bạn là Orchestrator của hệ thống tra cứu linh kiện Catalogue AI.
Nhiệm vụ: dựa trên tất cả evidence (vision analysis, metadata synthesis, vector similarity scores),
chọn và xếp hạng TOP 5 linh kiện khớp nhất với ảnh/mô tả đầu vào.

Nguyên tắc quyết định:
1. Ưu tiên evidence CÓ BẰNG CHỨNG (metadata xác nhận + vision đồng thuận)
2. Penalize mạnh false positive: vector similarity cao nhưng đặc điểm cấu trúc MÂU THUẪN
3. Nếu top candidates quá giống nhau (>95% similarity), dùng distinguishing_marks để phân biệt
4. Confidence score phản ánh mức độ chắc chắn, KHÔNG phải vector similarity
5. Giải thích rõ lý do chọn mỗi candidate trong match_reason

Trả JSON:
{
  "decision_summary": string,
  "top5": [
    {
      "candidate_id": string,
      "code": string,
      "final_score": number,
      "confidence": number,
      "match_reason": string,
      "evidence_sources": string[],
      "warnings": string[]
    }
  ],
  "rejected_notable": [
    {
      "candidate_id": string,
      "code": string,
      "rejection_reason": string
    }
  ],
  "overall_confidence": number,
  "recommendation": string
}`;

/**
 * Orchestrator: rerank candidates bằng reasoning model.
 */
export async function orchestrateRerank({ query, visionObservation, synthesis, candidates }, { signal } = {}) {
  const messages = [
    { role: "system", content: ORCHESTRATOR_SYSTEM_PROMPT },
    {
      role: "user",
      content: JSON.stringify({
        user_query: query,
        vision_analysis: visionObservation,
        metadata_synthesis: synthesis,
        candidate_pool: (candidates || []).slice(0, 15).map(c => ({
          id: c.id || c.record_id,
          code: c.code,
          part_id: c.part_id,
          vector_similarity: c.vector_similarity || c.similarity,
          identifying_features: c.identifying_features,
          confusing_note: c.confusing_note,
          usage_side: c.usage_side,
          view_mode: c.view_mode
        }))
      })
    }
  ];

  const result = await callJson("orchestrator", messages, {
    temperature: 0.05,
    maxTokens: 4096,
    responseFormat: { type: "json_object" },
    signal
  });

  const ranking = result.json || { raw: result.content, parse_error: true };
  ranking._model_used = result.modelUsed;
  ranking._provider_used = result.providerUsed;

  return ranking;
}

// ============================================================
// UTILS
// ============================================================

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl));
  if (!m) {
    const e = new Error("Ảnh phải là base64 data URL.");
    e.code = "KIM_IMAGE_FORMAT_INVALID";
    throw e;
  }
  return [m[1], m[2]];
}

/** Export rotator status for debugging tool */
export { getRotatorStatus };