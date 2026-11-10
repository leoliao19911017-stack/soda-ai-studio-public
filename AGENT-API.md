# Agent 接口契约

四个 agent 共用一套字段与一组操作。**字段名是契约，改名等于断掉所有 agent。**

| Agent | 职责 | 对目标系统的操作 |
|---|---|---|
| Agent-01（云端 OpenClaw） | 和周报人对话 | 写：周报 / 月报 / 目标 |
| Agent-02 | 项目管理，收周报月报 | 读：谁没交、谁偏离、达不成 |
| Agent-03 | 营销 | 读：营销相关目标与成果 |
| Agent-04 | 研发测试 | 读：研发目标与交付物 |

---

## 一、数据契约

### 目标 Goal

```json
{
  "id": "g_w_1",
  "title": "宁波银行验收：10 道问数题全部通过",
  "owner": "Sam Lee",
  "level": "公司大目标 | 季度目标 | 月度计划 | 周目标",
  "parentId": "g_m_1",
  "status": "进行中 | 达成 | 未达成 | 延期 | 已放弃",
  "progress": 60,
  "note": "数据权限未开，需产品组张伟支持"
}
```

`aligned` 不是存下来的字段，而是**算出来的**：沿 `parentId` 一路向上，必须摸到 `level=公司大目标` 的节点。摸不到就是偏离。

### 周报 / 月报 Report

```json
{
  "kind": "weekly | monthly",
  "cycle": "2026-W45 | 2026-11",
  "owner": "Sam Lee",
  "fields": { "…七要素…": "…" },
  "submit": true
}
```

七要素（周报，缺一不可）：
`本周目标达成` `本周结果` `本周风险` `下周目标` `预期结果` `潜在风险` `所需援助`
其中 `本周风险` `潜在风险` `所需援助` 允许填「无」，其余不收「无」。

月报七项：`本月达成目标` `关键成果及链接` `Lesson Learned` `能力提升` `产品建议` `市场洞察` `开放项` + `下月计划`

---

## 二、读接口（Agent-02 / Agent-03 / Agent-04）

```
GET /api/goals?owner=Sam Lee&level=周目标&aligned=false
GET /api/reports?owner=Sam Lee&cycle=2026-W45&kind=weekly
GET /api/alignment
```

返回示例：

```json
{
  "ok": true, "count": 3,
  "goals": [{
    "id": "g_w_1",
    "title": "宁波银行验收：10 道问数题全部通过",
    "level": "周目标",
    "owner": "Sam Lee",
    "progress": 60,
    "aligned": true,
    "chain": ["把 SODA 做成客户愿意持续付费的 AI 交付业务",
              "Q4 签约 3 家标杆客户并完成交付",
              "知识库问答在 2 家客户现场本地化部署跑通",
              "宁波银行验收：10 道问数题全部通过"]
  }]
}
```

`chain` 是给 agent 用的关键字段——它让 agent 不用自己爬树就能说清「这件事为什么重要」。

对齐体检：

```json
{ "ok": true, "total": 7, "unalignedCount": 1, "coverage": "86%",
  "unaligned": [{ "title": "整理产品演示视频素材库", "owner": "Sam Lee",
                  "hint": "没有挂到任何上级目标…" }] }
```

## 二·五、上下文装配接口（Context Assembly）

```
POST /api/v1/context/assemble
Cookie: gos=<session>            // 或 Authorization: Bearer <apiToken>
{
  "goalId": "g_w_1",
  "query": "这个目标现在进展如何，有哪些相关周报？",
  "maxTokens": 8000
}
```

返回：

```json
{
  "goal": { "id": "g_w_1", "title": "…", "level": "周目标", "owner": "p_demo1" },
  "children": [{ "id": "g_w_2", "title": "…", "level": "周目标" }],
  "reports": [{ "owner": "p_demo1", "cycle": "2026-W45", "kind": "weekly", "summary": "…" }],
  "tokenEstimate": 1234,
  "truncated": false,
  "generatedAt": "2026-11-06T10:30:00Z"
}
```

规则：

- **周报全员可见**（透明化是核心设计目标，不是隐私泄露）。
- **目标是公司公共信息**，全员可见；只有「人」的档案（联系方式等）不下发给前端。
- 未登录 `401`；`goalId` 不存在 `404`。
- 超出 `maxTokens` 时先丢汇报、再丢子目标，`truncated` 置 `true`；至少保留 `goal`。
  本地估算按 UTF-8 字节数 / 3（中文约 1 字节对应 1/3 token）。

## 三、写接口（Agent-01）

```
POST /api/reports   {kind, cycle, owner, fields, submit}
POST /api/goals     {title, owner, level, parentId, progress, status, note}
```

`owner` 可以传姓名（「Sam Lee」）、昵称或 id，服务端负责解析。

### ⚠️ 群聊场景：可以读，但不要刷屏

Agent-01只在**群聊**里出现（无私聊入口），群里可能同时有 admin 和 member。

**周报本来就是公开的，所以在群里念周报不构成泄露。** 这一点和常见的「Agent 别乱说数据」相反，在本系统里是允许的。

要注意的是另外两件事：

| 约束 | 原因 |
|---|---|
| **人工触发，不主动播报** | 不要在群里定时推送全员周报，那是噪音 |
| **一次只回一个问题** | 群里有 8 个人时，长篇输出会淹没对话 |

**推荐的工具拆分**（走 MCP 或 function calling）：

| 类型 | 工具名 | 群里 | 说明 |
|---|---|---|---|
| **写** | `goal_report_submit` | ✅ | 员工提交；agent 角色可代写 |
| **查** | `goal_query` | ✅ | 目标、周报全员可见 |
| **汇总** | `goal_summarize` | ✅ | Agent-02 汇总用 |

> 群里的正确姿势：员工说一句「这周干完了 X」，Agent-02 调用 `goal_report_submit` 落库，
> 回一句「收到」即可。想看汇总，**由人主动问**，不要主动推。

---

## 四、两种落地形态

### A. 飞书多维表格（推荐，公司推广用这个）

所有 agent 本来就有飞书身份，Base 是天然共享层，不需要额外公网服务。

| 操作 | lark-cli |
|---|---|
| 读目标 | `base +record-list --base-token $BT --table-id $T_GOAL --filter-json '{"logic":"and","conditions":[["负责人","intersects",["Sam Lee"]]]}'` |
| 写周报 | `base +record-batch-create --base-token $BT --table-id $T_WEEKLY --json '{"create_records":[{...}]}'` |
| 写目标 | `base +record-batch-create --base-token $BT --table-id $T_GOAL --json '{"create_records":[{...}]}'` |
| 对齐体检 | 读全部目标，按 `对齐检查` 公式字段筛 `未对齐` |

Base 里 `目标.对齐检查` 这类公式字段就是为 agent 准备的——不用自己算，直接读。

### B. 本地 / 云端 HTTP 服务（当前形态）

`node goal-os/web/server.js`，同一套路径与字段。适合先跑通流程、做看板。
云端 Agent-01 要调它，服务必须部署在它能访问到的地方（同一台云主机，或反向代理到公网）。

**迁移时只换 handler 内部实现，对外路径和字段不变**——agent 侧技能不用改。

---

## 五、给 agent 的一句话说明

> 目标系统的读写口径见 `AGENT-API.md`。写周报前先按七要素核对，缺的当场问；读目标时优先用返回的 `chain` 解释层级关系；判定偏离只看 `aligned`，不要自己猜。

## 六、演示数据与真实数据的区分（agent 必读）

数据文件顶层有 `dataStatus`，每条记录有 `placeholder`：

- `dataStatus: "demo"` — 整库是界面演示数据，`goals` 全部为占位，**不得当作业务事实引用、不得据此汇报**
- 单条 `placeholder: true` — 该条是占位，`title` 通常带「（示例）」前缀

agent 在被问到「公司现在目标是什么」「覆盖率多少」时，必须先看 `dataStatus`；
若为 `demo`，要回答「当前只有演示数据，真实目标尚未录入」，而不是照抄数字。

真实数据入库后 `dataStatus` 置为 `live`，并移除 `placeholder`。
