// Đọc hiểu ảnh cho Thư ký Kim:
//  - encodeImage: ảnh -> embedding (endpoint ngoài, như Kim v5 của DictionaryAI)
//  - fetchImageAsDataUrl: lấy ảnh qua KIM_MEDIA_BASE_URL (proxy /api/media)
//  - describeImage: gọi Gemini vision để phân tích cấu trúc ảnh

import { activeProfile } from "./vectorProfile.mjs";

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

const OBSERVATION_PROMPT = `Bạn là chuyên gia nhận diện linh kiện công nghiệp.
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

export async function describeImage(imageDataUrl, { userNote = "", signal } = {}) {
  const apiKey = String(process.env.GEMINI_API_KEY || "");
  if (!apiKey) {
    const e = new Error("Thiếu GEMINI_API_KEY để phân tích ảnh.");
    e.code = "KIM_VISION_NOT_CONFIGURED";
    throw e;
  }

  const model = String(process.env.KIM_GEMINI_MODEL || "gemini-2.5-flash");
  const [mime, base64] = splitDataUrl(imageDataUrl);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: OBSERVATION_PROMPT + (userNote ? `\n\nGhi chú người dùng: ${userNote}` : "") },
            { inline_data: { mime_type: mime, data: base64 } }
          ]
        }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
      })
    }
  );

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
    e.code = "KIM_VISION_FAILED";
    throw e;
  }

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, parse_error: true };
  }
}

function splitDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(String(dataUrl));
  if (!m) {
    const e = new Error("Ảnh phải là base64 data URL.");
    e.code = "KIM_IMAGE_FORMAT_INVALID";
    throw e;
  }
  return [m[1], m[2]];
}