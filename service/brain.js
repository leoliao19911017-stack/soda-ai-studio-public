'use strict';
/**
 * brain.js — 对话编排：一句话进来，出「草稿 + 缺口追问」或「定稿 + 确认」。
 *
 * 状态机很小，只有三个状态：
 *   collecting  正在收集，每轮追加原话 → 重新抽取 → 报缺口
 *   confirming  要素齐了，等用户说「确认」或提出修改
 *   (null)      空闲
 *
 * 关键约束：字段缺失由 policy.js 判定，模型无权决定「够了没有」。
 */
const policy = require('./policy');
const llm = require('./llm');

const MAX_Q = 3; // 一次最多问 3 个，问太多人会烦

function newSession() {
  return { mode: null, cycle: null, raw: '', slots: {}, stage: null, asked: [], updatedAt: Date.now() };
}

const KIND_LABEL = { weekly: '周报', monthly: '月报', goal: '目标' };

function timeLeft(deadline) {
  if (!deadline) return '';
  const ms = deadline.getTime() - Date.now();
  if (ms <= 0) return '已过截止时间';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `还剩 ${Math.max(1, Math.round(ms / 60000))} 分钟`;
  if (h < 48) return `还剩 ${h} 小时`;
  return `还剩 ${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

function fmtDeadline(deadline) {
  if (!deadline) return '';
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date(deadline.getTime() + 8 * 3600 * 1000); // 显示为北京时间
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** 按制度分组渲染字段 */
function renderGroups(kind, slots) {
  const spec = policy.SPECS[kind];
  const out = [];
  for (const g of spec.groups) {
    const lines = [];
    for (const f of g.fields) {
      const v = slots[f];
      if (policy.isEmpty(v)) continue;
      lines.push(`**${f}**：${String(v).replace(/\n+/g, ' ')}`);
    }
    if (lines.length) out.push(`【${g.title}】\n${lines.join('\n')}`);
  }
  return out.join('\n\n');
}

function filledCount(kind, slots) {
  const spec = policy.SPECS[kind];
  let total = 0, done = 0;
  for (const g of spec.groups) {
    for (const f of g.fields) {
      total++;
      if (!policy.isEmpty(slots[f])) done++;
    }
  }
  return { done, total };
}

function statusLine(kind, cycle) {
  const deadline = kind === 'weekly' ? policy.weekDeadline(cycle) : kind === 'monthly' ? policy.monthDeadline(cycle) : null;
  const spec = policy.SPECS[kind];
  if (!deadline) return `📌 ${spec.cadence}`;
  return `📌 截止 ${fmtDeadline(deadline)}（${timeLeft(deadline)}）`;
}

function chunkQuestions(qs) {
  // 标出字段名，用户才知道这句话补的是哪一栏，也能按序号作答
  return qs.map((q, i) => `${i + 1}.（${q.field}）${q.ask}`).join('\n');
}

const BARE_NONE = /^(无|没有|暂无|没了|没什么|没有风险|无风险|没啥|none|null)[。.!！]?$/i;

function formatCollecting(kind, cycle, slots, missing, lintIssues) {
  const { done, total } = filledCount(kind, slots);
  const head = `📝 **${KIND_LABEL[kind]}草稿 · ${cycle}**\n${statusLine(kind, cycle)}`;

  const body = renderGroups(kind, slots);
  const shown = missing.slice(0, MAX_Q);
  const rest = missing.length - shown.length;

  const qBlock =
    `❓ **还差 ${missing.length} 项**，回答下面这些我就补齐：\n` +
    chunkQuestions(shown) +
    (rest > 0 ? `\n（还有 ${rest} 项，先答这几个）` : '');

  const lintBlock = lintIssues.length
    ? `\n\n⚠️ 自检：\n` + lintIssues.slice(0, 2).map((i) => `· ${i.detail}`).join('\n')
    : '';

  return [
    head,
    body ? `\n${body}` : '',
    `\n✅ 已整理 ${done}/${total}`,
    qBlock,
    lintBlock
  ].filter(Boolean).join('\n');
}

function formatConfirm(kind, cycle, slots, lintIssues) {
  const head = `✅ **${KIND_LABEL[kind]}定稿 · ${cycle}**\n${statusLine(kind, cycle)}`;
  const body = renderGroups(kind, slots);
  const lintBlock = lintIssues.length
    ? `\n\n⚠️ 自检（不阻塞提交）：\n` + lintIssues.map((i) => `· ${i.detail}`).join('\n')
    : '';
  return [
    head,
    `\n${body}`,
    lintBlock,
    `\n回复「**确认**」我写入目标管理台；要改哪句直接说，我改完再确认。`
  ].filter(Boolean).join('\n');
}

/**
 * 主入口。
 * @param {object} opts
 * @param {string} opts.text 用户这句话
 * @param {object} opts.session 会话状态（会被就地更新并返回）
 * @param {object} [opts.statusProvider] 可选：异步返回 {hasReport, deadline, ...}
 * @returns {Promise<{reply:string, session:object, action:object|null}>}
 */
async function handle({ text, session = newSession(), statusProvider = null }) {
  const t = String(text || '').trim();
  if (!t) return { reply: '你说，我在听。', session, action: null };

  // 1) 指令优先
  const cmd = llm.command(t);
  if (cmd === 'cancel') {
    const fresh = newSession();
    return { reply: '好，清空了。想重来时直接说「写周报」或「写月报」。', session: fresh, action: null };
  }
  if (cmd === 'help') {
    return {
      reply: [
        '**我是你的汇报整理助手，按《SODA AI 汇报与目标对齐机制》干活。**',
        '',
        '· 直接说「写周报」「写月报」「定目标」，然后把想到的都说给我',
        '· 我会整理成制度要求的结构，缺什么当场问你',
        '· 说「确认」我就写进目标管理台',
        '',
        '周报：本周日 22:30 前。月报：月度会议前一天发出。'
      ].join('\n'),
      session,
      action: null
    };
  }
  if (cmd === 'status') {
    const info = statusProvider ? await statusProvider(session) : null;
    return { reply: info || statusFallback(session), session, action: null };
  }

  // 2) 确认提交
  if (cmd === 'confirm') {
    if (session.stage !== 'confirming') {
      return { reply: '还没到定稿。先把你这周/这月的情况说给我，我整理好再确认。', session, action: null };
    }
    return {
      reply: `收到，正在写入…`,
      session: { ...session, stage: 'submitted' },
      action: { type: 'persist', kind: session.mode, cycle: session.cycle, slots: session.slots }
    };
  }

  // 3) 确定模式
  let kind = session.mode;
  if (!kind) {
    kind = llm.guessKind(t);
    if (!kind) {
      return {
        reply: '我按制度帮你整理**周报**或**月报**。这句话是要写周报、月报，还是定目标？\n（直接说「周报」就行）',
        session,
        action: null
      };
    }
  }

  // 4) 周期
  const cycle = session.cycle || policy.cycleInfo(kind === 'monthly' ? 'monthly' : 'weekly').key;

  // 5) 纯否定回答（「无 / 没有」）走确定性分支，绝不交给模型去推断
  //    模型会把「下周目标：10 道题全过」推断成「预期结果：10 道题全部通过」——那就是编造。
  if (BARE_NONE.test(t)) {
    const missingNow = policy.gaps(kind, session.slots);
    const blocking = missingNow.find((m) => !m.allowNone);

    if (!missingNow.length) {
      return {
        reply: '要素已经齐了，你说「确认」我就写入；要改哪句直接说。',
        session: { ...session, mode: kind, cycle, stage: 'confirming' },
        action: null
      };
    }

    if (blocking) {
      return {
        reply: [
          `「**${blocking.field}**」这栏不能填「无」——它是制度里的必填项，缺了负责人没法判断进展。`,
          '',
          blocking.ask,
          '\n其余可以留空的项，你直接说「无」我就一起收。'
        ].join('\n'),
        session: { ...session, mode: kind, cycle, updatedAt: Date.now() },
        action: null
      };
    }

    // 剩下的都是允许「无」的项：一次全部收下
    const slots = { ...session.slots };
    for (const m of missingNow) slots[m.field] = '无';
    return {
      reply: formatConfirm(kind, cycle, slots, policy.lint(kind, slots)),
      session: { ...session, mode: kind, cycle, slots, stage: 'confirming', updatedAt: Date.now() },
      action: null
    };
  }

  // 6) 累积原话并抽取
  const raw = (session.raw ? session.raw + '\n' : '') + t;
  const { fields } = await llm.extract(kind, raw, session.slots);
  const slots = { ...session.slots, ...fields };

  // 7) 缺口 + 自检
  const missing = policy.gaps(kind, slots);
  const lintIssues = policy.lint(kind, slots);

  if (missing.length === 0) {
    return {
      reply: formatConfirm(kind, cycle, slots, lintIssues),
      session: { ...session, mode: kind, cycle, raw, slots, stage: 'confirming', updatedAt: Date.now() },
      action: null
    };
  }

  const asked = await llm.askQuestions(kind, slots, missing);
  return {
    reply: formatCollecting(kind, cycle, slots, asked, lintIssues),
    session: { ...session, mode: kind, cycle, raw, slots, stage: 'collecting', updatedAt: Date.now() },
    action: null
  };
}

function statusFallback(session) {
  if (!session.mode) {
    const w = policy.cycleInfo('weekly');
    const m = policy.cycleInfo('monthly');
    return [
      '**当前状态**',
      `· 本周 ${w.key}：截止 ${fmtDeadline(w.deadline)}（${timeLeft(w.deadline)}）`,
      `· 本月 ${m.key}：截止 ${fmtDeadline(m.deadline)}（${timeLeft(m.deadline)}）`,
      '',
      '说「写周报」开始。'
    ].join('\n');
  }
  const { done, total } = filledCount(session.mode, session.slots);
  return `**${KIND_LABEL[session.mode]} ${session.cycle}**：已整理 ${done}/${total}，${session.stage === 'confirming' ? '等你确认' : '还在收集'}。`;
}

module.exports = { handle, newSession, timeLeft, fmtDeadline, KIND_LABEL };
