// Hồ sơ embedding của vector base — phải khớp tuyệt đối 3 nơi
// (client DictionaryAI, server, bảng catalogue_image_vectors).
// Mặc định lấy đúng profile cls_l2_v1 của repo; ghi đè được bằng env.

export function activeProfile(env = process.env) {
  return {
    model: String(env.KIM_VECTOR_MODEL || "onnx-community/dinov2-small"),
    model_version: String(env.KIM_VECTOR_MODEL_VERSION || "ef1fb10"),
    preprocess_version: String(env.KIM_PREPROCESS_VERSION || "kim_canon_v2"),
    profile: String(env.KIM_EMBEDDING_PROFILE || "cls_l2_v1"),
    dimension: Number(env.KIM_VECTOR_DIMENSION || 384)
  };
}

export function sameProfile(a, b) {
  return (
    a?.model === b?.model &&
    a?.model_version === b?.model_version &&
    a?.preprocess_version === b?.preprocess_version &&
    a?.profile === b?.profile &&
    Number(a?.dimension) === Number(b?.dimension)
  );
}

export function l2Normalize(vector) {
  const arr = vector.map(Number);
  let norm = 0;
  for (const v of arr) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return arr.map(v => v / norm);
}

export function assertVector(vector, profile) {
  if (!Array.isArray(vector) || vector.length !== Number(profile.dimension)) {
    const e = new Error(
      `Vector phải có đúng ${profile.dimension} chiều (nhận ${Array.isArray(vector) ? vector.length : typeof vector}).`
    );
    e.code = "KIM_VECTOR_DIMENSION_MISMATCH";
    throw e;
  }
}

export function vectorLiteral(vector) {
  return `[${Array.from(vector).map(v => Number(v).toFixed(8)).join(",")}]`;
}