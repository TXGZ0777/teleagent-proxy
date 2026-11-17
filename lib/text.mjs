// 文本体积控制：限制单轮发给内核的 prompt 大小。
//
// 背景（2026-11-17 实测，D:\Program Files\teleagent-proxy）：prompt 越大，模型「思考」
// 产出的 token 越多，而网关要等思考结束才开始吐内容——20k 字符 2.5s 返回；50k 静默
// 75~90s 后才吐；150k+ 超过 120s 仍无内容，客户端只会看到超时并反复重试同样的大
// prompt，形成「必定超时」。所以首轮折叠与增量轮都必须限体积：
//   TA_MAX_FOLD_CHARS  单轮总体积预算（默认 40000；0=关闭）
//   TA_MAX_TOOL_CHARS  单条工具结果的截取上限（默认 12000；0=关闭）

/** 超长文本截取首尾（保留 60% 头 + 40% 尾），中间用省略标记替代。max<=0 时原样返回。 */
export function trimMiddle(text, maxChars) {
  const s = String(text ?? '');
  const max = Number(maxChars) || 0;
  if (max <= 0 || s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${s.slice(0, head)}\n…（中间省略 ${s.length - head - tail} 字符）…\n${s.slice(-tail)}`;
}

/**
 * 把 entries 拼成一段 text，超限时按策略裁剪（原地修改 entries）：
 *   entries: [{ kind: 'user'|'assistant'|'tool'|'line', text }]
 *   1) 优先丢弃最旧的 kind='tool' 条目（用户/助手主线保真，工具结果可重取）；
 *   2) 工具条目全丢完仍超限，才整体截尾（保留最近的内容）。
 * maxChars<=0 时不裁剪。返回 { text, dropped, tailTrimmed }。
 */
export function fitEntries(entries, maxChars) {
  const max = Number(maxChars) || 0;
  const sizeOf = () => entries.reduce((n, e) => (e ? n + e.text.length + 1 : n), 0);
  let dropped = 0;
  if (max > 0) {
    for (let i = 0; i < entries.length && sizeOf() > max; i += 1) {
      if (!entries[i] || entries[i].kind !== 'tool') continue;
      entries[i] = null;
      dropped += 1;
    }
  }
  let text = entries.filter(Boolean).map((e) => e.text).join('\n');
  let tailTrimmed = false;
  if (max > 0 && text.length > max) {
    text = `（较早内容已省略）\n${text.slice(text.length - max)}`;
    tailTrimmed = true;
  } else if (dropped > 0) {
    text = `（较早的 ${dropped} 条工具结果已省略，以控制上下文长度）\n${text}`;
  }
  return { text, dropped, tailTrimmed };
}
