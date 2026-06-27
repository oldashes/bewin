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
```

`db:schema` 会创建表结构，`db:import` 会把当前 CSV 信号导入 Neon，`db:import-klines` 会把策略相关股票的本地日 K 缓存导入 Neon。

默认 K 线导入从 `2024-01-01` 开始，可通过环境变量调整：

```bash
KLINE_START_DATE=2025-01-01 npm run db:import-klines
```

服务端收益验证会优先读取 Neon 的 `stock_daily_bars`；如果某只股票没有入库，会临时请求东方财富 K 线并写回 Neon。

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
```

根目录 `public/` 是静态前端，`api/` 是 Vercel Functions。

## 目录

```text
work/strategy-dashboard/   Web 服务和前端页面
public/                    Vercel 静态前端入口
api/                       Vercel Functions 入口
outputs/                   回测 CSV、分析报告和截图输出
work/cache/                本地行情/板块缓存，不提交 GitHub
```

## 当前数据模式

当前服务仍使用本地 CSV 和缓存文件：

- `outputs/em-popularity-sector-filter-sweet-spot-events.csv`
- `outputs/em-popularity-backtest-events.csv`
- `outputs/latest-one-month-strategy-candidates.csv`
- `work/cache/eastmoney-popularity-backtest/kline/`
- `work/cache/sector-filter-backtest/board-members/`
- `work/cache/strategy-dashboard/stock-meta.json`

后续可以把每日快照、策略信号、行情数据迁移到 Neon Postgres。
