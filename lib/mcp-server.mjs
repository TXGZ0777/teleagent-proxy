// 最小 MCP 服务端（Streamable HTTP），把客户端工具暴露给 TeleAgent kernel。
//
// 只实现 kernel 会用到的方法：initialize / notifications/* / tools/list / tools/call / ping。
// tools/call 的处理由调用方决定（这里是"挂起，等客户端执行完再回填"）。
import http from 'node:http';
import crypto from 'node:crypto';

const PROTOCOL_VERSION = '2024-11-05';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
    req.on('error', reject);
  });
}

/** OpenAI/Responses 风格工具 → MCP 工具定义 */
export function toMcpTools(tools = []) {
  const out = [];
  for (const item of tools) {
    const fn = item?.function ?? item;
    const name = typeof fn?.name === 'string' ? fn.name : null;
    if (!name) continue;
    out.push({
      name,
      description: typeof fn.description === 'string' ? fn.description : '',
      inputSchema: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    });
  }
  return out;
}

export function mcpText(text, isError = false) {
  return {
    content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }],
    isError,
  };
}

export async function startMcpServer({ getTools = () => [], onCall } = {}) {
  const stats = { initialized: 0, listed: 0, called: 0, errors: 0 };
  const sseClients = new Set();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && url.pathname.startsWith('/mcp')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/mcp')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const batch = Array.isArray(payload) ? payload : [payload];
    const answers = [];
    for (const message of batch) {
      const answer = await handle(message);
      if (answer !== undefined) answers.push(answer);
    }

    if (answers.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json', 'MCP-Protocol-Version': PROTOCOL_VERSION });
    res.end(JSON.stringify(Array.isArray(payload) ? answers : answers[0]));
  });

  async function handle(message) {
    const id = message?.id;
    const method = message?.method;
    const params = message?.params ?? {};

    if (typeof method === 'string' && method.startsWith('notifications/')) {
      if (method === 'notifications/initialized') stats.initialized++;
      return undefined;
    }

    const reply = (result) => ({ jsonrpc: '2.0', id: id ?? null, result });
    const fail = (code, msg) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg } });

    try {
      switch (method) {
        case 'initialize':
          return reply({
            protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'teleagent-proxy', version: '0.2.0' },
          });
        case 'ping':
          return reply({});
        case 'tools/list':
          stats.listed++;
          return reply({ tools: toMcpTools(getTools()) });
        case 'tools/call': {
          stats.called++;
          if (typeof onCall !== 'function') return reply(mcpText('工具中继未接入', true));
          const result = await onCall(params.name, params.arguments ?? {});
          return reply(mcpText(result?.text ?? result, result?.isError === true));
        }
        default:
          return fail(-32601, `Method not found: ${method}`);
      }
    } catch (error) {
      stats.errors++;
      return fail(-32603, String(error?.message ?? error));
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    stats,
    notifyToolsChanged() {
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
        } catch {}
      }
    },
    close: () =>
      new Promise((resolve) => {
        for (const client of sseClients) {
          try {
            client.end();
          } catch {}
        }
        sseClients.clear();
        server.close(resolve);
      }),
  };
}

export { PROTOCOL_VERSION, crypto };
