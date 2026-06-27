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
```

`db:schema` 会创建表结构，`db:import` 会把当前 CSV 信号导入 Neon。

## 目录

```text
work/strategy-dashboard/   Web 服务和前端页面
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
