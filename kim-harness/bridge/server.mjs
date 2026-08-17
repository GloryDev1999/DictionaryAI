// Cầu nối HTTP cho Thư ký Kim (DSH headless).
// Nhận POST /search {message} -> spawn `dsh --profile kim "<task>"` -> trả JSON.
// Chạy độc lập trên Node; DictionaryAI gọi qua KIM_DSH_BRIDGE_URL.
//
// Cách chạy:
//   source kim-harness/.env   (hoặc export các biến trong .env.kim.example)
//   node kim-harness/bridge/server.mjs
// Cổng mặc định 3090; token bảo vệ: KIM_BRIDGE_TOKEN.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.KIM_BRIDGE_PORT || 3090);
const HOST = process.env.KIM_BRIDGE_HOST || "127.0.0.1";
const TOKEN = String(process.env.KIM_BRIDGE_TOKEN || "");
const DSH_BIN = process.env.DSH_BIN || "dsh";
const TIMEOUT_MS = Number(process.env.KIM_BRIDGE_TIMEOUT_MS || 180_000);

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function readBody(req, cap = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > cap) { reject(new Error("Body quá lớn")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function runKim(task, cwd) {
  return new Promise(resolve => {
    const child = spawn(DSH_BIN, ["--profile", "kim", task], {
      cwd: cwd || process.env.DSH_CWD || os.homedir(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let out = "";
    let err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, TIMEOUT_MS);

    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, answer: out.trim(), log: err.trim().slice(-2000) });
    });
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true, service: "kim-dsh-bridge" });
  }

  if (req.method !== "POST" || !req.url?.startsWith("/search")) {
    return json(res, 404, { ok: false, message: "Chỉ hỗ trợ POST /search và GET /health." });
  }

  if (TOKEN && req.headers["x-kim-bridge-token"] !== TOKEN) {
    return json(res, 401, { ok: false, message: "Sai KIM_BRIDGE_TOKEN." });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req) || "{}");
  } catch (e) {
    return json(res, 400, { ok: false, message: `JSON không hợp lệ: ${e.message}` });
  }

  const message = String(body.message || "").trim().slice(0, 4000);
  if (!message) return json(res, 400, { ok: false, message: "Thiếu message." });

  const { code, answer, log } = await runKim(message, body.cwd);

  if (code !== 0) {
    return json(res, 200, {
      ok: false,
      exit_code: code,
      user_message: "Thư ký Kim xử lý chưa thành công.",
      log: log || null
    });
  }

  return json(res, 200, { ok: true, answer });
});

server.listen(PORT, HOST, () => {
  console.log(`[kim-dsh-bridge] http://${HOST}:${PORT} (profile kim, timeout ${TIMEOUT_MS}ms)`);
});