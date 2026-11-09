# 发布到插件市场（操作手册）

市场（[dshmarket](https://dshmarket.com)）的目录数据来自
`https://awesome-dsh-plugin.com/plugins.json`，而它是从 **GitHub 仓库 + npm 包**聚合出来的：
一条目录记录长这样（真实样例）：

```json
{
  "name": "dsh-empty-turn-guard",
  "owner": "nlflora",
  "url": "https://github.com/nlflora/dsh-empty-turn-guard",
  "category": "agi",
  "npm": "@nlflora/dsh-empty-turn-guard",
  "version": "0.1.0",
  "install": "dsh plugin --profile web add @nlflora/dsh-empty-turn-guard"
}
```

**结论：要让插件出现在市场里，需要两件事——(1) 包发布到 npm，(2) 有一个带 `dsh-plugin` topic 的
GitHub 仓库。** 目录会自己抓取，不需要你手改任何 registry 文件。

---

## 现在就绪的东西

- 包名 `dsh-cost-kline` 在 npm 上 **未被占用**（2026-11-09 查询返回 404）。
- `package.json` 已具备发布所需字段：`name` / `version` / `description`（中英） / `license` /
  `keywords`（含 `dsh-plugin`） / `files` / `engines` / `dsh.bundle` / `dsh.client`。
- `private` 已移除（否则 `npm publish` 直接拒绝）。
- `README.md`、`CHANGELOG.md`、`LICENSE`(MIT) 都在 `files` 白名单里。
- 已用 `npm pack` 打出可分发的 `.tgz`（见下文「打包」）。

## 打包

```bash
cd plugins/dsh-cost-kline
npm pack            # 产出 dsh-cost-kline-0.3.1.tgz
npm pack --dry-run  # 只看会打进包的文件清单
```

## 第 1 步：发布到 npm

```bash
npm adduser          # 或 npm login（需要一次性验证码时按提示走）
npm publish --access public
```

发布后验证：

```bash
npm view dsh-cost-kline version
npm view dsh-cost-kline keywords
```

> 如果 `dsh-cost-kline` 名字被人抢注了，改 `package.json` 的 `name`（比如 `@你的scope/dsh-cost-kline`）
> 再发布，并同步改本文档里的安装命令。

## 第 2 步：建 GitHub 仓库

```bash
cd plugins/dsh-cost-kline
git init
git add -A
git commit -m "feat: dsh-cost-kline 0.3.1 — 侧边栏花费 K 线卡片"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dsh-cost-kline.git
git push -u origin main
```

然后到仓库页面设置 **Topics**：加上 `dsh-plugin`、`deepseek-harness`、`dsh`。
（`dsh-plugin` 是目录抓取的关键标记，缺了它就不会被收录。）

建议同时在 GitHub 上打个 release，tag 用 `v0.3.1`，把 `dsh-cost-kline-0.3.1.tgz` 传上去。

## 第 3 步：等目录抓取

抓取是自动的，一般几分钟到一天内，页面出现在：

```
https://awesome-dsh-plugin.com/p/<你的用户名>/dsh-cost-kline/
```

确认已收录：

```bash
curl -s https://awesome-dsh-plugin.com/plugins.json | grep -o '"name":"dsh-cost-kline"' | head -1
```

如果几天都没收录，可以去 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> 提个 issue/PR
把仓库加进去，格式照抄上面那条样例。

## 第 4 步：在 DSH 里装

用户在插件市场里搜「花费 K 线」或 `cost-kline`，点安装即可；命令行等价于：

```bash
dsh plugin add dsh-cost-kline
```

装完重启 Harness。

## 后续发版

```bash
# 改代码 → 更新 version 和 CHANGELOG
npm version patch      # 0.3.1 → 0.3.2，自动打 tag
npm publish
git push --follow-tags
```

## 发布前自查清单

- [ ] `npm pack --dry-run` 的文件清单里没有多余的（`.tmp/`、截图、测试脚本都不该在 `files` 里）
- [ ] `node --check index.js && node --check client.js` 通过
- [ ] 装到干净 profile 里能出卡片（`dsh plugin add` 后重启）
- [ ] README 里写的安装命令与实际包名一致
- [ ] 版本号在 `package.json` 与 `index.js` 的 `VERSION` 常量里一致
