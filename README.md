# Virtual Launch Monitor

一个单进程 Telegram Bot，用于监控 Virtuals 在 Base 和 Robinhood Chain 上的新代币发射。

## 核心功能

- 每秒监听 Base 和 Robinhood Chain 的 Virtuals 发射合约事件。
- 链上捕获 Token 后，优先从发射交易解析项目 ID 并直读详情；无法解析时按 Token 地址反查，官方最新列表仅作为最终兜底。
- 只对“刚发射且项目自身 `socials.VERIFIED_LINKS.TWITTER` 存在”的项目发送自动通知。
- 启动时的最新页只建立基线，绝不补发历史项目。
- 即使旧项目在服务启动后才被官方列表索引，也只登记、不补发。
- 未见过但已经超过 5 分钟的项目只登记、不通知。
- Telegram 用户可以开启、暂停通知，并选择 Base/Robinhood 网络。
- “查询 Upcoming”按钮按需读取 Launch Radar，只返回项目概要和 Virtuals 项目详情页链接。
- SQLite 保存用户状态、已见项目和通知去重记录，无需 PostgreSQL。

## 运行

要求 Node.js 22+ 和 pnpm。

```powershell
pnpm install
Copy-Item .env.example .env
# 在 .env 中填写 TELEGRAM_BOT_TOKEN
pnpm test
pnpm build
pnpm start
```

开发模式：

```powershell
pnpm dev
```

健康检查：

```text
http://127.0.0.1:3000/health
```

## Telegram

- `/start`：显示菜单。
- “开启通知”：从此刻开始接收新的合格发射通知，不补发历史。
- `/pause`：暂停自动通知。
- `/resume`：恢复自动通知。
- `/chains base robinhood`：选择网络，也可使用 `/chains all`。
- “查询 Upcoming”：实时查询一次 Launch Radar。
- `/status`：查看当前状态。
- `/test`：测试 Telegram 收发。
- `/tax <代币CA>`：从代币发射区块扫描到“发射后 98 分钟”或当前最新区块（取较早者），只累计与该代币交易关联、且转入固定税收地址的 VIRTUAL；后续查询采用 SQLite 增量扫描。
- `/efdv <代币CA>`：从最新区块直接读取 Bonding/毕业后 LP 储备、代币总供应量、Pair 的 `taxStartTime`、BondingV5 的税率类型和链上持续时间，返回当前 FDV；反狙击税仍有效时同时返回真实 eFDV，结束后直接返回 FDV。

真实 eFDV 不使用官网缓存的 `fdvInVirtual`。计算口径为：

```text
链上 FDV = totalSupply × VIRTUAL reserve ÷ token reserve
真实 eFDV = 链上 FDV × 100 ÷ (100 - 当前总买入税率)
```

当前税率按合约 Router 的实际逻辑计算：以最新区块时间减去 Pair 的 `taxStartTime`（旧 Pair 回退到 `startTime`），再结合 `BondingConfig.getAntiSniperDuration(type)` 线性递减。不同类型可以是 60 秒、600 秒或 98 分钟，不能统一按官网倒计时或固定 98 分钟推断。

## Virtual 官方 X 关注检测

在 `.env` 中配置 X Developer App 的 App-only Bearer Token：

```dotenv
X_BEARER_TOKEN=你的_X_API_BEARER_TOKEN
```

- 新发射项目只检测一次，并把第一次检测快照保存到 SQLite；服务重启后不会重复检测。
- 8 名 Virtual 官方人员中只要有一人关注项目，Telegram 消息就会标记为“重点关注”。
- “查询 Upcoming”每执行一次都会重新检测本次 Launch Radar 项目，并把重点项目排在前面。
- X API 查询失败时显示“未知”，不会错误显示为 `0/8`。
- X API 按量计费；请在 X Developer Console 中设置合理的消费上限。

## Telegram 白名单

三名用户继续共用同一个 Bot Token。将允许使用 Bot 的 Telegram Chat ID 写入 `.env`：

```dotenv
TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321,1122334455
```

变量为空时不限制用户；填写后，只有名单内用户能注册、查询 Upcoming 或开启通知。未授权用户发送消息时会收到自己的 Chat ID，但不会写入 SQLite。修改白名单后需要重启服务。

## 数据文件

默认数据库为 `data/monitor.sqlite`。它保存：

- Telegram chat ID、开启/暂停状态和网络选择；
- 已经见过的 Virtuals 项目；
- 待发送、失败重试和已发送通知。

## 低延迟 RPC

默认配置使用 Base 与 Robinhood Chain 的公共 RPC。公共端点适合本地测试，但存在限流和稳定性风险；正式长期运行时，请在 `.env` 中把 `BASE_RPC_URL` 和 `ROBINHOOD_RPC_URL` 替换为 Alchemy、QuickNode 等服务商的专用端点。`CHAIN_POLL_MS=1000` 通常能在新区块出现后约 1 秒内捕获发射事件。

备份或迁移时复制该文件即可。
