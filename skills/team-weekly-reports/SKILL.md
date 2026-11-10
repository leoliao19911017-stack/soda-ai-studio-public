---
name: team-weekly-reports
description: "Use when building transparent team weekly reports."
version: 1.0.0
---

# Team Weekly Reports

把「每个人每周干了什么」变成可对齐、可追溯、可被 Agent 辅助的事实源。

## 它解决什么问题

传统周报的三个毛病：

- 写完发到群里，三天后翻不到
- 和季度目标对不上，年底发现方向偏了
- 领导要汇总时，靠人一份份复制粘贴

这套做法的核心是：**周报不是汇报，是对齐工具**。每份周报必须挂到一个目标上，目标必须是公司级目标拆下来的。

## 三个约束（必须遵守，否则会退化成普通周报）

**1. 全员可见。**

这是设计，不是漏洞。

几乎所有组织第一次看到这个系统都会说「应该加权限，只能看自己的」。**不要加**。

理由：周报的价值在于横向对齐——你知道隔壁组在做什么，才能避免重复劳动、才能主动配合。一旦变成只能看自己的，它就只是个归档工具，失去了 90% 的价值。

如果组织对透明有顾虑，那是管理问题，不是技术问题。技术上不要替他们做这个决定。

**2. 周报必须挂目标。**

允许写「本周没什么进展」的空周报，但不允许不挂目标的周报。不挂目标的周报无法被汇总，也无法被对齐。

**3. 乐观锁。**

多个人（和 Agent）可能同时改同一条记录。用版本号防覆盖：

```javascript
function updateRow(table, id, patch, expectedVersion) {
  const rows = db.prepare(
    `UPDATE ${table} SET ... , version = version + 1
     WHERE id = ? AND version = ?`
  ).run(..., id, expectedVersion);
  if (rows.changes === 0) throw new Error('版本冲突，请刷新后重试');
}
```

## 数据流

```
公司目标 (company goal)
    └── 部门目标 (team goal)
            └── 个人目标 (person goal)
                    └── 周报 (report) ── 声明：本周推进了哪个目标
                            └── 下周目标 (next_week) ── 可自动落成下周期目标
```

周报结构：

```
本周进展（必须列表，每条挂目标 id）
遇到的问题
下周计划
需要的支持
```

## Agent 代写角色

允许 Agent 代某个员工写周报，但必须标记：

```json
{"personId": "p1", "author": "agent:writer-1", "authorMode": "delegated"}
```

**不能伪装成人写的。** 看板上要标出来「这份是 Agent 代写，本人未确认」。

## 已知缺陷（如果你照着抄，记得修）

**Context 超预算静默丢数据。**

组装「给 Agent 看的上下文」时，超过 token 预算就直接 break：

```javascript
for (const r of visibleReports) {
  result.reports.push({...});
  if (estimateTokens(result) > maxTokens) {
    result.reports.pop();
    truncated = true;
    break;              // ← 这里，后面全丢
  }
}
```

后果：Agent 拿不到最新周报，以为「本周没人汇报」，给出看起来正常但基于不完整信息的答案。**它不会报错。**

修法：

```javascript
// 按时间倒序排，重要的在前
visibleReports.sort((a, b) => b.week.localeCompare(a.week));
const dropped = [];
for (const r of visibleReports) {
  const candidate = {...result, reports: [...result.reports, r]};
  if (estimateTokens(candidate) > maxTokens) {
    dropped.push({id: r.id, week: r.week, reason: 'token_budget'});
    continue;                    // 继续试后面的，不是 break
  }
  result.reports.push(r);
}
result.meta = { truncated: dropped.length > 0, dropped };
```

**必须把 dropped 返回给调用方**，否则 Agent 还是不知道自己少了什么。

## 常见坑

**周报和目标混在一起做权限。** 不要。见上面第一条。

**「下周目标」不自动落库。** 周报里写了「下周要做 X」，但系统不会自动创建下周的目标记录。要么手动加，要么写个定时任务把它落下来——但后者要注意别把随口说的计划变成正式目标。

**两个管理员互删。** 加一个 superadmin 层级，或者干脆禁止 admin 删除 admin。

## 验证装好了

```bash
# 1. 能创建目标
curl -X POST http://127.0.0.1:8787/api/goals -d '{"title":"测试目标"}' -H "Content-Type: application/json"

# 2. 能提交周报
curl -X POST http://127.0.0.1:8787/api/reports -d '{"personId":"p1","week":"2026-W45","items":[]}' -H "Content-Type: application/json"

# 3. 换个人也能看到（验证全员可见）
curl http://127.0.0.1:8787/api/reports
```

第三条能看到第一条的东西，才算装对。

## 参考实现

完整代码：`github.com/your-org/soda-ai-studio`

技术栈：Node.js + Express + SQLite。
关键文件：
- `web/lib/context.js` — 上下文组装（缺陷在这）
- `web/lib/store.js` — 写库入口
- `web/migrations/` — 001 建表 / 002 目标 / 003 凭证剥离 / 004 Agent 列
