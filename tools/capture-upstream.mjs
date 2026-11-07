// 抓包代理（调试用）：把 kernel 的上游请求原样转发并落盘，用于看清真正发出去的 system prompt
//
// 用法：
//   node tools/capture-upstream.mjs                                   # 监听 9909，转发到官方上游
//   TA_CAPTURE_PORT=9909 TA_CAPTURE_TARGET=https://agent.teleai.com.cn node tools/capture-upstream.mjs
//   TA_UPSTREAM_BASE_URL=http://127.0.0.1:9909/superCowork/sapi/api/v1 node server.mjs
//
// 落盘位置：runtime/capture/req-<时间>.json / res-<时间>.txt
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'runtime', 'capture');
fs.mkdirSync(outDir, { recursive: true });

const PORT = Number(process.env.TA_CAPTURE_PORT || 9909);
const TARGET = process.env.TA_CAPTURE_TARGET || 'https://agent.teleai.com.cn';
const HOP_HEADERS = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding']);

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const id = stamp();
    const url = TARGET + req.url;

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k)) headers[k] = v;

    let bodyPretty = raw.toString('utf8');
    try {
      bodyPretty = JSON.stringify(JSON.parse(bodyPretty), null, 2);
    } catch {}
    fs.writeFileSync(path.join(outDir, `req-${id}.json`), bodyPretty || '(empty)');

    console.log(`[capture] ${req.method} ${req.url} → ${url} (${raw.length}B)  req-${id}.json`);
    if (bodyPretty.length < 4000) console.log(bodyPretty);

    try {
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw,
      });
      const resHeaders = {};
      upstream.headers.forEach((v, k) => {
        if (!HOP_HEADERS.has(k)) resHeaders[k] = v;
      });
      res.writeHead(upstream.status, resHeaders);

      const out = fs.createWriteStream(path.join(outDir, `res-${id}.txt`));
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          res.write(chunk);
          out.write(chunk);
        }
      }
      out.end();
      res.end();
    } catch (err) {
      console.error('[capture] 转发失败:', err.message);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `capture forward failed: ${err.message}` } }));
    }
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`[capture] 监听 http://127.0.0.1:${PORT} → ${TARGET}`);
    console.log(`[capture] 落盘目录 ${outDir}`);
  });
