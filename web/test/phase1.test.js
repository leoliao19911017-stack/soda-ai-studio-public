#!/usr/bin/env node
'use strict';
/**
 * Phase 1 验收脚本（真实 HTTP 请求，不 mock）。
 *
 * 前置：
 *   1. 迁移已跑：node web/migrations/001_init.js
 *   2. 服务已启动：PORT=8787 GOALOS_DB=<与下面同一个库> node web/server.js
 *   3. 本脚本与服务使用同一个 GOALOS_DB 环境变量
 *
 * 运行：
 *   PORT=8787 GOALOS_DB=web/data.test.db node web/server.js
 *   BASE_URL=http://127.0.0.1:8787 GOALOS_DB=web/data.test.db node web/test/phase1.test.js
 *
 * 注意：脚本会写入一条 Sam Lee 的周报、并发改一次 g_w_1、新建/删除一条临时目标。
 * 请对测试库跑，不要对生产库跑。
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const PASS = process.env.TEST_PASS || 'CHANGE_ME_BEFORE_USE';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail === undefined ? '' : '  → ' + JSON.stringify(detail)}`);
  }
}

async function call(method, urlPath, opts = {}) {
  const headers = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  if (opts.bearer) headers['Authorization'] = 'Bearer ' + opts.bearer;
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  return { status: res.status, data, headers: res.headers };
}

function cookieOf(res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return list.length ? list[0].split(';')[0] : '';
}

async function main() {
  console.log(`\nPhase 1 验收 @ ${BASE}\n`);

  /* 0. 未登录 → 401 */
  console.log('[1] 鉴权');
  const anon = await call('POST', '/api/v1/context/assemble', { body: { goalId: 'g_m_1' } });
  check('未登录调用 context 返回 401', anon.status === 401, anon.status);

  const baseline = await call('GET', '/api/data');
  check('GET /api/data 公开可读', baseline.status === 200 && Array.isArray(baseline.data.goals), baseline.status);
  const baselineGoalCount = baseline.data.goals.length;
  const baselinePeople = baseline.data.people.length;

  /* 2. Sam Lee 登录 */
  const login = await call('POST', '/api/login', { body: { name: 'Sam Lee', password: PASS } });
  check('Sam Lee 登录 200 且 role=member', login.status === 200 && login.data.role === 'member', login.data);
  const leo = cookieOf(login);
  check('登录返回会话 Cookie', /^gos=[a-f0-9]{48}$/.test(leo), leo ? leo.slice(0, 12) + '…' : '');

  console.log('[2] Sam Lee 全量数据');
  const data = await call('GET', '/api/data', { cookie: leo });
  check('GET /api/data 200', data.status === 200, data.status);
  check('loggedIn=true', data.data.loggedIn === true, data.data.loggedIn);
  check('me.personId=p_demo1', data.data.me && data.data.me.personId === 'p_demo1', data.data.me);
  check('目标条数与迁移后一致', data.data.goals.length === baselineGoalCount, {
    before: baselineGoalCount, now: data.data.goals.length
  });
  check('人员条数与迁移后一致', data.data.people.length === baselinePeople, {
    before: baselinePeople, now: data.data.people.length
  });
  check('Sam Lee 能看到自己的目标 g_m_1', data.data.goals.some(g => g.id === 'g_m_1' && g.owner === 'p_demo1'));
  const leoGoal = data.data.goals.find(g => g.id === 'g_m_1');
  check('goal 记录带 version（乐观锁）', !!(leoGoal && Number.isInteger(leoGoal.version)), leoGoal && leoGoal.version);

  const leoReportsBefore = data.data.reports.length;
  const hadSameReport = data.data.reports.some(r =>
    r.owner === 'p_demo1' && r.kind === 'weekly' && r.cycle === '2026-W45');
  console.log('[3] 写一条 Sam Lee 周报（用于验证 context 能带到他的周报）');
  const reportRes = await call('POST', '/api/reports', {
    cookie: leo,
    body: {
      kind: 'weekly',
      cycle: '2026-W45',
      fields: {
        '本周目标达成': 'Phase 1 SQLite 迁移完成',
        '本周结果': 'Phase1 并发测试周报：context 能拉到这条周报',
        '本周风险': '无',
        '下周目标': '完成 Context API 验收',
        '预期结果': '验收通过',
        '潜在风险': '无',
        '所需援助': '无'
      },
      status: '已提交'
    }
  });
  check('POST /api/reports 200', reportRes.status === 200, reportRes.status);
  const leoReport = reportRes.data && reportRes.data.report;
  check('周报 owner=p_demo1、cycle=2026-W45', !!(leoReport && leoReport.owner === 'p_demo1' && leoReport.cycle === '2026-W45'), leoReport);
  const reportCountAfter = (await call('GET', '/api/data', { cookie: leo })).data.reports.length;
  check('周报写入后条数正确', reportCountAfter === leoReportsBefore + (hadSameReport ? 0 : 1), {
    before: leoReportsBefore, after: reportCountAfter, existed: hadSameReport
  });

  console.log('[4] Context Assembly — 自己的目标');
  const ctx = await call('POST', '/api/v1/context/assemble', {
    cookie: leo,
    body: { goalId: 'g_m_1', query: '这个目标现在进展如何，有哪些相关周报？', maxTokens: 8000 }
  });
  check('member 拉自己的目标 200', ctx.status === 200, ctx.status);
  const ctxBody = ctx.data || {};
  check('goal.id=g_m_1', ctxBody.goal && ctxBody.goal.id === 'g_m_1', ctxBody.goal);
  check('children 含子目标 g_w_1', Array.isArray(ctxBody.children) && ctxBody.children.some(c => c.id === 'g_w_1'),
    ctxBody.children);
  check('reports 含 Sam Lee 刚写的周报', Array.isArray(ctxBody.reports) &&
    ctxBody.reports.some(r => r.owner === 'p_demo1' && r.cycle === '2026-W45' && /Phase1 并发测试周报/.test(r.summary)),
    ctxBody.reports);
  check('不泄露Alex Chen的汇报', Array.isArray(ctxBody.reports) && !ctxBody.reports.some(r => r.owner === 'p_yu'),
    ctxBody.reports);
  check('tokenEstimate > 0', typeof ctxBody.tokenEstimate === 'number' && ctxBody.tokenEstimate > 0, ctxBody.tokenEstimate);
  check('未超出预算时 truncated=false', ctxBody.truncated === false, ctxBody.truncated);
  check('generatedAt 为 ISO 时间', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(ctxBody.generatedAt)),
    ctxBody.generatedAt);
  console.log('       返回摘要:', JSON.stringify({
    goal: ctxBody.goal,
    children: ctxBody.children,
    reports: ctxBody.reports,
    tokenEstimate: ctxBody.tokenEstimate,
    truncated: ctxBody.truncated
  }));

  console.log('[5] 权限边界');
  const forbidden = await call('POST', '/api/v1/context/assemble', {
    cookie: leo, body: { goalId: 'g_q_1', maxTokens: 8000 }
  });
  check('member 拉别人的私人目标 → 403', forbidden.status === 403, forbidden.status);

  const selfReport = await call('POST', '/api/v1/context/assemble', {
    cookie: leo, body: { goalId: 'g_q_1', role: 'admin', principalId: 'p_yu', maxTokens: 8000 }
  });
  check('自报 role=admin / principalId 不能提权（仍 403）', selfReport.status === 403, selfReport.status);

  const missing = await call('POST', '/api/v1/context/assemble', {
    cookie: leo, body: { goalId: 'g_does_not_exist' }
  });
  check('不存在的 goalId → 404', missing.status === 404, missing.status);

  const tiny = await call('POST', '/api/v1/context/assemble', {
    cookie: leo, body: { goalId: 'g_m_1', maxTokens: 1 }
  });
  check('maxTokens=1 → 200 且 truncated=true', tiny.status === 200 && tiny.data.truncated === true,
    { status: tiny.status, truncated: tiny.data && tiny.data.truncated, tokenEstimate: tiny.data && tiny.data.tokenEstimate });

  console.log('[6] Bearer token');
  const tokenRes = await call('GET', '/api/token', { cookie: leo });
  check('GET /api/token 200', tokenRes.status === 200 && !!tokenRes.data.token, tokenRes.data);
  if (tokenRes.data && tokenRes.data.token) {
    const bearer = await call('POST', '/api/v1/context/assemble', {
      bearer: tokenRes.data.token, body: { goalId: 'g_m_1' }
    });
    check('Bearer 可调用 context', bearer.status === 200, bearer.status);
  }

  console.log('[7] Admin 视角');
  const adminLogin = await call('POST', '/api/login', { body: { name: 'Alex Chen', password: PASS } });
  check('Alex Chen登录 200 且 role=admin', adminLogin.status === 200 && adminLogin.data.role === 'admin', adminLogin.data);
  const admin = cookieOf(adminLogin);
  const adminCtx = await call('POST', '/api/v1/context/assemble', {
    cookie: admin, body: { goalId: 'g_q_1', maxTokens: 8000 }
  });
  check('admin 拉任意目标 200', adminCtx.status === 200, adminCtx.status);
  const adminCtx2 = await call('POST', '/api/v1/context/assemble', {
    cookie: admin, body: { goalId: 'g_w_1' }
  });
  check('admin 能看到 Sam Lee 的周报', adminCtx2.status === 200 &&
    Array.isArray(adminCtx2.data.reports) && adminCtx2.data.reports.some(r => r.owner === 'p_demo1'),
    adminCtx2.data && adminCtx2.data.reports);

  console.log('[8] 并发写同一目标（乐观锁）');
  const before = await call('GET', '/api/data', { cookie: leo });
  const g = before.data.goals.find(x => x.id === 'g_w_1');
  check('g_w_1 存在且带 version', !!(g && Number.isInteger(g.version)), g && g.version);
  const baseVersion = g.version;
  const [r1, r2] = await Promise.all([
    call('POST', '/api/goals', {
      cookie: leo,
      body: { ...g, id: 'g_w_1', progress: 61, version: baseVersion }
    }),
    call('POST', '/api/goals', {
      cookie: leo,
      body: { ...g, id: 'g_w_1', progress: 62, version: baseVersion }
    })
  ]);
  const statuses = [r1.status, r2.status].sort((a, b) => a - b);
  check('两个并发请求：一个 200、一个 409', statuses[0] === 200 && statuses[1] === 409, statuses);
  const conflict = r1.status === 409 ? r1 : r2;
  check('冲突响应 code=VERSION_CONFLICT', conflict.data && conflict.data.code === 'VERSION_CONFLICT', conflict.data);

  const after = await call('GET', '/api/data', { cookie: leo });
  const gAfter = after.data.goals.find(x => x.id === 'g_w_1');
  const winner = r1.status === 200 ? r1 : r2;
  check('最终 version = 旧版本 + 1', gAfter.version === baseVersion + 1, {
    before: baseVersion, after: gAfter.version
  });
  check('最终进度 = 成功请求的进度（没有丢写）',
    gAfter.progress === winner.data.goal.progress,
    { final: gAfter.progress, winner: winner.data.goal.progress });

  console.log('[9] 旧接口回归：无 version 字段的写法仍可用');
  const created = await call('POST', '/api/goals', {
    cookie: leo,
    body: { title: 'Phase1 回归临时目标', level: '周目标', parentId: 'g_m_1', progress: 10, note: 'test' }
  });
  check('POST /api/goals 新建 200', created.status === 200 && created.data.ok === true, created.status);
  const tempId = created.data && created.data.goal && created.data.goal.id;
  check('新建目标带 version=1', !!(tempId && created.data.goal.version === 1), created.data && created.data.goal);
  const del = await call('POST', '/api/goals/delete', { cookie: leo, body: { id: tempId } });
  check('POST /api/goals/delete 删除 200', del.status === 200 && del.data.ok === true, del.status);

  console.log('[10] events 表');
  const db = require('../lib/db');
  db.init();
  const goalEvents = db.eventCount('g_w_1', 'goal.upsert');
  check('g_w_1 有 goal.upsert 事件', goalEvents >= 1, goalEvents);
  const reportEvents = leoReport ? db.eventCount(leoReport.id, 'report.upsert') : 0;
  check('Sam Lee 周报有 report.upsert 事件', reportEvents >= 1, reportEvents);
  const sample = db.all('SELECT subject_id, type, created_at FROM events ORDER BY id DESC LIMIT 3');
  console.log('       最近 3 条事件:', JSON.stringify(sample));
  db.close();

  console.log('\n────────────────────────────');
  console.log(`结果：${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('失败项：');
    for (const f of failures) console.log(' -', f.name, JSON.stringify(f.detail));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('\n验收脚本异常终止（服务没起、库不对或网络错误）：');
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
