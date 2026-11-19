// planTurn / isToollessSummarizationTurn 回归测试。
//
// 背景（2026-11-19 串台事故）：dsh/WorkBuddy 的 compact 总结请求（无工具、全量历史
// 塞在最后一条 user 消息里）撞上桥的「长对话存档模式」，模型没有任何工具、读不了
// 存档检索指针，只能凭指针文案里的项目路径幻觉编造历史，假总结被固化后污染后续
// 每一轮。修复：总结轮豁免存档模式，走放宽上限（TA_COMPACT_MAX_CHARS）的全量折叠。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isToollessSummarizationTurn, planTurn } from '../lib/shim.mjs';

// 2026-11-19 实抓的 compact 提示词骨架（指令 + 标签 + 全量历史正文）
const COMPACT_PROMPT = [
  'Your task is to write a detailed and structured summary of between an AI agent and a user,',
  "paying close attention to the user's explicit requests and previous actions.",
  '<conversation_history_summary>',
  '[put your structured summary content in this tag]',
  '</conversation_history_summary>',
].join('\n');

const compactMessages = [
  { role: 'system', content: '你是助手' },
  { role: 'user', content: `${COMPACT_PROMPT}\n\n${'（历史正文）'.repeat(500)}` },
];

test('compact 总结请求（无工具）命中豁免', () => {
  assert.equal(isToollessSummarizationTurn({}, compactMessages), true);
  assert.equal(isToollessSummarizationTurn(undefined, compactMessages), true);
});

test('带工具的普通轮不豁免（即使文案含总结指令）', () => {
  const body = { tools: [{ type: 'function', function: { name: 'ta_read', parameters: {} } }] };
  assert.equal(isToollessSummarizationTurn(body, compactMessages), false);
});

test('无工具的普通用户轮不豁免', () => {
  assert.equal(isToollessSummarizationTurn({}, [{ role: 'user', content: '先打包测试包' }]), false);
  assert.equal(isToollessSummarizationTurn({}, []), false);
  assert.equal(isToollessSummarizationTurn({}, undefined), false);
});

test('数组形态的 content 同样能命中标记词', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: '<conversation_history_summary>…' }] },
  ];
  assert.equal(isToollessSummarizationTurn({}, msgs), true);
});

// —— planTurn 豁免路径：真实对话骨架不被存档指针替代 ——

/** ~32 万字符的长历史（与事故现场同量级）：40 轮 × 大工具输出。 */
function longHistory() {
  const msgs = [];
  for (let i = 0; i < 40; i += 1) {
    msgs.push({ role: 'user', content: `第${i}轮：请阅读 docs/nas-docker.md 并整理 ${'x'.repeat(2000)}` });
    msgs.push({ role: 'tool', content: `[工具输出 #${i}] ${'y'.repeat(6000)}` });
    msgs.push({ role: 'assistant', content: `第${i}轮结论：改动已落盘，测试通过。` });
  }
  return msgs;
}

test('豁免路径保留真实骨架：用户/助手消息不被丢弃、无存档指针', () => {
  const plan = planTurn(null, longHistory(), { maxChars: 120000 }); // 豁免轮的调用形态
  assert.equal(plan.archived, undefined, '未启用存档模式');
  assert.ok(plan.text.includes('第0轮'), '最早的用户消息仍在');
  assert.ok(plan.text.includes('第39轮结论'), '最新的助手消息仍在');
  assert.ok(plan.foldedChars <= 120000, `裁后 ${plan.foldedChars} 字符在放宽上限内`);
});

test('豁免路径丢的是旧工具结果，不是对话正文', () => {
  const plan = planTurn(null, longHistory(), { maxChars: 120000 });
  assert.ok(plan.trimmed > 0, `应丢弃部分旧工具结果（实际丢弃 ${plan.trimmed} 条）`);
  assert.ok(!plan.text.includes('[工具输出 #0]'), '最旧的工具结果被丢弃');
  assert.ok(plan.text.includes('第0轮：请阅读'), '同一轮的用户正文保留');
});

test('未豁免 + archive：大历史仍走存档摘要（回归保护：修复只豁免总结轮）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-plan-turn-'));
  try {
    const plan = planTurn(null, longHistory(), { archive: { dir, key: 't' }, recentChars: 4000 });
    assert.ok(plan.archived, '应返回 archived 标记');
    assert.ok(plan.archived.chars > 12000, '历史确实超过存档阈值');
    assert.ok(plan.text.includes('【对话历史说明 · 请务必先读】'), '检索指针在场');
    assert.ok(plan.foldedChars < 20000, `只发指针+近期摘录（实际 ${plan.foldedChars} 字符）`);
    assert.ok(fs.existsSync(plan.archived.file), '存档文件已落盘');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未豁免 + archive：小历史仍走全量折叠（阈值行为不变）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-plan-turn-'));
  try {
    const msgs = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在的' }];
    const plan = planTurn(null, msgs, { archive: { dir, key: 't' }, maxChars: 40000 });
    assert.equal(plan.archived, undefined, '低于阈值不启用存档摘要');
    assert.ok(plan.text.includes('用户：你好'));
    assert.ok(plan.text.includes('助手：在的'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
