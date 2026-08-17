-- Kim v6 Admin Config: lưu trữ providers + API keys cho API Rotator.
-- Chạy trên Supabase SQL Editor. Table này chỉ service_role mới đọc/ghi được.

create table if not exists public.kim_provider_config (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,              -- e.g. "xkiro", "openai-backup"
  base_url text not null,                 -- e.g. "https://api.xkiro.com/v1"
  api_key_encrypted text not null,        -- AES-256-GCM encrypted; giải mã ở edge function
  models jsonb not null default '[]',     -- [{id, roles[], contextWindow?}]
  is_active boolean not null default true,
  priority integer not null default 0,    -- thấp = ưu tiên cao hơn khi rotate
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index để query nhanh theo priority + active
create index if not exists idx_kim_provider_config_active_priority
  on public.kim_provider_config (is_active desc, priority asc);

-- RLS: chỉ service_role truy cập (bridge chạy với service_role key)
alter table public.kim_provider_config enable row level security;
create policy "service_role_only" on public.kim_provider_config
  for all using (auth.role() = 'service_role');

-- Trigger auto-update updated_at
create or replace function public.kim_provider_config_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger trg_kim_provider_config_updated_at
  before update on public.kim_provider_config
  for each row execute function public.kim_provider_config_updated_at();

-- Seed mặc định: xkiro provider (API key placeholder — thay bằng key thật qua UI hoặc INSERT thủ công)
insert into public.kim_provider_config (name, base_url, api_key_encrypted, models, priority)
values (
  'xkiro',
  'https://api.xkiro.com/v1',
  'PLACEHOLDER_ENCRYPTED_KEY',
  '[
    {"id":"qwen/qwen3.8-max","roles":["orchestrator","synthesizer"]},
    {"id":"deepseek/deepseek-v4-pro","roles":["orchestrator"]},
    {"id":"xiaomi/mimo-v2.5-pro","roles":["vision"]},
    {"id":"qwen/qwen3-vl-plus","roles":["vision"]},
    {"id":"mistralai/mistral-medium-3.5","roles":["synthesizer"]},
    {"id":"deepseek/deepseek-v4-flash","roles":["fallback","lightweight"]},
    {"id":"mistralai/mistral-large-2512","roles":["fallback"]},
    {"id":"minimax/minimax-m2.7","roles":["lightweight"]}
  ]'::jsonb,
  0
)
on conflict (name) do nothing;