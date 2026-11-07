// 临时验收脚本：验证本地反代三件事——模型清单、非流式、流式
const base = 'http://127.0.0.1:8787';

const show = (label, value) => console.log(`\n=== ${label} ===\n${value}`);

// 1) 模型清单
const models = await (await fetch(`${base}/v1/models`)).json();
show('GET /v1/models', models.data.map((m) => m.id).join(', '));

// 2) 非流式，中文
const t0 = Date.now();
const res = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'chat-flash',
    messages: [{ role: 'user', content: '用一句话介绍你自己，再报一下今天日期。' }],
  }),
});
const data = await res.json();
show(`非流式 (${res.status}, ${Date.now() - t0}ms)`, data.choices?.[0]?.message?.content ?? JSON.stringify(data));
console.log('usage:', JSON.stringify(data.usage));

// 3) 流式，统计首字延迟与增量条数
const t1 = Date.now();
const sres = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'chat-flash',
    stream: true,
    messages: [{ role: 'user', content: '数到五，每个数字一行。' }],
  }),
});
let first = 0;
let chunks = 0;
let text = '';
const decoder = new TextDecoder();
let buf = '';
for await (const part of sres.body) {
  buf += decoder.decode(part, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 2);
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    const evt = JSON.parse(payload);
    if (evt.error) throw new Error(JSON.stringify(evt.error));
    const d = evt.choices?.[0]?.delta ?? {};
    const piece = d.content ?? '';
    if (piece && !first) first = Date.now() - t1;
    if (piece) chunks++;
    text += piece;
  }
}
show(`流式 (${sres.status}, 首字 ${first}ms, ${chunks} 个增量)`, text.trim());

// 4) 健康检查
const health = await fetch(`${base}/healthz`);
show(`GET /healthz (${health.status})`, (await health.text()).slice(0, 300));
