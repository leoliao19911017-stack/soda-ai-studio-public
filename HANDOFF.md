# Soda AI Studio · 交接文档

> 交接范围：Soda 周/月目标与对齐系统。
> 读完应能做到四件事：**跑起来**、**分清哪些数据是真的**、**在不破坏契约的前提下改代码**、**知道哪些地方是坑**。

最后更新：**2026-11-07**（数据层已迁到 SQLite 并上线）

---

## 1. 一句话说清这是什么

员工在飞书里跟机器人「Agent-01」说话 → 系统按公司制度整理成结构化周报/月报 → 写入共享数据 → 网页看板把「我的目标有没有挂在涛哥的链上」可视化 → 另外三个 agent（Agent-02/Agent-03/Agent-04）读取同一份数据。

制度依据：`Soda Docs/Policies/SODA AI 汇报与目标对齐机制.pdf`（对齐链条、两栏七要素、月报七项、截止时间）。

**核心理念**：事实源优先、透明化（周报和目标全员可见）、零填报（Agent 采集+整理，人只做每周一次判断）。

---

## 2. 现在到什么程度

| 能力 | 状态 | 证据 / 说明 |
|---|---|---|
| 对话整理引擎（七要素抽取 + 缺口追问） | ✅ 离线验证 | `node service/smoke.js` 跑通 5 轮真实口吻对话，含拒收「无」的场景 |
| 目标数据服务（读写 API） | ✅ 已上线 | https://your-domain.com/ |
| **数据层 SQLite** | ✅ **2026-11-07 上线** | 乐观锁 + 事件表，解决并发覆盖 |
| **Context Assembly API** | ✅ 可用 | `POST /api/v1/context/assemble` |
| **周报/目标全员可见** | ✅ 已改 | 透明化是产品设计，不是权限漏洞 |
| **agent 角色代写** | ✅ 已加 | Agent-01/Agent-02 可代任意员工写入 |
| 对齐看板 | ✅ 已重做 | 群目标 → 成员/Agent → 线程，一屏无跳转 |
| Agent-01的录入技能 | ⚠️ 已写好，未上真机 | `Soda AI Guys/Agent-01/skills/goal-intake/SKILL.md` |
| 飞书多维表格底座 | ❌ 被权限阻塞 | `setup.js` 代码就绪，卡在 App 缺 `base:app:create` |
| 与真实飞书环境的联调 | ❌ 未做 | **未有一条真实员工周报进入过系统** |

---

## 3. 数据真实性（必读，别踩坑）

看板上的数字看起来很真，但**目前没有一条是真实业务数据**。

| 内容 | 真假 |
|---|---|
| 公司名、Founder、Sam Lee 这个人 | **真** |
| 四个人名与职责（Agent-01=录入 / Agent-02=项目管理 / Agent-03=营销 / Agent-04=研发测试） | **真** |
| 8 位员工姓名 | **真** |
| 2026-W45 周期 | **真**（按当前日期计算） |
| 7 个目标的标题、进度、状态 | **假**，全部为占位 |
| 「宁波银行」「10 道问数题」「张伟」等细节 | **假**，出自冒烟测试用例 |
| 周报 | **0 条**，数据库里就是空的 |

已做的防护：

- 顶层 `dataStatus: "demo"`；每条占位记录 `placeholder: true`，标题带「（示例）」
- [AGENT-API.md](AGENT-API.md) 里写死规则：agent 被问公司目标时先看 `dataStatus`，是 demo 就回答「真实目标尚未录入」，不许照抄数字

---

## 4. 架构

```
        ┌──────────────┐
        │    员工      │  飞书群里说话
        └──────┬───────┘
               ▼
        ┌──────────────┐   写    ┌──────────────────┐
        │   Agent-01     │────────▶│  SQLite (data.db) │
        │ (云端OpenClaw)│        │  goals / reports  │
        └──────────────┘        │  events / meta    │
                                └────────┬──────────┘
                                         │ 读
              ┌──────────────────────────┼──────────────────────────┐
              ▼                          ▼                          ▼
        ┌──────────┐              ┌──────────┐              ┌──────────┐
        │ Agent-02  │              │ Agent-03 │              │  Agent-04  │
        │ 项目管理 │              │   营销   │              │ 研发测试 │
        └──────────┘              └──────────┘              └──────────┘
```

关键点：**Agent-01只写，其余只读**。四个 agent 共用一套字段名，谁都不能自创字段。

---

## 5. 数据契约

### 目标 Goal

```json
{
  "id": "g_w_1",
  "title": "客户验收：10 道问数题全部通过",
  "owner": "p_demo1",
  "level": "公司大目标 | 季度目标 | 月度计划 | 周目标",
  "parentId": "g_m_1",
  "status": "进行中 | 达成 | 未达成 | 延期 | 已放弃",
  "progress": 60,
  "note": "依赖谁 / 未达成原因",
  "placeholder": false
}
```

> ⚠️ `owner` 存储的是 **`personId`**（如 `p_demo1`），不是姓名。写入时传姓名会被服务端解析，读出来的都是 id。

两个**算出来**的语义字段（不是存储字段，接口返回时现算）：

- **`aligned`**：沿 `parentId` 一路向上，必须摸到 `level=公司大目标` 的节点。摸不到 = 偏离。这是「工作不偏离」的唯一机器判据。
- **`chain`**：从根节点到当前目标的完整标题数组。给 agent 用——让它不用自己爬树就能说清「这件事为什么重要」。

### 汇报 Report

```json
{
  "id": "r_xxx",
  "kind": "weekly | monthly",
  "cycle": "2026-W45 | 2026-11",
  "owner": "p_demo1",
  "fields": { "七要素…": "…" },
  "status": "草稿 | 已提交",
  "version": 1,
  "updatedAt": "ISO 时间"
}
```

`(owner, kind, cycle)` 三者唯一。

### 周报七要素

| 栏位 | 必填 | 收「无」 |
|---|---|---|
| 本周目标达成 | ✅ | ❌ |
| 本周结果 | ✅ | ❌ |
| 本周风险 | ✅ | ✅ |
| 下周目标 | ✅ | ❌ |
| 预期结果 | ✅ | ❌ |
| 潜在风险 | ✅ | ✅ |
| 所需援助 | ✅ | ✅ |

月报：`本月达成目标` `关键成果及链接` `Lesson Learned`（三项必填）+ `能力成长` `产品建议` `市场洞察` `开放项` `下月计划`。

### demo / live

顶层 `dataStatus` 为 `"demo"` 或 `"live"`。真实数据入库后置为 `live` 并移除各条 `placeholder`。

---

## 6. 数据库（2026-11-07 新增）

### 表结构：宽表 + JSON 列

| 表 | 主键 | 索引字段 | 说明 |
|---|---|---|---|
| `people` | `id` | - | 人员 |
| `agents` | `id` | - | Agent 名册 |
| `goals` | `id` | `parentId`, `owner` | 目标（四层） |
| `reports` | `id` | `owner`, `kind`, `cycle` | `(owner,kind,cycle)` 唯一 |
| `users` | `id` | - | 账号（passHash/salt/apiToken） |
| `events` | `id` | `subject_id` | 事件流水，同事务写入 |
| `meta` | `key` | - | 公司信息、`dataStatus` |
| `schema_migrations` | `version` | - | 迁移记录 |

所有业务表结构：`id TEXT PK, json TEXT, version INTEGER`

### 三条不可破坏的约束

**① 乐观锁** — `db.js` `updateRow()` 必须传 `expectedVersion`，不匹配抛 `VERSION_CONFLICT` → HTTP 409。
这是解决原 `fs.writeFileSync` 并发覆盖的核心。

**② 写操作走事务 + 事件**
```js
const update = db.transaction((id, version, next) => {
  const r = db.prepare(`UPDATE goals SET json=?, version=version+1
                        WHERE id=? AND version=?`).run(JSON.stringify(next), id, version);
  if (r.changes !== 1) throw new VersionConflictError();
  db.addEvent(id, 'goal.updated', next);   // 同事务
});
```

**③ 不要用大事务包住外部调用** — LLM 推理、HTTP 请求都不能放在 `transaction()` 里。

### pragma

```js
journal_mode = WAL      // 读写并发
busy_timeout = 5000     // 锁等待 5s
foreign_keys = ON
```

---

## 7. API（现状，2026-11-07 核对）

服务：`PORT=8787 node web/server.js`

### 读

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/data` | 看板全量（**周报、目标全员可见**） |
| GET | `/api/me` | 当前登录人 |
| GET | `/api/token` | 取自己的 apiToken |

### 写

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | `/api/login` | `{name, password}` → Set-Cookie `gos` |
| POST | `/api/logout` | - |
| POST | `/api/goals` | member 只能改自己的；admin/agent 可代写 |
| POST | `/api/goals/delete` | 同上 |
| POST | `/api/reports` | member 只能写自己；**agent 必须传 owner** |
| POST | `/api/profile` / `/api/password` | 改自己 |

### Agent 专用

**`POST /api/v1/context/assemble`**

```json
{ "goalId": "g_m_1", "query": "进展如何", "maxTokens": 8000 }
```

```json
{
  "goal": { "id": "...", "title": "...", "level": "...", "owner": "..." },
  "children": [{ "id": "...", "title": "...", "level": "..." }],
  "reports": [{ "owner": "...", "cycle": "...", "kind": "...", "summary": "..." }],
  "tokenEstimate": 145,
  "truncated": false,
  "generatedAt": "2026-11-07T..."
}
```

> ⚠️ **身份只来自 Cookie 或 Bearer**，请求体里的 `principalId` / `role` 一律不采信。

### ⚠️ 已废弃的旧接口

`/api/goals?owner=&level=`、`/api/reports?owner=&cycle=`、`/api/alignment`、`/api/save` —— 这些在迁移到 SQLite 时已不存在。旧文档里的相关描述全部作废。

---

## 8. 角色模型

| 角色 | 能读 | 能写 |
|---|---|---|
| 访客 | 公开结构 | ❌ |
| `member` | **全部目标 + 全部周报** | 只能写自己的 |
| `admin` | 全部 | 全部 + 人员/账号管理 |
| `agent` | 全部 | **可代任意员工写**，不能改密码和人员 |

### agent 账号

```bash
GOALOS_AGENT_PASS='***' node web/migrations/002_agent_account.js agent2 "Agent-02"
```

产出 `userId` / `apiToken`。**没有 `personId`**，因为它不是人。

### ⚠️ apiToken 永不过期

48 位 hex，拿到即等于该身份全权限。管理员 token 泄露 = 系统失守。
所以 `data.repo.json` 里剥离了它；`004_reset_password.js` 重设密码时会同步轮换 token。

---

## 9. 文件清单

| 路径 | 职责 | 改动影响 |
|---|---|---|
| `schema.json` | 数据模型唯一事实源（7 张表 43 字段） | 改字段名 = 断所有 agent |
| `service/policy.js` | 制度机器可读版：字段规格、缺口判定、纪律自检、周期计算 | 改这里就改变了追问行为 |
| `service/llm.js` | DeepSeek 抽取与追问措辞 | 提示词影响整理质量 |
| `service/brain.js` | 对话状态机（收集 → 定稿 → 确认） | 交互流程 |
| `service/smoke.js` | 离线对话验证 | 改提示词后跑这个 |
| `service/setup.js` | 按 schema 建飞书 Base | 公司推广的模板部署工具 |
| **`web/server.js`** | HTTP 入口、路由、鉴权（348 行） | 换存储只改 handler |
| **`web/lib/db.js`** | SQLite 封装：事务、乐观锁、事件表（316 行） | **DSH 独占** |
| **`web/lib/store.js`** | 业务存取层（343 行） | **DSH 独占** |
| **`web/lib/context.js`** | Context Assembly（134 行） | — |
| **`web/migrations/001-004`** | 迁移脚本 | 新建编号，别改老的 |
| `web/index.html` | 看板界面（~890 行单文件） | **Codex 独占** |
| `web/data.repo.json` | 剥离凭证的数据（可入库） | — |
| `web/data.json` | 运行时数据（**不入库**） | — |
| `Soda AI Guys/Agent-01/skills/goal-intake/SKILL.md` | Agent-01的录入技能 | 装到云端工作区才生效 |
| `AGENT-API.md` | 四个 agent 的接口契约 | — |
| `CONVENTIONS.md` | 多 agent 协作约定 | 改代码前必读 |
| `refs/policy-text.md` | 从 PDF 提取的制度全文 | 参考 |

---

## 10. 怎么跑

### 本地

```bash
git clone https://github.com/your-org/soda-ai-studio.git
cd soda-ai-studio
npm install
cp web/data.repo.json web/data.json       # 仓库里只有剥离凭证的版本
node web/migrations/001_init.js           # data.json → data.db
node web/migrations/004_reset_password.js Sam Lee 'your-password'   # 必须
PORT=8787 node web/server.js
```

### 离线验证对话引擎

```bash
node service/smoke.js
```

依赖：Node ≥ 18（线上 v22.16.0）；`better-sqlite3`；模型用 DeepSeek（key 从 `~/.dsh/.credentials.yaml` 或 `DEEPSEEK_API_KEY`）。

### 线上部署

| 项 | 值 |
|---|---|
| 主机 | `YOUR_SERVER_IP`（阿里云） |
| 目录 | `/opt/soda-goalos/` |
| 服务 | systemd `soda-goalos`，端口 8080 |
| nginx | `/etc/nginx/conf.d/goalos-ssl.conf`（80 跳 443 → 反代 8080） |
| 部署脚本 | `python deploy/ssh_run.py exec/put` |

```bash
# 发版
python deploy/ssh_run.py put web/server.js /opt/soda-goalos/server.js
python deploy/ssh_run.py exec "systemctl restart soda-goalos"
```

> ⚠️ **阿里云只允许 80/443 出网**。8091、8092、8080 从外网一律空 502。
> 需要新入口 → 加 nginx 路径，**不要开新端口**。

---

## 11. 界面现状与扩展点

界面用 oil-ui 的流程重做过一版，方向与理由写在 [DESIGN-UI.md](DESIGN-UI.md)。一句话：**把「对齐」做成一条竖直的对齐轴**——群目标在轴顶，线程沿轴展开，轴外的目标就是游离目标；全页唯一实心按钮是「接入对齐轴」。

**不要动**（动了四个 agent 全断）：

1. 字段名（七要素、`level` 的四个取值）
2. `aligned` / `chain` 的语义
3. `dataStatus` / `placeholder` 两个标记

**头像怎么换**：`people[].avatar` 和 `agents[].avatar` 填图片 URL 即生效；留空时用低饱和的姓名色盘。

**已知限制**：窄屏只验证到 492px；没有做独立 UX 走查；线程链条按深度优先拉平，多上级目标时会误读成串行。

---

## 12. 已知缺陷（按优先级）

### P0 · Context 超预算静默丢数据

`web/lib/context.js` 组装报告时：

```js
for (const r of visibleReports) {
  result.reports.push({...});
  if (estimateTokens(result) > maxTokens) { result.reports.pop(); truncated = true; break; }
}
```

**一超预算就 `break`，后面全丢，只标一个 `truncated: true`，不告诉 Agent 丢了什么。**

后果：周报变多后，Agent 会静默拿不到最新周报，还以为「本周没有汇报」。**它不会报错**，只会给出一个看起来正常但基于不完整信息的答案。

**建议修法**：按时间倒序 + 重要性排序后再裁剪，并明确返回「因预算丢弃了 N 条什么」。

### P1 · 数据仍是 demo

`dataStatus: "demo"`，目标全是占位。需接入真实目标后改 `live`。

### P1 · 周报「下周目标」不自动生成

周报写了「下周目标」，但不会自动落成下周期目标记录。这是云端 agent 的活。

### P2 · admin 之间无保护

两个 admin 可互相删。可加 superadmin。

### P2 · 移动端未验证

「每个人的目标」落地页刚切换，移动端没测。

---

## 13. 已知阻塞

| # | 阻塞 | 需要谁 | 具体动作 |
|---|---|---|---|
| 1 | Agent-01的 App 缺 `base:app:create`，建不了多维表格 | 管理员 | 控制台开通 base 全家桶权限 |
| 2 | 缺真实目标 | 涛哥 | 两三个公司大目标 |
| 3 | 缺人员汇报关系 | HR/你 | 姓名 + 汇报关系 + 每人用哪个 agent |
| 4 | Agent-01技能未上真机 | 运维 | `SKILL.md` 放进云端工作区，能访问 `$STORE` |

---

## 14. 多 agent 分工边界

| 谁 | 能改 | 不能碰 |
|---|---|---|
| **Codex** | `web/index.html`（**独占**） | 所有 server 侧 |
| **云端 Agent** | `server.js` 业务函数、周报闭环 | `index.html`、`lib/` |
| **DSH / Hermes** | `server.js` 鉴权路由、`lib/`、`deploy/` | `index.html` |
| **任何人** | 新建 migration | 改已执行的 migration 编号 |

硬规矩（详见 `CONVENTIONS.md`）：

1. 开分支 `feat/<谁>-<做什么>`，不直接推 main
2. 写库必须走 `store.js`，不要自己 `fs.writeFileSync`
3. `web/data.json` 和 `data.db` 永不入库
4. 推之前 `git pull --rebase`

---

## 15. 回滚

| 回滚什么 | 怎么做 |
|---|---|
| 生产数据 | `/opt/soda-goalos/data.json.backup-main-switch-20261107-120209` |
| 迁移前原始数据 | `/opt/soda-goalos/data.json.pre-migration-20261106` |
| 代码到 Phase 1 前 | `git checkout 1f9f295` |
| nginx | `cp /etc/nginx/conf.d/goalos-ssl.conf.bak-before-staging ...` |

---

## 16. 建议的下一步顺序

1. **修 P0 的 Context 截断缺陷** —— 现在是隐性的（周报 0 条触发不到），等员工开始交周报就会静默失效，且极难排查
2. **补真实目标 + 人员汇报关系**（阻塞 2、3）—— 哪怕只填涛哥两个目标和三个人
3. **Agent-01上真机**（阻塞 4），跑通第一条真实周报
4. 打通 `setup.js`（阻塞 1）
5. 再谈公司推广与「人—agent—目标—设备—制度」统一视图

---

## 17. 两个设计决策及其理由（别改坏了）

**① 模型负责理解语言，代码负责守规矩。**
缺口判定、必填校验、纪律自检、周期计算全在 `policy.js` 里用确定性逻辑做，模型只做抽取和措辞。起因：早期让模型判断「要素够不够」，它把「下周目标：10 道题全过」推断成「预期结果：10 道题全部通过」，直接把缺口填平了——那就是编造。现在纯否定回答（「无」）连模型都不进。

**② 周报的「下周目标」必须落成目标记录。**
如果只存成一段文本，下周的「本周回顾」就没有基准可对照，整套机制会退化成写作文。制度里说的「周报是承诺的凭据」，靠这一步才成立。

---

## 18. 架构设计文档

不在仓库，本地：`D:\DY\docs_output\soda-ai-studio-arch\`

| 文件 | 内容 |
|---|---|
| `Company-OS-完整方案-20261106.md` | 三份合并版 |
| `架构方案整理-20261106.md` | 核心抽象、六层记忆、权限模型 |
| `零填报机制设计-20261106.md` | 口述、采集、判断机制 |
| `工程实现设计-20261106.md` | 伪代码、Schema、设备契约、技术选型 |
| `Agent名册-现状与权限模型.md` | 四个 Agent 的权限现状 |
| `任务书-Phase1-SQLite迁移与ContextAPI.md` | Phase 1 原始任务书 |
