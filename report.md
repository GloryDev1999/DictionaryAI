# Báo cáo Kiến trúc — DictionaryAI (Catalogue AI)

> Repo: https://github.com/GloryDev1999/DictionaryAI · Branch `main` · Phân tích tại commit `0bc358b`

## 1. Tổng quan

**DictionaryAI** (tên hiển thị "Catalogue AI") là ứng dụng web **tra cứu linh kiện công nghiệp** (bushing, bạc lót, cao su…) dựa trên catalogue nội bộ, hỗ trợ tìm kiếm bằng **mô tả văn bản tiếng Việt** và **ảnh chụp linh kiện**. Hệ thống gồm 2 "harness" AI (được nhân cách hóa thành tên riêng):

| Harness | Vai trò | Phiên bản |
|---|---|---|
| **Denis** | Chat/trợ lý tìm kiếm đa năng (vision + metadata scoring + verify) | v1 (`harness.js`), v4 (3-agent orchestrator) |
| **Kim** | Engine tìm kiếm catalogue chuyên sâu: text metadata + vector image search (DINOv2) | v5 |

Kiến trúc tổng thể: **static SPA (Vue 3) + Cloudflare Pages Functions (serverless) + Supabase (Postgres/pgvector RPC) + Cloudflare R2 (lưu ảnh)**.

```
Browser (index.html + Vue3)
   │  fetch /api/kim/search, /api/denis/search, /api/upload, /api/media/...
   ▼
Cloudflare Pages Functions (functions/api/**)
   ├── _middleware: CORS origin check, content-type guard, security headers
   ├── Kim v5 orchestrator  ──► Supabase RPC (metadata + vector) + R2
   ├── Denis v1/v4 harness  ──► Supabase RPC + Gemini/OpenRouter(Gemma)
   └── Upload → R2 bucket (CATALOGUE_BUCKET)
```

## 2. Cấu trúc thư mục

```
.
├── index.html                 # Toàn bộ frontend (Vue 3 SPA, ~2400 dòng, Tailwind CDN)
├── src/kim/                   # Module frontend bổ sung cho Kim
│   ├── vector/                #   DINOv2 chạy trong browser (ONNX Web Worker)
│   │   ├── browserDinov2.js   #     wrapper worker, profile cls_l2_v1 / dim 384
│   │   ├── dinov2.worker.js   #     worker encode ảnh → embedding
│   │   ├── imageCanonicalizer.js
│   │   └── chunkedUpsert.js   #     upsert vector theo lô
│   ├── performance/virtualGrid.js
│   └── RENAME_UI.md
├── functions/                 # Cloudflare Pages Functions (backend serverless)
│   ├── api/
│   │   ├── kim/               # search, vector-search/upsert/lifecycle, reindex, health, _middleware
│   │   ├── denis/             # chat, search, search-v4, probe, health
│   │   ├── media/[[path]].js  # proxy ảnh từ R2
│   │   └── upload.js          # upload ảnh linh kiện lên R2
│   └── _lib/                  # Logic nghiệp vụ
│       ├── shared/            # errors, http, hash, validation
│       ├── kim/v5/            # orchestrator, vector, retrieval, guards, agents, schemas…
│       └── denis/             # v1 harness + v4 orchestrator (agents A/B/C)
├── sql/002_match_vectors_rpc.sql   # RPC pgvector trên Supabase
├── tools/                     # Trang admin: reindex vector
└── .env.kim-v5.example        # Mẫu cấu hình biến môi trường
```

## 3. Frontend

- **Single-file SPA**: `index.html` nạp Vue 3 + Tailwind + supabase-js + Lucide qua CDN — không có build step, deploy thẳng lên Cloudflare Pages.
- Giao diện: catalogue card, viewer ảnh (zoom/pan), modal chi tiết; tối ưu render bằng `content-visibility` + virtual grid (`src/kim/performance/virtualGrid.js`).
- Gọi backend qua các endpoint relative: `/api/kim/search`, `/api/kim/vector-upsert`, `/api/upload`, ảnh lấy qua `/api/media/...`.
- **Embedding phía client**: `src/kim/vector/browserDinov2.js` chạy mô hình **DINOv2-small (ONNX)** trong Web Worker để encode ảnh query ngay trên trình duyệt, gửi `query_embedding` lên server — giảm tải cho server và tránh phải truyền ảnh gốc.
- Frontend gửi `session_token` (header `x-session-token`) cho mọi API call.

## 4. Backend — Cloudflare Pages Functions

### 4.1 Bảo mật & middleware
- `functions/api/kim/_middleware.js`: chặn origin lạ (whitelist `KIM_ALLOWED_ORIGINS`), bắt buộc `application/json` cho POST/PUT/PATCH, gắn security headers (`nosniff`, `X-Frame-Options: DENY`, `referrer-policy`, `permissions-policy`, `no-store`).
- Mọi endpoint xác thực qua **RPC `app_me`** của Supabase bằng session token; upload yêu cầu role `admin`/`editor`.

### 4.2 Luồng dữ liệu Supabase
- Connector chuẩn (`_lib/kim/v5/connectors/supabase.js`): gọi Postgres RPC qua REST:
  - `app_me` — xác thực session
  - `app_search_catalogue` — tìm metadata (search text, usage_side, view_mode, phân trang)
  - `scanCatalogue` — quét tối đa `KIM_MAX_SCAN_ROWS` (mặc định 1500) làm fallback khi kết quả yếu
- Vector search dùng RPC `match_catalogue_image_vectors` với **service_role key** (`supabaseService.js`) — xem mục 5.

## 5. Kim v5 — Pipeline tìm kiếm chính

`POST /api/kim/search` → `runKimSearch()` (`_lib/kim/v5/orchestrator.js`). Triết lý: **deterministic trước, AI sau — chỉ gọi AI khi thật sự mơ hồ**, và luôn có fallback.

### 5.1 Các bước

1. **Exact lookup**: query khớp chính xác `code`/`part_id` → trả ngay (mode `KIM_EXACT`, 0 lần gọi AI).
2. **Text retrieval**: parse ràng buộc văn bản (`textConstraints.js`: số lỗ, hình dạng, màu…), tìm theo câu gốc + tối đa 4 "anchor" quan trọng; thiếu thì scan catalogue.
3. **Nhánh chỉ-text** (không có ảnh): lọc nghiêm theo constraint → `KIM_TEXT_STRICT`; không thì xếp hạng metadata (ngưỡng 0.20) → `KIM_TEXT_METADATA`/`KIM_TEXT_STRONG`. Không bao giờ gọi AI.
4. **Nhánh ảnh**:
   - Kiểm tra feature flag `KIM_VECTOR_SEARCH_ENABLED`.
   - **Canonicalize**: gọi endpoint tách nền (foreground) nếu cấu hình; lỗi thì fallback ảnh gốc, hạ quality score.
   - **Encode**: dùng embedding client gửi lên (phải khớp profile `cls_l2_v1`, dim 384, L2-normalized) hoặc gọi `KIM_EMBEDDING_ENDPOINT`.
   - **Vector search**: RPC pgvector HNSW (`hnsw.ef_search=100`), lọc theo đúng profile model/preprocess, ngưỡng similarity ≥ `KIM_VECTOR_MIN` (0.55), top-K 30; hỗ trợ **multi-probe** (nhiều biến thể ảnh → RRF fusion).
   - **Collapse**: mỗi record (SKU) có thể có nhiều view (front/back/detail) → chỉ giữ view tốt nhất.
   - **Hydrate + rank metadata + structural evidence** → **score fusion** (`scoreFusion.js`) → pool ứng viên (resolverK=10), hash pool để chống hallucination.
5. **Ambiguity gate** (`ambiguityGate.js`): chỉ gọi **Gemini resolver** nếu được bật và điểm mơ hồ vượt gap (`KIM_AMBIGUITY_GAP`, có vector floor). Kết quả Gemini bị **ép trong pool ứng viên** (`guards/candidatePool.js`) — không được tự bịa candidate.
6. **Gemma judge** (OpenRouter, Gemma-4-31b free): chỉ chạy khi Gemini trả về vẫn còn mơ hồ (`KIM_JUDGE_GAP`) → mode `KIM_VECTOR_GEMINI_GEMMA`.

### 5.2 Ngân sách & quan sát
- `runtime/budget.js` giới hạn số lần gọi AI mỗi query (mặc định 1 Gemini + 1 OpenRouter); `runtime/trace.js` ghi vết từng bước; `ai_calls.snapshot()` trả về trong response.

## 6. Denis — Trợ lý/chat (2 thế hệ cùng tồn tại)

### 6.1 Denis v1 (`searchHarness.js`, endpoint `/api/denis/search`, `/api/denis/chat`)
Luồng: **Vision observe → retrieve theo thuật ngữ → score heuristic → vision verify top-K**.
- Quan sát ảnh bằng model vision (OpenRouter) theo schema `OBSERVATION_SCHEMA`.
- Heuristic score: khớp mã +80, khớp metadata +16, khớp số lỗ +25…, kèm từ điển tiếng Việt ("bạc lót", "màu xám"…).
- Verify: gửi ảnh query + ảnh top candidate (đọc từ R2) cho model xếp hạng lại theo `VERIFY_SCHEMA`.

### 6.2 Denis v4 (`v4/orchestrator.js`, endpoint `/api/denis/search-v4`) — mô hình **3 agent**
- **Agent A – Visual Analyst**: Gemini tạo "visual signature"; fallback Gemma qua OpenRouter.
- **Agent B – Evidence Resolver**: so sánh trực tiếp ảnh query với ảnh candidate (Gemini) hoặc rank metadata (Gemma cho text-only).
- **Agent C – Critic/Judge**: chỉ chạy khi kết quả B mơ hồ và còn budget (OpenRouter/Gemma).
- Các chế độ: `EASY_STRONG_FILTER`, `EASY_EXACT`, `EASY_FILTER`, `MEDIUM_AGENT_B_METADATA`, `IMAGE_AGENT_A_SUFFICIENT`, `HARD_2_AGENT`, `HARD_3_AGENT`… kèm fallback khi thiếu API key hoặc provider lỗi (không bao giờ trả về rỗng khi vẫn còn ứng viên).
- Guards: `validateRanking`/`validateJudge`/`assertTop5ForUi` đảm bảo UI luôn nhận ≤5 candidate hợp lệ; `candidate_pool_hash` truy vết.

## 7. Tầng Vector (DINOv2 + pgvector)

- **Model**: `onnx-community/dinov2-small`, 384 chiều, profile `cls_l2_v1` (CLS token + L2 normalize), preprocess `kim_canon_v2`. Profile được **đóng băng** và phải khớp tuyệt đối giữa client–server–DB (nếu lệch → lỗi `KIM_VECTOR_PROFILE_MISMATCH`).
- **Lưu trữ**: bảng `catalogue_image_vectors` (halfvec(384)) với các cột profile; index HNSW.
- **RPC** `match_catalogue_image_vectors` (`sql/002_match_vectors_rpc.sql`): cosine distance `<=>`, lọc `is_active` + đúng profile, `security definer`, **chỉ grant execute cho `service_role`** (anon/authenticated bị revoke).
- **Endpoint quản trị** (`/api/kim/vector-*`, `reindex*`): upsert/lifecycle/reindex batch, bảo vệ bằng `KIM_ADMIN_TOKEN`; trang công cụ ở `tools/kim-vector-reindex.html`.
- **Upsert phía client**: browser encode ảnh bằng DINOv2 worker rồi `chunkedUpsert` qua `/api/kim/vector-upsert`.

## 8. Lưu trữ ảnh (R2) & Upload

- Bucket R2 binding `CATALOGUE_BUCKET`; ảnh tổ chức theo `{asset_type}/{CODE}/{uploadId}.{ext}` với asset_type ∈ {thumb, front, back, detail, compare}.
- `POST /api/upload`: multipart, xác thực role admin/editor, giới hạn 10MB, chỉ nhận webp/png/jpeg, cache immutable 1 năm.
- `/api/media/[[path]].js` serve ảnh công khai; frontend đọc ảnh qua `R2_MEDIA_BASE_URL=/api/media`.

## 9. Cấu hình (feature flags & env)

Từ `.env.kim-v5.example`:
- **Flags**: `KIM_ENABLED`, `KIM_VECTOR_SEARCH_ENABLED`, `KIM_GEMINI_RERANK_ENABLED`, `KIM_GEMMA_JUDGE_ENABLED`, `KIM_V4_ROLLBACK_ENABLED` (mọi tính năng AI đều tắt mặc định, an toàn khi thiếu key).
- **AI providers**: `GEMINI_API_KEY` (gemini-3.5-flash), `OPENROUTER_API_KEY` (gemma-4-31b-it:free, app "Thu Ky Kim").
- **Vector**: model/version/profile/dimension/topK/minSimilarity/maxScanRows + endpoint embedding & foreground riêng.
- **Gates**: `KIM_AMBIGUITY_GAP=0.035`, `KIM_JUDGE_GAP=0.05`.

## 10. Điểm mạnh của kiến trúc

1. **Tiết kiệm chi phí AI**: đường dẫn deterministic (exact/strong-filter/metadata) xử lý phần lớn query; AI chỉ vào khi ambiguity gate cho phép; budget cứng mỗi query.
2. **Chống hallucination**: agent AI chỉ được chọn trong pool ứng viên đã hash (`enforceCandidatePool`, `validateRanking`).
3. **Khả năng chống chịu**: mọi tầng đều có fallback (thiếu key → trả metadata + cảnh báo; endpoint lỗi → dùng ảnh gốc; provider chết → vẫn có kết quả).
4. **Versioning vector nghiêm ngặt**: profile (model + version + preprocess) phải khớp 3 nơi, cho phép reindex an toàn khi đổi model.
5. **Bảo mật phân tầng**: session RPC, role-based upload, middleware origin/content-type, RPC vector chỉ cho service_role.

## 11. Hạn chế / điểm cần lưu ý

- **`index.html` monolith ~2400 dòng** — khó bảo trì khi phình to; đã có dấu hiệu tách module dần vào `src/`.
- `hydrateVectorHits` tự nhận là **bridge tạm** (scan toàn bộ catalogue rồi map) — tốn chi phí khi catalogue lớn; nên có RPC hydration riêng.
- Denis v1 và v4 cùng tồn tại — cần quyết định deprecate để giảm bề mặt bảo trì.
- CDN runtime (Tailwind CDN, unpkg) — phụ thuộc mạng ngoài, không phù hợp nếu cần offline/bundle.
- `scanCatalogue` (1500 dòng) là fallback đúng nhưng sẽ chậm dần theo kích thước catalogue.

## 12. Tóm tắt một request ảnh qua Kim v5

```
Client encode ảnh (DINOv2 worker) ──► POST /api/kim/search {message, query_embedding, hints}
  → validateSession(app_me) → validateKimQuery
  → exactLookup? ──yes──► KIM_EXACT
  → text retrieval + constraints
  → canonicalize (foreground?) → encode (client/endpoint)
  → pgvector RPC (≥0.55) → collapse per record → hydrate
  → rank metadata + structural evidence → score fusion → pool(10)
  → ambiguity gate ──no──► KIM_VECTOR_CLEAR (top 5)
  → Gemini resolver (ép pool)
  → còn mơ hồ? ──yes──► Gemma judge → KIM_VECTOR_GEMINI_GEMMA
  → trả ≤5 candidate + warnings + ai_calls budget
```