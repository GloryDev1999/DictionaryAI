# Hướng dẫn Sử dụng — Thư ký Kim v6 (DictionaryAI)

> Tài liệu dành cho người vận hành và phát triển. Cập nhật: 2026-08-17.

---

## 1. Tổng quan hệ thống

**DictionaryAI** là ứng dụng tra cứu linh kiện công nghiệp hỗ trợ tìm kiếm bằng văn bản tiếng Việt và ảnh chụp. Hệ thống gồm 3 thành phần chính:

| Thành phần | Mô tả | Công nghệ |
|---|---|---|
| **Frontend** | Giao diện catalogue, viewer ảnh, upload | Vue 3 SPA (single-file `index.html`) + Tailwind CDN |
| **Backend cũ** | Kim v5 + Denis v1/v4 (Cloudflare Pages Functions) | Serverless JS + Supabase + R2 |
| **Thư ký Kim v6** | Harness mới trên nền DeepSeek Harness, pipeline 4 tầng | DSH headless + API Rotator đa provider |

Kim v6 **không thay thế** backend cũ mà chạy song song, được kích hoạt qua feature flag.

---

## 2. Cài đặt & Cấu hình Kim v6

### 2.1 Yêu cầu

- Node.js ≥ 22 hoặc ≥ 24
- `dsh` CLI (cài qua `npx @deepseek-ai/dsh`)
- Tài khoản xkiro (hoặc bất kỳ OpenAI-compatible API nào)
- Supabase project với bảng `catalogue_image_vectors` đã tạo
- DINOv2 embedding endpoint (server-side)

### 2.2 Cài đặt nhanh

```bash
# 1. Clone repo
git clone https://github.com/GloryDev1999/DictionaryAI.git
cd DictionaryAI

# 2. Tạo DSH_HOME riêng cho Kim
mkdir -p ~/.dsh-kim/profiles/kim

# 3. Cài plugin kim vào profile
dsh plugin --profile kim add "file:$(pwd)/kim-harness"

# 4. Sao chép env mẫu
cp kim-harness/.env.kim.example .env
nano .env   # Điền API keys thật
```

### 2.3 Biến môi trường quan trọng

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `DSH_HOME` | ✅ | Đường dẫn DSH home riêng (`~/.dsh-kim`) |
| `KIM_LLM_API_KEY` | ✅ | Key cho agent persona chat |
| `KIM_LLM_BASE_URL` | ✅ | Endpoint LLM (mặc định `https://api.xkiro.com/v1`) |
| `XKIRO_API_KEY` | ✅ | Key cho API Rotator (pipeline tools) |
| `KIM_PROVIDERS` | ✅ | JSON array cấu hình đa provider (xem mục 3) |
| `SUPABASE_URL` | ✅ | Supabase project URL |
| `SUPABASE_ANON_KEY` | ✅ | Anon key cho metadata search |
| `SUPABASE_SERVICE_ROLE_KEY` | ⚠️ | Service role key (chỉ cần cho vector upsert/lifecycle) |
| `KIM_EMBEDDING_ENDPOINT` | ⚠️ | DINOv2 server endpoint (chỉ cần cho vector search) |
| `KIM_MEDIA_BASE_URL` | ⚠️ | Proxy ảnh (mặc định `/api/media`) |

---

## 3. Cấu hình API Rotator (Đa Provider)

API Rotator tự động xoay vòng model khi hết quota. Cấu hình qua biến `KIM_PROVIDERS` (JSON array):

```json
[
  {
    "name": "xkiro",
    "baseURL": "https://api.xkiro.com/v1",
    "apiKeyEnv": "XKIRO_API_KEY",
    "models": [
      {"id": "deepseek/deepseek-v4-pro", "roles": ["orchestrator"]},
      {"id": "xiaomi/mimo-v2.5-pro", "roles": ["vision"]},
      {"id": "mistralai/mistral-medium-3.5", "roles": ["synthesizer"]},
      {"id": "deepseek/deepseek-v4-flash", "roles": ["fallback"]},
      {"id": "minimax/minimax-m2.7", "roles": ["lightweight"]}
    ]
  },
  {
    "name": "openrouter",
    "baseURL": "https://openrouter.ai/api/v1",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "models": [
      {"id": "google/gemini-3.5-flash", "roles": ["vision", "fallback"]}
    ]
  }
]
```

### Vai trò model

| Role | Nhiệm vụ | Model gợi ý |
|---|---|---|
| `vision` | Phân tích ảnh → đặc điểm cấu trúc | `xiaomi/mimo-v2.5-pro`, `qwen/qwen3-vl-plus` |
| `orchestrator` | Reasoning rerank → Top 5 | `deepseek/deepseek-v4-pro`, `mistral-large-2512` |
| `synthesizer` | Tổng hợp metadata neighbors | `mistralai/mistral-medium-3.5`, `minimax-m2.7` |
| `fallback` | Dự phòng chung | `deepseek/deepseek-v4-flash` |
| `lightweight` | Tác vụ nhẹ, tốc độ cao | `minimax/minimax-m2.7`, `ministral-3b` |

### Cách xoay vòng

1. Gọi model primary cho role → nếu 429/quota → cooldown 60s
2. Chuyển sang model tiếp theo cùng role
3. Tất cả cooldown → dùng fallback
4. Cooldown hết → tự động retry

---

## 4. Pipeline 4 Tầng (Tìm kiếm bằng ảnh)

```
Ảnh input
   │
   ▼
┌─────────────────────────┐
│ TẦNG 1: Vision Analyst  │  kim_image_describe
│ Model: vision role      │  → JSON đặc điểm cấu trúc
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ TẦNG 2: Vector Encoder  │  kim_vector_search
│ DINOv2 → pgvector HNSW │  → Top-K candidates
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ TẦNG 3: Synthesizer     │  kim_synthesize
│ Vision + Neighbors meta │  → Refined features
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ TẦNG 4: Orchestrator    │  kim_rerank
│ Reasoning model         │  → Top 5 cuối cùng
└─────────────────────────┘
```

Mỗi tầng gọi tool tương ứng; agent Kim tự orchestrate tuần tự khi nhận yêu cầu tìm ảnh.

---

## 5. Danh sách 9 Tools

| Tool | Tầng | Input chính | Output |
|---|---|---|---|
| `kim_image_describe` | Vision | Ảnh (data URL / path) | JSON đặc điểm cấu trúc |
| `kim_vector_search` | Vector | Ảnh + top_k | Hits từ pgvector |
| `kim_synthesize` | Synthesizer | Vision JSON + Neighbors JSON | Refined features JSON |
| `kim_rerank` | Orchestrator | Query + Vision + Synthesis + Candidates | Top 5 ranked JSON |
| `kim_catalogue_search` | — | Text query | Metadata rows |
| `kim_image_fetch` | — | Image path | Content-type + size |
| `kim_vector_upsert` | Admin | Record ID + Ảnh | Upsert confirmation |
| `kim_vector_lifecycle` | Admin | Record ID + is_active | Update confirmation |
| `kim_rotator_status` | Debug | — | Trạng thái rotation |

---

## 6. Chạy & Kiểm tra

### 6.1 Headless (CLI)

```bash
source .env
dsh --profile kim "Tìm bushing màu xám có 4 lỗ"
dsh --profile kim "Phân tích ảnh này" --attach ./anh.jpg
```

### 6.2 Bridge HTTP

```bash
node kim-harness/bridge/server.mjs
# Mặc định http://127.0.0.1:3090

curl http://localhost:3090/health
curl -X POST http://localhost:3090/search \
  -H "content-type: application/json" \
  -H "x-kim-bridge-token: <token>" \
  -d '{"message":"Tìm bạc lót cao su"}'
```

### 6.3 Kết nối DictionaryAI (Production)

Trên Cloudflare Pages, thêm biến:
```
KIM_DSH_PROXY_ENABLED=true
KIM_DSH_BRIDGE_URL=http://<vps>:3090
KIM_BRIDGE_TOKEN=<secret>
```

Frontend gọi `/api/kim/search-dsh` → proxy tới bridge. Tắt flag → fallback Kim v5.

---

## 7. Troubleshooting

| Triệu chứng | Nguyên nhân | Giải pháp |
|---|---|---|
| `KIM_NO_MODEL_AVAILABLE` | Không có model khả dụng cho role | Kiểm tra `KIM_PROVIDERS` + API key |
| `KIM_RATE_LIMITED` liên tục | Hết quota tất cả providers | Thêm provider/key mới |
| `KIM_EMBEDDING_NOT_CONFIGURED` | Thiếu DINOv2 endpoint | Set `KIM_EMBEDDING_ENDPOINT` |
| `KIM_VECTOR_PROFILE_MISMATCH` | Profile client ≠ server | Kiểm tra `KIM_VECTOR_*` vars |
| Vision trả kết quả kém | Model vision yếu | Đổi model trong providers |
| Rerank chậm | Model orchestrator nặng | Dùng flash thay pro |
| Bridge timeout | Task quá phức tạp | Tăng `KIM_BRIDGE_TIMEOUT_MS` |

---

## 8. File tham khảo

| File | Nội dung |
|---|---|
| `kim-harness/index.mjs` | Plugin DSH, đăng ký 9 tools |
| `kim-harness/lib/apiRotator.mjs` | Multi-provider rotation engine |
| `kim-harness/lib/image.mjs` | Vision/Synthesizer/Orchestrator |
| `kim-harness/lib/supabase.mjs` | Supabase RPC connector |
| `kim-harness/lib/vectorProfile.mjs` | DINOv2 profile config |
| `kim-harness/bridge/server.mjs` | HTTP bridge |
| `kim-harness/DEPLOY.md` | Hướng dẫn triển khai chi tiết |
| `kim-harness/.env.kim.example` | Mẫu biến môi trường |
| `report.md` | Báo cáo kiến trúc đầy đủ |
| `functions/api/kim/search-dsh.js` | Proxy endpoint trên CF Pages |