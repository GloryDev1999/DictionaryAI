// Kim v6 — Orchestrator/Reranker Tier (CF-native)
// POST /api/kim/v6/rerank { vision_features, refined_features, candidates }
// → Reasoning model đánh giá + xếp hạng → Top 5 cuối cùng chính xác nhất

import { json, readJson } from "../../../_lib/shared/http.js";
import { callJson } from "../../../_lib/kim/v6/apiRotator.js";
import { validateSession } from "../../../_lib/kim/v5/connectors/supabase.js";

const RERANK_PROMPT = `Bạn là chuyên gia xếp hạng kết quả tìm kiếm linh kiện công nghiệp.
Nhiệm vụ: đánh giá danh sách ứng viên và chọn Top 5 khớp nhất với ảnh query.

ĐẶC ĐIỂM TỪ ẢNH (Vision Analyst):
{{VISION_FEATURES}}

ĐẶC ĐIỂM TINH CHỈNH (Metadata Synthesizer):
{{REFINED_FEATURES}}

DANH SÁCH ỨNG VIÊN (từ vector search + metadata):
{{CANDIDATES}}

Hãy phân tích từng ứng viên, so sánh với đặc điểm ảnh, và trả về JSON:
{
  "top5": [
    {
      "rank": 1,
      "code": string,
      "record_id": string,
      "similarity_score": number,
      "match_reason": string,
      "confidence": "high"|"medium"|"low",
      "evidence_summary": string
    }
  ],
  "analysis_notes": string,
  "ambiguous": boolean
}

Nguyên tắc xếp hạng:
1. Khớp cấu trúc (số lỗ, hình dạng, gờ) quan trọng hơn similarity score thuần
2. Nếu refined_features.suggested_codes có mã trùng candidate → ưu tiên cao
3. Nếu nhiều candidate giống nhau >95% → ambiguous=true, ghi rõ trong analysis_notes
4. Chỉ đưa vào top5 những mã có evidence rõ ràng; nếu ít hơn 5 mã đủ tốt thì trả ít hơn
5. Không bịa mã không có trong danh sách candidates`;

export async function onRequestPost({ request, env }) {
  const token = request.headers.get("x-session-token") || "";
  try {
    await validateSession(env, token);
  } catch (e) {
    return json({ ok: false, message: e?.message || "Session không hợp lệ." }, 401);
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    return json({ ok: false, message: "JSON body không hợp lệ." }, 400);
  }

  const { vision_features, refined_features, candidates } = body;

  if (!vision_features || !refined_features || !Array.isArray(candidates)) {
    return json(
      { ok: false, message: "Cần vision_features, refined_features và candidates (array)." },
      400
    );
  }

  const prompt = RERANK_PROMPT
    .replace("{{VISION_FEATURES}}", JSON.stringify(vision_features, null, 2))
    .replace("{{REFINED_FEATURES}}", JSON.stringify(refined_features, null, 2))
    .replace("{{CANDIDATES}}", JSON.stringify(candidates.slice(0, 20), null, 2));

  const messages = [{ role: "user", content: prompt }];

  try {
    const result = await callJson(env, "orchestrator", messages, {
      temperature: 0.05,
      maxTokens: 4096,
      responseFormat: { type: "json_object" },
    });

    return json({
      ok: true,
      reranked: result.json || { raw: result.content },
      model_used: result.modelUsed,
      provider_used: result.providerUsed,
    });
  } catch (e) {
    console.error("[kim-v6-rerank]", e.message);
    return json({ ok: false, message: e.message, code: e.code }, 502);
  }
}

</content>