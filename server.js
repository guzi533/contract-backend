"use strict";

/**
 * 合同编号生成器 —— 零依赖后端服务
 * 仅使用 Node 内置模块（http / fs / path / crypto / fetch），无需 npm install。
 *
 * 数据：
 *   - 默认（本地模式）：JSON 文件数据库 (data/db.json) + 合同文件存 data/uploads/
 *   - 云端模式（设了 SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY）：记录存 Supabase Postgres，
 *     合同文件存 Supabase Storage，数据持久、可被免费托管平台调用。
 *
 * 部署：
 *   - 本地 / 内网常开电脑：node server.js
 *   - Vercel 等 serverless 平台：handler 通过 api/index.js 适配器调用
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MANAGER_PW = process.env.MANAGER_PW || "6688";
// 机构固定码（编号中段）。默认苏州中支 3205；江苏分公司等可通过环境变量 FIXED 覆盖。
const FIXED = process.env.FIXED || "3205";
// 页面标题。默认苏州中支；其他分公司通过环境变量 CONTRACT_TITLE 覆盖。
const CONTRACT_TITLE = process.env.CONTRACT_TITLE || "苏州中支合同台账";
// 流水号起始基准：苏州你手动已编到 82 号，系统生成的下一个从 83 开始。
// 仅作用于“当年”（跨年自动从 001 重新计）。其他分公司通过环境变量 SEQ_BASE 覆盖（默认 0，即从 001 开始）。
const SEQ_BASE = parseInt(process.env.SEQ_BASE || "82", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB（Vercel 免费版请求体上限约 4.5MB，留余量）

const TOKEN_TTL = 2 * 60 * 60 * 1000; // 管理者令牌有效期 2 小时
const sessions = new Map(); // token -> 过期时间戳(ms)

const USE_SUPABASE = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY));
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const SB_BUCKET = process.env.SUPABASE_BUCKET || "contracts";
const SB_TABLE = process.env.SUPABASE_TABLE || "records";

const DEPTS = [
  { code: "01", name: "综合" },
  { code: "02", name: "财务" },
  { code: "03", name: "社保" },
  { code: "04", name: "团险" },
  { code: "05", name: "运营" },
  { code: "06", name: "纪检/合规" },
  { code: "07", name: "健管" },
  { code: "08", name: "个客" },
  { code: "09", name: "个渠（银保、互动）" },
];

// ---------------------- 工具函数 ----------------------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); return; }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function getYear(dateStr) {
  if (dateStr && /^\d{4}/.test(dateStr)) return dateStr.slice(0, 4);
  return String(new Date().getFullYear());
}
function pad3(n) { return ("00" + n).slice(-3); }
function buildCode(year, seq) { return year + "-" + FIXED + "-" + pad3(seq); }

// ---------------------- 存储层：本地 / Supabase ----------------------
function ensureLocalDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]", "utf8");
}
function localReadAll() {
  ensureLocalDirs();
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) { return []; }
}
function localWriteAll(arr) {
  ensureLocalDirs();
  fs.writeFileSync(DB_FILE, JSON.stringify(arr, null, 2), "utf8");
}
function localAdd(rec) {
  const all = localReadAll();
  all.push(rec);
  localWriteAll(all);
  return rec;
}
function localDeleteById(id) {
  const all = localReadAll();
  const idx = all.findIndex(r => r.id === id);
  if (idx < 0) return null;
  const [removed] = all.splice(idx, 1);
  localWriteAll(all);
  if (removed.filePath && fs.existsSync(removed.filePath)) {
    try { fs.unlinkSync(removed.filePath); } catch (e) {}
  }
  return removed;
}
function localClear() {
  const all = localReadAll();
  for (const r of all) {
    if (r.filePath && fs.existsSync(r.filePath)) { try { fs.unlinkSync(r.filePath); } catch (e) {} }
  }
  localWriteAll([]);
}
function localGetOne(id) {
  return localReadAll().find(r => r.id === id) || null;
}

async function sbRequest(path, opts) {
  const r = await fetch(SB_URL + path, Object.assign({
    headers: {
      "apikey": SB_KEY,
      "Authorization": "Bearer " + SB_KEY,
      "Content-Type": "application/json"
    }
  }, opts || {}));
  return r;
}
async function sbGetAll() {
  const r = await sbRequest("/rest/v1/" + SB_TABLE + "?select=*&order=created_at.asc");
  if (!r.ok) throw new Error("Supabase 查询失败: " + r.status);
  return r.json();
}
async function sbInsert(rec) {
  // records 表结构: id uuid pk, code text, data jsonb, created_at timestamptz
  const row = { code: rec.code, data: rec };
  if (!rec.id) row.id = crypto.randomUUID();
  else row.id = rec.id;
  const r = await sbRequest("/rest/v1/" + SB_TABLE, {
    method: "POST",
    body: JSON.stringify(row)
  });
  if (!r.ok) throw new Error("Supabase 写入失败: " + r.status + " " + await r.text());
  return rec;
}
async function sbDeleteById(id) {
  const r = await sbRequest("/rest/v1/" + SB_TABLE + "?id=eq." + encodeURIComponent(id), { method: "DELETE" });
  if (!r.ok) throw new Error("Supabase 删除失败: " + r.status);
}
async function sbClear() {
  // PostgREST 不支持 truncate via API，用条件删除
  const r = await sbRequest("/rest/v1/" + SB_TABLE + "?id=neq.00000000-0000-0000-0000-000000000000", { method: "DELETE" });
  if (!r.ok) throw new Error("Supabase 清空失败: " + r.status);
}
async function sbGetOne(id) {
  const r = await sbRequest("/rest/v1/" + SB_TABLE + "?id=eq." + encodeURIComponent(id) + "&select=*");
  if (!r.ok) throw new Error("Supabase 查询失败: " + r.status);
  const rows = await r.json();
  return rows[0] || null;
}
async function sbUploadFile(id, buf, mime, originalName) {
  const ext = (originalName.match(/\.[^.]+$/) || [""])[0];
  const path = id + ext;
  const r = await sbRequest("/storage/v1/object/" + SB_BUCKET + "/" + path, {
    method: "POST",
    headers: { "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY, "Content-Type": mime || "application/octet-stream" },
    body: buf
  });
  if (!r.ok) throw new Error("Supabase 上传文件失败: " + r.status + " " + await r.text());
  return path;
}
async function sbDeleteFile(filePath) {
  if (!filePath) return;
  await sbRequest("/storage/v1/object/" + SB_BUCKET + "/" + filePath, { method: "DELETE" });
}
function sbPublicUrl(filePath) {
  return SB_URL + "/storage/v1/object/public/" + SB_BUCKET + "/" + filePath;
}

// 通用存储接口（对上层屏蔽本地/云端差异）
async function storeGetAll() {
  if (USE_SUPABASE) {
    const rows = await sbGetAll();
    return rows.map(r => {
      const d = r.data || {};
      return Object.assign({}, d, { id: r.id, code: r.code, fileUrl: d.filePath ? sbPublicUrl(d.filePath) : null });
    });
  }
  return localReadAll().map(r => {
    const o = Object.assign({}, r);
    delete o.filePath; // 列表不暴露内部路径
    return o;
  });
}
async function storeGetOne(id) {
  if (USE_SUPABASE) {
    const row = await sbGetOne(id);
    if (!row) return null;
    const d = row.data || {};
    return Object.assign({}, d, { id: row.id, code: row.code, filePath: d.filePath || null, fileUrl: d.filePath ? sbPublicUrl(d.filePath) : null });
  }
  return localGetOne(id);
}
async function storeAdd(rec) {
  if (USE_SUPABASE) {
    // 文件已在调用前传好并填入 rec.filePath；记录插入
    return sbInsert(rec);
  }
  return localAdd(rec);
}
async function storeDelete(id) {
  if (USE_SUPABASE) {
    const one = await storeGetOne(id);
    if (one && one.filePath) { try { await sbDeleteFile(one.filePath); } catch (e) {} }
    return sbDeleteById(id);
  }
  return localDeleteById(id);
}
async function storeClear() {
  if (USE_SUPABASE) {
    // 删全部文件
    const rows = await sbGetAll();
    for (const r of rows) {
      const d = r.data || {};
      if (d.filePath) { try { await sbDeleteFile(d.filePath); } catch (e) {} }
    }
    return sbClear();
  }
  return localClear();
}
async function storeSaveFile(rec, buf, mime, originalName) {
  if (USE_SUPABASE) {
    const p = await sbUploadFile(rec.id, buf, mime, originalName);
    rec.filePath = p;
    return p;
  }
  ensureLocalDirs();
  const safe = rec.id + "_" + originalName.replace(/[^\w\u4e00-\u9fa5.\-]/g, "_");
  const p = path.join(UPLOADS_DIR, safe);
  fs.writeFileSync(p, buf);
  rec.filePath = p;
  return p;
}
async function storeReadFile(rec) {
  if (USE_SUPABASE) {
    if (!rec.filePath) return null;
    const r = await fetch(sbPublicUrl(rec.filePath));
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  }
  if (rec.filePath && fs.existsSync(rec.filePath)) return fs.readFileSync(rec.filePath);
  return null;
}

// ---------------------- 业务：流水号 ----------------------
async function nextSeqFor(year) {
  // 按已有记录里同年最大流水号 + 1（编号格式：年-3205-流水号）
  const prefix = year + "-" + FIXED + "-";
  const all = await storeGetAll();
  let max = 0;
  for (const r of all) {
    if (!r || !r.code) continue;
    if (r.code.startsWith(prefix)) {
      const tail = r.code.split("-").pop();
      const n = parseInt(tail, 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  // 起始基准：当年手动已编到 SEQ_BASE 号，系统生成的下一个不能小于 SEQ_BASE+1。
  // 跨年（year 不是当年）时不套用基准，自动从 001 重新计。
  const floor = (year === String(new Date().getFullYear())) ? SEQ_BASE : 0;
  return Math.max(max, floor) + 1;
}

// ---------------------- 鉴权 ----------------------
function makeToken() { return crypto.randomBytes(24).toString("hex"); }
function tokenValid(tok) {
  if (!tok) return false;
  const exp = sessions.get(tok);
  if (!exp) return false;
  if (Date.now() > exp) { sessions.delete(tok); return false; }
  return true;
}
function requireManager(req, res) {
  const h = req.headers["x-manager-token"] || req.headers["X-Manager-Token"];
  if (!tokenValid(h)) {
    sendJSON(res, 403, { ok: false, msg: "需要管理者权限" });
    return false;
  }
  return true;
}

// ---------------------- ZIP 打包（store 方式）----------------------
function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = crc32._t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(d) {
  return ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
}
function buildZip(entries) {
  const enc = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  for (const e of entries) {
    const name = e.name;
    const data = e.data;
    const nameBuf = Buffer.from(enc.encode(name));
    const crc = crc32(data);
    const size = data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 flag
    lh.writeUInt16LE(0, 8); // store
    lh.writeUInt16LE(dosTime(now), 10);
    lh.writeUInt16LE(dosDate(now), 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime(now), 12);
    ch.writeUInt16LE(dosDate(now), 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centralParts.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(localBuf.length, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, end]);
}

// ---------------------- 静态文件服务（容器模式下同时托管前端页面）----------------------
function guessMime(p) {
  const ext = (path.extname(p) || "").toLowerCase();
  const map = {
    ".html": "text/html", ".htm": "text/html",
    ".css": "text/css", ".js": "application/javascript",
    ".json": "application/json", ".png": "image/png",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".svg": "image/svg+xml", ".ico": "image/x-icon",
    ".txt": "text/plain", ".csv": "text/csv"
  };
  return map[ext] || "application/octet-stream";
}
function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // 防目录穿越
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJSON(res, 403, { ok: false, msg: "Forbidden" });
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    // 单页应用兜底：找不到就回 index.html
    const idx = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(idx)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(idx));
    }
    return sendJSON(res, 404, { ok: false, msg: "Not Found" });
  }
  res.writeHead(200, { "Content-Type": guessMime(filePath) + "; charset=utf-8" });
  res.end(fs.readFileSync(filePath));
}

// ---------------------- 路由处理器 ----------------------
const handler = async (req, res) => {
  try {
    const method = req.method;
    const url = new URL(req.url, "http://x");
    const pathname = url.pathname;

    // 健康检查
    if (method === "GET" && pathname === "/api/health") {
      return sendJSON(res, 200, { ok: true, mode: USE_SUPABASE ? "supabase" : "local" });
    }

    // 前端配置（标题 / 机构固定码），供不同分公司实例共用同一份代码
    if (method === "GET" && pathname === "/api/config") {
      return sendJSON(res, 200, { ok: true, title: CONTRACT_TITLE, fixed: FIXED });
    }

    // 环境诊断（确认 Supabase 钥匙是否就绪 / Node 版本 / 当前模式）
    if (method === "GET" && pathname === "/api/diag") {
      return sendJSON(res, 200, {
        ok: true,
        mode: USE_SUPABASE ? "supabase" : "local",
        nodeVersion: process.version,
        sbUrlSet: !!SB_URL,
        sbKeySet: !!SB_KEY,
        sbBucket: SB_BUCKET,
        sbTable: SB_TABLE,
        managerPwDefault: MANAGER_PW === "6688"
      });
    }

    // 部门列表（公开）
    if (method === "GET" && pathname === "/api/depts") {
      return sendJSON(res, 200, { ok: true, depts: DEPTS });
    }

    // 记录列表（公开）
    if (method === "GET" && pathname === "/api/records") {
      const all = await storeGetAll();
      return sendJSON(res, 200, { ok: true, records: all });
    }

    // POST /api/login （管理者校验 + 发令牌）
    if (method === "POST" && pathname === "/api/login") {
      const raw = await readBody(req);
      let b; try { b = JSON.parse(raw); } catch (e) { b = {}; }
      if (b.pw !== MANAGER_PW) return sendJSON(res, 200, { ok: false, msg: "密码错误" });
      const tok = makeToken();
      sessions.set(tok, Date.now() + TOKEN_TTL);
      return sendJSON(res, 200, { ok: true, token: tok, ttlMs: TOKEN_TTL });
    }

    // POST /api/records （新增 + 生成编号）
    if (method === "POST" && pathname === "/api/records") {
      const raw = await readBody(req);
      let b; try { b = JSON.parse(raw); } catch (e) { b = {}; }
      const year = getYear(b.signDate);
      const seq = await nextSeqFor(year);
      const code = buildCode(year, seq);
      const id = crypto.randomUUID();
      const rec = {
        id, code, year, seq,
        operator: b.operator || "",
        contractName: b.contractName || "",
        partyA: b.partyA || "",
        partyB: b.partyB || "",
        partyC: b.partyC || "",
        category: b.category || "",
        signDate: b.signDate || "",
        subject: b.subject || "",
        amount: b.amount || "0",
        term: b.term || "",
        obligations: b.obligations || "",
        performance: b.performance || "",
        change: b.change || "",
        changeDesc: b.changeDesc || "",
        dispute: !!b.dispute,
        disputeDesc: b.disputeDesc || "",
        sealTime: b.sealTime || "",
        createdAt: new Date().toISOString()
      };
      await storeAdd(rec);
      // 列表里展示用
      const out = Object.assign({}, rec);
      delete out.filePath;
      return sendJSON(res, 200, { ok: true, record: out });
    }

    // DELETE /api/records/:id （管理者）
    if (method === "DELETE" && /^\/api\/records\/[^/]+$/.test(pathname)) {
      if (!requireManager(req, res)) return;
      const id = pathname.split("/").pop();
      await storeDelete(id);
      return sendJSON(res, 200, { ok: true });
    }

    // GET /api/records/:id/file （下载单条合同文件）
    if (method === "GET" && /^\/api\/records\/[^/]+\/file$/.test(pathname)) {
      const id = pathname.split("/")[3];
      const one = await storeGetOne(id);
      if (!one) return sendJSON(res, 404, { ok: false, msg: "记录不存在" });
      const buf = await storeReadFile(one);
      if (!buf) return sendJSON(res, 404, { ok: false, msg: "文件不存在" });
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=\"" + encodeURIComponent(one.fileName || "file") + "\""
      });
      res.end(buf);
      return;
    }

    // GET /api/export/csv （管理者）
    if (method === "GET" && pathname === "/api/export/csv") {
      if (!requireManager(req, res)) return;
      const all = await storeGetAll();
      const headers = ["编号","年份","流水号","录入人","合同名称","甲方","乙方","丙方","合同类别","合同签署日期","合同标的","合同金额","合同期限","义务(内容/时间/标准)","履行情况","变更情况","变更说明","是否涉及纠纷","纠纷说明","合同用印时间","创建时间"];
      const esc = v => { const s = v == null ? "" : String(v); return /[\",\\n]/.test(s) ? "\"" + s.replace(/\"/g, "\"\"") + "\"" : s; };
      const lines = [headers.join(",")];
      for (const r of all) {
        lines.push([
          r.code, r.year, r.seq, r.operator, r.contractName, r.partyA, r.partyB, r.partyC, r.category, r.signDate,
          r.subject, r.amount, r.term, r.obligations, r.performance, r.change, r.changeDesc,
          r.dispute ? "是" : "否", r.disputeDesc, r.sealTime, r.createdAt
        ].map(esc).join(","));
      }
      const csv = "\uFEFF" + lines.join("\n");
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=records_" + Date.now() + ".csv"
      });
      res.end(csv);
      return;
    }

    // GET /api/export/zip （管理者）
    if (method === "GET" && pathname === "/api/export/zip") {
      if (!requireManager(req, res)) return;
      const all = await storeGetAll();
      const entries = [];
      for (const r of all) {
        const one = await storeGetOne(r.id);
        if (!one) continue;
        const buf = await storeReadFile(one);
        if (!buf) continue;
        const name = (one.code || "contract") + "_" + (one.fileName || "file");
        entries.push({ name, data: buf });
      }
      if (!entries.length) return sendJSON(res, 400, { ok: false, msg: "暂无可下载的合同文件" });
      const zip = buildZip(entries);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=contracts_" + Date.now() + ".zip"
      });
      res.end(zip);
      return;
    }

    // POST /api/reset-seq （管理者，重置本年流水号 = 删空 db）
    if (method === "POST" && pathname === "/api/reset-seq") {
      if (!requireManager(req, res)) return;
      // 云端模式无意义：流水号由已有记录推算，无法真重置；本地模式直接清空 records 表
      if (USE_SUPABASE) return sendJSON(res, 200, { ok: true, msg: "云端模式流水号由已有记录推算，已忽略" });
      await storeClear();
      return sendJSON(res, 200, { ok: true });
    }

    // POST /api/clear （管理者，清空所有记录）
    if (method === "POST" && pathname === "/api/clear") {
      if (!requireManager(req, res)) return;
      await storeClear();
      return sendJSON(res, 200, { ok: true });
    }

    // 非 /api 请求 → 静态文件（前端页面）；找不到文件才 404
    if (!pathname.startsWith("/api/")) {
      return serveStatic(req, res, pathname);
    }
    sendJSON(res, 404, { ok: false, msg: "Not Found" });
  } catch (e) {
    sendJSON(res, 500, { ok: false, msg: "服务器错误：" + e.message });
  }
};

if (require.main === module) {
  const server = http.createServer(handler);
  server.listen(PORT, "0.0.0.0", () => {
    console.log("合同编号生成器已启动： http://0.0.0.0:" + PORT);
    console.log("存储模式：" + (USE_SUPABASE ? "云端 Supabase" : "本地文件") + (USE_SUPABASE ? "" : "  数据目录：" + DATA_DIR));
    console.log("管理者密码：" + MANAGER_PW);
  });
}

// 同时支持 Vercel 等 serverless 平台：导出 handler 供 api/index.js 复用
module.exports = { handler };
