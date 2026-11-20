// 三协议工具中继集成测试（无需真实 TeleAgent / kernel）
//
// 用一个假 kernel 模拟：prompt 后主动向 MCP 桥发起 tools/call（挂起），
// 客户端回灌 tool 结果后放行、再吐正文。端到端验证 chat / responses / anthropic
// 三条协议都能完成「工具调用 → 回灌 → 续跑」往返，以及无工具时的纯对话回归。
//
//   node tools/test-tool-relay.mjs
import http from 'node:http';
import { createShim } from '../lib/shim.mjs';
import { createToolBridge } from '../lib/toolbridge.mjs';

let PASS = 0;
let FAIL = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { PASS++; console.log(`  ok  ${name}`); }
  else { FAIL++; console.log(`  FAIL ${name}${detail ? ' :: ' + detail : ''}`); }
};

// ---------- 假 kernel ----------
function createFakeKernel() {
  const eventClients = new Set();
  const pendingEvents = [];
  let mcpUrl = null;
  let toolCalled = new Set();
  let lastPromptText = '';
  let lastToolsFlags = null;

  const emit = (ev) => {
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    if (eventClients.size === 0) pendingEvents.push(frame);
    else for (const res of eventClients) { try { res.write(frame); } catch {} }
  };
  const emitAnswer = (text) => {
    emit({ type: 'message.updated', properties: { info: { id: 'm1', role: 'assistant', sessionID: 's1', tokens: { input: 100, output: 20, cache: { read: 0 } } } } });
    emit({ type: 'message.part.updated', properties: { part: { sessionID: 's1', messageID: 'm1', type: 'text', text } } });
    emit({ type: 'session.status', properties: { sessionID: 's1', status: { type: 'idle' } } });
  };

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '').split('?')[0];
    let body = '';
    for await (const c of req) body += c;
    const json = (obj, status = 200) => {
      const b = JSON.stringify(obj);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(b);
    };

    if (url === '/global/health' || url === '/config') return json({ ok: true, agent: { build: { prompt: '' } } });
    if (url === '/mcp') {
      try { mcpUrl = JSON.parse(body).config.url; } catch {}
      return json({ ok: true });
    }
    if (url === '/experimental/tool/ids') return json(['ta_shell', 'builtin_read']);
    if (url === '/session' && req.method === 'POST') return json({ id: 's1' });
    if (url === '/session/s1/abort' || /\/session\/s1\/.*\/abort/.test(url)) return json({ ok: true });
    if (/\/session\/s1\/prompt_async$/.test(url)) {
      try {
        const parsed = JSON.parse(body);
        lastPromptText = parsed.parts?.map((p) => p.text).join('\n') ?? '';
        lastToolsFlags = parsed.tools ?? null;
      } catch {}
      const sessionID = 's1';
      if (toolCalled.has(sessionID)) {
        // resuming 不应发 prompt（由 shim 直接放行）；若真发说明状态机错了，仍给正文便于观察
        emitAnswer('UNEXPECTED_PROMPT_ON_RESUME');
        return json({ ok: true });
      }
      toolCalled.add(sessionID);
      // 主动向 MCP 桥发起工具调用；onCall 会挂起，直到客户端回灌
      void (async () => {
        try {
          const r = await fetch(mcpUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ta_shell', arguments: { command: ['echo', 'hi'] } } }),
          });
          const j = await r.json();
          const text = j?.result?.content?.[0]?.text ?? JSON.stringify(j);
          emitAnswer('工具返回：' + text);
        } catch (e) {
          emitAnswer('TOOL_CALL_ERROR ' + e.message);
        }
      })();
      return json({ ok: true });
    }
    if (url === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': connected\n\n');
      for (const f of pendingEvents.splice(0)) { try { res.write(f); } catch {} }
      eventClients.add(res);
      req.on('close', () => eventClients.delete(res));
      return;
    }
    return json({ error: 'not found' }, 404);
  });

  return {
    server,
    get lastPromptText() { return lastPromptText; },
    get lastToolsFlags() { return lastToolsFlags; },
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)),
    port: () => server.address().port,
    resetToolState: () => { toolCalled = new Set(); },
    proc: { exitCode: null },
    origin: '',
    sign: () => ({}),
    async call(method, path, data) {
      const r = await fetch(this.origin + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: data ? JSON.stringify(data) : undefined,
      });
      const text = await r.text();
      let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
      return { status: r.status, json: j, text };
    },
    waitReady: async () => ({}),
    close: () => new Promise((r) => server.close(r)),
  };
}

async function post(port, path, body) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
  return { status: r.status, j, text, ctype: r.headers.get('content-type') };
}

// 从 SSE 文本里抽出事件 payload
function sseEvents(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try { out.push(JSON.parse(line.slice(6))); } catch {}
  }
  return out;
}

// ---------- 主流程 ----------
const fake = createFakeKernel();
await fake.listen();
fake.origin = `http://127.0.0.1:${fake.port()}`;

const bridge = await createToolBridge({ kernel: fake, logger: { warn: () => {}, log: () => {} } });
const models = [{ id: 'chat-flash' }, { id: 'chat-pro' }];
const shim = await createShim({ getKernel: async () => fake, bridge, models, port: 0 });
const P = shim.port;

const TOOLS_CHAT = [{ type: 'function', function: { name: 'shell', description: 'run shell', parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } } } }];
const TOOLS_ANT = [{ name: 'shell', description: 'run shell', input_schema: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } } }];
const TOOLS_RESP = [{ type: 'function', name: 'shell', description: 'run shell', parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } } } }];

console.log('\n[1] OpenAI chat/completions 工具往返');
fake.resetToolState();
{
  // 首轮：带 tools 的提问 → 应返回 tool_calls，finish_reason=tool_calls
  const r1 = await post(P, '/v1/chat/completions', {
    model: 'chat-flash', stream: false,
    messages: [{ role: 'user', content: 'list files' }], tools: TOOLS_CHAT,
  });
  ok('chat 首轮 200', r1.status === 200, `status=${r1.status} ${r1.text.slice(0, 200)}`);
  const tc = r1.j?.choices?.[0]?.message?.tool_calls;
  ok('chat 返回 tool_calls', Array.isArray(tc) && tc.length === 1, JSON.stringify(r1.j?.choices?.[0]));
  ok('chat finish_reason=tool_calls', r1.j?.choices?.[0]?.finish_reason === 'tool_calls');
  ok('chat 工具名=shell', tc?.[0]?.function?.name === 'shell', JSON.stringify(tc?.[0]));
  ok('chat 注入了 builtinFlags', !!fake.lastToolsFlags && fake.lastToolsFlags.builtin_read === false, JSON.stringify(fake.lastToolsFlags));
  const callId = tc?.[0]?.id;

  // 回灌轮：带 role:tool 结果 → 应放行并拿到正文
  const r2 = await post(P, '/v1/chat/completions', {
    model: 'chat-flash', stream: false,
    messages: [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: null, tool_calls: tc },
      { role: 'tool', tool_call_id: callId, content: 'file1.txt' },
    ], tools: TOOLS_CHAT,
  });
  ok('chat 回灌轮 200', r2.status === 200, `status=${r2.status} ${r2.text.slice(0, 200)}`);
  const ans = r2.j?.choices?.[0]?.message?.content ?? '';
  ok('chat 续跑拿到正文', ans.includes('工具返回'), ans);
  ok('chat 回灌后 finish=stop', r2.j?.choices?.[0]?.finish_reason === 'stop');
}

console.log('\n[2] OpenAI Responses 工具往返');
fake.resetToolState();
{
  const r1 = await post(P, '/v1/responses', {
    model: 'chat-flash', stream: false, input: 'list files', tools: TOOLS_RESP,
  });
  ok('responses 首轮 200', r1.status === 200, `status=${r1.status} ${r1.text.slice(0, 200)}`);
  const fc = (r1.j?.output ?? []).find((o) => o.type === 'function_call');
  ok('responses 返回 function_call', !!fc, JSON.stringify(r1.j?.output));
  const callId = fc?.call_id;

  const r2 = await post(P, '/v1/responses', {
    model: 'chat-flash', stream: false,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
      { type: 'function_call', name: 'shell', call_id: callId, arguments: '{}' },
      { type: 'function_call_output', call_id: callId, output: 'file1.txt' },
    ],
    tools: TOOLS_RESP,
  });
  ok('responses 回灌轮 200', r2.status === 200, `status=${r2.status} ${r2.text.slice(0, 200)}`);
  const msg = (r2.j?.output ?? []).find((o) => o.type === 'message');
  const ans = (msg?.content ?? []).map((c) => c.text).join('');
  ok('responses 续跑拿到正文', ans.includes('工具返回'), ans);
}

console.log('\n[3] Anthropic messages 工具往返');
fake.resetToolState();
{
  const r1 = await post(P, '/v1/messages', {
    model: 'chat-flash', stream: false,
    messages: [{ role: 'user', content: 'list files' }], tools: TOOLS_ANT,
  });
  ok('anthropic 首轮 200', r1.status === 200, `status=${r1.status} ${r1.text.slice(0, 200)}`);
  const tu = (r1.j?.content ?? []).find((c) => c.type === 'tool_use');
  ok('anthropic 返回 tool_use', !!tu, JSON.stringify(r1.j?.content));
  ok('anthropic stop_reason=tool_use', r1.j?.stop_reason === 'tool_use', String(r1.j?.stop_reason));
  ok('anthropic tool id 为 toolu_ 前缀', typeof tu?.id === 'string' && tu.id.startsWith('toolu_'), String(tu?.id));
  const toolUseId = tu?.id;

  const r2 = await post(P, '/v1/messages', {
    model: 'chat-flash', stream: false,
    messages: [
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: [tu] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'file1.txt' }] },
    ], tools: TOOLS_ANT,
  });
  ok('anthropic 回灌轮 200', r2.status === 200, `status=${r2.status} ${r2.text.slice(0, 200)}`);
  const ans = (r2.j?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  ok('anthropic 续跑拿到正文', ans.includes('工具返回'), ans);
  ok('anthropic 回灌后 stop=end_turn', r2.j?.stop_reason === 'end_turn', String(r2.j?.stop_reason));
}

console.log('\n[4] 流式工具事件形状');
{
  const r = await fetch(`http://127.0.0.1:${P}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const text = await r.text();
  const evs = sseEvents(text);
  ok('anthropic 流式无工具仍正常收尾', evs.some((e) => e.type === 'message_stop'), text.slice(0, 200));

  const rc = await fetch(`http://127.0.0.1:${P}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const ct = await rc.text();
  ok('chat 流式含 [DONE]', ct.includes('[DONE]'), ct.slice(0, 200));
}

console.log('\n[5] 流式工具调用 delta 序列');
{
  // chat 流式工具调用：应发 tool_calls delta + finish_reason=tool_calls
  fake.resetToolState();
  const rc = await fetch(`http://127.0.0.1:${P}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-flash', stream: true, messages: [{ role: 'user', content: 'use tool' }], tools: TOOLS_CHAT }),
  });
  const ct = await rc.text();
  ok('chat 流式工具：含 tool_calls', ct.includes('"tool_calls"'), ct.slice(0, 300));
  ok('chat 流式工具：finish_reason=tool_calls', ct.includes('"tool_calls"') && /"finish_reason":"tool_calls"/.test(ct), ct.slice(-300));
  // 清掉这次挂起，避免污染后续
  const tcMatch = /"id":"(call_[0-9a-f]+)"/.exec(ct);
  const callId = tcMatch?.[1];
  if (callId) {
    await post(P, '/v1/chat/completions', {
      model: 'chat-flash', stream: false,
      messages: [
        { role: 'user', content: 'use tool' },
        { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'shell', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: callId, content: 'ok' },
      ], tools: TOOLS_CHAT,
    });
  }

  // anthropic 流式工具调用：应发 tool_use content_block + input_json_delta
  fake.resetToolState();
  const ra = await fetch(`http://127.0.0.1:${P}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'chat-flash', stream: true, messages: [{ role: 'user', content: 'use tool' }], tools: TOOLS_ANT }),
  });
  const at = await ra.text();
  const aevs = sseEvents(at);
  ok('anthropic 流式工具：有 tool_use 块', aevs.some((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'), at.slice(0, 400));
  ok('anthropic 流式工具：有 input_json_delta', aevs.some((e) => e.type === 'content_block_delta' && e.delta?.type === 'input_json_delta'), at.slice(0, 400));
  ok('anthropic 流式工具：stop_reason=tool_use', aevs.some((e) => e.type === 'message_delta' && e.delta?.stop_reason === 'tool_use'), at.slice(-400));
  const tuEvt = aevs.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use');
  if (tuEvt) {
    await post(P, '/v1/messages', {
      model: 'chat-flash', stream: false,
      messages: [
        { role: 'user', content: 'use tool' },
        { role: 'assistant', content: [tuEvt.content_block] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuEvt.content_block.id, content: 'ok' }] },
      ], tools: TOOLS_ANT,
    });
  }
}

await shim.close();
await bridge.close();
fake.close();

console.log(`\n结果：${PASS} 通过 / ${FAIL} 失败`);
process.exit(FAIL === 0 ? 0 : 1);
