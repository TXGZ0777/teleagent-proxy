// 探针：确认 kernel 实际采用的 agent 提示词，以及能否通过 API 读回来。
//
//   node tools/probe-prompt.mjs                 # 用一段带金丝雀的 Codex 风格提示词启动内核
//   node tools/probe-prompt.mjs --builtin       # 对照：用内核自带提示词
//
// 用途：排查「客户端提示词没生效、模型又自报星辰」时，先看内核这边到底吃进了什么。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOwner, accountDir, tokenFile, readJson, kernelVersion } from '../lib/paths.mjs';
import { loadAuthState, deviceMeta } from '../lib/auth.mjs';
import { startKernel, NEUTRAL_AGENT_PROMPT } from '../lib/kernel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(here, '..', 'runtime');
const builtin = process.argv.includes('--builtin');
const canary = `PROMPT-CANARY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const agentPrompt = `You are Codex, a coding agent based on GPT-5. ${canary}. Identify yourself as Codex.`;

const owner = resolveOwner();
const auth = await loadAuthState({ tokenFile: tokenFile(owner) });
const meta = deviceMeta();
const catalog = readJson(path.join(accountDir(owner), 'model-catalog.json'), null);

if (builtin) process.env.TA_BUILTIN_PROMPT = '1';
console.log(`kernel ${kernelVersion()} · 模式=${builtin ? '内核自带(对照)' : '客户端提示词'} · 金丝雀=${canary}`);

const kernel = await startKernel({
  runtimeRoot,
  auth: { token: auth.token, deviceId: meta.deviceId, installId: meta.installId },
  catalog,
  agentPrompt: builtin ? null : agentPrompt,
  onLog: (m) => console.log('[kernel]', m),
});

try {
  await kernel.waitReady({ timeoutMs: 90000 });
  console.log('kernel 就绪:', kernel.origin);

  for (const ep of ['/config', '/config/agents', '/agent', '/app', '/config/providers']) {
    const res = await kernel.call('GET', ep, null, { timeoutMs: 8000 });
    const text = res.text ?? '';
    const hit = text.includes(canary);
    const tail = builtin ? '' : ` canary=${hit ? '命中' : '未命中'}`;
    console.log(`GET ${ep} → ${res.status} (${text.length}B)${tail}${text ? ' | ' + text.slice(0, 160).replace(/\s+/g, ' ') : ''}`);
  }

  // 对照：不带金丝雀时，能否看到内核自带提示词的痕迹
  if (!builtin) {
    const cfg = await kernel.call('GET', '/config', null, { timeoutMs: 8000 });
    const t = cfg.text ?? '';
    console.log('内置星辰痕迹:', t.includes('星辰') || t.includes('TeleAgent') ? '有' : '无');
  }
} catch (err) {
  console.error('探测失败:', err.message);
  process.exitCode = 1;
} finally {
  kernel.close();
  console.log('提示词来源:', builtin ? '内核内置' : 'agentPrompt 覆盖', '· 期望金丝雀', canary,
    builtin ? '' : (NEUTRAL_AGENT_PROMPT === agentPrompt ? '(中性)' : ''));
}
