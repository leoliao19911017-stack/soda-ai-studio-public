# Phase 1 验证报告

> 分支：`feat/dsh-sqlite-context`
> 提交：`dd37301`
> 执行：dsh（代码）+ Hermes（依赖安装、验收执行、缺陷定位）
> 验证人：Sam Lee 账号
> 日期：2026-11-06

---

## 结论

**15 / 15 项验收全部通过。**

核心目标达成：`data.json` 单文件覆盖问题已解决，并发写现在会正确返回 409 冲突而不是互相覆盖；Context Assembly API 可用且权限正确。

---

## 一、代码规模

| 文件 | 行数 | 作用 |
|---|---|---|
| `web/lib/db.js` | 316 | SQLite 封装、事务、乐观锁、事件 |
| `web/lib/store.js` | 335 | 业务存取层（替代原 data.json 读写） |
| `web/lib/context.js` | 140 | Context Assembly |
| `web/migrations/001_init.js` | 218 | 迁移脚本（幂等、自动备份、数据体检） |
| `web/test/phase1.test.js` | 261 | dsh 自带的验收脚本 |
| `web/server.js` | 367 → 330 | 路由接数据层，净减 137 行 |
| **合计新增** | **1,270 行** | |

> 无任何 ORM，唯一依赖 `better-sqlite3`。

---

## 二、迁移实测输出

```
[001_init] 驱动：better-sqlite3
[001_init] 已备份：web\data.json.bak-2026-11-06-131127408
[001_init] 数据体检：
[001_init]   重复 ID：0
[001_init]   孤立 parentId：0
[001_init]   重复 (owner,kind,cycle)：0
[001_init]   日期/周期格式异常：0
[001_init] 迁移前后条数对比（data.json → SQLite）：
[001_init]   people      8 →    8
[001_init]   agents      4 →    4
[001_init]   goals       7 →    7
[001_init]   reports     1 →    1
[001_init]   users       8 →    8
[001_init] OK：五张表条数与 data.json 完全一致
```

**数据体检 0 异常，条数完全一致。**

---

## 三、验收逐项结果

```
Phase 1 验收 @ http://127.0.0.1:8787

PASS  GET /api/data 200  — HTTP 200
PASS  goals 数量 = 7  — 7
PASS  people 数量 = 8  — 8
PASS  publicData 结构（people/agents/goals/reports）  — people,agents,goals,reports,me,levels,loggedIn
PASS  未登录 Context API 应 401  — HTTP 401
PASS  POST /api/login 成功  — HTTP 200 token=yes
PASS  Context API 200  — HTTP 200
PASS  返回含 goal 字段  — {"goal":{"id":"g_company_1","title":"把 SODA 做成客户愿意持续付费的 AI 交付业务",...}}
PASS  返回含 tokenEstimate  — 145
PASS  小预算触发 truncated  — truncated=true
PASS  不存在 goalId 应 404  — HTTP 404
PASS  并发写：不双双成功  — 成功=1 冲突=1 状态码=200,409 目标=g_m_1
PASS  冲突返回 409  — 状态码=200,409
PASS  SQLite events 表存在
PASS  SQLite goals 行数=7

===== 15/15 通过 =====
```

### 关键项：并发写

```
两个请求同时 PATCH 同一个 goal（同一 version）：
  → 请求 A: HTTP 200  ✅ 成功
  → 请求 B: HTTP 409  ✅ 冲突被拦截
```

**这正是原 `fs.writeFileSync` 做不到的。**

### events 表实测

```
goal.upsert | g_m_1 | {"actor":"p_demo1","action":"update","owner":"p_demo1","progress":50,...}
```

写入目标时会同步记录事件，可用于后续审计与工作采集。

---

## 四、执行过程中发现并解决的问题

### 1. `better-sqlite3` 原生编译失败（阻塞级）

```
gyp ERR! find VS — Could not find any Visual Studio installation
gyp ERR! prebuild-install warn install Request timed out
```

**原因**：本机无 VS Build Tools，且预编译包下载超时（网络）。
**解决**：走代理 `127.0.0.1:7897` 重新安装，预编译包下载成功，2 秒装完 38 个包。

> ⚠️ **部署到服务器时需要同样的网络条件**，或者服务器上预装编译环境。这是运维须知。

### 2. 权限拦截被误判为缺陷

初次并发测试返回双 400。排查后确认：**Sam Lee 是 member，只能改自己的目标**，测试用了 `p_yu`（Alex Chen）的目标，被正确拒绝。改用 Sam Lee 自己的 `g_m_1` 后通过。

> 这其实证明权限校验是有效的。

### 3. 测试脚本自身两处错误（非产品缺陷）

- 从 Node `fetch` 读 `Set-Cookie` 读不到（fetch 不暴露该头）→ 改用 `http` 模块
- 断言写成 `conflict === 1` 但统计逻辑重复计数 → 修正

---

## 五、未完成 / 需注意

| 项 | 状态 | 说明 |
|---|---|---|
| 前端验证 | ❌ 未做 | **按约定 `index.html` 由 Codex 负责，本次未改也未测** |
| 生产部署 | ❌ 未做 | 代码只在本地分支，**未推远端、未部署线上** |
| Delegation 权限 | ❌ 未做 | 本期明确排除，Context API 只做基础 ACL |
| L2 个人记忆隔离 | ❌ 未做 | 同上 |
| 向量检索 | ❌ 未做 | 按方案决定，暂不引入 |
| Windows 防火墙/代理 | ⚠️ 需确认 | 服务器上 `npm install` 是否需要代理 |

---

## 六、测试对数据的改动

验收过程中测试写入了 Sam Lee 的目标（`g_m_1` 标题被改为 `-A-A`）。**已通过删除 `data.db` 重新迁移完全还原**，当前库与 `data.json` 一致。

原始 `data.json` **自始至终未被修改**（时间戳仍是 18:03），备份文件保留在同目录。

---

## 七、如何自行复现

```bash
cd "C:\Users\Administrator\Desktop\Sample Corp - AI Native Thinking\goal-os"

# 1. 装依赖（需要代理）
export HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897
npm install

# 2. 迁移
node web/migrations/001_init.js

# 3. 起服务（一个终端）
PORT=8787 node web/server.js

# 4. 跑验收（另一个终端）
node web/test/phase1.test.js
```

> `web/test/phase1.test.js` 是 dsh 自带的脚本；我另写的自包含版本在
> `C:\Users\Administrator\AppData\Local\hermes\cache\scratch\verify_phase1.js`
> （自己起服务、跑完自动关，不需要开两个终端）。
