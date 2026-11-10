# 协作约定

多个 agent（云端 agent、Codex、本地 DSH、Hermes）共同维护这个仓库。目标不是「都能改」，而是**改完不互相踩**。

> ⚠️ **2026-11-06 起数据层已从 `data.json` 改为 SQLite。** 先读完下面「快速上手」再动手，否则会改到已经废弃的代码路径。

---

## 快速上手（新 agent 第一次接手的必做四步）

```bash
git clone https://github.com/your-org/soda-ai-studio.git
cd soda-ai-studio
git checkout feat/dsh-sqlite-context     # Phase 1 分支，未合并 main

npm install                              # 装 better-sqlite3
cp web/data.repo.json web/data.json      # 仓库里只有剥离凭证的版本
node web/migrations/001_init.js          # data.json → data.db
node web/migrations/004_reset_password.js Sam Lee 'your-password'   # 必须，否则登不进去
PORT=8787 node web/server.js
```

**为什么 `data.json` 不能直接用**：仓库里的 `data.repo.json` 已剥离 `passHash` / `salt` / `apiToken`，密码为空，必须重设。

---

## 目录结构（Phase 1 之后）

| 路径 | 作用 | 谁主改 |
|---|---|---|
| `web/server.js` | HTTP 入口、路由、鉴权 | DSH（鉴权/路由）、云端 agent（业务函数） |
| `web/lib/db.js` | SQLite 封装：事务、乐观锁、事件表 | **DSH 独占** |
| `web/lib/store.js` | 业务存取层（替代原 data.json 读写） | **DSH 独占** |
| `web/lib/context.js` | Context Assembly（Agent 拉上下文） | DSH |
| `web/index.html` | 单文件前端 | **Codex 独占** |
| `web/migrations/` | 一次性脚本，跑完不动 | 别改已有编号 |
| `deploy/ssh_run.py` | 部署脚本 | DSH |

**`web/index.html` 是单文件**，Codex 是唯一主力；其他人要动这一页，先打招呼或改成只动 server 侧。

---

## 硬规矩

1. **开分支，别直接推 main**：`feat/<谁>-<做什么>`，例如 `feat/cloud-weekly-rollover`、`feat/codex-mobile`。
2. **改 `server.js` 必须重启服务**，改 `index.html` 不用：
   ```
   systemctl restart soda-goalos
   ```
3. **`web/data.json` 与 `web/data.db` 不入库**（含密码哈希与长期 token）。
4. **提交信息**：`feat: …` / `fix: …` / `chore: …`，一句话说清改了什么，不要「update」。
5. **推之前先 `git pull --rebase`**，冲突自己解决，不要把冲突标记推上去。
6. **写数据库必须走 `store.js`，不要自己 `fs.writeFileSync`。** 乐观锁和事件记录都在里面，绕过去会重新引入并发覆盖问题。

---

## 数据层的关键约束（Phase 1 加的，别破坏）

| 约束 | 位置 | 说明 |
|---|---|---|
| **乐观锁** | `db.js` `updateRow()` | 更新必须传 `expectedVersion`，不匹配抛 `VERSION_CONFLICT` → HTTP 409 |
| **事件记录** | `db.js` `addEvent()` | 写业务对象同事务写 `events` 表，别绕过 |
| **PUBLIC_BASE_PATH** | `server.js` `BASE_PATH` 环境变量 | 挂在子路径（`/staging`）时用，本地开发不用设 |
| **周报/目标全员可见** | `server.js` `publicData()` | 这是**产品设计**，不是权限漏洞，别「修」回去 |

> ⚠️ 最后一条最容易误判：早期版本是「admin 全部 / member 见自己」，**已明确改为全员可见**（透明化是核心目标）。不要按旧的「最小权限」直觉改回过滤。

---

## 不要动

- `DESIGN-SYSTEM.md` 里定的色彩 token、字号层级、组件规格（要改先提案）
- `users[].passHash` / `salt` / `apiToken` 的生成逻辑（安全相关）
- 生产库 `/opt/soda-goalos/data.json`（要用接口或后台改，别手改文件）
- 已执行过的 `migrations/00X_*.js`（新建编号，别改老的）

---

## 部署

**主站**（8080）：
```
python deploy/ssh_run.py put web/index.html /opt/soda-goalos/index.html
python deploy/ssh_run.py exec "systemctl restart soda-goalos"
```

**Staging**（8092，走 `/staging/` 子路径）：
```
python deploy/ssh_run.py put web/server.js /opt/soda-goalos-staging/server.js
python deploy/ssh_run.py exec "cd /opt/soda-goalos-staging && kill \$(pgrep -f 'node server.js'|head -1); sleep 1; (PORT=8092 BASE_PATH=/staging nohup node server.js > /var/log/goalos-staging.log 2>&1 &)"
```

- 主站：https://your-domain.com/
- Staging：https://your-domain.com/staging/
- ⚠️ **阿里云只允许 80/443 出网**，非标端口从外部访问一律 502。需要新入口就加 nginx 路径，不要开新端口。

---

## 当前状态与待办

- [x] 数据层迁到 SQLite（Phase 1，见 `PHASE1-验证报告.md`）
- [x] 周报/目标全员可见
- [x] Context Assembly API（`POST /api/v1/context/assemble`）
- [x] `agent` 角色可代员工写周报
- [ ] **Context 超预算时直接 break，静默丢弃后续周报** ← 已知缺陷，待修
- [ ] 数据仍是 `dataStatus: "demo"`，需接入涛哥真实目标后改 `live`
- [ ] 周报「下周目标」尚未自动生成下周期目标记录（云端 agent 的活）
- [ ] admin 之间无保护（可加 superadmin）
- [ ] 「每个人的目标」落地页移动端尚未验证
- [ ] Phase 1 分支尚未合并 `main`
