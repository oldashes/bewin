---
title: Bewin项目说明
type: 技术方案
tags:
  - javascript
  - backend
  - database
  - deployment
project: bewin
date: 2026-06-28
status: draft
---

# Bewin

Bewin 是一个本地回测与线上看板项目，用来研究 A 股“人气趋势”信号是否具备选股价值。它把东方财富历史人气、同花顺后续每日积累的人气榜、东方财富行情 K 线、板块/行业特征和策略回测结果放到同一套 Web 看板里，支持每日候选、策略自定义、买入收益验证、策略评测和失败归因。

> 这个项目只用于策略研究、回测复盘和候选池观察，不构成投资建议，也不会替代人工判断。

## 核心目标

项目最初关注的问题是：如果一只股票的人气排名从较低区间持续上升，是否可能提前发现趋势形成。后续逐步加入板块共振、量能过滤、同花顺数据积累、策略自定义、随机基准、沪深300对照和自归因分析。

当前系统主要回答这些问题：

- 某个交易日有哪些候选股票被策略选中？
- 候选股票属于什么交易所、板块、涨跌幅规则和新股阶段？
- 如果在信号日或次日买入，1 天、2 天、3 天、4 天、5 天、1 周、2 周和当前收益如何？
- 个股是否跑赢同期沪深300？
- 某只股票历史上是否被策略捕捉过？
- 当前策略在历史样本中 5 日、10 日、20 日表现如何？
- 胜率是否只是五五开，还是收益分布、盈亏比、超额收益更有意义？
- 失败样本是否存在共同归因，可以用于后续策略降权或观察？

## 系统架构

```mermaid
flowchart LR
  subgraph External["外部数据"]
    EM["东方财富\n历史人气 / 日K / 沪深300"]
    THS["同花顺\n每日人气榜快照"]
  end

  subgraph Local["本地项目"]
    Outputs["outputs/*.csv\n历史回测样本"]
    Cache["work/cache\n行情与板块缓存"]
    Server["work/strategy-dashboard/server.js\n本地服务 + 业务逻辑"]
    Public["public + work/strategy-dashboard/public\n看板前端"]
    Scripts["scripts/*.js\n导入 / 同步 / 策略实验"]
  end

  subgraph Cloud["线上"]
    Vercel["Vercel\n静态前端 + Serverless API + Cron"]
    Neon["Neon Postgres\n信号 / K线 / 人气快照 / 策略配置"]
  end

  EM --> Outputs
  EM --> Cache
  THS --> Scripts
  Outputs --> Scripts
  Cache --> Scripts
  Scripts --> Neon
  Public --> Server
  Server --> Neon
  Server --> EM
  Vercel --> Neon
  Vercel --> EM
```

### 运行形态

| 场景 | 入口 | 说明 |
|---|---|---|
| 本地开发 | `npm start` | 启动 `work/strategy-dashboard/server.js`，默认监听 `127.0.0.1:4173` |
| 线上访问 | Vercel | `public/` 作为静态前端，`api/` 作为 Vercel Functions |
| 数据存储 | Neon Postgres | 线上默认读取 Neon；本地可通过 `DATA_MODE=csv` 强制使用 CSV |
| 定时同步 | Vercel Cron | 收盘后补 K 线和同花顺人气快照 |

## 目录结构

```text
.
├── api/                         Vercel Functions 入口，统一代理到 server.js
├── api/cron/                    Vercel Cron 入口
├── db/schema.sql                Neon Postgres 表结构
├── outputs/                     历史回测 CSV、阶段性分析报告
├── public/                      Vercel 静态前端
├── scripts/                     数据导入、同步、策略实验脚本
├── work/strategy-dashboard/     本地 Web 服务和业务逻辑
├── work/strategy-dashboard/public/
│   └── app.js/styles.css        本地服务使用的前端资源
└── work/cache/                  本地行情、板块、元数据缓存，通常不提交
```

注意：前端文件有两份：

- `public/app.js`、`public/styles.css`：Vercel 静态部署使用。
- `work/strategy-dashboard/public/app.js`、`work/strategy-dashboard/public/styles.css`：本地 `npm start` 使用。

修改前端时需要保持两边同步。

## 快速启动

```bash
npm install
npm start
```

默认访问：

```text
http://127.0.0.1:4173
```

如果根目录存在 `.env` 且配置了 `DATABASE_URL`，服务优先读取 Neon。强制回到本地 CSV：

```bash
DATA_MODE=csv npm start
```

常用环境变量见 `.env.example`：

```text
DATABASE_URL="postgresql://user:password@host/dbname?sslmode=require"
CRON_SECRET="replace-with-a-long-random-string"
SYNC_LOOKBACK_DAYS=60
SYNC_MAX_STOCKS=20
THS_HOT_CATEGORIES="stock,concept,industry"
THS_WATCHLIST_MAX=20
THS_WATCHLIST_LOOKBACK_DAYS=60
```

## 数据来源

| 数据 | 来源 | 用途 | 当前处理方式 |
|---|---|---|---|
| 东方财富历史人气 | 已沉淀在 `outputs/` / Neon | 回测主数据源 | 可回溯更长周期，支撑策略实验 |
| 同花顺人气榜 | 每日抓取后写入 `popularity_snapshots` | 未来同花顺历史回测 | 历史较短，需要从现在开始积累 |
| 股票日 K | 东方财富 | 收益验证、回测、当前收益 | 优先读 Neon；缺失时请求并回写 |
| 沪深300日 K | 东方财富 | 个股收益对照 | 用于展示同期指数收益和超额收益 |
| 市场随机基准 | 本地 K 线宇宙 / `market_daily_baselines` | 策略测评 | 同日期全市场随机 A 股篮子的期望收益 |
| 股票元数据 | 缓存 + Neon `stocks` | 交易所、板块、新股、涨跌幅标签 | 不足时按代码规则推断 |
| 板块成员和板块表现 | `work/cache/sector-filter-backtest` | 板块共振与伪板块过滤 | 用于强板块、板块量能、板块热度计算 |

## 数据库模型

核心表在 `db/schema.sql`：

| 表 | 作用 |
|---|---|
| `stocks` | 股票名称、交易所、板块、行业、概念、上市日期 |
| `strategy_signals` | 已生成的内置策略信号，如早期发现、热门确认 |
| `strategy_feature_events` | 完整特征池，用于动态计算自定义策略 |
| `strategy_configs` | 用户保存的自定义策略参数 |
| `stock_daily_bars` | 股票日 K 数据 |
| `market_daily_baselines` | 同日全市场随机基准统计 |
| `popularity_snapshots` | 东方财富/同花顺人气榜原始快照 |
| `sync_runs` | 每日同步任务日志 |
| `import_batches` | 导入批次记录 |

初始化或更新表结构：

```bash
npm run db:schema
```

## 数据导入与同步

### 一次性导入

```bash
npm run db:import
npm run db:import-features
npm run db:import-klines
npm run db:import-market-baseline
npm run db:import-ths
```

| 命令 | 作用 |
|---|---|
| `db:import` | 把 `outputs/` 中的早期发现、热门确认等信号导入 `strategy_signals` |
| `db:import-features` | 把完整特征池导入 `strategy_feature_events`，支撑自定义策略重算 |
| `db:import-klines` | 把策略相关股票本地日 K 缓存导入 `stock_daily_bars` |
| `db:import-market-baseline` | 计算并导入同日市场随机基准 |
| `db:import-ths` | 导入已有同花顺历史热榜 CSV 样本 |

K 线默认从 `2024-01-01` 导入，可调整：

```bash
KLINE_START_DATE=2025-01-01 npm run db:import-klines
```

市场基准默认从 `2025-01-01` 计算，可调整：

```bash
MARKET_BASELINE_START_DATE=2025-09-01 npm run db:import-market-baseline
```

### 每日同步

```bash
npm run sync:daily
npm run sync:ths
```

| 命令 | 作用 |
|---|---|
| `sync:daily` | 刷新近期策略相关股票日 K，补齐收益验证需要的数据 |
| `sync:ths` | 抓取同花顺个股、概念、行业热榜，以及观察池股票 attentionDegree |

常用参数：

```bash
SYNC_LOOKBACK_DAYS=90 SYNC_MAX_STOCKS=50 npm run sync:daily
THS_WATCHLIST_MAX=50 npm run sync:ths
```

## Vercel 部署

Vercel 导入 GitHub 仓库时使用：

```text
Application Preset: Other
Root Directory: ./
Build Command: 留空
Output Directory: 留空
Install Command: npm install
```

线上环境变量：

```text
DATABASE_URL=postgresql://...
CRON_SECRET=一段随机长字符串
SYNC_LOOKBACK_DAYS=60
SYNC_MAX_STOCKS=20
THS_HOT_CATEGORIES=stock,concept,industry
THS_WATCHLIST_MAX=20
```

`vercel.json` 当前配置：

| Cron | UTC 时间 | 北京时间 | 作用 |
|---|---:|---:|---|
| `/api/cron/daily-sync` | 周一到周五 08:30 | 16:30 | 收盘后刷新近期策略股票日 K |
| `/api/cron/ths-sync` | 周一到周五 08:40 | 16:40 | 写入同花顺人气快照 |

Cron 入口在生产环境要求 `CRON_SECRET`。本地未设置 `CRON_SECRET` 时允许直接调试。

## API 入口

所有 API 最终都由 `work/strategy-dashboard/server.js` 的 `handleApiRequest` 分发。Vercel 下 `api/*.js` 只是轻量代理。

| 路径 | 作用 |
|---|---|
| `/api/overview` | 数据源、策略、可用日期、策略参数定义 |
| `/api/daily` | 指定日期的候选股票、板块聚合、摘要指标 |
| `/api/timeline` | 历史日期列表和每日表现 |
| `/api/evaluation` | 策略评测、随机基准、失败归因 |
| `/api/strategy-configs` | 读取或保存自定义策略配置 |
| `/api/stock-signals` | 查询某只股票是否曾被选中 |
| `/api/position` | 买入收益验证，含沪深300与超额收益 |
| `/api/cron/daily-sync` | 刷新日 K 的定时任务 |
| `/api/cron/ths-sync` | 抓取同花顺人气快照的定时任务 |

示例：

```bash
curl 'http://127.0.0.1:4173/api/daily?date=2026-05-25&source=em&strict=1&strategy=custom:profit-resonance-v1'
curl 'http://127.0.0.1:4173/api/position?code=300553&date=2026-01-12&entry=nextOpen'
curl 'http://127.0.0.1:4173/api/evaluation?source=em&strict=1&strategy=custom:profit-resonance-v1'
```

## 看板功能

### 每日候选

按信号日期展示策略选出的股票，并展示：

- 股票名称、代码、数据来源和模型评分。
- 信号提示：波段首次、波段延续、等待二次确认、已二次确认等。
- 交易标签：上交所/深交所/北交所、主板/创业板/科创板、10%/20%/30%涨跌幅、新股或次新股。
- 人气排名、20 日前排名、上移幅度、量能倍数。
- 最佳板块、板块 5 日涨幅、5/10/20 日收益。
- 风险标签和信号强度分。

### 历史记录

右侧历史记录按交易日列出：

- 信号日期。
- 候选数。
- 候选强度。
- 5 日均值。
- 20 日均值。

日期选择会尽量按交易日校正。遇到节假日或非交易日，会映射到邻近有效交易日，避免用户误以为“数据缺失”。

### 买入收益验证

输入股票代码和买入日期后，计算：

- 当前收益。
- 1 天、2 天、3 天、4 天、5 天、1 周、2 周收益。
- 当日涨跌幅。
- 最高浮盈。
- 最大回撤。
- 同期沪深300收益。
- 相对指数收益。

收益口径：

```text
收益 = (退出日收盘价 - 买入价) / 买入价
最高浮盈 = 持有窗口内最高价相对买入价的收益
最大回撤 = 持有窗口内最低价相对买入价的收益
相对指数收益 = 个股收益 - 同期沪深300收益
```

它们都是相对买入价的累计收益，不是单日收益。单日涨跌单独显示在“当日涨跌”字段。

买入方式：

| 方式 | 口径 |
|---|---|
| 信号次日开盘 | 信号日后第一个交易日开盘买入 |
| 当日收盘 | 信号日收盘买入 |
| 当日开盘 | 信号日开盘买入 |

### 股票信号查询

可输入股票代码或名称，查看该股票历史是否被策略捕捉过。返回内容包括：

- 命中次数。
- 覆盖信号日。
- 首次和最近信号日期。
- 每次命中的策略标签、风险标签、信号强度。
- 对应 5/10/20 日收益。

### 板块 / 行业推荐

根据当日候选股反推强板块：

- 按行业或概念聚合候选。
- 展示板块 5 日涨幅、量能、20 日表现。
- 用于判断个股是孤立异动，还是板块轮动中的一部分。

## 策略体系

Bewin 的策略不是一个固定规则，而是一套可配置的特征筛选框架。

### 内置策略

服务端内置两个基础策略：

| 策略 | 核心逻辑 | 适用场景 |
|---|---|---|
| 早期发现 | 人气排名 400-1200 上移 + 个股温和放量 + 板块 5 日 3%-15% + 板块量能 1.2-2.0 | 提前发现从冷门区升温的股票 |
| 热门确认 | 人气进入前 100 + 20 日前至少上移 300 名 + 量能 0.8-3.5 + 个股 5 日涨幅不过热 | 确认已经进入热门区的趋势股 |

### 前端预设

前端策略编辑器提供多套预设。预设本质上是自定义策略参数模板，保存后写入 `strategy_configs`，并基于 `strategy_feature_events` 动态重算候选池。

| 预设 | 参数概览 | 设计意图 |
|---|---|---|
| 早期发现 | 400-1200 / 量能 1.0-2.5 / 板块 3%-15% | 默认观察池，捕捉从冷门区升温 |
| 稳健过滤 | 350-900 / 上移 ≥500 / 每日 ≤5 | 减少噪声，偏少而精 |
| 共振趋势 | 600-1600 / 量能 1.5-3.0 / 每日 ≤3 | 个股温和启动且板块同步走强 |
| 强共振收益 | 400-1200 / 个股 5 日 5%-25% / 板块 8%-20% | 偏 20 日收益弹性，目前是重点实验策略 |
| 宽松观察 | 300-1500 / 量能 0.8-3.2 / 每日 ≤12 | 扩大复盘池，适合人工找线索 |
| 热门确认 | 1-100 / 上移 ≥300 / 量能 0.8-3.5 | 对人气前排做趋势确认 |

### 可配置参数

| 参数 | 含义 | 影响 |
|---|---|---|
| `rankMin` / `rankMax` | 当前人气排名区间 | 越小越热门；早期策略通常避开前 100 |
| `rankDelta20Min` | 20 日前排名减当前排名的最小值 | 越大代表人气上升越明显 |
| `amountRatioMin` / `amountRatioMax` | 个股成交额相对均值倍数 | 过滤无量和过热放量 |
| `stockPrev5MinPct` / `stockPrev5MaxPct` | 个股信号日前 5 日涨幅区间 | 控制启动程度，避免追高 |
| `boardRet5MinPct` / `boardRet5MaxPct` | 板块 5 日涨幅区间 | 用于板块趋势和过热过滤 |
| `boardAmountRatioMin` / `boardAmountRatioMax` | 板块量能倍数 | 判断板块资金是否有效放大 |
| `maxPerDate` | 每日最多候选数 | 控制候选池规模 |
| `requireStrongBoard` | 是否必须存在强板块 | 开启后排除孤立个股 |
| `requireResonance` | 是否要求个股与板块共振 | 开启后更偏强共振策略 |

## 特征与评分

### 基础评分

早期发现策略的基础分来自：

| 特征 | 权重 | 解释 |
|---|---:|---|
| 人气上移 | 36% | `rank20 - rank`，衡量从低关注走向高关注 |
| 板块强度 | 24% | 板块 5 日涨幅 |
| 个股量能适配 | 18% | 个股量能是否处于温和放大区 |
| 板块量能适配 | 14% | 板块整体量能是否有效 |
| 个股动量 | 8% | 个股信号日前 5 日涨跌幅 |

热门确认策略的基础分更强调当前排名、20 日上移、10 日上移、量能和短线涨幅是否不过热。

### 信号强度分

在基础分之上，系统会再计算 `signalStrength`：

| 分层 | 分数 | 含义 |
|---|---:|---|
| 高优先级 | ≥85 | 共振质量较高，历史回测表现明显更好 |
| 观察池 | 70-84 | 有一定质量，但需要继续验证 |
| 等待确认 | <70 | 更适合观察，不适合直接追 |

加分因素包括：

- 个股相对板块更强。
- 板块热度处于非拥挤区。
- 板块量能处于 1.5-2.0 区间。
- 单信号日而非多信号扩散。
- 归因为 `resonance_leader` 或 `resonance_follow`。

扣分因素包括：

- 多信号日扩散。
- 板块半拥挤。
- 板块量能不足。
- 个股落后板块。
- 短线追高。
- 风险标签过多。

### 归因类型

系统会用个股和板块的相对关系给信号打归因类型：

| 类型 | 含义 |
|---|---|
| `resonance_leader` | 个股和板块同步走强，且个股相对板块领先 |
| `resonance_follow` | 个股和板块同步走强，但个股不明显领先 |
| `board_led_lag` | 板块很强但个股落后 |
| `stock_led` | 个股很强，板块不一定同步 |
| `isolated_stock` | 个股异动但板块不强 |
| `board_led` | 板块强，个股尚未明显启动 |
| `overheated_resonance` | 个股和板块共振但已偏热 |
| `overheated_stock` | 个股短线过热 |
| `weak_or_early` | 信号仍弱或过早 |

## 策略评测

策略评测在 `/api/evaluation` 完成，前端“策略测评”区展示。

### 评测周期

当前默认评测：

- 5 日收益。
- 10 日收益。
- 20 日收益。

其中 20 日是更接近趋势策略的主观察周期；5 日更容易受短线波动影响。

### 指标口径

| 指标 | 解释 |
|---|---|
| 样本数 | 策略在回测区间内选出的候选股票数 |
| 到期数 | 已有足够后续 K 线能计算对应周期收益的样本数 |
| 策略均值 | 候选股票对应周期收益均值 |
| 策略胜率 | 对应周期收益大于 0 的比例 |
| 随机均值 | 同日全市场随机 A 股篮子的期望收益 |
| 随机胜率 | 同日市场随机样本的胜率 |
| 超额均值 | 策略均值 - 随机均值 |
| 胜率超额 | 策略胜率 - 随机胜率 |
| 中位数 | 收益分布中位数，用于减少极端样本影响 |
| 盈亏比 | 平均盈利 / 平均亏损 |
| Profit Factor | 总盈利 / 总亏损 |

### 为什么不只看胜率

策略胜率接近 50% 不一定无效，原因是：

- 如果平均盈利明显大于平均亏损，胜率 50% 也可能有正期望。
- 如果收益显著跑赢同日市场随机基准，说明信号可能有信息含量。
- 如果少数大收益样本贡献主要收益，需要再看中位数和失败样本，防止过度依赖长尾。
- 如果市场整体暴跌，个股亏损但跑赢市场，也不能简单归为策略失败。

所以看板同时展示胜率、均值、中位数、盈亏比、随机基准、超额收益和失败归因。

## 自归因 Agent

自归因 Agent 是第一版规则化复盘模块，不是大模型自动调参。

它做三件事：

1. 找出 20 日失败样本。
2. 给失败样本打标签。
3. 统计哪些标签的失败率或跑输市场概率显著高于整体。

### 失败定义

| 类型 | 口径 |
|---|---|
| 绝对失败 | 20 日收益 < 0 |
| 弱收益 | 20 日收益在 0%-5% |
| 相对失败 | 20 日收益跑输同日市场随机基准 |

### 当前标签

| 标签 | 含义 |
|---|---|
| 多信号日扩散 | 同一天候选较多，可能是行情扩散或噪声增多 |
| 板块半拥挤 | 板块热度在 80%-90%，容易处于不稳定区 |
| 板块高拥挤 | 板块热度 ≥90%，需警惕追高但也可能是主线确认 |
| 板块量能不足 | 板块量能 1.3-1.5，放量不够充分 |
| 板块量能边缘 | 板块量能 <1.3 |
| 假前排 | 个股相对板块略强但不够明显 |
| 个股落后板块 | 板块强但个股相对弱 |
| 板块后排 | 个股在板块内部排序偏后 |
| 短线追高 | 个股短线涨幅和板块热度都偏高 |
| 个股量能偏弱 | 个股量能 <1.7 |
| 个股量能偏高 | 个股量能 >2.1 |
| 20%高波动 | 创业板、科创板等 20% 涨跌幅股票，波动天然更大 |

### 输出结果

自归因区展示：

- 20 日失败 / 到期样本。
- 跑输市场 / 到期样本。
- 弱收益样本。
- 整体超额收益。
- 信号强度分层表现。
- 失败标签分组表现。
- 可验证假设。
- 最差失败样本列表。

### 使用原则

归因只用于提出“下一步验证假设”，不能凭一两个失败案例直接改策略。合理流程是：

1. 观察失败标签是否有稳定统计优势。
2. 检查它是否也会误杀成功样本。
3. 用自定义策略改一组参数。
4. 重新计算候选池和评测。
5. 再看训练区间、测试区间和最近区间是否都改善。

## 同花顺数据积累

同花顺人气榜历史回溯能力有限，所以项目当前策略是：

- 历史回测主要依赖东方财富人气数据。
- 从现在开始每日抓取同花顺人气榜，写入 `popularity_snapshots`。
- 等积累足够时间后，再用同花顺数据单独回测或与东方财富交叉验证。

`sync:ths` 会抓取：

- 个股热榜。
- 概念热榜。
- 行业热榜。
- attentionDegree 前 100。
- 近期观察池股票的人气排名。

这部分是未来比较两个平台口径、做双平台共振信号的重要基础。

## 策略实验脚本

`scripts/strategy-lab.js` 用于离线策略实验。它会读取完整特征池、K 线和板块成员，做参数网格搜索，并输出训练/测试/全量表现。

默认配置包括：

```text
from: 2025-09-29
to: 2026-06-03
trainTo: 2026-03-31
testFrom: 2026-04-01
horizon: ret20
objective: balanced
```

用途：

- 粗筛策略参数。
- 比较不同参数组合在训练区和测试区的稳定性。
- 避免只根据单个 case 调参导致过拟合。

## 常见开发操作

### 启动本地后台服务

```bash
screen -dmS bewin4173 bash -lc 'cd /Users/XuTian/iDev/github/bewin && npm start > /tmp/bewin-4173.log 2>&1'
```

查看：

```bash
screen -ls
tail -f /tmp/bewin-4173.log
```

停止：

```bash
screen -S bewin4173 -X quit
```

### 检查代码

```bash
node --check work/strategy-dashboard/server.js
node --check public/app.js
node --check work/strategy-dashboard/public/app.js
```

### 验证关键接口

```bash
curl -I http://127.0.0.1:4173/

curl 'http://127.0.0.1:4173/api/position?code=300553&date=2026-01-12&entry=nextOpen'

curl 'http://127.0.0.1:4173/api/evaluation?source=em&strict=1&strategy=custom:profit-resonance-v1'
```

### 推送上线

项目已连接 GitHub 和 Vercel。推送到 `main` 后，Vercel 会自动部署。

```bash
git add .
git commit -m "docs: update project readme"
git push origin main
```

## 当前局限

- 东方财富和同花顺的人气统计口径不同，不能直接假设两者完全可替代。
- 同花顺历史样本仍短，需要持续积累。
- 自归因 Agent 目前是规则化统计，不是自动学习模型。
- 板块归因依赖当前板块成员和缓存质量，伪板块过滤仍可能漏判。
- 策略回测没有计入交易成本、滑点、停牌、真实成交可得性。
- 高波动股票的收益验证需要结合交易所涨跌幅、新股阶段和流动性。
- 回测表现可能被少数长尾收益拉高，必须同时看中位数、失败样本和测试区间。

## 后续方向

- 持续积累同花顺历史人气数据，形成独立回测源。
- 增加双平台共振信号：东方财富人气上升 + 同花顺同步升温。
- 引入更明确的板块归因：个股带动板块，还是板块轮动带动个股。
- 将自归因标签变成可配置降权因子，而不是直接过滤。
- 增加交易成本、滑点和仓位管理模拟。
- 增加训练/验证/最近区间分段评测，降低过拟合风险。
- 增加定时报表或消息推送，跟踪每日候选的事后表现。
