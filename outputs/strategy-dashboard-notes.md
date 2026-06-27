# 人气趋势策略 Web 看板说明

本地入口：http://127.0.0.1:4173

## 已实现

- 按日期查看每日策略候选股票。
- 查看当日推荐板块 / 行业聚合。
- 展示 5 日、10 日、20 日后的回测表现；未到期数据显示为“未到期”。
- 支持手动输入股票代码和日期，验证买入后 1-5 天、1 周、2 周收益。
- 支持从每日候选股表格点击“验证”，自动带入股票代码和信号日期。
- 支持股票信号查询：输入股票代码或名称，查看历史是否被当前策略选中过，并可跳转到对应信号日高亮该股票。
- 支持切换策略模式：早期发现 / 热门确认。
- 候选股展示交易标签：上交所/深交所/北交所、主板/科创板/创业板、10%/20%/30%涨跌幅、新股/次新股、上市初期无涨跌幅。
- 候选股展示信号提示：波段首次、波段延续、个股已加速、板块偏热、等待二次确认、已二次确认。
- 顶部新增信号提示统计：首次/延续、观察池、过热提示、二次启动。
- 顶部核心指标和信号提示均带 `?` 说明，悬停可查看含义和计算口径。
- 日期选择接入本地 A 股交易日历：交易日无候选时显示 0 候选，休市日才回退到相邻交易日，并展示上一个/下一个信号日。
- 支持切换人气数据源：东方财富历史人气 / 同花顺本地积累；同花顺统一文件路径预留为 `outputs/ths-popularity-strategy-candidates.csv`。
- 支持过滤伪板块，例如昨日涨停、季报预增、基金重仓、融资融券等。
- 历史日期轴可点击回看曾经的每日推荐。

## 信号提示规则

- `波段首次`：同一股票超过 15 天未触发后重新触发。
- `波段延续`：同一股票在 15 天内再次触发。
- `个股已加速`：个股近 5 日涨幅不低于 20%。
- `板块偏热`：板块近 5 日涨幅不低于 12%。
- `等待二次确认`：延续信号、个股已加速或板块偏热时进入观察池。
- `已二次确认`：进入观察池后，出现回踩再重新走强。

## 策略模式

- `早期发现`：个股人气 400-1200 上移 + 个股温和放量 + 板块 5 日 3%-15% + 板块量能 1.2-2.0，用于提前发现从冷门区升温的股票。
- `热门确认`：个股进入人气前 100 + 相对 20 日前上移至少 300 名 + 个股量能 0.8-3.5 + 个股 5 日涨幅不超过 35%，用于确认已经进入热门区的趋势股。
- 热门确认策略第一版按个股和行业聚合，不强制使用板块涨幅过滤；后续可接入 `board-kline` 做增强。

## 当前数据

- 历史验证样本：`outputs/em-popularity-sector-filter-sweet-spot-events.csv`
- 热门确认样本：`outputs/em-popularity-backtest-events.csv`
- 最近候选样本：`outputs/latest-one-month-strategy-candidates.csv`
- 同花顺本地积累样本：`outputs/ths-popularity-strategy-candidates.csv`，当前未生成时页面显示“尚未积累”。
- 股票元信息缓存：`work/cache/strategy-dashboard/stock-meta.json`
- 严格过滤后样本：453 条
- 日期范围：2025-09-26 至 2026-06-26

## 本地运行

```bash
node work/strategy-dashboard/server.js
```

刷新股票元信息：

```bash
node work/strategy-dashboard/refresh-stock-meta.js
```

## API

```text
GET /api/overview
GET /api/daily?date=2026-06-26&strict=true&source=em&strategy=early
GET /api/timeline?strict=true&source=em&strategy=hot
GET /api/stock-signals?q=688519&strict=true&source=em&strategy=early
GET /api/position?code=605178&date=2026-06-24&entry=nextOpen
```

买入方式：

- `nextOpen`：信号次日开盘，默认值，适合复盘每日推荐。
- `close`：当日收盘。
- `open`：当日开盘。

## 下一步线上化

- 把 CSV 文件换成 SQLite 表：`ranking_signal`、`board_signal`、`signal_result`。
- 每天收盘后跑一次策略，写入当天候选。
- 每天更新 5/10/20 日后的表现，自动回填命中结果。
- VPS 可先用 Oracle Cloud Always Free；轻量版也可以用 Cloudflare Worker + D1。
