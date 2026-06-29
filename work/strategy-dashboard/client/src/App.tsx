import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Loader,
  Modal,
  NumberInput,
  Paper,
  Progress,
  ScrollArea,
  Select,
  SimpleGrid,
  Skeleton,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconChartBar,
  IconChartLine,
  IconChevronRight,
  IconExternalLink,
  IconHelpCircle,
  IconHistory,
  IconRefresh,
  IconRocket,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconTargetArrow,
} from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

type AnyRecord = Record<string, any>;

const STRATEGY_PRESETS = [
  {
    key: "early",
    title: "早期发现",
    badge: "默认",
    description: "从冷门区升温，适合作为观察池。",
    summary: "400-1200 / 量能1.0-2.5 / 板块3%-15%",
    params: {
      rankMin: 400,
      rankMax: 1200,
      rankDelta20Min: 1,
      amountRatioMin: 1,
      amountRatioMax: 2.5,
      stockPrev5MinPct: -20,
      stockPrev5MaxPct: 35,
      boardRet5MinPct: 3,
      boardRet5MaxPct: 15,
      boardAmountRatioMin: 1.2,
      boardAmountRatioMax: 2,
      maxPerDate: 0,
      requireStrongBoard: true,
      requireResonance: false,
    },
  },
  {
    key: "conservative",
    title: "稳健过滤",
    badge: "少而精",
    description: "减少噪声和追高，更适合每日少量跟踪。",
    summary: "350-900 / 上移>=500 / 每日<=5",
    params: {
      rankMin: 350,
      rankMax: 900,
      rankDelta20Min: 500,
      amountRatioMin: 1.1,
      amountRatioMax: 2.2,
      stockPrev5MinPct: -8,
      stockPrev5MaxPct: 22,
      boardRet5MinPct: 4,
      boardRet5MaxPct: 12,
      boardAmountRatioMin: 1.2,
      boardAmountRatioMax: 1.8,
      maxPerDate: 5,
      requireStrongBoard: true,
      requireResonance: false,
    },
  },
  {
    key: "resonance",
    title: "共振趋势",
    badge: "20日优先",
    description: "个股温和启动且板块同步走强，侧重20日趋势验证。",
    summary: "600-1600 / 量能1.5-3.0 / 每日<=3",
    params: {
      rankMin: 600,
      rankMax: 1600,
      rankDelta20Min: 1,
      amountRatioMin: 1.5,
      amountRatioMax: 3,
      stockPrev5MinPct: -8,
      stockPrev5MaxPct: 22,
      boardRet5MinPct: 3,
      boardRet5MaxPct: 15,
      boardAmountRatioMin: 1,
      boardAmountRatioMax: 2.5,
      maxPerDate: 3,
      requireStrongBoard: true,
      requireResonance: true,
    },
  },
  {
    key: "profit-resonance",
    title: "强共振收益",
    badge: "实验",
    description: "板块强势区间内挑个股同步走强，偏20日收益弹性。",
    summary: "400-1200 / 个股5日5%-25% / 板块8%-20%",
    params: {
      rankMin: 400,
      rankMax: 1200,
      rankDelta20Min: 0,
      amountRatioMin: 1.5,
      amountRatioMax: 3,
      stockPrev5MinPct: 5,
      stockPrev5MaxPct: 25,
      boardRet5MinPct: 8,
      boardRet5MaxPct: 20,
      boardAmountRatioMin: 1.2,
      boardAmountRatioMax: 2,
      maxPerDate: 3,
      requireStrongBoard: true,
      requireResonance: true,
    },
  },
  {
    key: "wide",
    title: "宽松观察",
    badge: "复盘池",
    description: "扩大候选范围，适合人工复盘找线索。",
    summary: "300-1500 / 量能0.8-3.2 / 每日<=12",
    params: {
      rankMin: 300,
      rankMax: 1500,
      rankDelta20Min: 0,
      amountRatioMin: 0.8,
      amountRatioMax: 3.2,
      stockPrev5MinPct: -20,
      stockPrev5MaxPct: 35,
      boardRet5MinPct: -5,
      boardRet5MaxPct: 20,
      boardAmountRatioMin: 0.8,
      boardAmountRatioMax: 3,
      maxPerDate: 12,
      requireStrongBoard: false,
      requireResonance: false,
    },
  },
  {
    key: "hot",
    title: "热门确认",
    badge: "趋势确认",
    description: "已经进入前100，侧重确认而不是提前发现。",
    summary: "1-100 / 上移>=300 / 个股<=35%",
    params: {
      rankMin: 1,
      rankMax: 100,
      rankDelta20Min: 300,
      amountRatioMin: 0.8,
      amountRatioMax: 3.5,
      stockPrev5MinPct: -20,
      stockPrev5MaxPct: 35,
      boardRet5MinPct: -100,
      boardRet5MaxPct: 300,
      boardAmountRatioMin: 0,
      boardAmountRatioMax: 20,
      maxPerDate: 0,
      requireStrongBoard: false,
      requireResonance: false,
    },
  },
];

function readInitialState() {
  const params = new URLSearchParams(window.location.search);
  return {
    date: params.get("date") || "",
    strict: params.get("strict") !== "0",
    source: params.get("source") === "ths" ? "ths" : "em",
    strategy: params.get("strategy") || "early",
  };
}

async function requestJson<T = AnyRecord>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

function apiQuery(params: Record<string, string | boolean | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  return search.toString();
}

function toFiniteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pct(value: unknown, digits = 2) {
  const number = toFiniteNumber(value);
  if (number === null) return "未到期";
  return `${(number * 100).toFixed(digits)}%`;
}

function signedPct(value: unknown, digits = 2) {
  const number = toFiniteNumber(value);
  if (number === null) return "-";
  return `${number >= 0 ? "+" : ""}${(number * 100).toFixed(digits)}%`;
}

function signedPp(value: unknown, digits = 1) {
  const number = toFiniteNumber(value);
  if (number === null) return "-";
  return `${number >= 0 ? "+" : ""}${(number * 100).toFixed(digits)}pp`;
}

function number(value: unknown, digits = 2) {
  const num = toFiniteNumber(value);
  if (num === null) return "-";
  return num.toFixed(digits);
}

function price(value: unknown) {
  const num = toFiniteNumber(value);
  if (num === null) return "-";
  return num.toFixed(2);
}

function valueTone(value: unknown) {
  const number = toFiniteNumber(value);
  if (number === null) return "muted";
  if (number > 0) return "up";
  if (number < 0) return "down";
  return "muted";
}

function rankDelta(stock: AnyRecord) {
  return Number.isFinite(stock.rank20) && Number.isFinite(stock.rank) ? stock.rank20 - stock.rank : null;
}

function quoteUrl(stock: AnyRecord) {
  const code = stock.code || "";
  const prefix = code.startsWith("6") ? "sh" : "sz";
  return `https://quote.eastmoney.com/${prefix}${code}.html`;
}

function marketLabel(type: string) {
  if (type === "industry") return "行业";
  if (type === "concept") return "概念";
  return type || "-";
}

function HelpTip({ label }: { label: string }) {
  return (
    <Tooltip label={label} multiline maw={280} withArrow>
      <ActionIcon variant="subtle" color="gray" size="xs" aria-label={label}>
        <IconHelpCircle size={15} />
      </ActionIcon>
    </Tooltip>
  );
}

function ToneText({ value, children }: { value: unknown; children?: ReactNode }) {
  return <span className={`tone ${valueTone(value)}`}>{children ?? pct(value)}</span>;
}

function tagColor(item: string) {
  if (/等待|观察|二次|回踩|不直接追/.test(item)) return "orange";
  if (/过热|偏热|加速|风险|拥挤|追高|高波动|边缘/.test(item)) return "red";
  if (/确认|可按|规则|验证|基础候选/.test(item)) return "teal";
  if (/波段|首次|首板|延续/.test(item)) return "indigo";
  if (/科创|创业|北交|20%|30%/.test(item)) return "violet";
  if (/上交|深交|沪市|深市|主板/.test(item)) return "cyan";
  if (/10%|涨跌幅|正常/.test(item)) return "gray";
  return "blue";
}

function Chips({ items, limit = 4 }: { items?: string[]; limit?: number }) {
  const clean = (items || []).filter(Boolean);
  if (!clean.length) {
    return (
      <Tooltip label="正常" withArrow>
        <Badge variant="light" color="gray" className="tagBadge">正常</Badge>
      </Tooltip>
    );
  }
  const visible = clean.slice(0, limit);
  const hidden = clean.slice(limit);
  return (
    <Group gap={6} wrap="wrap">
      {visible.map((item) => (
        <Tooltip key={item} label={item} withArrow openDelay={250}>
          <Badge variant="light" color={tagColor(item)} className="tagBadge">
            {item}
          </Badge>
        </Tooltip>
      ))}
      {hidden.length ? (
        <Tooltip label={hidden.join(" / ")} multiline maw={320} withArrow openDelay={250}>
          <Badge variant="light" color="gray" className="tagBadge compact">
            +{hidden.length}
          </Badge>
        </Tooltip>
      ) : null}
    </Group>
  );
}

function AppShellHeader({
  date,
  setDate,
  daily,
  overview,
  strict,
  setStrict,
  source,
  setSource,
  moveDate,
  refresh,
  loading,
}: AnyRecord) {
  return (
    <header className="topbar">
      <Group gap="md" className="brandGroup">
        <ThemeIcon size={48} radius="md" variant="light">
          <IconChartLine size={27} />
        </ThemeIcon>
        <Box>
          <Text size="xs" c="blue" fw={700}>本地回测看板</Text>
          <Text component="h1" className="title">人气趋势策略</Text>
        </Box>
      </Group>

      <Group className="topControls" gap="sm">
        <TextInput
          label="信号日期"
          type="date"
          value={date}
          min={overview?.tradingMinDate || overview?.minDate || undefined}
          max={overview?.tradingMaxDate || overview?.maxDate || undefined}
          onChange={(event) => setDate(event.currentTarget.value)}
          className="dateInput"
        />
        <Button.Group>
          <Tooltip label="上一交易日">
            <Button variant="default" px="sm" onClick={() => moveDate(-1)} disabled={loading}>
              <IconArrowLeft size={16} />
            </Button>
          </Tooltip>
          <Button variant="default" onClick={() => setDate((daily?.availableDates || []).at(-1) || overview?.maxDate || date)} disabled={loading}>
            最新
          </Button>
          <Tooltip label="下一交易日">
            <Button variant="default" px="sm" onClick={() => moveDate(1)} disabled={loading}>
              <IconArrowRight size={16} />
            </Button>
          </Tooltip>
        </Button.Group>
        <Select
          label="数据源"
          value={source}
          onChange={(value) => setSource(value || "em")}
          data={[
            { value: "em", label: "东方财富历史人气" },
            { value: "ths", label: "同花顺本地积累" },
          ]}
          className="sourceSelect"
        />
        <Checkbox
          checked={strict}
          onChange={(event) => setStrict(event.currentTarget.checked)}
          label="过滤伪板块"
          className="strictToggle"
        />
        <ActionIcon size={38} variant="light" onClick={refresh} loading={loading} aria-label="刷新">
          <IconRefresh size={18} />
        </ActionIcon>
      </Group>

      <Group className="statusGroup" gap="xs">
        <Badge size="lg" variant="light" color="blue">
          {overview?.dataSource?.shortLabel || "数据源"} · {overview?.dataStrategy?.shortLabel || "策略"} · {overview?.strictCount ?? "-"} 条样本
        </Badge>
        <Badge size="lg" variant="default">
          {overview?.minDate && overview?.maxDate ? `${overview.minDate} 至 ${overview.maxDate}` : "待积累"}
        </Badge>
      </Group>
    </header>
  );
}

function MetricCard({ title, help, value, detail, tone, icon }: AnyRecord) {
  return (
    <Paper className={`metricCard ${tone || ""}`} withBorder>
      <Group justify="space-between" align="flex-start">
        <Group gap={6}>
          <Text c="dimmed" fw={700} size="sm">{title}</Text>
          {help ? <HelpTip label={help} /> : null}
        </Group>
        {icon ? <ThemeIcon variant="light" color="blue">{icon}</ThemeIcon> : null}
      </Group>
      <Text className="metricValue">{value}</Text>
      <Text c="dimmed" size="sm">{detail}</Text>
    </Paper>
  );
}

function Metrics({ daily }: { daily?: AnyRecord }) {
  const stats = daily?.stats || {};
  const signal = daily?.signalStats || {};
  return (
    <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md">
      <MetricCard
        title="候选股票"
        help="当前信号日下，满足策略并通过伪板块过滤的股票数量。"
        value={stats.count ?? "-"}
        detail={`${stats.matured5 ?? 0} 个已有5日结果，${stats.matured20 ?? 0} 个已有20日结果`}
        icon={<IconTargetArrow size={18} />}
      />
      <MetricCard title="推荐板块" help="按候选股票聚合出的行业或概念数量。" value={daily?.boards?.length ?? "-"} detail="按候选股聚合" icon={<IconChartBar size={18} />} />
      <MetricCard title="5日均值 / 胜率" help="信号次日开盘买入，持有5个交易日收盘卖出的平均收益和胜率。" value={<ToneText value={stats.avgRet5} />} detail={`胜率 ${pct(stats.win5, 1)}，中位数 ${pct(stats.medianRet5)}`} tone={valueTone(stats.avgRet5)} />
      <MetricCard title="20日均值 / 胜率" help="信号次日开盘买入，持有20个交易日收盘卖出的平均收益和胜率。" value={<ToneText value={stats.avgRet20} />} detail={`胜率 ${pct(stats.win20, 1)}，中位数 ${pct(stats.medianRet20)}`} tone={valueTone(stats.avgRet20)} />
      <MetricCard title="首次 / 延续" help="波段首次信号与同一股票延续信号数量。" value={`${signal.first ?? 0} / ${signal.continuation ?? 0}`} detail="首次 / 延续" />
      <MetricCard title="观察池" help="不直接追，用于等待回踩或二次确认的候选数。" value={signal.waitForConfirm ?? 0} detail="不直接追" tone="watch" />
      <MetricCard title="过热提示" help="个股已加速或板块偏热的数量。" value={`${signal.accelerated ?? 0} / ${signal.boardHot ?? 0}`} detail="个股已加速 / 板块偏热" />
      <MetricCard title="二次启动" help="回踩后走强或直接走强的候选数量。" value={`${signal.confirmed ?? 0} + ${signal.direct ?? 0}`} detail="回踩走强" tone="confirm" />
    </SimpleGrid>
  );
}

function DateBanner({ daily }: { daily?: AnyRecord }) {
  if (!daily) return null;
  if (daily.dataSource?.available === false) {
    return <Alert color="yellow" icon={<IconAlertTriangle size={18} />}>{daily.dataSource.message || "当前数据源暂无可用历史数据。"}</Alert>;
  }
  const status = daily.dateStatus || {};
  if (!daily.requestedDate || (status.isTradingDate !== false && status.hasSignal !== false)) return null;
  const text = daily.rule || "当前日期没有符合策略的候选。";
  return <Alert color={status.isTradingDate === false ? "blue" : "yellow"} icon={<IconAlertTriangle size={18} />}>{text}</Alert>;
}

function StockTable({ stocks, onVerify }: { stocks: AnyRecord[]; onVerify: (code: string, date: string) => void }) {
  if (!stocks.length) {
    return <EmptyState text="这一天没有符合当前过滤条件的候选。" />;
  }
  return (
    <ScrollArea type="auto" offsetScrollbars>
      <Table miw={1380} verticalSpacing="md" className="stockTable">
        <colgroup>
          <col className="stockCol" />
          <col className="signalCol" />
          <col className="tradeCol" />
          <col className="actionCol" />
          <col className="rankCol" />
          <col className="rank20Col" />
          <col className="amountCol" />
          <col className="boardCol" />
          <col className="boardRetCol" />
          <col className="returnCol" />
          <col className="returnCol" />
          <col className="returnCol" />
          <col className="riskCol" />
        </colgroup>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>股票</Table.Th>
            <Table.Th>信号提示</Table.Th>
            <Table.Th>交易标签</Table.Th>
            <Table.Th>操作</Table.Th>
            <Table.Th>人气</Table.Th>
            <Table.Th>20日前</Table.Th>
            <Table.Th>量能</Table.Th>
            <Table.Th>板块</Table.Th>
            <Table.Th>板块5日</Table.Th>
            <Table.Th>5日</Table.Th>
            <Table.Th>10日</Table.Th>
            <Table.Th>20日</Table.Th>
            <Table.Th>风险</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {stocks.map((stock) => {
            const strength = stock.signalStrength;
            const risks = [...(stock.riskTags || []), ...(stock.riskFlags || [])];
            return (
              <Table.Tr key={`${stock.signalDate}-${stock.code}-${stock.bestBoardName}`}>
                <Table.Td>
                  <Stack gap={2}>
                    <Group gap={6}>
                      <Text component="a" href={quoteUrl(stock)} target="_blank" rel="noreferrer" fw={800} className="linkText">
                        {stock.name}
                      </Text>
                      <IconExternalLink size={14} />
                    </Group>
                    <Text size="xs" c="dimmed">{stock.code} / {stock.source} / 强度 {strength?.score ?? Math.round(stock.modelScore ?? stock.score ?? 0)}</Text>
                  </Stack>
                </Table.Td>
                <Table.Td>
                  <Stack gap={6}>
                    <Chips items={stock.signalInsight?.tags || []} limit={3} />
                    <Text size="xs" c="dimmed">{stock.signalInsight?.actionHint || "-"}</Text>
                  </Stack>
                </Table.Td>
                <Table.Td><Chips items={stock.meta?.tags || []} limit={3} /></Table.Td>
                <Table.Td><Button size="xs" variant="filled" color="blue" className="verifyActionButton" onClick={() => onVerify(stock.code, stock.signalDate)}>验证</Button></Table.Td>
                <Table.Td>
                  <Group gap={6}>
                    <Text fw={800}>{stock.rank ?? "-"}</Text>
                    <Badge color={Number(strength?.score) >= 70 ? "blue" : "red"} variant="light">{strength?.score ?? `+${rankDelta(stock) ?? "-"}`}</Badge>
                  </Group>
                </Table.Td>
                <Table.Td>{stock.rank20 ?? "-"}</Table.Td>
                <Table.Td>{number(stock.amountRatio)}x</Table.Td>
                <Table.Td>{stock.bestBoardName} <Text span c="dimmed">({marketLabel(stock.bestBoardType)})</Text></Table.Td>
                <Table.Td><ToneText value={stock.bestBoardRet5} /></Table.Td>
                <Table.Td><ToneText value={stock.ret5} /></Table.Td>
                <Table.Td><ToneText value={stock.ret10} /></Table.Td>
                <Table.Td><ToneText value={stock.ret20} /></Table.Td>
                <Table.Td><Chips items={risks} limit={3} /></Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function DailyCandidates({ daily, loading, refresh, onVerify }: AnyRecord) {
  return (
    <Paper className="sectionPanel" withBorder>
      <Group justify="space-between" align="flex-start" className="sectionHead">
        <Box>
          <Text component="h2" className="sectionTitle">{daily?.selectedDate || "-"} 每日候选</Text>
          <Text c="dimmed" size="sm">{daily?.rule || "读取策略规则中..."}</Text>
        </Box>
        <Button variant="light" leftSection={<IconRefresh size={16} />} onClick={refresh} loading={loading}>刷新</Button>
      </Group>
      {loading ? <Skeleton height={260} radius="md" /> : <StockTable stocks={daily?.stocks || []} onVerify={onVerify} />}
    </Paper>
  );
}

function TimelinePanel({ rows, selectedDate, setDate }: { rows: AnyRecord[]; selectedDate?: string; setDate: (date: string) => void }) {
  const visibleRows = rows.filter((row) => (row.count || 0) > 0 || row.date === selectedDate);
  const maxCount = Math.max(1, ...visibleRows.map((item) => item.count || 0));
  return (
    <Paper className="sidePanel historyPanel" withBorder>
      <Group justify="space-between" className="panelHead">
        <Box>
          <Text component="h2" className="sectionTitle">历史记录</Text>
          <Text c="dimmed" size="sm">点击切换日期</Text>
        </Box>
        <ThemeIcon variant="light"><IconHistory size={18} /></ThemeIcon>
      </Group>
      <div className="timelineGrid header">
        <span>日期 <HelpTip label="策略在该交易日生成候选股票的日期。" /></span>
        <span>数 <HelpTip label="该信号日满足当前过滤条件的候选数量。" /></span>
        <span>强度 <HelpTip label="按列表最大候选数归一化的信号密度条，不代表收益强弱。" /></span>
        <span>5日 <HelpTip label="当日候选 5 个交易日后的平均收益。" /></span>
        <span>20日 <HelpTip label="当日候选 20 个交易日后的平均收益。" /></span>
      </div>
      <ScrollArea.Autosize mah={520} type="auto" offsetScrollbars>
        <Stack gap={4} p="xs">
          {visibleRows.slice().reverse().map((row) => (
            <UnstyledButton key={row.date} className={`timelineGrid row ${row.date === selectedDate ? "active" : ""}`} onClick={() => setDate(row.date)}>
              <strong>{row.date}</strong>
              <span>{row.count}只</span>
              <Progress value={Math.max(6, (row.count / maxCount) * 100)} size="sm" radius="xl" />
              <ToneText value={row.avgRet5} />
              <ToneText value={row.avgRet20} />
            </UnstyledButton>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Paper>
  );
}

function StrategyPanel({
  overview,
  strategy,
  setStrategy,
  source,
  openEvaluation,
  openAttribution,
  onSaved,
}: AnyRecord) {
  const current = overview?.availableStrategies?.find((item: AnyRecord) => item.key === strategy) || overview?.dataStrategy || {};
  const [name, setName] = useState("");
  const [params, setParams] = useState<AnyRecord>({});
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setName(current.custom ? current.label || "我的策略" : `${current.shortLabel || current.label || "策略"} 调整版`);
    setParams(current.params || {});
    setExpanded(false);
    setMessage("");
  }, [strategy, overview?.generatedAt]);

  const strategyOptions = useMemo(
    () => (overview?.availableStrategies || []).map((item: AnyRecord) => ({ value: item.key, label: `${item.custom ? "自定义 · " : ""}${item.shortLabel || item.label}` })),
    [overview],
  );

  const paramDefs = overview?.strategyParamDefs || [];
  const visibleDefs = expanded ? paramDefs : [];

  async function save() {
    setSaving(true);
    setMessage("保存中...");
    try {
      const customId = current.custom ? current.id || String(strategy).replace(/^custom:/, "") : undefined;
      const payload = await requestJson(`/api/strategy-configs?source=${encodeURIComponent(source)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: customId,
          source,
          baseStrategy: current.custom ? "early" : current.key || strategy,
          name,
          description: current.custom ? current.description || "" : `${current.label || "内置策略"} 的自定义参数版本`,
          params,
        }),
      });
      setMessage("已保存并重算");
      onSaved(payload.strategy?.key || `custom:${payload.config.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? `保存失败：${error.message}` : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Paper className="sidePanel" withBorder>
      <Group justify="space-between" className="panelHead">
        <Text component="h2" className="sectionTitle">策略配置</Text>
        <ThemeIcon variant="light"><IconSettings size={18} /></ThemeIcon>
      </Group>

      <Stack gap="md" p="md">
        <Paper withBorder p="md" radius="md" className="plainBlock">
          <Group justify="space-between" align="flex-start">
            <Box flex={1}>
              <Text fw={800}>当前策略</Text>
              <Select mt="xs" value={strategy} onChange={(value) => value && setStrategy(value)} data={strategyOptions} />
            </Box>
            <Text size="xs" c="dimmed">保存后更新当前自定义策略</Text>
          </Group>
          <SimpleGrid cols={2} mt="md">
            <Button variant="light" color="blue" onClick={openEvaluation}>策略测评</Button>
            <Button variant="light" color="blue" onClick={openAttribution}>自归因 Agent</Button>
          </SimpleGrid>
          <SimpleGrid cols={1} mt="md" spacing={6}>
            {(overview?.dataStrategy?.ruleItems || []).slice(0, 8).map((item: string) => (
              <div className="ruleItem" key={item}><span />{item}</div>
            ))}
          </SimpleGrid>
        </Paper>

        <Paper withBorder p="md" radius="md" className="plainBlock">
          <Group justify="space-between">
            <Text fw={800}>策略参数</Text>
            <Text size="sm" c="dimmed">需要微调时再展开</Text>
          </Group>
          <TextInput label="策略名称" mt="sm" value={name} onChange={(event) => setName(event.currentTarget.value)} />
          <Button mt="md" variant="light" fullWidth onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起高级参数" : "展开高级参数"}
          </Button>
          {expanded ? (
            <SimpleGrid cols={{ base: 1, xs: 2 }} mt="md">
              {visibleDefs.map((def: AnyRecord) =>
                def.type === "boolean" ? (
                  <Checkbox
                    key={def.key}
                    label={def.label}
                    description={def.help}
                    checked={Boolean(params[def.key])}
                    onChange={(event) => setParams((old) => ({ ...old, [def.key]: event.currentTarget.checked }))}
                  />
                ) : (
                  <NumberInput
                    key={def.key}
                    label={def.label}
                    description={def.help}
                    min={def.min}
                    max={def.max}
                    step={def.step ?? (def.type === "integer" ? 1 : 0.1)}
                    value={params[def.key] ?? ""}
                    onChange={(value) => setParams((old) => ({ ...old, [def.key]: value === "" || value === null ? "" : Number(value) }))}
                  />
                ),
              )}
            </SimpleGrid>
          ) : null}
          <Button mt="md" fullWidth onClick={save} loading={saving}>保存并重算</Button>
          <Button mt="sm" fullWidth variant="default" onClick={() => setParams(current.params || {})}>恢复当前策略参数</Button>
          {message ? <Text mt="sm" c="dimmed" size="sm">{message}</Text> : null}
        </Paper>

        <Paper withBorder p="md" radius="md" className="plainBlock">
          <Group justify="space-between">
            <Text fw={800}>策略预设</Text>
            <Text size="sm" c="dimmed">先选方向，再按需微调</Text>
          </Group>
          <SimpleGrid cols={{ base: 1, xs: 2 }} mt="md">
            {STRATEGY_PRESETS.map((preset) => (
              <UnstyledButton key={preset.key} className="presetCard" onClick={() => {
                setName(`${preset.title} 调整版`);
                setParams(preset.params);
                setMessage(`已套用「${preset.title}」，保存后才会重算候选池。`);
              }}>
                <Group justify="space-between" align="flex-start">
                  <Text fw={800}>{preset.title}</Text>
                  <Badge variant="light">{preset.badge}</Badge>
                </Group>
                <Text size="sm" c="dimmed" mt={4}>{preset.description}</Text>
                <Text size="sm" mt={8}>{preset.summary}</Text>
              </UnstyledButton>
            ))}
          </SimpleGrid>
        </Paper>
      </Stack>
    </Paper>
  );
}

function BoardsPanel({ boards }: { boards: AnyRecord[] }) {
  return (
    <Paper className="sectionPanel halfPanel" withBorder>
      <Text component="h2" className="sectionTitle">板块 / 行业推荐</Text>
      <Text c="dimmed" size="sm" mb="md">由当日候选股反推板块热度</Text>
      <Stack gap="sm">
        {boards.length ? boards.map((board) => (
          <Paper key={`${board.type}-${board.name}`} p="md" radius="md" withBorder className="plainBlock">
            <Group justify="space-between" align="flex-start">
              <Box>
                <Text fw={800}>{board.name}</Text>
                <Text size="sm" c="dimmed">{marketLabel(board.type)} / {board.stockCount} 只候选</Text>
                <Group gap={6} mt={8}>{(board.stocks || []).slice(0, 5).map((stock: AnyRecord) => <Badge key={stock.code} variant="light">{stock.name}</Badge>)}</Group>
              </Box>
              <Group gap="lg">
                <Box><Text c="dimmed" size="xs">板块5日</Text><ToneText value={board.boardRet5} /></Box>
                <Box><Text c="dimmed" size="xs">量能</Text><Text fw={800}>{number(board.boardAmountRatio)}x</Text></Box>
                <Box><Text c="dimmed" size="xs">20日表现</Text><ToneText value={board.avgRet20} /></Box>
              </Group>
            </Group>
          </Paper>
        )) : <EmptyState text="这一天没有板块聚合结果。" />}
      </Stack>
    </Paper>
  );
}

function PositionVerifier({ selectedDate, initialCode }: { selectedDate?: string; initialCode?: string }) {
  const [code, setCode] = useState(initialCode || "");
  const [date, setDate] = useState(selectedDate || "");
  const [entry, setEntry] = useState("next_open");
  const [payload, setPayload] = useState<AnyRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (selectedDate && !date) setDate(selectedDate);
  }, [selectedDate, date]);

  async function verify(nextCode = code, nextDate = date) {
    if (!nextCode || !nextDate) {
      setError("请先输入股票代码和买入日期。");
      return;
    }
    setCode(nextCode);
    setDate(nextDate);
    setLoading(true);
    setError("");
    try {
      setPayload(await requestJson(`/api/position?${apiQuery({ code: nextCode, date: nextDate, entry })}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "计算失败");
    } finally {
      setLoading(false);
    }
  }

  (window as any).__bewinVerify = verify;

  return (
    <Paper className="sectionPanel" withBorder>
      <Text component="h2" className="sectionTitle">买入收益验证</Text>
      <Text c="dimmed" size="sm">输入股票和买入日期，计算持有收益</Text>
      <SimpleGrid cols={{ base: 1, md: 4 }} mt="md" className="verifyForm">
        <TextInput label="股票代码" value={code} onChange={(event) => setCode(event.currentTarget.value)} placeholder="例如 605178" />
        <TextInput label="买入日期" type="date" value={date} onChange={(event) => setDate(event.currentTarget.value)} />
        <Select label="买入方式" value={entry} onChange={(value) => setEntry(value || "next_open")} data={[
          { value: "next_open", label: "信号次日开盘" },
          { value: "same_close", label: "信号日收盘" },
        ]} />
        <Button mt={24} onClick={() => verify()} loading={loading}>计算收益</Button>
      </SimpleGrid>
      {error ? <Alert color="yellow" mt="md" icon={<IconAlertTriangle size={18} />}>{error}</Alert> : null}
      {loading ? <Skeleton height={180} mt="md" /> : <VerifyResult payload={payload} />}
    </Paper>
  );
}

function VerifyResult({ payload }: { payload: AnyRecord | null }) {
  if (!payload) return <EmptyState text="点击候选股「验证」，或输入代码与日期后计算持有收益。" />;
  const horizons = normalizeHorizons(payload.horizons || []);
  const current = horizons.find((item) => item.current);
  const timed = horizons.filter((item) => !item.current);
  return (
    <Paper mt="md" p="lg" radius="md" withBorder className="verifyResult">
      <Group justify="space-between" align="flex-start">
        <Box>
          <Group gap="sm"><Text fw={900} size="xl">{payload.name}</Text><Text c="dimmed">{payload.code}</Text></Group>
          <Group gap={8} mt="sm">
            <Badge variant="light">{payload.entryModeLabel}</Badge>
            <Badge variant="light">买入 {payload.entryDate}</Badge>
            <Badge variant="light">价格 {price(payload.entryPrice)}</Badge>
            {payload.latestDate ? <Badge variant="light">最新 {payload.latestDate}</Badge> : null}
          </Group>
          <Group gap={6} mt="md">{(payload.meta?.tags || []).map((tag: string) => <Badge key={tag} variant="light">{tag}</Badge>)}</Group>
        </Box>
        {current ? (
          <Paper p="md" radius="md" withBorder className="currentReturn">
            <Text c="dimmed" size="sm">当前收益</Text>
            <Text className={`bigReturn ${valueTone(current.return)}`}>{pct(current.return)}</Text>
            <Text c="dimmed" size="sm">{current.exitDate} 收盘 {price(current.exitClose)}</Text>
            <Text size="sm">当日涨跌 <ToneText value={current.dayReturn}>{signedPct(current.dayReturn)}</ToneText></Text>
          </Paper>
        ) : null}
      </Group>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 3, xl: 6 }} mt="lg">
        {timed.map((item) => (
          <Paper key={`${item.label}-${item.days}`} p="md" radius="md" withBorder className={`returnCard ${valueTone(item.return)}`}>
            <Group justify="space-between"><Text fw={800}>{item.label}</Text><Text c="dimmed" size="sm">{item.exitDate || item.status}</Text></Group>
            <Text className={`returnValue ${valueTone(item.return)}`}>{pct(item.return)}</Text>
            <Text size="sm" c="dimmed">收盘 {price(item.exitClose)}</Text>
            <Text size="sm">当日涨跌 <ToneText value={item.dayReturn}>{signedPct(item.dayReturn)}</ToneText></Text>
            {item.benchmark ? <Text size="sm">{item.benchmark.name} <ToneText value={item.benchmark.return} /></Text> : null}
            <Text size="sm">最高浮盈 <ToneText value={item.maxReturn} /></Text>
            <Text size="sm">最大回撤 <ToneText value={item.maxDrawdown} /></Text>
          </Paper>
        ))}
      </SimpleGrid>
    </Paper>
  );
}

function normalizeHorizons(horizons: AnyRecord[]) {
  const result: AnyRecord[] = [];
  const byDays = new Map();
  for (const item of horizons) {
    if (item.current) {
      result.push(item);
      continue;
    }
    const existing = byDays.get(item.days);
    if (!existing) {
      byDays.set(item.days, item);
      result.push(item);
    } else if (/周/.test(item.label || "") && !/周/.test(existing.label || "")) {
      const index = result.indexOf(existing);
      if (index >= 0) result[index] = item;
      byDays.set(item.days, item);
    }
  }
  return result;
}

function StockLookup({ source, strategy, strict, onOpenSignal }: AnyRecord) {
  const [keyword, setKeyword] = useState("");
  const [payload, setPayload] = useState<AnyRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function search() {
    if (!keyword.trim()) {
      setError("请输入股票代码或名称。");
      return;
    }
    setLoading(true);
    setError("");
    try {
      setPayload(await requestJson(`/api/stock-signals?${apiQuery({ q: keyword.trim(), strict, source, strategy })}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "查询失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Paper className="sectionPanel halfPanel" withBorder>
      <Text component="h2" className="sectionTitle">股票信号查询</Text>
      <Text c="dimmed" size="sm">查询某只股票历史是否被选中</Text>
      <Group mt="md" align="end">
        <TextInput label="股票代码 / 名称" value={keyword} onChange={(event) => setKeyword(event.currentTarget.value)} onKeyDown={(event) => event.key === "Enter" && search()} flex={1} />
        <Button leftSection={<IconSearch size={16} />} onClick={search} loading={loading}>查询信号</Button>
      </Group>
      {error ? <Alert color="yellow" mt="md">{error}</Alert> : null}
      {loading ? <Skeleton height={160} mt="md" /> : <LookupResult payload={payload} onOpenSignal={onOpenSignal} />}
    </Paper>
  );
}

function LookupResult({ payload, onOpenSignal }: AnyRecord) {
  if (!payload) return <EmptyState text="输入股票代码或名称，查看该股票在当前策略下的历史命中记录。" />;
  if (!payload.count) return <EmptyState text={payload.message || "没有查到历史信号。"} />;
  return (
    <Stack mt="md">
      <Group justify="space-between">
        <Box>
          <Text fw={900}>{payload.query} 命中 {payload.count} 次</Text>
          <Text c="dimmed" size="sm">覆盖 {payload.signalDateCount} 个信号日，首次 {payload.firstDate}，最近 {payload.latestDate}</Text>
        </Box>
        <Group>
          <Badge variant="light">5日均值 {pct(payload.stats?.avgRet5)}</Badge>
          <Badge variant="light">20日均值 {pct(payload.stats?.avgRet20)}</Badge>
        </Group>
      </Group>
      <ScrollArea.Autosize mah={420} type="auto">
        <Stack gap="sm">
          {(payload.matches || []).map((item: AnyRecord) => (
            <Paper key={`${item.signalDate}-${item.code}-${item.source}`} p="md" radius="md" withBorder className="signalHit">
              <Group justify="space-between" align="flex-start">
                <Button size="xs" variant="light" onClick={() => onOpenSignal(item.signalDate, item.code)}>查看</Button>
                <Box flex={1}>
                  <Group gap="sm"><Text fw={900}>{item.signalDate}</Text><Text c="dimmed">{item.source}</Text></Group>
                  <Text fw={800}>{item.name} <Text span c="dimmed">{item.code}</Text></Text>
                  <Chips items={[...(item.signalInsight?.tags || []), ...(item.riskTags || [])]} limit={4} />
                </Box>
              </Group>
              <SimpleGrid cols={{ base: 2, md: 4 }} mt="sm">
                <Text size="sm">人气 <b>{item.rank ?? "-"}</b></Text>
                <Text size="sm">上移 <b>{item.rankDelta != null ? `+${item.rankDelta}` : "-"}</b></Text>
                <Text size="sm">量能 <b>{number(item.amountRatio)}x</b></Text>
                <Text size="sm">板块 <b>{item.bestBoardName}</b></Text>
                <Text size="sm">5日 <ToneText value={item.ret5} /></Text>
                <Text size="sm">10日 <ToneText value={item.ret10} /></Text>
                <Text size="sm">20日 <ToneText value={item.ret20} /></Text>
              </SimpleGrid>
            </Paper>
          ))}
        </Stack>
      </ScrollArea.Autosize>
    </Stack>
  );
}

function EvaluationModal({ opened, onClose, evaluation }: AnyRecord) {
  const horizons = evaluation?.horizons || [];
  return (
    <Modal opened={opened} onClose={onClose} size="xl" title="策略测评" centered>
      {!evaluation ? <Loader /> : (
        <Stack>
          <Text c="dimmed">{evaluation.dataStrategy?.shortLabel || "当前策略"} · {evaluation.sampleCount} 个样本 · {evaluation.dateCount} 个信号日</Text>
          <SimpleGrid cols={{ base: 1, md: 3 }}>
            {horizons.map((item: AnyRecord) => (
              <Paper key={item.key} p="md" withBorder radius="md">
                <Text fw={900}>{item.label}</Text>
                <Group align="end" mt="sm">
                  <Text className={`returnValue ${valueTone(item.avg)}`}>{pct(item.avg)}</Text>
                  <Text c="dimmed">胜率 {pct(item.winRate, 1)}</Text>
                </Group>
                <SimpleGrid cols={2} mt="sm">
                  <Text size="sm">中位 <ToneText value={item.median} /></Text>
                  <Text size="sm">超额 <ToneText value={item.excess?.avg}>{signedPp(item.excess?.avg)}</ToneText></Text>
                  <Text size="sm">随机均值 <ToneText value={item.baseline?.avg} /></Text>
                  <Text size="sm">样本 {item.maturedCount}/{item.sampleCount}</Text>
                  <Text size="sm">最好 <ToneText value={item.best} /></Text>
                  <Text size="sm">最差 <ToneText value={item.worst} /></Text>
                </SimpleGrid>
              </Paper>
            ))}
          </SimpleGrid>
        </Stack>
      )}
    </Modal>
  );
}

function AttributionModal({ opened, onClose, evaluation }: AnyRecord) {
  const data = evaluation?.selfAttribution;
  return (
    <Modal opened={opened} onClose={onClose} size="xl" title="自归因 Agent" centered>
      {!data ? <Loader /> : (
        <Stack>
          <Alert color="blue" icon={<IconSparkles size={18} />}>{data.definition}</Alert>
          <SimpleGrid cols={{ base: 1, md: 4 }}>
            <MetricMini label="样本" value={data.counts?.sampleCount} />
            <MetricMini label="20日到期" value={data.counts?.matured20} />
            <MetricMini label="绝对失败" value={data.counts?.absoluteFailureCount} />
            <MetricMini label="跑输市场" value={data.counts?.marketUnderperformCount} />
          </SimpleGrid>
          <Tabs defaultValue="strength">
            <Tabs.List>
              <Tabs.Tab value="strength">强度分层</Tabs.Tab>
              <Tabs.Tab value="tags">标签归因</Tabs.Tab>
              <Tabs.Tab value="hypotheses">优化假设</Tabs.Tab>
              <Tabs.Tab value="failures">失败样本</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="strength" pt="md"><AttributionRows rows={data.strengthBands || []} labelKey="label" /></Tabs.Panel>
            <Tabs.Panel value="tags" pt="md"><AttributionRows rows={data.tagStats || []} labelKey="tag" /></Tabs.Panel>
            <Tabs.Panel value="hypotheses" pt="md">
              <Stack>{(data.hypotheses || []).map((item: AnyRecord) => (
                <Paper key={item.tag} p="md" withBorder radius="md">
                  <Group justify="space-between"><Text fw={900}>{item.tag}</Text><Badge>{item.action}</Badge></Group>
                  <Text size="sm" c="dimmed">样本 {item.count}，失败率 {pct(item.failureRate, 1)}，跑输抬升 {signedPp(item.underperformLift)}</Text>
                </Paper>
              ))}</Stack>
            </Tabs.Panel>
            <Tabs.Panel value="failures" pt="md">
              <Stack>{(data.failureCases || []).map((item: AnyRecord) => (
                <Paper key={`${item.signalDate}-${item.code}`} p="md" withBorder radius="md">
                  <Group justify="space-between"><Text fw={900}>{item.signalDate} {item.name} {item.code}</Text><ToneText value={item.ret20} /></Group>
                  <Text size="sm" c="dimmed">{item.bestBoardName} · 强度 {item.signalStrength?.score ?? "-"} · 超额 {signedPp(item.excessRet20)}</Text>
                  <Chips items={item.riskTags || []} limit={5} />
                </Paper>
              ))}</Stack>
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}
    </Modal>
  );
}

function AttributionRows({ rows, labelKey }: { rows: AnyRecord[]; labelKey: string }) {
  return (
    <Table>
      <Table.Thead><Table.Tr><Table.Th>分组</Table.Th><Table.Th>样本</Table.Th><Table.Th>20日</Table.Th><Table.Th>胜率</Table.Th><Table.Th>超额</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.key || row[labelKey]}>
            <Table.Td>{row[labelKey]}</Table.Td>
            <Table.Td>{row.count}</Table.Td>
            <Table.Td><ToneText value={row.avg} /></Table.Td>
            <Table.Td>{pct(row.winRate, 1)}</Table.Td>
            <Table.Td><ToneText value={row.marketExcessAvg} /></Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function MetricMini({ label, value }: { label: string; value: unknown }) {
  return <Paper p="md" withBorder radius="md"><Text c="dimmed" size="sm">{label}</Text><Text fw={900} size="xl">{String(value ?? "-")}</Text></Paper>;
}

function EmptyState({ text }: { text: string }) {
  return (
    <Paper className="emptyState" radius="md">
      <ThemeIcon variant="light" color="blue"><IconRocket size={18} /></ThemeIcon>
      <Text c="dimmed">{text}</Text>
    </Paper>
  );
}

export function App() {
  const initial = useMemo(readInitialState, []);
  const [date, setDate] = useState(initial.date);
  const [strict, setStrict] = useState(initial.strict);
  const [source, setSource] = useState(initial.source);
  const [strategy, setStrategy] = useState(initial.strategy);
  const [evaluationOpen, setEvaluationOpen] = useState(false);
  const [attributionOpen, setAttributionOpen] = useState(false);
  const queryClient = useQueryClient();

  const commonKey = [source, strategy, strict] as const;
  const overviewQuery = useQuery({
    queryKey: ["overview", source, strategy],
    queryFn: () => requestJson(`/api/overview?${apiQuery({ source, strategy })}`),
  });
  const timelineQuery = useQuery({
    queryKey: ["timeline", ...commonKey],
    queryFn: () => requestJson<AnyRecord[]>(`/api/timeline?${apiQuery({ strict, source, strategy })}`),
  });
  const dailyQuery = useQuery({
    queryKey: ["daily", date, ...commonKey],
    queryFn: () => requestJson(`/api/daily?${apiQuery({ date, strict, source, strategy })}`),
  });
  const evaluationQuery = useQuery({
    queryKey: ["evaluation", ...commonKey],
    queryFn: () => requestJson(`/api/evaluation?${apiQuery({ strict, source, strategy })}`),
  });

  const daily = dailyQuery.data;
  const overview = overviewQuery.data;
  const loading = overviewQuery.isFetching || timelineQuery.isFetching || dailyQuery.isFetching;

  useEffect(() => {
    if (!daily?.selectedDate) return;
    const url = new URL(window.location.href);
    url.searchParams.set("date", daily.requestedDate || daily.selectedDate);
    url.searchParams.set("strict", strict ? "1" : "0");
    url.searchParams.set("source", source);
    url.searchParams.set("strategy", strategy);
    window.history.replaceState({}, "", url);
    if (!date) setDate(daily.selectedDate);
  }, [daily?.selectedDate, daily?.requestedDate, strict, source, strategy]);

  useEffect(() => {
    if (!overview?.availableStrategies?.length) return;
    if (!overview.availableStrategies.some((item: AnyRecord) => item.key === strategy)) {
      setStrategy(overview.availableStrategies[0].key);
    }
  }, [overview?.generatedAt, source]);

  function refreshAll() {
    queryClient.invalidateQueries();
  }

  function moveDate(step: number) {
    const dates = daily?.tradingDates?.length ? daily.tradingDates : daily?.availableDates || [];
    const current = date || daily?.selectedDate;
    if (!dates.length || !current) return;
    const exact = dates.indexOf(current);
    const next = exact >= 0 ? dates[exact + step] : step > 0 ? dates.find((item: string) => item > current) : dates.filter((item: string) => item < current).at(-1);
    if (next) setDate(next);
  }

  function verifyFromStock(code: string, signalDate: string) {
    const verifier = (window as any).__bewinVerify;
    if (typeof verifier === "function") verifier(code, signalDate);
    window.requestAnimationFrame(() => document.getElementById("positionVerifier")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const error = overviewQuery.error || dailyQuery.error || timelineQuery.error;

  return (
    <Box className="appShell">
      <AppShellHeader
        date={date}
        setDate={setDate}
        daily={daily}
        overview={overview}
        strict={strict}
        setStrict={setStrict}
        source={source}
        setSource={setSource}
        moveDate={moveDate}
        refresh={refreshAll}
        loading={loading}
      />

      {loading ? (
        <div className="pageLoading"><Loader size="sm" /><span>数据刷新中...</span></div>
      ) : null}

      <main className="dashboardGrid">
        <section className="mainColumn">
          {error ? <Alert color="red" icon={<IconAlertTriangle size={18} />}>{error instanceof Error ? error.message : "加载失败"}</Alert> : null}
          <DateBanner daily={daily} />
          <Metrics daily={daily} />
          <DailyCandidates daily={daily} loading={dailyQuery.isFetching} refresh={refreshAll} onVerify={verifyFromStock} />
          <div id="positionVerifier"><PositionVerifier selectedDate={daily?.selectedDate} /></div>
          <SimpleGrid cols={{ base: 1, lg: 2 }}>
            <BoardsPanel boards={daily?.boards || []} />
            <StockLookup
              source={source}
              strategy={strategy}
              strict={strict}
              onOpenSignal={(signalDate: string, code: string) => {
                setDate(signalDate);
                setTimeout(() => verifyFromStock(code, signalDate), 100);
              }}
            />
          </SimpleGrid>
        </section>

        <aside className="sideColumn">
          <TimelinePanel rows={timelineQuery.data || []} selectedDate={daily?.selectedDate} setDate={setDate} />
          <StrategyPanel
            overview={overview}
            strategy={strategy}
            setStrategy={setStrategy}
            source={source}
            openEvaluation={() => setEvaluationOpen(true)}
            openAttribution={() => setAttributionOpen(true)}
            onSaved={(nextStrategy: string) => {
              setStrategy(nextStrategy);
              refreshAll();
            }}
          />
        </aside>
      </main>

      <EvaluationModal opened={evaluationOpen} onClose={() => setEvaluationOpen(false)} evaluation={evaluationQuery.data} />
      <AttributionModal opened={attributionOpen} onClose={() => setAttributionOpen(false)} evaluation={evaluationQuery.data} />
    </Box>
  );
}
