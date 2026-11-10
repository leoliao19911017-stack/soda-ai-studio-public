---
name: agent-office-dashboard
description: "Use when building an agent status dashboard."
version: 1.0.0
---

# Agent Office Dashboard

把「每个 Agent 在干什么、进度到哪、卡在哪」变成一块人人可看的看板。

适用于：已经有一队 AI Agent 在干活（营销、客服、内容），但没人知道它们实际状态，只能靠人反复问。

## 它解决什么问题

没有看板时，Agent 的工作是黑箱：

- 老板问「那个稿子写完了吗」，得挨个去问 Agent
- Agent 卡住了没人知道，等到 deadline 才发现
- 出了事不知道是哪个环节错的
- 周末做总结靠回忆

看板把这三件事变可观测：**谁在做什么、做到哪一步、卡在什么上**。

## 数据模型

最小可用只需一张表：

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,           -- 显示名
  role TEXT NOT NULL,           -- 岗位，如 内容生产官
  status TEXT NOT NULL,         -- idle | working | blocked | offline
  current_task TEXT,            -- 正在做什么（一句话）
  progress INTEGER DEFAULT 0,   -- 0-100
  updated_at TEXT NOT NULL,     -- ISO8601
  avatar TEXT,                  -- 头像 URL，可空
  model TEXT,                   -- 用什么模型
  permissions INTEGER           -- 权限级别 L0-L4
);
```

**关键是 `updated_at`**。看板上超过 30 分钟没更新的 Agent 应该显灰——那通常意味着它卡住了或者挂了，而不是真的在思考。

## 状态机

四个状态，不要更多：

```
idle ──收到任务──> working ──完成──> idle
                     │
                     ├──遇到阻塞──> blocked ──解除──> working
                     └──进程挂了──> offline
```

`blocked` 必须带原因（`current_task` 写「等 Martin 确认部署参数」），否则这个状态没有意义。

## 接入方式

Agent 每做一步就推一次状态。两种方式：

**方式 A：HTTP 接口**（推荐，跨机器可用）

```bash
curl -X POST http://your-dashboard/api/agents/status \
  -H "Content-Type: application/json" \
  -d '{"id":"agent-1","status":"working","current_task":"写产品页文案","progress":40}'
```

**方式 B：直接写库**（同机器时更简单）

```python
import sqlite3, datetime
conn = sqlite3.connect('data.db')
conn.execute(
  "UPDATE agents SET status=?, current_task=?, progress=?, updated_at=? WHERE id=?",
  ('working', '写产品页文案', 40, datetime.datetime.now().isoformat(), 'agent-1'))
conn.commit()
```

## 关键设计决策（踩过的坑）

**看板只显示事实，不显示评价。** 「进度 40%」是事实，「进展良好」是评价。看板上的评价一律不可信，因为写它的是 Agent 自己。

**超时显灰比报警有用。** 不要做「超过 30 分钟没动就发消息」的告警，那会变成噪音。显示成灰色，人一眼就看见了。

**不要做权限隔离。** 看板的价值就是透明。加了「只看自己的」就等于回到黑箱。如果组织坚持要权限，那说明它还没准备好用 Agent。

## 常见坑

**SQLite 并发写。** 多 Agent 同时写会 `database is locked`。解法：

```python
conn = sqlite3.connect('data.db', timeout=10)
conn.execute('PRAGMA journal_mode=WAL')
```

WAL 模式允许读写并发。timeout 给足 10 秒。

**Node 装 better-sqlite3 失败。** 需要编译原生模块，中国网络必须走代理：

```bash
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
npm install better-sqlite3
```

**端口冲突。** 8080 经常被别的服务占。默认改 8787。

**Agent 不上报就一片空白。** 接入时先做一个「心跳」：每个 Agent 即使没任务也每 5 分钟上报一次 `idle`。这样至少能看出谁活着。

## 验证装好了

```bash
# 1. 服务起来
curl http://127.0.0.1:8787/health

# 2. 能写状态
curl -X POST http://127.0.0.1:8787/api/agents/status \
  -H "Content-Type: application/json" \
  -d '{"id":"test","status":"working","current_task":"测试"}'

# 3. 能读回来
curl http://127.0.0.1:8787/api/agents
```

三步都返回 200 才算装好。

## 参考实现

完整代码：`github.com/your-org/soda-ai-studio`

技术栈：Node.js + Express + SQLite + 原生前端（无构建步骤）。
关键文件：
- `web/server.js` — 路由与鉴权
- `web/lib/db.js` — 数据层，带乐观锁
- `web/lib/store.js` — 写库统一入口
- `web/migrations/` — 建表脚本
