// Vercel serverless function 入口
// 把 Vercel 传进来的 Web Request 适配成 Node http IncomingMessage / ServerResponse 风格，
// 然后复用 server.js 里的 handler。这样 server.js 一行不用改。
const { handler } = require("../server.js");

function nodeReqFromWeb(req) {
  const headers = {};
  for (const [k, v] of req.headers.entries()) headers[k.toLowerCase()] = v;
  const r = {
    method: req.method,
    url: req.url,
    headers,
    _body: null,
    _bodyPromise: null,
  };
  // 兼容 readBody() 中的 req.on("data"/"end"/"error")
  r.on = (event, cb) => {
    if (event === "data" || event === "end" || event === "error") {
      r._bodyPromise = r._bodyPromise || (async () => {
        try {
          if (req.method === "GET" || req.method === "HEAD") return "";
          const ab = await req.arrayBuffer();
          return Buffer.from(ab).toString("utf8");
        } catch (e) { throw e; }
      })();
      r._bodyPromise.then(
        (text) => {
          if (event === "data" && text) cb(Buffer.from(text));
          if (event === "end") cb();
        },
        (err) => { if (event === "error") cb(err); }
      );
    }
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
  try {
    const req = nodeReqFromWeb(request);
    const res = nodeResCollector();
    await handler(req, res);
    return new Response(res._body, { status: res._status, headers: res._headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, msg: "适配层错误: " + (e && e.message || e) }), {
      status: 500, headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
};
