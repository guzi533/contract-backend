// Vercel serverless function 入口
// 复用 server.js 里的 handler 处理所有 /api/* 请求。
// 前端静态页面（public/index.html）由 Vercel 自动托管为网站根目录，无需此函数处理。
const { handler } = require("../server.js");
module.exports = handler;
