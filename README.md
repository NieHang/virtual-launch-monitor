# Virtual Launch Monitor

一个单进程 Telegram Bot，并可选接入企业微信群机器人，用于监控 Virtuals 在 Base、Robinhood Chain 和 Solana 上的新代币发射。

## 核心功能

- 每秒监听 Base 和 Robinhood Chain 的 Virtuals 发射合约事件；Solana 发射通过官方 API 轮询捕获。
- 链上捕获 Token 后，优先从发射交易解析项目 ID 并直读详情；无法解析时按 Token 地址反查，官方最新列表仅作为最终兜底。
- 只对“刚发射且项目自身 `socials.VERIFIED_LINKS.TWITTER` 存在”的项目发送自动通知。
- 每个新发射项目查询 Frontrun Top 20；命中结果会缓存，首次查询未命中时会在 15 秒后再查一次，每个项目总共最多查询 2 次。Smart Followers 最终仍为 0 时不通知，大于 0 时发送重要提醒，Top 20 命中 Virtual 官方人员时发送最高提醒。
- 启动时的最新页只建立基线，绝不补发历史项目。
- 启动基线中尚未到发射时间的计划项目会保留待发射状态，真正发射时仍会正常通知。
- 即使旧项目在服务启动后才被官方列表索引，也只登记、不补发。
- 未见过但已经超过 5 分钟的项目只登记、不通知。
- Telegram 用户可以开启、暂停通知，并选择 Base/Robinhood/Solana 网络。
- 企业微信通道只推送 Top 20 命中 V 官方人员关注的项目，不推送普通 Smart Followers 项目。
- “查询 Upcoming”按钮按需读取 Launch Radar，只返回项目概要和 Virtuals 项目详情页链接。
- SQLite 保存用户状态、已见项目和通知去重记录，无需 PostgreSQL。

## 运行

要求 Node.js 22+ 和 pnpm。

```powershell
pnpm install
Copy-Item .env.example .env
# 在 .env 中填写 TELEGRAM_BOT_TOKEN、FrontRunKey；需要微信推送时再填写 WECOM_WEBHOOK_URL
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
- `/chains base robinhood solana`：选择网络，也可使用 `/chains all`。
- “查询 Upcoming”：实时查询一次 Launch Radar。
- `/status`：查看当前状态。
- `/test`：测试 Telegram 收发。
- `/search <代币CA>`：查询 Virtuals 项目，返回与自动通知相同的信息格式。

“查询 Upcoming”会在每次点击时重新查询每个项目的 Frontrun Top 20；`/search` 和自动发射通知会复用数据库中已经保存的单次查询结果，避免重复消耗 API Credits。
- `/tax <代币CA>`：从代币发射区块扫描到“发射后 98 分钟”或当前最新区块（取较早者），只累计与该代币交易关联、且转入固定税收地址的 VIRTUAL；后续查询采用 SQLite 增量扫描。
- `/efdv <代币CA>`：从最新区块直接读取 Bonding/毕业后 LP 储备、代币总供应量、Pair 的 `taxStartTime`、BondingV5 的税率类型和链上持续时间，返回当前 FDV；反狙击税仍有效时同时返回真实 eFDV，结束后直接返回 FDV。

真实 eFDV 不使用官网缓存的 `fdvInVirtual`。计算口径为：

```text
链上 FDV = totalSupply × VIRTUAL reserve ÷ token reserve
真实 eFDV = 链上 FDV × 100 ÷ (100 - 当前总买入税率)
```

当前税率按合约 Router 的实际逻辑计算：以最新区块时间减去 Pair 的 `taxStartTime`（旧 Pair 回退到 `startTime`），再结合 `BondingConfig.getAntiSniperDuration(type)` 线性递减。不同类型可以是 60 秒、600 秒或 98 分钟，不能统一按官网倒计时或固定 98 分钟推断。

## 企业微信

在企业微信群中添加“群机器人”，复制 Webhook 地址并写入 `.env`：

```dotenv
WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的机器人key
```

重启服务后生效。该通道独立于 Telegram 用户状态，只在 Frontrun 返回结果已解析完成且 `virtualOfficials` 非空时入队；同一项目只发送一次，失败会自动重试。通知使用纯文本格式，兼容企业微信“微信插件”在普通微信客户端中直接显示。未配置 Webhook 时不会积压微信历史消息。

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
- 企业微信待发送、失败重试和已发送通知。

## 低延迟 RPC

默认配置使用 Base 与 Robinhood Chain 的公共 RPC。公共端点适合本地测试，但存在限流和稳定性风险；正式长期运行时，请在 `.env` 中把 `BASE_RPC_URL` 和 `ROBINHOOD_RPC_URL` 替换为 Alchemy、QuickNode 等服务商的专用端点。`CHAIN_POLL_MS=1000` 通常能在新区块出现后约 1 秒内捕获 EVM 发射事件；Solana 使用 `OFFICIAL_API_POLL_MS` 配置的官方 API 轮询周期。

备份或迁移时复制该文件即可。
