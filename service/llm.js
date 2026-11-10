'use strict';
/**
 * llm.js — DeepSeek 调用层。
 *
 * 只做两件事：把口语整理成制度字段；判断这句话属于哪种汇报。
 * 缺口判定、纪律自检、格式组装都在 policy.js / brain.js 里用确定性逻辑做，
 * 不交给模型——模型负责理解语言，代码负责守规矩。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const API_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.GOALOS_MODEL || 'deepseek-flash';

let cachedKey = null;
function apiKey() {
  if (cachedKey) return cachedKey;
  if (process.env.DEEPSEEK_API_KEY) return (cachedKey = process.env.DEEPSEEK_API_KEY);
  const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const m = /DEEPSEEK_API_KEY\s*:\s*["']?([A-Za-z0-9_\-]{20,})/.exec(txt);
    if (m) return (cachedKey = m[1]);
  } catch (_) {}
  throw new Error('找不到 DEEPSEEK_API_KEY（环境变量或 ~/.dsh/.credentials.yaml）');
}

async function chat(messages, { json = false, temperature = 0.2, maxTokens = 2000 } = {}) {
  const body = {
    model: MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey()}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!json) return text;
  return parseJson(text);
}

function parseJson(text) {
  let s = String(text).trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error('模型返回的不是合法 JSON: ' + String(text).slice(0, 200));
  }
}

// ── 意图识别（纯规则，够用且零延迟）──────────────────────────────────────
const CMDS = {
  confirm: /^(确认|定稿|提交|ok|好|可以|就这样|没问题|发吧|写进去)/i,
  cancel: /^(取消|重来|算了|不写了|清空)/,
  status: /^(状态|进度|我(本周|这个月)?(还有|缺)|查(看|询)|我的(周报|月报)|待办)/,
  help: /^(帮助|help|\?|怎么用|说明)/
};

function command(text) {
  const t = String(text).trim();
  for (const [k, re] of Object.entries(CMDS)) if (re.test(t)) return k;
  return null;
}

function guessKind(text) {
  const t = String(text);
  if (/月报|月度|本月|这个月|上月|下月|月度会议/.test(t)) return 'monthly';
  if (/周报|本周|这周|上周|下周|周目标/.test(t)) return 'weekly';
  if (/目标|OKR|计划|拆解|对齐/.test(t)) return 'goal';
  return null;
}

// ── 抽取 ────────────────────────────────────────────────────────────────
const POLICY_NOTE = `制度背景：公司要求「目标写下来，风险说在前面，经验沉淀给团队」。
对齐链条：公司大目标 → 季度目标 → 月度计划 → 周目标 → 每日执行。
三条写作纪律：1) 只写事实与数字，不写「做了很多事」这类无法核对的描述；2) 风险与援助必须和成果写在同一份报告里，报喜也报忧；3) 一页纸能说完就不写三页。`;

function systemPrompt(kind) {
  const shapes = {
    weekly: `周报两栏七要素：
【回头看·本周】本周目标达成（对照上周目标逐条核对，写明完成度，未达成写原因与补救）、本周结果（交付物与数据，附链接）、本周风险（已发生或预见的问题、影响范围）
【向前看·下周】下周目标（具体可核对）、预期结果、潜在风险、所需援助（写明找谁、要什么）`,
    monthly: `月报七项：本月达成目标（对照月初计划逐条核对完成度）、关键成果及链接（每个都要可点击）、Lesson Learned（做对了什么/踩了什么坑/下次怎么避免）、能力成长、产品建议、市场洞察、开放项；另有下月计划（须注明所属季度目标与对应公司大目标）。`,
    goal: `目标制定要素：目标（动词开头、可核对）、层级（公司大目标/季度目标/月度计划/周目标）、对齐上级（向上支撑哪个目标）、关键结果（数字或里程碑）。`
  };

  return `你是 SODA（Sample Corp）的目标与汇报整理助手。你的任务是把同事在飞书里随口说的话，整理成符合公司制度的结构化内容。

${POLICY_NOTE}

本次要整理的是：${shapes[kind]}

严格要求：
- 只使用用户明确说过的信息。绝不编造数字、链接、人名、日期。
- 不要跨字段推断：如果某栏的内容是你从另一栏推出来的（例如从「下周目标」推出「预期结果」），就不要填，返回空字符串。真实汇报里「目标」和「预期结果」是两件事，合并会让负责人看不出差别。
- 用户没说的一律返回空字符串 ""。
- 把口语改写成书面、简洁、可核对的表述，但不得增加用户没提供的信息。
- 保留用户给的所有数字、链接、专有名词（客户名、产品名、人名）原样。
- 如果用户明确说了「无 / 没有 / 暂无」，对应字段就填「无」——这表示他已经回答过了。
- 每条尽量控制在一到两句话，周报要能一页纸读完。

输出 JSON，仅两个键：
{"fields": {字段名: "整理后的内容"}, "notes": "一句话说明你做了什么合并或推断，没有就空字符串"}`;
}

/**
 * 把累积的用户话语抽取成字段。
 * @param {'weekly'|'monthly'|'goal'} kind
 * @param {string} rawText 用户累计原话
 * @param {object} current 已有字段（用于增量合并）
 */
async function extract(kind, rawText, current = {}) {
  const fieldNames = kind === 'weekly'
    ? ['本周目标达成', '本周结果', '本周风险', '下周目标', '预期结果', '潜在风险', '所需援助']
    : kind === 'monthly'
      ? ['本月达成目标', '关键成果及链接', 'Lesson Learned', '能力成长', '产品建议', '市场洞察', '开放项', '下月计划']
      : ['目标', '层级', '对齐上级', '关键结果'];

  const user = `已知已填内容（JSON，可能为部分）：${JSON.stringify(current)}

用户最新原话：
"""
${rawText.slice(-6000)}
"""

请输出 JSON，fields 的键必须是以下之一：${fieldNames.join('、')}。
只输出这些键，不要新增。`;

  const out = await chat(
    [
      { role: 'system', content: systemPrompt(kind) },
      { role: 'user', content: user }
    ],
    { json: true, temperature: 0.1 }
  );

  const fields = out && typeof out.fields === 'object' && out.fields ? out.fields : {};
  const clean = {};
  for (const k of fieldNames) {
    const v = fields[k];
    if (typeof v === 'string' && v.trim()) clean[k] = v.trim();
    else if (typeof v === 'number') clean[k] = String(v);
  }
  return { fields: clean, notes: typeof out?.notes === 'string' ? out.notes : '' };
}

/** 针对缺口生成贴合上下文的追问（一次最多 3 条） */
async function askQuestions(kind, slots, missing) {
  if (!missing.length) return [];
  const prompt = `同事正在写${kind === 'weekly' ? '周报' : kind === 'monthly' ? '月报' : '目标'}。
已经写下的内容：${JSON.stringify(slots)}
还缺这些要素：${missing.map((m) => m.field).join('、')}

请为每个缺失要素生成一句追问，要求：
- 结合他上面已经写的内容来问，让他一句话就能答上，而不是让他重新组织语言
- 一个问题只问一件事，口语化，不超过 40 字
- 不要包含「请提供」「能否告知」这类公文腔

输出 JSON：{"questions": {字段名: "追问"}}`;

  try {
    const out = await chat(
      [
        { role: 'system', content: '你是善于追问的汇报助手，问题短、具体、贴着对方已经说的话。' },
        { role: 'user', content: prompt }
      ],
      { json: true, temperature: 0.4 }
    );
    const q = out?.questions || {};
    return missing.map((m) => ({ ...m, ask: typeof q[m.field] === 'string' && q[m.field].trim() ? q[m.field].trim() : m.ask }));
  } catch (_) {
    return missing; // 模型挂了就退回制度里的标准问法
  }
}

module.exports = { chat, extract, askQuestions, command, guessKind, MODEL };
