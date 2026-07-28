// Vercel serverless function 入口
// 适配 Web Request <-> Node http 风格，调用 server.js 的 handler。
// 防御式设计：require 失败 / handler 抛错 / 进程级异常 -> 全部转为可读 JSON 500。

let _handler = null;
let _loadError = null;
try {
  ({ handler: _handler } = require("../server.js"));
} catch (e) {
  _loadError = e;
}

// 进程级兜底：把未捕获异常/拒绝转为 500 响应，避免 Vercel 显示 FUNCTION_INVOCATION_FAILED
const _diag = (where, err) => new Response(
  JSON.stringify({ ok: false, where, msg: String(err && err.message || err), stack: String(err && err.stack || "") }),
  { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
);
process.on("uncaughtException", (e) => { try { console.error("[uncaughtException]", e); } catch (_) {} });
process.on("unhandledRejection", (e) => { try { console.error("[unhandledRejection]", e); } catch (_) {} });

function nodeReqFromWeb(req) {
  const headers = {};
  if (req && req.headers) {
    if (typeof req.headers.entries === "function") {
      for (const [k, v] of req.headers.entries()) headers[k.toLowerCase()] = v;
    } else {
      for (const k of Object.keys(req.headers)) headers[k.toLowerCase()] = String(req.headers[k]);
    }
  }
  const r = {
    method: req.method,
    url: req.url,
    headers,
    _body: null,
    _bodyPromise: null,
    _bodyError: null,
  };
  // 兼容 server.js 里 readBody() 的 req.on("data"/"end"/"error")
  r.on = (event, cb) => {
    if (event !== "data" && event !== "end" && event !== "error") return;
    if (!r._bodyPromise) {
      r._bodyPromise = (async () => {
        if (req.method === "GET" || req.method === "HEAD") return "";
        const ab = await req.arrayBuffer();
        return Buffer.from(ab).toString("utf8");
      })().catch((e) => { r._bodyError = e; throw e; });
    }
    r._bodyPromise.then(
      (text) => {
        if (r._bodyError) return;
        if (event === "data" && text) cb(Buffer.from(text));
        if (event === "end") cb();
      },
      (err) => { if (event === "error") cb(err); else if (event === "end") cb(); }
    );
  };
  return r;
}

function nodeResCollector() {
  let statusCode = 200;
  const headers = {};
  const chunks = [];
  const res = {
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    getHeader(k) { return headers[k.toLowerCase()]; },
    removeHeader(k) { delete headers[k.toLowerCase()]; },
    writeHead(s, h) { statusCode = s; if (h) for (const k in h) headers[k.toLowerCase()] = h[k]; },
    write(d) { if (d) chunks.push(typeof d === "string" ? Buffer.from(d) : Buffer.from(d)); return true; },
    end(d) {
      if (d && !Buffer.isBuffer(d)) d = Buffer.from(typeof d === "string" ? d : JSON.stringify(d));
      if (d) chunks.push(d);
      res._ended = true;
    },
    on() {},
    get _status() { return statusCode; },
    get _headers() { return headers; },
    get _body() { return Buffer.concat(chunks); },
  };
  return res;
}

module.exports = async (request) => {
  if (_loadError) return _diag("module-load", _loadError);
  try {
    const req = nodeReqFromWeb(request);
    const res = nodeResCollector();
    await _handler(req, res);
    return new Response(res._body, { status: res._status, headers: res._headers });
  } catch (e) {
    return _diag("handler", e);
  }
};