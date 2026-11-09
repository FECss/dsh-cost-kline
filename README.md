# dsh-cost-kline

**在 DeepSeek Harness 里实时看到你的花费，画成股票一样的 K 线图。**

Real-time cost of your DeepSeek Harness sessions, drawn as a candlestick chart.

---

## 它做了什么

- **Host 侧**（`index.js`）：监听 `session/event`，从每条 `assistant/message` 的 usage 里取 token 数
  （`inputTokens` 未命中缓存、`cacheReadTokens` 命中、`cacheWriteTokens` 写入、`outputTokens` 输出），
  按单价表折成人民币，记进账本并落盘；在 `ctx.webServer` 上注册 HTTP 路由。
- **浏览器侧**（`client.js`）：注册两个插槽——侧边栏底部常驻卡片 `sidebar.footer.action`（主界面）与
  `shell.overlay` 浮窗（详情，默认收起）。两者共用一条 2.5 秒轮询，不会重复请求。

## 界面在哪

- **侧边栏底部**（设置之上）：一张卡片，显示今日金额、余额、峰谷标注和一条迷你 K 线；
  侧边栏收起成窄轨道时只留一个 💰 图标。
- 点卡片右上角 **⤢** 打开完整浮窗（可拖拽、可切换 1/3/5/15/60 分钟周期、悬停看 tooltip）；
  浮窗右上角 `—` 收起，`×` 关闭回到卡片。
- 卡片常驻，浮窗开关不影响它。

## 图怎么读

- 每根 K 线的纵轴是**该时段每分钟的花费金额（¥/分）**：
  `open` = 该时段第一分钟的花费，`close` = 最后一分钟的花费，`high`/`low` = 时段内最高/最低的那一分钟。
- **红**=时段末尾比开头烧得快，**绿**=变慢，灰=持平。
- 下方细柱是**该时段的 token 用量**（成交量）。
- 黄线是 `close` 的 5 周期均线。
- 顶部是累计金额、今日花费、近 1 小时花费和缓存命中率。
- **余额**来自 DSH 账号服务（`ctx.get('deepseekAccount')`），点一下即可强制刷新（其余时间 60s 缓存）；
  「峰时/谷时」按 DeepSeek 官方时段（北京时间 00:30–08:30 谷时）标注。
  账号服务不在场时显示「不可用」，不影响 K 线。

## 安装

来自插件市场（发布到 npm 之后）：

```bash
dsh plugin add dsh-cost-kline
```

从本地目录安装（开发者）：

```bash
dsh plugin add /path/to/dsh-cost-kline
```

装完重启 Harness（或让它重载该 bundle）即可在侧边栏底部看到卡片。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-cost-kline/state` | 全量状态（合计、按模型、按会话、原始样本、余额） |
| GET | `/dsh-cost-kline/balance` | 只取余额（含各币种充值/赠送拆分） |
| POST | `/dsh-cost-kline/balance/refresh` | 强制刷新余额（绕过 60s 缓存） |
| POST | `/dsh-cost-kline/reset` | 清空账本 |

账本落盘在 `$DSH_PROFILE_DIR/dsh-cost-kline/ledger.json`（没有 profile 时落 `$DSH_HOME`）。

## 单价（可改）

默认值在 `cordis.patch.yml` 的 `config.prices`（**每 100 万 token 的人民币价**）：

| 字段 | 含义 | 默认 |
| --- | --- | --- |
| `cacheHit` | 命中缓存的输入 | 0.2 |
| `cacheMiss` | 未命中缓存的输入 | 2 |
| `cacheWrite` | 写缓存 | 2 |
| `output` | 输出（含推理） | 3 |

`prices` 是「模型名子串 → 单价」的表，`default` 兜底。你可以按自己的 profile 覆盖：

```yaml
- insert:
    - id: dsh-cost-kline
      name: dsh-cost-kline
      config:
        currency: CNY
        prices:
          default: { cacheHit: 0.2, cacheMiss: 2, cacheWrite: 2, output: 3 }
          "deepseek-reasoner": { cacheHit: 1, cacheMiss: 4, cacheWrite: 4, output: 16 }
```

> **这是估算，不是官方账单。** 官方扣费以 DeepSeek 平台为准。

## 兼容性

- 需要 `ctx.webServer`（所有 profile 都有）。
- 余额是**可选**能力：没有 `deepseekAccount` 服务时只显示「不可用」，其余功能照常。
- 纯前端无外部依赖，不联网、不上传任何数据；账本只写本地文件。

## 许可

MIT
