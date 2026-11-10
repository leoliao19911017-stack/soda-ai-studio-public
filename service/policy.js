'use strict';
/**
 * policy.js — 《SODA AI 汇报与目标对齐机制》的机器可读版本。
 *
 * 这是唯一允许修改"制度"的地方。改这里的字段规格，周报/月报的追问行为立刻跟着变，
 * 不需要动对话逻辑。字段名必须与 schema.json 中多维表格的列名完全一致。
 */

// ── 对齐链条（policy.p3 / p9）────────────────────────────────────────────
const CHAIN = ['公司大目标', '季度目标', '月度计划', '周目标'];

// ── 字段规格 ────────────────────────────────────────────────────────────
// required: 缺失必追问；optional: 缺失只提示；allowNone: 可以答「无」而不算缺口
const SPECS = {
  weekly: {
    table: '周报',
    label: '周报',
    cadence: '每周日 22:30 前',
    groups: [
      { key: 'back', title: '回头看 · 本周', fields: ['本周目标达成', '本周结果', '本周风险'] },
      { key: 'forward', title: '向前看 · 下周', fields: ['下周目标', '预期结果', '潜在风险', '所需援助'] }
    ],
    fields: {
      本周目标达成: {
        required: true,
        ask: '本周目标达成了哪几项？对着上周写下的目标逐条核对，达成就是达成，未达成的写原因和补救。'
      },
      本周结果: {
        required: true,
        ask: '交付物和数据是什么？能量化的给数字，能附链接的附上。'
      },
      本周风险: {
        required: true,
        allowNone: true,
        ask: '有没有已发生或预见的问题？影响范围多大？（没有就回「无」）'
      },
      下周目标: {
        required: true,
        ask: '下周要完成哪些目标？写具体、可核对的动作，别写「推进 XX」。'
      },
      预期结果: {
        required: true,
        ask: '这些下周目标完成后，具体产出是什么？'
      },
      潜在风险: {
        required: true,
        allowNone: true,
        ask: '下周的目标有哪些潜在风险？（没有就回「无」）'
      },
      所需援助: {
        required: true,
        allowNone: true,
        ask: '需要谁帮你扫清什么障碍？写明「找谁、要什么」，这比成果更该说。'
      }
    }
  },
  monthly: {
    table: '月报',
    label: '月报',
    cadence: '每月最后一个工作日 10:30–13:30 月度会议，书面报告提前一天发出',
    groups: [
      { key: 'core', title: '核心复盘', fields: ['本月达成目标', '关键成果及链接', 'Lesson Learned'] },
      { key: 'growth', title: '沉淀与洞察', fields: ['能力成长', '产品建议', '市场洞察'] },
      { key: 'next', title: '下月计划', fields: ['下月计划'] },
      { key: 'open', title: '开放项', fields: ['开放项'] }
    ],
    fields: {
      本月达成目标: {
        required: true,
        ask: '这个月计划的目标，逐条核对完成了哪些？写明完成度。'
      },
      关键成果及链接: {
        required: true,
        ask: '交付物、文档、上线功能有哪些？每个都要能点开的链接。'
      },
      LessonLearned: {
        required: true,
        ask: '做对了什么、踩了什么坑、下次怎么避免？这是月报里最值钱的部分。'
      },
      能力成长: { required: false, ask: '这个月新掌握了什么技能、方法或认知？' },
      产品建议: { required: false, ask: '从一线看到的、产品该改的地方？' },
      市场洞察: { required: false, ask: '客户、竞品、行业有什么一线观察？' },
      下月计划: {
        required: true,
        ask: '下个月计划做什么？必须注明它支撑哪个季度目标、对应哪个公司大目标。'
      },
      开放项: { required: false, ask: '框架之外还有什么值得说的？' }
    }
  },
  goal: {
    table: '目标',
    label: '目标制定',
    cadence: '月度计划在月报中写明，周目标在周报中校准',
    groups: [
      { key: 'what', title: '目标本体', fields: ['目标', '层级', '对齐上级'] },
      { key: 'measure', title: '怎么算达成', fields: ['关键结果'] }
    ],
    fields: {
      目标: { required: true, ask: '要达成什么？动词开头，写成能被核对的样子。' },
      层级: {
        required: true,
        ask: '这是哪一层？' + CHAIN.join(' → ') + '。'
      },
      对齐上级: {
        required: true,
        allowSkipWhen: (slots) => slots['层级'] === '公司大目标',
        ask: '它向上支撑哪个目标？' + CHAIN.join(' → ') + ' 的链条不能断。'
      },
      关键结果: { required: true, ask: '怎么衡量达成？给数字或明确的里程碑。' }
    }
  }
};

// ── 三条写作纪律（policy.p5）──────────────────────────────────────────────
const VAGUE_PATTERNS = [
  /做了很多(事|工作)?/,
  /推进了(不少|很多|一些)/,
  /持续优化/,
  /有一定的?(进展|提升|改善)/,
  /差不多(完成)?/,
  /基本上(完成)?/,
  /优化了?体验/,
  /积极配合/,
  /努力(推进|完成)/
];

const NONE_WORDS = /^(无|没有|暂无|没|none|null|n\/a|不需要|无风险|暂无风险)[。.!！]?$/i;

const isEmpty = (v) => v == null || String(v).trim() === '' || NONE_WORDS.test(String(v).trim());

/** 缺口检测：返回必填但缺失的字段，按对话顺序排 */
function gaps(kind, slots) {
  const spec = SPECS[kind];
  if (!spec) return [];
  const out = [];
  for (const group of spec.groups) {
    for (const f of group.fields) {
      const def = spec.fields[f];
      if (!def || !def.required) continue;
      if (typeof def.allowSkipWhen === 'function' && def.allowSkipWhen(slots)) continue;
      if (isEmpty(slots[f])) out.push({ field: f, ask: def.ask, allowNone: !!def.allowNone, group: group.title });
    }
  }
  return out;
}

/** 建议补全（非阻塞） */
function suggestions(kind, slots) {
  const spec = SPECS[kind];
  if (!spec) return [];
  const out = [];
  for (const group of spec.groups) {
    for (const f of group.fields) {
      const def = spec.fields[f];
      if (!def || def.required) continue;
      if (isEmpty(slots[f])) out.push({ field: f, ask: def.ask });
    }
  }
  return out;
}

/** 三条纪律自检 */
function lint(kind, slots) {
  const issues = [];
  const spec = SPECS[kind] || {};

  for (const [field, value] of Object.entries(slots)) {
    const text = String(value || '');
    if (!text) continue;

    for (const p of VAGUE_PATTERNS) {
      if (p.test(text)) {
        issues.push({
          level: 'warn',
          field,
          rule: '只写事实与数字',
          detail: `「${text.match(p)[0]}」无法核对，换成具体数字或交付物。`
        });
        break;
      }
    }
  }

  // 结果必须有数字或链接
  const resultField = kind === 'weekly' ? '本周结果' : kind === 'monthly' ? '关键成果及链接' : null;
  if (resultField && slots[resultField]) {
    const t = String(slots[resultField]);
    const hasNumber = /\d/.test(t);
    const hasLink = /https?:\/\/|飞书|\/docx\/|\/wiki\/|\/base\//i.test(t);
    if (!hasNumber && !hasLink) {
      issues.push({
        level: 'warn',
        field: resultField,
        rule: '只写事实与数字',
        detail: '这条没有数字也没有链接，同事无法核对。'
      });
    }
  }

  // 援助要写明找谁
  if (kind === 'weekly' && slots['所需援助'] && !isEmpty(slots['所需援助'])) {
    const t = String(slots['所需援助']);
    if (t.length > 2 && !/找|请|需要.{0,6}(帮|支持|协调|讲解|确认)|@/.test(t)) {
      issues.push({
        level: 'warn',
        field: '所需援助',
        rule: '风险与援助同报告',
        detail: '援助要写清「找谁、要什么」，否则负责人无法帮你扫障碍。'
      });
    }
  }

  // 一页纸
  const total = Object.values(slots).join('').length;
  if (kind === 'weekly' && total > 900) {
    issues.push({ level: 'info', field: null, rule: '一页纸', detail: `全文 ${total} 字，周报应一页纸读完，建议压到 600 字内。` });
  }

  return issues;
}

// ── 周期计算 ─────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

const weekKey = (d = new Date()) => {
  const { year, week } = isoWeek(d);
  return `${year}-W${pad(week)}`;
};

function weekRange(key) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(key);
  if (!m) return null;
  const year = +m[1], week = +m[2];
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const start = new Date(week1Mon);
  start.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { start, end };
}

function shiftWeek(key, delta) {
  const r = weekRange(key);
  if (!r) return key;
  const d = new Date(r.start);
  d.setUTCDate(d.getUTCDate() + delta * 7);
  return weekKey(d);
}

const monthKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const quarterKey = (d = new Date()) => `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
const yearKey = (d = new Date()) => `${d.getFullYear()}`;

/** 每周日 22:30 截止 */
function weekDeadline(key) {
  const r = weekRange(key);
  if (!r) return null;
  const d = new Date(r.end);
  d.setUTCHours(22 - 8, 30, 0, 0); // 周日 22:30 Asia/Shanghai → UTC
  return d;
}

/** 每月最后一个工作日；书面报告提前一天发出 */
function monthLastWorkday(year, month) {
  const d = new Date(Date.UTC(year, month, 0)); // 当月最后一天
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

function monthDeadline(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const lw = monthLastWorkday(+m[1], +m[2]);
  const d = new Date(lw);
  d.setUTCDate(lw.getUTCDate() - 1); // 提前一天
  d.setUTCHours(22 - 8, 30, 0, 0);
  return d;
}

function monthMeeting(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const lw = monthLastWorkday(+m[1], +m[2]);
  lw.setUTCHours(10 - 8, 30, 0, 0);
  return lw;
}

function cycleInfo(kind, now = new Date()) {
  if (kind === 'weekly') {
    const key = weekKey(now);
    return { key, type: '周', deadline: weekDeadline(key), label: key + ' 周报' };
  }
  const key = monthKey(now);
  return { key, type: '月', deadline: monthDeadline(key), meeting: monthMeeting(key), label: key + ' 月报' };
}

module.exports = {
  CHAIN, SPECS, gaps, suggestions, lint, isEmpty, NONE_WORDS,
  weekKey, weekRange, shiftWeek, monthKey, quarterKey, yearKey,
  weekDeadline, monthDeadline, monthMeeting, cycleInfo
};
