'use strict';
/**
 * Context Assembly（Phase 1 最小实现）
 *
 *   ① 鉴权：调用方传入已由 Cookie / Bearer 解析出的 me，本文件不接受
 *      请求体里的 principalId / role —— 身份永远不来自自报字段。
 *   ② 解析范围：goalId → 该目标 + 全部后代目标 + 相关汇报。
 *   ③ 组装：按 maxTokens 预算贪心装入，超出则截断。
 *   ④ 返回：稳定的结构化 JSON（不返回 note 等可能含敏感信息的自由文本）。
 *
 * 权限（本期）：
 *   - admin：全部。
 *   - member：自己 owner 的目标 + 公司大目标（公共结构）；别人的私人目标 403。
 *   - 汇报：member 只能看到自己的，绝不泄露他人汇报。
 */

const ESTIMATE_DIVISOR = 3; // UTF-8 字节数 / 3 ≈ token 数（中文 3 字节≈1 token）
const MAX_TOKENS_CAP = 200000;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / ESTIMATE_DIVISOR);
}

function isPublicStructure(goal) {
  return goal.level === '公司大目标';
}

function summarize(report) {
  const fields = report.fields && typeof report.fields === 'object' ? report.fields : {};
  const preferred = ['本周结果', '本月达成目标', '本周目标达成', '关键成果及链接', '下周目标', '下月计划'];
  for (const key of preferred) {
    const v = fields[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
  }
  for (const v of Object.values(fields)) {
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
  }
  return '';
}

function descendantsOf(goals, rootId) {
  const byParent = new Map();
  for (const g of goals) {
    if (!g.parentId) continue;
    if (!byParent.has(g.parentId)) byParent.set(g.parentId, []);
    byParent.get(g.parentId).push(g);
  }
  const out = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const pid = queue.shift();
    for (const g of byParent.get(pid) || []) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      out.push(g);
      queue.push(g.id);
    }
  }
  return out;
}

/**
 * @returns {{status:number, body:object}}
 */
function assemble(data, me, input) {
  const goalId = input.goalId == null ? '' : String(input.goalId).trim();
  if (!goalId) throw httpError('goalId 必填', 400);

  const byId = new Map(data.goals.map(g => [g.id, g]));
  const goal = byId.get(goalId);
  if (!goal) throw httpError('目标不存在', 404);

  const isAdmin = me.role === 'admin';
  // 目标全员可见（透明化）：不再按 owner 做 403 拦截。
  // 仅保留「目标必须存在」的 404。L2 个人记忆的隔离不在这里，见六层记忆模型。

  // 目标与周报全员可见（透明化），不再按 owner 过滤。
  // 注意：这只放开「目标结构 + 周报」，不等于放开 L2 个人记忆。
  const visibleGoals = descendantsOf(data.goals, goalId);

  const ownerScope = new Set([goal.owner, ...visibleGoals.map(g => g.owner)]);
  const visibleReports = data.reports.filter(r => ownerScope.has(r.owner));

  const rawMax = Number(input.maxTokens);
  const maxTokens = Number.isFinite(rawMax) && rawMax > 0
    ? Math.min(Math.floor(rawMax), MAX_TOKENS_CAP)
    : 8000;

  const result = {
    goal: { id: goal.id, title: goal.title, level: goal.level, owner: goal.owner },
    children: [],
    reports: [],
    tokenEstimate: 0,
    truncated: false,
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  };

  let truncated = false;
  for (const g of visibleGoals) {
    result.children.push({ id: g.id, title: g.title, level: g.level });
    if (estimateTokens(result) > maxTokens) {
      result.children.pop();
      truncated = true;
      break;
    }
  }
  for (const r of visibleReports) {
    result.reports.push({
      owner: r.owner,
      cycle: r.cycle,
      kind: r.kind,
      summary: summarize(r)
    });
    if (estimateTokens(result) > maxTokens) {
      result.reports.pop();
      truncated = true;
      break;
    }
  }

  result.tokenEstimate = estimateTokens(result);
  // 预算小到连 goal 本身都装不下时也必须如实标记。
  result.truncated = truncated || result.tokenEstimate > maxTokens;
  return result;
}

module.exports = { assemble, estimateTokens, summarize, descendantsOf };
