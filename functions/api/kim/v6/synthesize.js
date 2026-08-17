// Kim v6 — Metadata Synthesizer Tier (CF-native)
// POST /api/kim/v6/synthesize { vision_features, vector_neighbors }
// → Tổng hợp vision analysis + metadata của top-K vector neighbors → refined features
// Giúp phân biệt các mã giống nhau 95%

import { json, readJson } from "../../../_lib/shared/http.js";
import { callJson } from "../../../_lib/kim/v6/apiRotator.js";
import { validateSession } from "../../../_lib/kim/v5/connectors/supabase.js";

const SYNTHESIZER_PROMPT = `Bạn là chuyên gia tổng hợp đặc điểm linh kiện công nghiệp.
Nhiệm vụ: kết hợp thông tin từ 2 nguồn để tạo bộ đặc điểm tinh chỉnh (refined features).

NGUỒN 1 — Phân tích ảnh (Vision Analyst):
{{VISION_FEATURES}}

NGUỒN 2 — Metadata của các linh kiện tương tự nhất trong vector base:
{{VECTOR_NEIGHBORS}}

Hãy tổng hợp và trả về JSON refined features:
{
  "refined_object_family": string|null,
  "refined_hole_count": number|null,
  "refined_geometry": string[],
  "refined_material": string|null,
  "distinguishing_marks": string[],
  "confidence_level": "high"|"medium"|"low",
  "disambiguation_notes": string,
  "suggested_codes": string[]
}

Nguyên tắc:
- Nếu vision và metadata khớp nhau → confidence high
- Nếu mâu thuẫn → ghi rõ trong disambiguation_notes, confidence low
- suggested_codes: mã linh kiện có khả năng khớp cao nhất dựa trên evidence tổng hợp
- Không bịa mã không có trong vector neighbors`;

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

  const visionFeatures = body.vision_features;
  const vectorNeighbors = body.vector_neighbors;

  if (!visionFeatures || !Array.isArray(vectorNeighbors)) {
    return json({ ok: false, message: "Cần vision_features và vector_neighbors (array)." }, 400);
  }

  const prompt = SYNTHESIZER_PROMPT
    .replace("{{VISION_FEATURES}}", JSON.stringify(visionFeatures, null, 2))
    .replace("{{VECTOR_NEIGHBORS}}", JSON.stringify(vectorNeighbors.slice(0, 10), null, 2));

  const messages = [{ role: "user", content: prompt }];

  try {
    const result = await callJson(env, "synthesizer", messages, {
      temperature: 0.15,
      maxTokens: 2048,
      responseFormat: { type: "json_object" },
    });

    return json({
      ok: true,
      refined_features: result.json || { raw: result.content },
      model_used: result.modelUsed,
      provider_used: result.providerUsed,
    });
  } catch (e) {
    console.error("[kim-v6-synthesize]", e.message);
    return json({ ok: false, message: e.message, code: e.code }, 502);
  }
}

</content>