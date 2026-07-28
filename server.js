"use strict";

/**
 * 合同编号生成器 —— 零依赖后端服务
 * 仅使用 Node 内置模块（http / fs / path / crypto / fetch），无需 npm install。
 *
 * 数据：
 *   - 默认（本地模式）：JSON 文件数据库 (data/db.json) + 合同文件存 data/uploads/
 *   - 云端模式（设了 SUPABASE_URL + SUPABASE_ANON_KEY）：记录存 Supabase Postgres，
 *     合同文件存 Supabase Storage，数据持久、可被免费托管平台（如 Render）调用。
 *
 * 编号规则：年 - 32 - 部门编号 - 3位流水号（流水号按年递增、跨年自动重置）
 *
 * 启动： node server.js   （可选环境变量 PORT / MANAGER_PW / DATA_DIR /
 *        SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_BUCKET / SUPABASE_TABLE）
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------- 配置 ----------
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MANAGER_PW = process.env.MANAGER_PW || "6688";
const FIXED = "32";
const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB

const TOKEN_TTL = 2 * 60 * 60 * 1000; // 管理者令牌有效期 2 小时
const sessions = new Map(); // token -> 过期时间戳(ms)

// ---------- 云端存储（Supabase）配置 ----------
const USE_SUPABASE = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY));
const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const SB_BUCKET = process.env.SUPABASE_BUCKET || "contracts";
const SB_TABLE = process.env.SUPABASE_TABLE || "records";

const DEPTS = [
  { label: "综合", code: "01" },
  { label: "财务", code: "02" },
  { label: "社保", code: "03" },
  { label: "团险", code: "04" },
  { label: "运营", code: "05" },
  { label: "纪检/合规", code: "06" },
  { label: "健管", code: "07" },
  { label: "个客", code: "08" },
  { label: "个渠（银保、互动）", code: "09" }
];

// ---------- 初始化目录（仅本地模式需要） ----------
if (!USE_SUPABASE) {
  [DATA_DIR, UPLOADS_DIR].forEach((d) => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ---------- 本地数据库（JSON 文件） ----------
function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const obj = JSON.parse(raw);
    if (!obj.seqByYear) obj.seqByYear = {};
    if (!obj.history) obj.history = [];
    return obj;
  } catch (e) {
    return { seqByYear: {}, history: [] };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}
let DB = USE_SUPABASE ? null : loadDB();

// ---------- 工具 ----------
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
function buildCode(y, deptCode, seq) {
  return y + "-" + FIXED + "-" + deptCode + "-" + String(seq).padStart(3, "0");
}
function isManager(pw) { return pw === MANAGER_PW; }
function issueToken() { const t = crypto.randomUUID(); sessions.set(t, Date.now() + TOKEN_TTL); return t; }
function validToken(t) {
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function safeId() { return crypto.randomUUID(); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// ---------- 云端存储（Supabase）辅助 ----------
function sbHeaders(extra) {
  return Object.assign(
    { "apikey": SB_KEY, "Authorization": "Bearer " + SB_KEY, "Content-Type": "application/json" },
    extra || {}
  );
}
async function sbGetAll() {
  const url = SB_URL + "/rest/v1/" + SB_TABLE + "?select=id,code,data,created_at&order=created_at.desc";
  const r = await fetch(url, { headers: sbHeaders() });
  const rows = await r.json();
  return (rows || []).map((row) => Object.assign({ id: row.id, code: row.code, createdAt: row.created_at }, row.data || {}));
}
async function sbGetOne(id) {
  const url = SB_URL + "/rest/v1/" + SB_TABLE + "?id=eq." + encodeURIComponent(id) + "&select=id,code,data,created_at";
  const r = await fetch(url, { headers: sbHeaders() });
  const rows = await r.json();
  if (!rows || !rows[0]) return null;
  const row = rows[0];
  return Object.assign({ id: row.id, code: row.code, createdAt: row.created_at }, row.data || {});
}
async function sbAdd(rec) {
  const url = SB_URL + "/rest/v1/" + SB_TABLE;
  const body = JSON.stringify({ id: rec.id, code: rec.code, data: rec });
  const r = await fetch(url, { method: "POST", headers: sbHeaders({ "Prefer": "return=representation" }), body });
  if (!r.ok) throw new Error("云端写入失败：" + (await r.text()));
  const rows = await r.json();
  if (Array.isArray(rows) && rows[0]) rec.id = rows[0].id || rec.id;
  return rec;
}
async function sbRemove(id) {
  const one = await sbGetOne(id);
  if (one && one.fileUrl) {
    const m = one.fileUrl.match(/\/object\/public\/[^\/]+\/(.+)$/);
    if (m) {
      try { await fetch(SB_URL + "/storage/v1/object/" + SB_BUCKET + "/" + m[1], { method: "DELETE", headers: sbHeaders() }); }
      catch (e) {}
    }
  }
  const r = await fetch(SB_URL + "/rest/v1/" + SB_TABLE + "?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: sbHeaders() });
  return r.ok;
}
async function sbNextSeq(year) {
  const url = SB_URL + "/rest/v1/" + SB_TABLE + "?code=like." + encodeURIComponent(year + "-32-*") + "&select=code";
  const r = await fetch(url, { headers: sbHeaders() });
  const rows = await r.json();
  const prefix = year + "-" + FIXED + "-";
  let max = 0;
  (rows || []).forEach((row) => {
    if (row.code && row.code.indexOf(prefix) === 0) {
      const n = parseInt(row.code.split("-").pop(), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return max + 1;
}
async function sbClearAll() {
  await fetch(SB_URL + "/rest/v1/" + SB_TABLE, { method: "DELETE", headers: sbHeaders() });
}
async function sbSaveFile(rec, fileObj) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(fileObj.data);
  if (!m) throw new Error("合同文件数据无效");
  const bin = Buffer.from(m[2], "base64");
  if (bin.length > MAX_FILE_BYTES) throw new Error("合同文件过大（超过 20MB）");
  const fileName = String(fileObj.name || "contract");
  const safe = (rec.id || safeId()) + "_" + fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  const encPath = encodeURIComponent(safe);
  const up = await fetch(SB_URL + "/storage/v1/object/" + SB_BUCKET + "/" + encPath, {
    method: "POST", headers: sbHeaders(), body: bin
  });
  if (!up.ok) throw new Error("文件上传失败：" + (await up.text()));
  rec.fileName = fileName;
  rec.fileUrl = SB_URL + "/storage/v1/object/public/" + SB_BUCKET + "/" + encPath;
}

// ---------- 本地存储辅助 ----------
function localGetAll() {
  return DB.history.map((r) => { const { fileData, filePath, ...rest } = r; return rest; });
}
function localGetOne(id) { return DB.history.find((x) => x.id === id) || null; }
function localAdd(rec) {
  DB.history.unshift(rec);
  const seq = parseInt(String(rec.code).split("-").pop(), 10);
  if (!isNaN(seq)) DB.seqByYear[rec.year] = seq;
  saveDB(DB);
}
function localRemove(id) {
  const idx = DB.history.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  const r = DB.history[idx];
  if (r.filePath && fs.existsSync(r.filePath)) { try { fs.unlinkSync(r.filePath); } catch (e) {} }
  DB.history.splice(idx, 1);
  saveDB(DB);
  return true;
}
function localNextSeq(year) { return (DB.seqByYear[year] || 0) + 1; }
function localSaveFile(rec, fileObj) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(fileObj.data);
  if (!m) throw new Error("合同文件数据无效");
  const bin = Buffer.from(m[2], "base64");
  if (bin.length > MAX_FILE_BYTES) throw new Error("合同文件过大（超过 20MB）");
  const fileName = String(fileObj.name || "contract");
  const ext = path.extname(fileName) || "";
  const storeName = safeId() + ext;
  const filePath = path.join(UPLOADS_DIR, storeName);
  fs.writeFileSync(filePath, bin);
  rec.fileName = fileName;
  rec.filePath = filePath;
}
function localClearAll() {
  DB.history.forEach((r) => { if (r.filePath && fs.existsSync(r.filePath)) { try { fs.unlinkSync(r.filePath); } catch (e) {} } });
  DB.history = [];
  saveDB(DB);
}

// ---------- 统一存储接口（自动选本地/云端） ----------
async function storeGetAll() { return USE_SUPABASE ? sbGetAll() : localGetAll(); }
async function storeGetOne(id) { return USE_SUPABASE ? sbGetOne(id) : localGetOne(id); }
async function storeAdd(rec) { if (USE_SUPABASE) await sbAdd(rec); else localAdd(rec); return rec; }
async function storeRemove(id) { return USE_SUPABASE ? sbRemove(id) : localRemove(id); }
async function storeNextSeq(year) { return USE_SUPABASE ? sbNextSeq(year) : localNextSeq(year); }
async function storeClearAll() { return USE_SUPABASE ? sbClearAll() : localClearAll(); }
async function storeSaveFile(rec, fileObj) { return USE_SUPABASE ? sbSaveFile(rec, fileObj) : localSaveFile(rec, fileObj); }

// ---------- ZIP 打包（store 方式，纯 Node 实现，支持中文名 UTF-8） ----------
function crc32(buf) {
  if (!crc32.t) {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    crc32.t = t;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.t[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function buildZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  let offset = 0;
  const cd = [];
  for (const f of files) {
    const data = f.data;
    const crc = crc32(data);
    const name = f.name;
    const nb = Buffer.from(enc.encode(name));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nb.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    parts.push(lh, nb, data);
    cd.push({ ch, nb });
    offset += lh.length + nb.length + data.length;
  }
  let cdSize = 0;
  cd.forEach((c) => (cdSize += c.ch.length + c.nb.length));
  const cdBuf = Buffer.alloc(cdSize);
  let p = 0;
  cd.forEach((c) => { c.ch.copy(cdBuf, p); p += c.ch.length; c.nb.copy(cdBuf, p); p += c.nb.length; });
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cdBuf, end]);
}

// ---------- CSV ----------
function buildCSV(history) {
  const cols = [
    ["编号", "code"], ["部门", "dept"], ["部门/机构", "org"], ["年份", "year"], ["签署日期", "date"],
    ["合同名称", "name"], ["甲方", "partyA"], ["乙方", "partyB"], ["丙方", "partyC"],
    ["类别", "category"], ["是否为公司格式文本", "isFormat"], ["合同标的", "subject"],
    ["合同金额(元)", "amount"], ["合同期限", "term"],
    ["义务内容/时间/标准", "obligations"], ["履行情况", "performance"],
    ["变更情况", "change"], ["涉及纠纷及诉讼仲裁", "dispute"], ["纠纷说明", "disputeDesc"],
    ["合同附件", "fileName"], ["生成时间", "createdAt"]
  ];
  const rows = [cols.map((c) => c[0]).join(",")];
  history.forEach((r) => {
    rows.push(cols.map((c) => {
      let v = r[c[1]];
      if (typeof v === "boolean") v = v ? "是" : "否";
      v = v == null ? "" : String(v);
      if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
      return v;
    }).join(","));
  });
  return "﻿" + rows.join("\n");
}

// ---------- 表单校验 ----------
function validateRecord(b) {
  const required = [
    ["org", "部门/机构"], ["name", "合同名称"], ["partyA", "合同甲方"], ["partyB", "合同乙方"],
    ["category", "合同类别"], ["subject", "合同标的"], ["amount", "合同金额（元）"],
    ["term", "合同期限"], ["obligations", "义务（内容/时间/标准）"], ["performance", "履行情况"], ["change", "变更情况"]
  ];
  for (const [k, label] of required) {
    if (b[k] == null || String(b[k]).trim() === "") return "请填写：" + label;
  }
  if (b.deptIndex == null || DEPTS[b.deptIndex] == null) return "请选择部门";
  if (!b.file || !b.file.data) return "请先上传合同文件（必传项）";
  if (b.dispute === true && (!b.disputeDesc || String(b.disputeDesc).trim() === ""))
    return "涉及纠纷，请填写纠纷/诉讼/仲裁说明";
  return null;
}

// ---------- 路由 ----------
const handler = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    const method = req.method;

    // 静态首页
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // ---- API ----
    if (pathname.startsWith("/api/")) {
      // GET /api/records
      if (method === "GET" && pathname === "/api/records") {
        const list = await storeGetAll();
        return sendJSON(res, 200, { ok: true, records: list });
      }

      // POST /api/records （生成编号并保存）
      if (method === "POST" && pathname === "/api/records") {
        const raw = await readBody(req);
        let b;
        try { b = JSON.parse(raw); } catch (e) { return sendJSON(res, 400, { ok: false, msg: "数据格式错误" }); }
        const err = validateRecord(b);
        if (err) return sendJSON(res, 400, { ok: false, msg: err });

        const year = getYear(b.date);
        const dept = DEPTS[b.deptIndex];
        const seq = await storeNextSeq(year);
        const code = buildCode(year, dept.code, seq);

        const rec = {
          id: safeId(),
          code, dept: dept.label, deptCode: dept.code, year,
          date: b.date || "", org: b.org, name: b.name,
          partyA: b.partyA, partyB: b.partyB, partyC: b.partyC || "",
          category: b.category, term: b.term, subject: b.subject, amount: b.amount,
          isFormat: b.isFormat === true, obligations: b.obligations,
          performance: b.performance, change: b.change,
          dispute: b.dispute === true, disputeDesc: b.disputeDesc || "",
          fileName: "", fileUrl: "", filePath: "", createdAt: new Date().toLocaleString("zh-CN")
        };

        if (b.file && b.file.data) {
          try { await storeSaveFile(rec, b.file); }
          catch (e) { return sendJSON(res, 400, { ok: false, msg: e.message }); }
        }

        await storeAdd(rec);
        const { fileData, filePath, ...rest } = rec;
        return sendJSON(res, 200, { ok: true, record: rest, code });
      }

      // DELETE /api/records/:id （管理者）
      const delMatch = pathname.match(/^\/api\/records\/([^/]+)$/);
      if (method === "DELETE" && delMatch) {
        const tk = req.headers["x-manager-token"] || "";
        if (!validToken(tk)) return sendJSON(res, 403, { ok: false, msg: "请先以管理者身份登录" });
        const ok = await storeRemove(delMatch[1]);
        return sendJSON(res, ok ? 200 : 404, { ok });
      }

      // GET /api/records/:id/file （下载单条合同文件）
      const fileMatch = pathname.match(/^\/api\/records\/([^/]+)\/file$/);
      if (method === "GET" && fileMatch) {
        const r = await storeGetOne(fileMatch[1]);
        if (!r) return sendJSON(res, 404, { ok: false, msg: "合同文件不存在" });
        if (USE_SUPABASE && r.fileUrl) { res.writeHead(302, { Location: r.fileUrl }); res.end(); return; }
        if (!USE_SUPABASE && r.filePath && fs.existsSync(r.filePath)) {
          const buf = fs.readFileSync(r.filePath);
          const encName = encodeURIComponent(r.fileName || "contract");
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": 'attachment; filename="' + encName + '"; filename*=UTF-8\'\'' + encName
          });
          res.end(buf);
          return;
        }
        return sendJSON(res, 404, { ok: false, msg: "合同文件不存在" });
      }

      // POST /api/login （管理者校验，成功返回令牌）
      if (method === "POST" && pathname === "/api/login") {
        const raw = await readBody(req);
        let b; try { b = JSON.parse(raw); } catch (e) { b = {}; }
        if (!isManager(b.pw || "")) return sendJSON(res, 200, { ok: false });
        return sendJSON(res, 200, { ok: true, token: issueToken() });
      }

      // GET /api/export/csv （管理者）
      if (method === "GET" && pathname === "/api/export/csv") {
        const tk = req.headers["x-manager-token"] || "";
        if (!validToken(tk)) return sendJSON(res, 403, { ok: false, msg: "请先以管理者身份登录" });
        const list = await storeGetAll();
        const csv = buildCSV(list);
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="contracts_' + new Date().toISOString().slice(0, 10) + '.csv"'
        });
        res.end(csv);
        return;
      }

      // GET /api/export/zip （管理者，批量打包合同文件）
      if (method === "GET" && pathname === "/api/export/zip") {
        const tk = req.headers["x-manager-token"] || "";
        if (!validToken(tk)) return sendJSON(res, 403, { ok: false, msg: "请先以管理者身份登录" });
        const list = await storeGetAll();
        const files = [];
        for (const r of list) {
          if (USE_SUPABASE) {
            if (r.fileUrl) {
              try {
                const fr = await fetch(r.fileUrl);
                if (fr.ok) files.push({ name: (r.code || "contract") + "_" + (r.fileName || "file"), data: Buffer.from(await fr.arrayBuffer()) });
              } catch (e) {}
            }
          } else {
            const full = await storeGetOne(r.id);
            if (full && full.filePath && fs.existsSync(full.filePath)) {
              files.push({ name: (r.code || "contract") + "_" + (r.fileName || "file"), data: fs.readFileSync(full.filePath) });
            }
          }
        }
        if (!files.length) return sendJSON(res, 400, { ok: false, msg: "没有可下载的合同文件" });
        const zip = buildZip(files);
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="contracts_' + new Date().toISOString().slice(0, 10) + '.zip"'
        });
        res.end(zip);
        return;
      }

      // POST /api/reset-seq （管理者，重置本年流水号；云端模式流水号由记录推导，无需重置）
      if (method === "POST" && pathname === "/api/reset-seq") {
        const tk = req.headers["x-manager-token"] || "";
        if (!validToken(tk)) return sendJSON(res, 403, { ok: false, msg: "请先以管理者身份登录" });
        if (!USE_SUPABASE) {
          const raw = await readBody(req);
          let b; try { b = JSON.parse(raw); } catch (e) { b = {}; }
          const year = b.year ? String(b.year) : String(new Date().getFullYear());
          DB.seqByYear[year] = 0;
          saveDB(DB);
        }
        return sendJSON(res, 200, { ok: true, note: USE_SUPABASE ? "云端模式流水号由记录自动推导" : "已重置" });
      }

      // POST /api/clear （管理者，清空记录）
      if (method === "POST" && pathname === "/api/clear") {
        const tk = req.headers["x-manager-token"] || "";
        if (!validToken(tk)) return sendJSON(res, 403, { ok: false, msg: "请先以管理者身份登录" });
        await storeClearAll();
        return sendJSON(res, 200, { ok: true });
      }

      return sendJSON(res, 404, { ok: false, msg: "接口不存在" });
    }

    // 其他静态资源（public 下）
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safePath);
    if (filePath.startsWith(PUBLIC_DIR) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mime = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime + "; charset=utf-8" });
      res.end(fs.readFileSync(filePath));
      return;
    }

    sendJSON(res, 404, { ok: false, msg: "Not Found" });
  } catch (e) {
    sendJSON(res, 500, { ok: false, msg: "服务器错误：" + e.message });
  }
};

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log("合同编号生成器已启动： http://0.0.0.0:" + PORT);
    console.log("存储模式：" + (USE_SUPABASE ? "云端 Supabase" : "本地文件") + (USE_SUPABASE ? "" : "  数据目录：" + DATA_DIR));
    console.log("管理者密码：" + MANAGER_PW);
  });
}

// 同时支持 Vercel 等 serverless 平台：导出 handler 供 api/index.js 复用
module.exports = { handler };
