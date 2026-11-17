// 对话历史存档 + 按需检索。
//
// 背景（2026-11-17 实测）：大对话（几百轮）的首轮折叠会把全量历史拼成约 4 万字符
// 发给模型，chat-pro 在这个体积下会静默卡死 240s，而同样输入换成短 prompt 17s 就回。
// 根因是「对话消息」这一档过大，与 system prompt / MCP 无关（已逐一排除）。
//
// 解法：首轮不再全量转发，而是
//   1) 把完整历史写成可读 Markdown 存档到本机文件；
//   2) 只把最近若干条消息 + 一段指针发给模型，指针告诉它完整历史在哪、需要时自己 grep/read。
// 这样模型平时轻装上阵不卡死，问到很早以前的内容时按需检索，历史一条不丢。

import fs from 'node:fs';
import path from 'node:path';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
    .filter(Boolean)
    .join('\n');
}

/** 把任意会话 key 变成安全文件名。 */
export function makeArchivePath(dir, key) {
  const safe = String(key ?? 'conversation').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'conversation';
  return path.join(dir, `${safe}.md`);
}

/**
 * 把完整历史写成可读 Markdown，供 AI 按需检索。覆盖式写入（同一对话始终保留最新快照）。
 * 返回 { file, chars, rounds }。
 */
export function writeArchive(file, messages) {
  const blocks = [];
  let rounds = 0;
  for (const m of messages) {
    const t = textOf(m?.content).trim();
    if (!t) continue;
    if (m.role === 'user') {
      rounds += 1;
      blocks.push(`\n## 👤 用户（第 ${rounds} 轮）\n\n${t}`);
    } else if (m.role === 'assistant') {
      blocks.push(`\n## 🤖 助手\n\n${t}`);
    } else if (m.role === 'tool') {
      blocks.push(`\n## 🔧 工具结果\n\n${t}`);
    }
  }
  const body = blocks.join('\n');
  const header =
    '# 对话历史存档\n\n' +
    '> 由 teleagent-proxy 自动生成，供 AI 在需要时用 grep / read 工具按需检索。\n' +
    `> 共 ${rounds} 轮用户对话。\n`;
  const full = header + body;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, full, 'utf8');
  return { file, chars: full.length, rounds };
}

/**
 * 从最新消息往前保留，直到接近 maxChars；返回正序文本。
 * 最新一条 user 消息一定在内（从后往前天然包含）。返回 { text, kept }。
 */
export function recentExcerpt(messages, maxChars) {
  const budget = Number(maxChars) > 0 ? Number(maxChars) : 10000;
  const picked = [];
  let size = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const t = textOf(m?.content).trim();
    if (!t) continue;
    const label = m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role === 'tool' ? '工具结果' : m.role;
    const piece = `${label}：${t}`;
    if (picked.length && size + piece.length > budget) break;
    picked.push(piece);
    size += piece.length + 1;
    if (size >= budget) break;
  }
  picked.reverse();
  return { text: picked.join('\n'), kept: picked.length };
}

/** 生成给模型看的指针文本：告诉它完整历史在哪、需要时怎么查。 */
export function archivePointer({ file, totalRounds, kept }) {
  return [
    '【对话历史说明 · 请务必先读】',
    '这是一个延续中的长对话。完整历史已存档到本机文件：',
    file,
    `共 ${totalRounds} 轮用户对话；为避免上下文过大导致响应超时，本次只附带最近的 ${kept} 条消息（见下方「最近消息」）。`,
    '★ 重要：本轮若涉及「继续任务 / 接着做 / 未完成的工作 / 之前讨论过的结论」，在动手前必须先用你的文件检索工具（grep / read）查询上面的存档文件，',
    '   确认任务当前进度、已完成步骤和待办清单后再行动，切勿仅凭下方「最近消息」猜测或重复做过的事。',
    '★ 需要更早的精确细节（某段代码、字段名、文件路径、之前定下的结论）时，同样先检索存档文件；确实查不到才说明没有，不要凭空编造。',
    '【最近消息】',
  ].join('\n');
}
