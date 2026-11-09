# Changelog

## 0.3.1

- 打包发布准备：补齐 `license` / `keywords` / `engines`，去掉 `private`，加入 LICENSE 与 CHANGELOG。
- 侧边栏卡片铺满侧边栏宽度（`width:100%` + 更稳的容器测量），迷你 K 线不再被压窄。
- 修复浮窗标题栏 `—` / `×` 点击无效：根因是 `setPointerCapture` 把后续 click 重定向到标题栏；
  改为 window 级拖拽监听，不再捕获指针。收起后的图标由 `▢` 换成 `+`（部分字体缺字形）。
- `GET /dsh-cost-kline/state` 增加 `version` 字段，便于排障时先确认装的哪一版。

## 0.3.0

- 新增侧边栏底部常驻卡片（插槽 `sidebar.footer.action`），卡片与浮窗共用一条轮询。
- 浮窗改为按需显示：卡片右上角 `⤢` 打开，`×` 收回。
- 图表支持紧凑模式（`compact` / `bodyH` / `volH` / `axisH` / `padLeft`），宽度自适应容器。
- 样式改为浅色优先 + `body[data-ds-dark-theme]` 深色覆盖，跟随 DSH 主题。

## 0.2.0

- 新增账户余额显示：来自 `ctx.get('deepseekAccount')`，60 秒缓存，点击强制刷新，标注峰/谷时段。
- 新增接口 `GET /dsh-cost-kline/balance`、`POST /dsh-cost-kline/balance/refresh`。
- 账号服务不可用时降级为「不可用」，不影响 K 线。

## 0.1.0

- 首个可用版本：监听 `session/event` 记录 token 用量，按单价表折算金额并落盘。
- `shell.overlay` 浮窗 K 线图：每分钟花费聚合 → 1/3/5/15/60 分钟分桶，红涨绿跌，下方 token 成交量柱，5 周期均线。
- 接口 `GET /dsh-cost-kline/state`、`POST /dsh-cost-kline/reset`。
