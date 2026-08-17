// Kim v6 — Vision Analyst Tier (CF-native)
// POST /api/kim/v6/analyze { image_data_url, user_note? }
// → Gọi vision model qua API Rotator → trả structured features JSON

import { json, readJson } from "../../../_lib/shared/http.js";
import { callJson } from "../../../_lib/kim/v6/apiRotator.js";
import { validateSession } from "../../../_lib/kim/v5/connectors/supabase.js";

const VISION_PROMPT = `Bạn là chuyên gia nhận diện linh kiện công nghiệp.
Phân tích ảnh này để tra cứu catalogue. Tập trung: họ vật thể, màu chủ đạo,
số lỗ/gờ/rãnh nếu thấy rõ, hình dạng tổng thể, chất liệu nhìn thấy (cao su/nhựa/kim loại),
gờ viền/flange, đặc điểm phân biệt. Không suy đoán kích thước tuyệt đối.
Trả JSON đúng schema:
{
  "object_family": string|null,
  "dominant_colors": string[],
  "geometry": string[],
  "hole_count": number|null,
  "visible_features": string[],
  "material_look": string|null,
  "orientation_cues": string[],
  "search_terms": string[],
  "uncertainties": string[]
}`;

export async function onRequestPost({ request, env }) {
  // Auth check
  const token = request.headers.get("x-session-token") || "";
  try {
    await validateSession(env, token);
  } catch (e) {
    return json({ ok: false, message: e?.message || "Session không hợp lệ." }, 401);
  }

  let body;
  try {
    body = await readJson(request, { maxBytes: 8_000_000 });
  } catch {
    return json({ ok: false, message: "JSON body không hợp lệ." }, 400);
  }

  const imageDataUrl = String(body.image_data_url || "").trim();
  if (!imageDataUrl || !imageDataUrl.startsWith("data:image/")) {
    return json({ ok: false, message: "Cần image_data_url (base64 data URL)." }, 400);
  }

  const userNote = String(body.user_note || "").trim();
  const [mime, base64Data] = splitDataUrl(imageDataUrl);

  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: VISION_PROMPT + (userNote ? `\n\nGhi chú: ${userNote}` : "") },
        { type: "image_url", image_url: { url: `data:${mime};base64,${base64Data}` } },
      ],
    },
  ];

  try {
    const result = await callJson(env, "vision", messages, {
      temperature: 0.1,
      maxTokens: 2048,
      responseFormat: { type: "json_object" },
    });

    return json({
      ok: true,
      features: result.json || { raw: result.content },
      model_used: result.modelUsed,
      provider_used: result.providerUsed,
    });
  } catch (e) {
    console.error("[kim-v6-analyze]", e.message);
    return json({ ok: false, message: e.message, code: e.code }, 502);
  }
}

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl));
  if (!m) throw new Error("Invalid data URL format");
  return [m[1], m[2]];
}

</content>