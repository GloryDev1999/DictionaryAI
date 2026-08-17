# Thư ký Kim v6 — Hướng dẫn Triển khai & Cấu hình

## Tổng quan

Thư ký Kim v6 là harness chuẩn trên nền **DeepSeek Harness**, chạy độc lập với DictionaryAI.
Kiến trúc 4-tier pipeline với API Rotator tự động xoay vòng đa provider, không khóa cứng endpoint.

```
Ảnh input → [Vision Analyst] → [Vector Encoder] → [Metadata Synthesizer] → [Orchestrator] → Top 5
              (model vision)     (DINOv2/pgvector)    (model lightweight)      (model reasoning)
```

## Cài đặt nhanh

### 1. Chuẩn bị môi trường

```bash
# Clone repo (nếu chưa có)
git clone https://github.com/GloryDev1999/DictionaryAI.git
cd DictionaryAI

# Tạo DSH_HOME riêng cho Kim (cách ly GUI)
mkdir -p ~/.dsh-kim/profiles
cp -r kim-harness/profile-template/* ~/.dsh-kim/profiles/kim/  # hoặc dùng dsh plugin

# Sao chép env mẫu và điền giá trị thật
cp kim-harness/.env.kim.example .env
nano .env  # Điền API keys, Supabase URL, etc.
```

### 2. Cấu hình API Providers

Mở `.env`, tìm biến `KIM_PROVIDERS`. Đây là JSON array cấu hình đa provider:

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
      {"id": "deepseek/deepseek-v4-flash", "roles": ["fallback", "lightweight"]},
      {"id": "mistralai/mistral-large-2512", "roles": ["fallback"]},
      {"id": "minimax/minimax-m2.7", "roles": ["lightweight"]}
    ]
  }
]
```

**Thêm provider mới:** Append object mới vào array, set `apiKeyEnv` trỏ tới biến env chứa key:

```json
[
  {"name": "xkiro", "..."},
  {
    "name": "openrouter",
    "baseURL": "https://openrouter.ai/api/v1",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "models": [
      {"id": "google/gemini-3.5-flash", "roles": ["vision", "fallback"]},
      {"id": "anthropic/claude-haiku-4.5", "roles": ["synthesizer", "lightweight"]}
    ]
  }
]
```

### 3. Phân bổ Model theo Vai trò

| Role | Mô tả | Model gợi ý (xkiro) | Fallback |
|------|-------|---------------------|----------|
| `vision` | Phân tích ảnh, trích đặc điểm | `xiaomi/mimo-v2.5-pro` | `qwen/qwen3-vl-plus`, `gemini-3.5-flash` |
| `orchestrator` | Reasoning + rerank Top 5 | `deepseek/deepseek-v4-pro` | `mistral-large-2512`, `deepseek-v4-flash` |
| `synthesizer` | Tổng hợp metadata từ neighbors | `mistralai/mistral-medium-3.5` | `minimax-m2.7`, `deepseek-v4-flash` |
| `fallback` | Dự phòng chung | `deepseek/deepseek-v4-flash` | Bất kỳ model nào |
| `lightweight` | Tác vụ nhẹ, tốc độ cao | `minimax/minimax-m2.7` | `ministral-3b`, `glm-4.5-air` |

### 4. Chạy thử

```bash
# Nạp env
source .env   # hoặc export từng biến

# Test headless
dsh --profile kim "Bạn là ai? Liệt kê các tool kim_*"

# Test bridge HTTP
node kim-harness/bridge/server.mjs &
curl http://localhost:3090/health
curl -X POST http://localhost:3090/search \
  -H "content-type: application/json" \
  -H "x-kim-bridge-token: <token>" \
  -d '{"message":"Tìm bushing xám 4 lỗ"}'
```

## 9 Tools của Kim v6

| Tool | Tầng | Chức năng |
|------|------|-----------|
| `kim_image_describe` | Vision Analyst | Phân tích ảnh ra đặc điểm cấu trúc JSON |
| `kim_vector_search` | Vector Encoder | Encode DINOv2 rồi pgvector search ra candidates |
| `kim_synthesize` | Metadata Synthesizer | Vision + neighbors ra refined features |
| `kim_rerank` | Orchestrator | Reasoning rerank ra Top 5 chính xác nhất |
| `kim_catalogue_search` | — | Tìm metadata catalogue theo text |
| `kim_image_fetch` | — | Nạp hoặc kiểm tra ảnh từ media proxy |
| `kim_vector_upsert` | — | Upsert embedding vào vector base |
| `kim_vector_lifecycle` | — | Bật hoặc tắt vector trong base |
| `kim_rotator_status` | Debug | Xem trạng thái API rotation |

## API Rotation Activity

Khi một model bị rate limit (429) hoặc hết quota (402/403):
1. Model đó bị cooldown 60 giây (hoặc theo Retry-After header)
2. Rotator tự động chuyển sang model tiếp theo cùng role
3. Nếu tất cả model cùng role đều cooldown thì dùng fallback
4. Cooldown hết hạn thì tự động retry

Kiểm tra trạng thái: gọi tool `kim_rotator_status` hoặc xem log bridge.

## Kết nối DictionaryAI

Trên Cloudflare Pages, thêm biến môi trường:

```
KIM_DSH_PROXY_ENABLED=true
KIM_DSH_BRIDGE_URL=http://<vps-ip>:3090
KIM_BRIDGE_TOKEN=<secret-token>
```

Frontend gọi `/api/kim/search-dsh` rồi proxy tới bridge rồi bridge spawn `dsh --profile kim`.
Tắt flag thì tự động fallback về Kim v5 cũ.

## Troubleshooting

| Vấn đề | Giải pháp |
|--------|-----------|
| KIM_NO_MODEL_AVAILABLE | Kiểm tra KIM_PROVIDERS JSON hợp lệ, API key đã set |
| KIM_RATE_LIMITED nhiều | Thêm provider/key mới vào KIM_PROVIDERS |
| KIM_EMBEDDING_NOT_CONFIGURED | Set KIM_EMBEDDING_ENDPOINT (DINOv2 server) |
| KIM_SUPABASE_NOT_CONFIGURED | Set SUPABASE_URL + SUPABASE_ANON_KEY |
| Vision trả kết quả kém | Thử đổi model vision trong providers |
| Rerank chậm | Dùng model orchestrator nhẹ hơn (flash thay vì pro) |

## File tham khảo

- `kim-harness/index.mjs` — Plugin DSH, đăng ký 9 tools
- `kim-harness/lib/apiRotator.mjs` — Multi-provider rotation engine
- `kim-harness/lib/image.mjs` — Vision/Synthesizer/Orchestrator implementations
- `kim-harness/lib/supabase.mjs` — Supabase connector
- `kim-harness/lib/vectorProfile.mjs` — DINOv2 profile config
- `kim-harness/bridge/server.mjs` — HTTP bridge
- `~/.dsh-kim/profiles/kim/cordis.patch.yml` — DSH profile config