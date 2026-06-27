# bewin

本地人气趋势策略看板，用于回测东方财富/同花顺人气数据、查看每日候选股票、板块聚合和买入收益验证。

## 启动

```bash
npm start
```

默认地址：

```text
http://127.0.0.1:4173
```

如果根目录存在 `.env` 且配置了 `DATABASE_URL`，服务会优先从 Neon Postgres 读取策略信号。需要强制回到本地 CSV 时：

```bash
DATA_MODE=csv npm start
```

## Neon

```bash
npm run db:schema
npm run db:import
npm run db:import-klines
npm run db:import-ths
npm run sync:daily
npm run sync:ths
```

`db:schema` 会创建表结构，`db:import` 会把当前 CSV 信号导入 Neon，`db:import-klines` 会把策略相关股票的本地日 K 缓存导入 Neon。

默认 K 线导入从 `2024-01-01` 开始，可通过环境变量调整：

```bash
KLINE_START_DATE=2025-01-01 npm run db:import-klines
```

服务端收益验证会优先读取 Neon 的 `stock_daily_bars`；如果某只股票没有入库，会临时请求东方财富 K 线并写回 Neon。

`sync:daily` 用于手动刷新近期策略股票的日 K 数据。默认选择最近 60 天信号相关、最久未更新的 20 只股票，可通过环境变量调整：

```bash
SYNC_LOOKBACK_DAYS=90 SYNC_MAX_STOCKS=50 npm run sync:daily
```

`db:import-ths` 会把当前 `outputs/` 里的同花顺历史热榜 CSV 样本写入 `popularity_snapshots`。`sync:ths` 会抓取同花顺最近交易日的个股/概念/行业热榜，并额外保存同花顺 attentionDegree 前 100 和近期观察池股票的人气排名。

```bash
THS_WATCHLIST_MAX=50 npm run sync:ths
```

## Vercel

Vercel 导入 GitHub 仓库时使用：

```text
Application Preset: Other
Root Directory: ./
Build Command: 留空
Output Directory: 留空
Install Command: npm install
```

环境变量：

```text
DATABASE_URL=postgresql://...
CRON_SECRET=一段随机长字符串
SYNC_LOOKBACK_DAYS=60
SYNC_MAX_STOCKS=20
THS_HOT_CATEGORIES=stock,concept,industry
THS_WATCHLIST_MAX=20
```

根目录 `public/` 是静态前端，`api/` 是 Vercel Functions。

Vercel Cron 已配置为每周一到周五 `08:30 UTC` 调用：

```text
/api/cron/daily-sync
```

对应北京时间 16:30，主要用于交易日收盘后补齐策略相关股票的东方财富日 K。Cron 入口在生产环境要求 `CRON_SECRET`；本地未设置 `CRON_SECRET` 时允许直接调试。

同花顺人气快照已配置为每周一到周五 `08:40 UTC` 调用：

```text
/api/cron/ths-sync
```

对应北京时间 16:40。它会写入 `popularity_snapshots`，作为未来同花顺历史回测的原始数据底座。

## 目录

```text
work/strategy-dashboard/   Web 服务和前端页面
public/                    Vercel 静态前端入口
api/                       Vercel Functions 入口
outputs/                   回测 CSV、分析报告和截图输出
work/cache/                本地行情/板块缓存，不提交 GitHub
```

## 当前数据模式

线上默认读取 Neon：

- `strategy_signals`：策略信号
- `stocks`：股票交易所、板块、新股等标签
- `stock_daily_bars`：日 K 数据
- `popularity_snapshots`：东方财富/同花顺等人气榜原始快照
- `sync_runs`：每日同步日志

本地保留 CSV 和缓存作为回测/重建数据源。设置 `DATA_MODE=csv` 时可强制使用本地文件。
