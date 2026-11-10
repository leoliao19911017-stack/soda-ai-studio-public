# Agent Office — 给 AI 团队用的目标与周报系统

一队 AI Agent 在干活，但你不知道它们实际在干什么。这套系统解决的就是这个。

两块看板：

**Agent Office** — 每个 Agent 在做什么、进度到哪、卡在什么上。

**Team Reports** — 每个人的周报月报，挂在公司目标上，全员可见。

---

## 为什么需要它

**没有看板时**，你的 Agent 团队是黑箱：

- 老板问「那个稿子写完了吗」，得挨个去问 Agent
- Agent 卡住了没人知道，等到 deadline 才发现
- 出了事不知道是哪个环节错的
- 做总结靠回忆

**没有周报系统时**，目标对不上：

- 周报写完发群里，三天后翻不到
- 和季度目标对不上，年底发现方向偏了
- 领导要汇总时，靠人一份份复制粘贴

---

## 核心设计（别的实现常常搞错的三点）

**1. 周报全员可见。**

这是设计，不是漏洞。

几乎所有组织第一次看到这个系统都会说「应该加权限，只能看自己的」。**不要加。**

周报的价值在于横向对齐——你知道隔壁组在做什么，才能避免重复劳动、才能主动配合。一旦变成只能看自己的，它就只是个归档工具，失去了 90% 的价值。

如果组织对透明有顾虑，那是管理问题，不是技术问题。

**2. 看板只显示事实，不显示评价。**

「进度 40%」是事实，「进展良好」是评价。看板上的评价一律不可信，因为写它的是 Agent 自己。

**3. 超时显灰比报警有用。**

不要做「超过 30 分钟没动就发消息」的告警，那会变成噪音。显示成灰色，人一眼就看见了。

---

## 快速开始

```bash
git clone https://github.com/your-org/soda-ai-studio.git
cd soda-ai-studio
npm install
```

中国网络装原生模块必须走代理：

```bash
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
npm install
```

配置环境变量：

```bash
export GOALOS_DEFAULT_PASS='你的初始密码'   # 必填，无默认值
export PORT=8787                           # 默认 8787，8080 常被占用
```

初始化管理员：

```bash
node web/migrations/004_reset_password.js admin 'YOUR_PASSWORD'
npm start
```

打开 `http://127.0.0.1:8787`。

---

## 数据模型

```
公司目标 (company)
    └── 季度重点 (quarter)
            └── 月度计划 (month)
                    └── 个人目标 (person)
                            └── 周报 (report) ── 声明推进了哪个目标
```

四张核心表：

| 表 | 作用 |
|---|---|
| `people` | 人员 |
| `agents` | Agent 名册与状态 |
| `goals` | 目标树，带 `parent_id` 指向上级 |
| `reports` | 周报 / 月报 |

建表脚本在 `web/migrations/`，按编号顺序执行。

---

## 接入你的 Agent

Agent 每做一步就推一次状态：

```bash
curl -X POST http://127.0.0.1:8787/api/agents/status \
  -H "Content-Type: application/json" \
  -d '{"id":"agent-1","status":"working","current_task":"写产品页文案","progress":40}'
```

状态只有四个：`idle` / `working` / `blocked` / `offline`。

`blocked` 必须带原因，写在 `current_task` 里（如「等 Martin 确认部署参数」），否则这个状态没有意义。

---

## 已知缺陷

**Context 超预算静默丢数据。**

`web/lib/context.js` 组装「给 Agent 看的上下文」时，超过 token 预算直接 `break`，后面全丢，只标一个 `truncated: true`，不告诉 Agent 丢了什么。

后果：Agent 拿不到最新周报，以为「本周没人汇报」，给出看起来正常但基于不完整信息的答案。**它不会报错。**

修法见 `skills/team-weekly-reports/SKILL.md`。

---

## 配套 Skill

仓库 `skills/` 下有两份 skill，可以直接装进 Hermes：

- `agent-office-dashboard` — 怎么给团队搭 Agent 看板
- `team-weekly-reports` — 怎么搭周报系统

```bash
cp -r skills/agent-office-dashboard ~/.hermes/skills/productivity/
cp -r skills/team-weekly-reports ~/.hermes/skills/productivity/
```

---

## 技术栈

Node.js + Express + SQLite + 原生前端（无构建步骤）。

- `web/server.js` — 路由与鉴权
- `web/lib/db.js` — 数据层，带乐观锁
- `web/lib/store.js` — 写库统一入口
- `web/lib/context.js` — 上下文组装
- `web/migrations/` — 建表脚本

**乐观锁**：多人（和 Agent）可能同时改同一条记录，用 `version` 字段防覆盖，`UPDATE ... WHERE id=? AND version=?`，`changes === 0` 就报冲突。

---

## 部署

```bash
sudo systemctl enable your-service
sudo systemctl start your-service
```

nginx 反代到 8787，只放行 80/443。云上开新端口通常会被安全组挡住。

---

## License

MIT
