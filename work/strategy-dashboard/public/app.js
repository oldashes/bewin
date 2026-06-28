const state = {
  availableDates: [],
  tradingDates: [],
  selectedDate: null,
  strict: true,
  dataSource: "em",
  strategy: "early",
  focusCode: null,
  timeline: [],
  availableStrategies: [],
  strategyParamDefs: [],
  currentStrategy: null,
};

const els = {
  sourceLabel: document.querySelector("#sourceLabel"),
  rangeLabel: document.querySelector("#rangeLabel"),
  dateInput: document.querySelector("#dateInput"),
  dataSourceSelect: document.querySelector("#dataSourceSelect"),
  strategySelect: document.querySelector("#strategySelect"),
  prevDate: document.querySelector("#prevDate"),
  nextDate: document.querySelector("#nextDate"),
  latestDate: document.querySelector("#latestDate"),
  strictToggle: document.querySelector("#strictToggle"),
  refreshButton: document.querySelector("#refreshButton"),
  metricCount: document.querySelector("#metricCount"),
  metricMatured: document.querySelector("#metricMatured"),
  metricBoards: document.querySelector("#metricBoards"),
  metricRet5: document.querySelector("#metricRet5"),
  metricWin5: document.querySelector("#metricWin5"),
  metricRet20: document.querySelector("#metricRet20"),
  metricWin20: document.querySelector("#metricWin20"),
  signalFirst: document.querySelector("#signalFirst"),
  signalContinuation: document.querySelector("#signalContinuation"),
  signalWait: document.querySelector("#signalWait"),
  signalHeat: document.querySelector("#signalHeat"),
  signalHeatDetail: document.querySelector("#signalHeatDetail"),
  signalConfirm: document.querySelector("#signalConfirm"),
  evaluationSubtitle: document.querySelector("#evaluationSubtitle"),
  evaluationRefresh: document.querySelector("#evaluationRefresh"),
  evaluationBody: document.querySelector("#evaluationBody"),
  dailyTitle: document.querySelector("#dailyTitle"),
  dailySubtitle: document.querySelector("#dailySubtitle"),
  stockRows: document.querySelector("#stockRows"),
  emptyState: document.querySelector("#emptyState"),
  boardList: document.querySelector("#boardList"),
  timeline: document.querySelector("#timeline"),
  ruleTitle: document.querySelector("#ruleTitle"),
  ruleList: document.querySelector("#ruleList"),
  ruleNote: document.querySelector("#ruleNote"),
  strategyNameInput: document.querySelector("#strategyNameInput"),
  strategyParamGrid: document.querySelector("#strategyParamGrid"),
  strategyEditMode: document.querySelector("#strategyEditMode"),
  saveStrategyButton: document.querySelector("#saveStrategyButton"),
  resetStrategyButton: document.querySelector("#resetStrategyButton"),
  strategySaveStatus: document.querySelector("#strategySaveStatus"),
  verifyCode: document.querySelector("#verifyCode"),
  verifyDate: document.querySelector("#verifyDate"),
  verifyEntry: document.querySelector("#verifyEntry"),
  verifyButton: document.querySelector("#verifyButton"),
  verifyResult: document.querySelector("#verifyResult"),
  lookupInput: document.querySelector("#lookupInput"),
  lookupButton: document.querySelector("#lookupButton"),
  lookupResult: document.querySelector("#lookupResult"),
  dateStatusBanner: document.querySelector("#dateStatusBanner"),
  tablePanel: document.querySelector(".tablePanel"),
};

function html(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pct(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "未到期";
  return `${(value * 100).toFixed(digits)}%`;
}

function signedPct(value, digits = 2, fallback = "-") {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

function pctValue(value, digits = 2, fallback = "-") {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return `${(value * 100).toFixed(digits)}%`;
}

function number(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(digits);
}

function price(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toFixed(2);
}

function pctClass(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "neutral";
  if (value > 0) return "up";
  if (value < 0) return "down";
  return "neutral";
}

function returnCell(value) {
  const pending = value === null || value === undefined || Number.isNaN(value);
  const cls = pending ? "returnCell pending" : `returnCell ${pctClass(value)}`;
  return `<span class="${cls}">${pct(value)}</span>`;
}

function skeletonRows(count = 5) {
  return Array.from({ length: count }, () => `
    <tr class="skeletonRow">
      <td><span class="skeleton wide"></span></td>
      <td><span class="skeleton mid"></span></td>
      <td><span class="skeleton mid"></span></td>
      <td><span class="skeleton short"></span></td>
      <td><span class="skeleton short"></span></td>
      <td><span class="skeleton short"></span></td>
      <td><span class="skeleton short"></span></td>
      <td><span class="skeleton mid"></span></td>
      <td><span class="skeleton short"></span></td>
      <td><span class="skeleton short"></span></td>
      <td><span class="skeleton short"></span></td>
      <td><span class="skeleton short"></span></td>
      <td><span class="skeleton short"></span></td>
    </tr>
  `).join("");
}

function setTableLoading(loading) {
  if (!els.tablePanel) return;
  els.tablePanel.classList.toggle("isLoading", loading);
  if (loading) {
    els.stockRows.innerHTML = skeletonRows();
    els.emptyState.hidden = true;
  }
}

function boardTypeLabel(type) {
  return type === "industry" ? "行业" : "概念";
}

function quoteUrl(stock) {
  return `https://quote.eastmoney.com/${String(stock.em || "").toLowerCase()}.html`;
}

function renderMetaChips(meta = {}) {
  const tags = Array.isArray(meta.tags) ? meta.tags : [];
  if (!tags.length) return '<span class="chip">未分类</span>';
  return tags
    .slice(0, 5)
    .map((tag) => {
      const important = /无涨跌幅|新股|次新股|北交|科创|创业|ST/.test(tag);
      return `<span class="chip ${important ? "warn" : ""}">${html(tag)}</span>`;
    })
    .join("");
}

function renderSignalChips(insight = {}) {
  const tags = Array.isArray(insight.tags) ? insight.tags : [];
  if (!tags.length) return '<span class="chip">无提示</span>';
  return tags
    .slice(0, 5)
    .map((tag) => {
      const tone = /等待|加速|偏热|延续/.test(tag) ? "warn" : /确认|直接走强/.test(tag) ? "good" : "";
      return `<span class="chip ${tone}">${html(tag)}</span>`;
    })
    .join("");
}

async function getJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }
  return response.json();
}

function query(date = state.selectedDate) {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  params.set("strict", state.strict ? "true" : "false");
  params.set("source", state.dataSource);
  params.set("strategy", state.strategy);
  return params.toString();
}

async function loadOverview() {
  const overview = await getJson(`/api/overview?source=${encodeURIComponent(state.dataSource)}&strategy=${encodeURIComponent(state.strategy)}`);
  state.availableStrategies = overview.availableStrategies || [];
  state.strategyParamDefs = overview.strategyParamDefs || [];
  state.currentStrategy = overview.dataStrategy || null;
  renderStrategyOptions();
  renderStrategyEditor(state.currentStrategy);
  const sourceName = overview.dataSource?.shortLabel || overview.dataSource?.label || "数据源";
  const strategyName = overview.dataStrategy?.shortLabel || overview.dataSource?.strategy?.shortLabel || "策略";
  els.sourceLabel.textContent = `${sourceName} · ${strategyName} · ${overview.strictCount ? `${overview.strictCount} 条样本` : "暂无样本"}`;
  els.rangeLabel.textContent = overview.minDate && overview.maxDate ? `${overview.minDate} 至 ${overview.maxDate}` : "待积累";
  const minDate = overview.tradingMinDate || overview.minDate;
  const maxDate = overview.tradingMaxDate || overview.maxDate;
  if (minDate) els.dateInput.min = minDate;
  else els.dateInput.removeAttribute("min");
  if (maxDate) els.dateInput.max = maxDate;
  else els.dateInput.removeAttribute("max");
}

function renderStrategyOptions() {
  if (!els.strategySelect || !state.availableStrategies.length) return;
  const current = state.strategy;
  const groups = [
    ["内置策略", state.availableStrategies.filter((item) => !item.custom)],
    ["自定义策略", state.availableStrategies.filter((item) => item.custom)],
  ];
  els.strategySelect.innerHTML = groups
    .filter(([, items]) => items.length)
    .map(
      ([label, items]) => `
        <optgroup label="${html(label)}">
          ${items.map((item) => `<option value="${html(item.key)}">${html(item.shortLabel || item.label)}</option>`).join("")}
        </optgroup>
      `,
    )
    .join("");
  if (state.availableStrategies.some((item) => item.key === current)) {
    els.strategySelect.value = current;
  } else {
    state.strategy = state.availableStrategies[0]?.key || "early";
    els.strategySelect.value = state.strategy;
  }
}

async function loadTimeline() {
  state.timeline = await getJson(
    `/api/timeline?strict=${state.strict ? "true" : "false"}&source=${encodeURIComponent(state.dataSource)}&strategy=${encodeURIComponent(state.strategy)}`,
  );
  renderTimeline();
}

async function loadEvaluation() {
  if (!els.evaluationBody) return;
  els.evaluationBody.innerHTML = '<div class="emptyState">测评计算中...</div>';
  try {
    const payload = await getJson(
      `/api/evaluation?strict=${state.strict ? "true" : "false"}&source=${encodeURIComponent(state.dataSource)}&strategy=${encodeURIComponent(state.strategy)}`,
    );
    renderEvaluation(payload);
  } catch (error) {
    els.evaluationBody.innerHTML = `<div class="emptyState">测评失败：${html(error.message)}</div>`;
  }
}

async function loadDaily(date) {
  setTableLoading(true);
  try {
    const payload = await getJson(`/api/daily?${query(date)}`);
    state.availableDates = payload.availableDates;
    state.tradingDates = payload.tradingDates || payload.availableDates;
    state.selectedDate = payload.selectedDate;
    els.dateInput.value = payload.requestedDate || payload.selectedDate || "";
    renderDaily(payload);
    renderDateBanner(payload);
    renderTimeline();
    updateUrl(payload.requestedDate || payload.selectedDate);
    focusStockRow();
  } finally {
    setTableLoading(false);
  }
}

function updateUrl(date) {
  if (!date) return;
  const url = new URL(window.location.href);
  url.searchParams.set("date", date);
  url.searchParams.set("strict", state.strict ? "1" : "0");
  url.searchParams.set("source", state.dataSource);
  url.searchParams.set("strategy", state.strategy);
  window.history.replaceState({}, "", url);
}

function renderDaily(payload) {
  const { stats, boards, stocks } = payload;
  const signalStats = payload.signalStats || {};
  renderRule(payload.dataStrategy || payload.dataSource?.strategy);
  els.metricCount.textContent = stats.count;
  els.metricMatured.textContent = `${stats.matured5} 个已有5日结果，${stats.matured20} 个已有20日结果`;
  els.metricBoards.textContent = boards.length;
  els.metricRet5.innerHTML = `<span class="${pctClass(stats.avgRet5)}">${pct(stats.avgRet5)}</span>`;
  els.metricWin5.textContent = `胜率 ${pct(stats.win5, 1)}，中位数 ${pct(stats.medianRet5)}`;
  els.metricRet20.innerHTML = `<span class="${pctClass(stats.avgRet20)}">${pct(stats.avgRet20)}</span>`;
  els.metricWin20.textContent = `胜率 ${pct(stats.win20, 1)}，中位数 ${pct(stats.medianRet20)}`;
  els.signalFirst.textContent = `${signalStats.first ?? 0} / ${signalStats.continuation ?? 0}`;
  els.signalContinuation.textContent = "首次 / 延续";
  els.signalWait.textContent = signalStats.waitForConfirm ?? 0;
  els.signalHeat.textContent = `${signalStats.accelerated ?? 0} / ${signalStats.boardHot ?? 0}`;
  els.signalHeatDetail.textContent = "个股已加速 / 板块偏热";
  els.signalConfirm.textContent = `${signalStats.confirmed ?? 0} + ${signalStats.direct ?? 0}`;

  els.dailyTitle.textContent = `${payload.selectedDate || "-"} 每日候选`;
  if (!els.verifyDate.value && payload.selectedDate) els.verifyDate.value = payload.selectedDate;
  els.dailySubtitle.textContent = dateStatusText(payload);

  els.stockRows.innerHTML = stocks.map(renderStockRow).join("");
  els.emptyState.hidden = stocks.length > 0;
  renderBoards(boards);
  updateNavButtons();
}

function dateStatusText(payload) {
  if (payload.dataSource?.available === false) {
    return payload.dataSource.message || `${payload.dataSource.label || "当前数据源"}暂无可用历史数据。`;
  }
  const status = payload.dateStatus || {};
  const requestedDate = payload.requestedDate;
  if (!requestedDate) return payload.rule;
  if (status.isTradingDate === false) {
    return `${requestedDate} 不是 A 股交易日，当前展示相邻交易日 ${payload.selectedDate || "-"}${
      status.previousTradingDate ? `；上一交易日 ${status.previousTradingDate}` : ""
    }${status.nextTradingDate ? `；下一交易日 ${status.nextTradingDate}` : ""}`;
  }
  if (!status.hasSignal) {
    return `${requestedDate} 是 A 股交易日，但没有符合当前策略的候选${
      status.previousSignalDate ? `；上一信号日 ${status.previousSignalDate}` : ""
    }${status.nextSignalDate ? `；下一信号日 ${status.nextSignalDate}` : ""}`;
  }
  return payload.rule;
}

function renderDateBanner(payload) {
  if (!els.dateStatusBanner) return;
  if (payload.dataSource?.available === false) {
    els.dateStatusBanner.hidden = false;
    els.dateStatusBanner.className = "dateStatusBanner warn";
    els.dateStatusBanner.innerHTML = `
      <div class="bannerInner">
        <span class="bannerIcon">⚠</span>
        <span>${html(payload.dataSource.message || "当前数据源暂无可用历史数据。")}</span>
      </div>
    `;
    return;
  }

  const status = payload.dateStatus || {};
  const requestedDate = payload.requestedDate;
  if (!requestedDate || (status.isTradingDate !== false && status.hasSignal !== false)) {
    els.dateStatusBanner.hidden = true;
    els.dateStatusBanner.innerHTML = "";
    return;
  }

  const tone = status.isTradingDate === false ? "info" : "warn";
  const message = dateStatusText(payload);
  els.dateStatusBanner.hidden = false;
  els.dateStatusBanner.className = `dateStatusBanner ${tone}`;
  els.dateStatusBanner.innerHTML = `
    <div class="bannerInner">
      <span class="bannerIcon">${tone === "info" ? "ℹ" : "⚠"}</span>
      <span>${html(message)}</span>
    </div>
  `;
}

function renderRule(strategy = {}) {
  const name = strategy.label || "策略规则";
  const items = Array.isArray(strategy.ruleItems) && strategy.ruleItems.length ? strategy.ruleItems : [];
  els.ruleTitle.textContent = name;
  els.ruleList.innerHTML = items.map((item) => `<span>${html(item)}</span>`).join("");
  els.ruleNote.textContent =
    strategy.note ||
    "这里展示的是策略候选和事后验证，不等同于买卖建议。最近日期的 10 日、20 日结果可能还没有到期。";
}

function strategyDisplayName(strategy = {}) {
  return strategy.custom ? strategy.label || "我的策略" : `${strategy.shortLabel || strategy.label || "策略"} 调整版`;
}

function renderStrategyEditor(strategy = state.currentStrategy || {}) {
  if (!els.strategyParamGrid) return;
  const params = strategy.params || {};
  els.strategyNameInput.value = strategyDisplayName(strategy);
  els.strategyEditMode.textContent = strategy.custom ? "保存后更新当前自定义策略" : "保存后生成自定义策略";
  els.strategyParamGrid.innerHTML = (state.strategyParamDefs || [])
    .map((def) => {
      const value = params[def.key];
      if (def.type === "boolean") {
        return `
          <label class="paramToggle">
            <input data-param="${html(def.key)}" type="checkbox" ${value ? "checked" : ""} />
            <span>${html(def.label)}</span>
            <small>${html(def.help || "")}</small>
          </label>
        `;
      }
      return `
        <div class="field paramField">
          <label for="param-${html(def.key)}">${html(def.label)}</label>
          <input
            id="param-${html(def.key)}"
            data-param="${html(def.key)}"
            type="number"
            min="${html(def.min ?? "")}"
            max="${html(def.max ?? "")}"
            step="${html(def.step ?? (def.type === "integer" ? 1 : 0.01))}"
            value="${html(value ?? "")}"
            title="${html(def.help || "")}"
          />
        </div>
      `;
    })
    .join("");
  els.strategySaveStatus.textContent = "";
}

function readStrategyParamsFromEditor() {
  const params = {};
  for (const input of els.strategyParamGrid.querySelectorAll("[data-param]")) {
    const key = input.dataset.param;
    params[key] = input.type === "checkbox" ? input.checked : Number(input.value);
  }
  return params;
}

async function saveStrategyFromEditor() {
  if (!els.strategyParamGrid) return;
  const current = state.currentStrategy || {};
  const customId = current.custom ? current.id || state.strategy.replace(/^custom:/, "") : "";
  els.strategySaveStatus.textContent = "保存中...";
  els.saveStrategyButton.disabled = true;
  try {
    const payload = await postJson(`/api/strategy-configs?source=${encodeURIComponent(state.dataSource)}`, {
      id: customId || undefined,
      source: state.dataSource,
      baseStrategy: current.custom ? "early" : current.key || state.strategy,
      name: els.strategyNameInput.value,
      description: current.custom ? current.description || "" : `${current.label || "内置策略"} 的自定义参数版本`,
      params: readStrategyParamsFromEditor(),
    });
    state.strategy = payload.strategy?.key || `custom:${payload.config.id}`;
    els.strategySaveStatus.textContent = "已保存，正在重算...";
    await reloadAll(state.selectedDate);
    els.strategySaveStatus.textContent = "已保存并重算";
  } catch (error) {
    els.strategySaveStatus.textContent = `保存失败：${error.message}`;
  } finally {
    els.saveStrategyButton.disabled = false;
  }
}

function renderStockRow(stock) {
  const flags = stock.riskFlags?.length
    ? stock.riskFlags.map((flag) => `<span class="chip warn">${html(flag)}</span>`).join("")
    : '<span class="chip">正常</span>';
  const rankDelta = stock.rank20 && stock.rank ? stock.rank20 - stock.rank : null;
  const scoreText =
    stock.modelScore !== null && stock.modelScore !== undefined
      ? `模型 ${Math.round(stock.modelScore)} / 评分 ${stock.score}`
      : `评分 ${stock.score}`;
  return `
    <tr data-code="${html(stock.code)}" class="${state.focusCode === stock.code ? "focusedRow" : ""}">
      <td>
        <div class="stockName">
          <a href="${quoteUrl(stock)}" target="_blank" rel="noreferrer">${html(stock.name)}</a>
          <small>${html(stock.code)} / ${html(stock.source)} / ${scoreText}</small>
        </div>
      </td>
      <td>
        <div class="signalCell">
          <div class="chipRow signalChips">${renderSignalChips(stock.signalInsight)}</div>
          <small>${html(stock.signalInsight?.actionHint || "-")}</small>
          ${
            stock.signalInsight?.secondary?.status && stock.signalInsight.secondary.status !== "无需等待"
              ? `<small>${html(stock.signalInsight.secondary.status)}${stock.signalInsight.secondary.date ? `：${html(stock.signalInsight.secondary.date)}` : ""}</small>`
              : ""
          }
        </div>
      </td>
      <td><div class="chipRow metaChips">${renderMetaChips(stock.meta)}</div></td>
      <td><button class="miniButton verifyStock" data-code="${html(stock.code)}" data-date="${html(stock.signalDate)}" type="button">验证</button></td>
      <td><div class="rankCell"><span>${stock.rank ?? "-"}</span><span class="score">+${rankDelta ?? "-"}</span></div></td>
      <td>${stock.rank20 ?? "-"}</td>
      <td>${number(stock.amountRatio)}x</td>
      <td>${html(stock.bestBoardName)} <span class="neutral">(${boardTypeLabel(stock.bestBoardType)})</span></td>
      <td><span class="${pctClass(stock.bestBoardRet5)}">${pctValue(stock.bestBoardRet5)}</span></td>
      <td>${returnCell(stock.ret5)}</td>
      <td>${returnCell(stock.ret10)}</td>
      <td>${returnCell(stock.ret20)}</td>
      <td><div class="chipRow">${flags}</div></td>
    </tr>
  `;
}

function focusStockRow() {
  if (!state.focusCode) return;
  requestAnimationFrame(() => {
    const row = els.stockRows.querySelector(`tr[data-code="${CSS.escape(state.focusCode)}"]`);
    if (row) row.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function horizonLabel(days) {
  if (days === 5) return "1周";
  if (days === 10) return "2周";
  return `${days}日`;
}

function normalizeVerifyHorizons(horizons = []) {
  const result = [];
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
      continue;
    }
    if (/周/.test(item.label || "") && !/周/.test(existing.label || "")) {
      const index = result.indexOf(existing);
      if (index >= 0) result[index] = item;
      byDays.set(item.days, item);
    }
  }
  return result;
}

async function verifyPosition(code = els.verifyCode.value, date = els.verifyDate.value) {
  const cleanCode = String(code || "").trim();
  if (!cleanCode || !date) {
    els.verifyResult.innerHTML = '<div class="emptyVerify">请先输入股票代码和买入日期。</div>';
    return;
  }
  els.verifyCode.value = cleanCode;
  els.verifyDate.value = date;
  els.verifyResult.innerHTML = '<div class="emptyVerify">计算中...</div>';
  const params = new URLSearchParams({
    code: cleanCode,
    date,
    entry: els.verifyEntry.value,
  });
  try {
    const payload = await getJson(`/api/position?${params.toString()}`);
    renderVerifyResult(payload);
  } catch (error) {
    els.verifyResult.innerHTML = `<div class="emptyVerify">计算失败：${html(error.message)}</div>`;
  }
}

async function lookupStockSignals(value = els.lookupInput.value) {
  const keyword = String(value || "").trim();
  if (!keyword) {
    els.lookupResult.innerHTML = '<div class="emptyVerify">请输入股票代码或名称。</div>';
    return;
  }
  els.lookupInput.value = keyword;
  els.lookupResult.innerHTML = '<div class="emptyVerify">查询中...</div>';
  const params = new URLSearchParams({
    q: keyword,
    strict: state.strict ? "true" : "false",
    source: state.dataSource,
    strategy: state.strategy,
  });
  try {
    const payload = await getJson(`/api/stock-signals?${params.toString()}`);
    renderLookupResult(payload);
  } catch (error) {
    els.lookupResult.innerHTML = `<div class="emptyVerify">查询失败：${html(error.message)}</div>`;
  }
}

function renderLookupResult(payload) {
  if (!payload.count) {
    els.lookupResult.innerHTML = `<div class="emptyVerify">${html(payload.message || "没有查到历史信号。")}</div>`;
    return;
  }
  const sourceName = payload.dataSource?.shortLabel || payload.dataSource?.label || "当前数据源";
  const cards = payload.matches
    .map(
      (item) => `
        <article class="signalHitCard">
          <div class="signalHitTop">
            <button class="miniButton openSignal" type="button" data-date="${html(item.signalDate)}" data-code="${html(item.code)}">查看</button>
            <div class="signalHitDate">
              <strong>${html(item.signalDate)}</strong>
              <small>${html(item.source)}</small>
            </div>
            <div class="stockName">
              <a href="${quoteUrl(item)}" target="_blank" rel="noreferrer">${html(item.name)}</a>
              <small>${html(item.code)} / ${Math.round(item.modelScore ?? item.score ?? 0)} 分</small>
            </div>
          </div>
          <div class="chipRow signalChips">${renderSignalChips(item.signalInsight)}</div>
          <div class="signalHitFacts">
            <span>人气 <b>${item.rank ?? "-"}</b></span>
            <span>上移 <b>${item.rankDelta !== null && item.rankDelta !== undefined ? `+${item.rankDelta}` : "-"}</b></span>
            <span>量能 <b>${number(item.amountRatio)}x</b></span>
            <span>板块 <b>${html(item.bestBoardName)}</b><em>${boardTypeLabel(item.bestBoardType)}</em></span>
            <span>5日 <b class="${pctClass(item.ret5)}">${pct(item.ret5)}</b></span>
            <span>10日 <b class="${pctClass(item.ret10)}">${pct(item.ret10)}</b></span>
            <span>20日 <b class="${pctClass(item.ret20)}">${pct(item.ret20)}</b></span>
          </div>
        </article>
      `,
    )
    .join("");

  els.lookupResult.innerHTML = `
    <div class="lookupSummary">
      <div>
        <strong>${html(payload.query)} 在 ${html(sourceName)} 命中 ${payload.count} 次</strong>
        <small>覆盖 ${payload.signalDateCount} 个信号日，首次 ${payload.firstDate}，最近 ${payload.latestDate}</small>
      </div>
      <div class="lookupStats">
        <span>5日均值 <b class="${pctClass(payload.stats.avgRet5)}">${pct(payload.stats.avgRet5)}</b></span>
        <span>20日均值 <b class="${pctClass(payload.stats.avgRet20)}">${pct(payload.stats.avgRet20)}</b></span>
      </div>
    </div>
    <div class="signalHitList">${cards}</div>
  `;
}

function renderVerifyResult(payload) {
  const horizons = normalizeVerifyHorizons(payload.horizons);
  const current = horizons.find((item) => item.current);
  const timed = horizons.filter((item) => !item.current);

  const renderHorizonCard = (item) => {
    const tone = pctClass(item.return);
    return `
      <article class="verifyCard ${item.current ? "current" : ""} ${tone}">
        <header class="verifyCardHead">
          <span>${html(item.label || horizonLabel(item.days))}</span>
          ${item.exitDate ? `<small>${html(item.exitDate)}</small>` : `<small>${html(item.status || "")}</small>`}
        </header>
        <strong class="verifyCardReturn ${tone}">${pct(item.return)}</strong>
        <footer class="verifyCardFoot">
          <span>收盘 <b>${price(item.exitClose)}</b></span>
          <span>当日涨跌 <b class="${pctClass(item.dayReturn)}">${signedPct(item.dayReturn)}</b></span>
          <span>最高浮盈 <b class="${pctClass(item.maxReturn)}">${pct(item.maxReturn)}</b></span>
          <span>最大回撤 <b class="${pctClass(item.maxDrawdown)}">${pct(item.maxDrawdown)}</b></span>
        </footer>
      </article>
    `;
  };

  const renderGroup = (title, items) => {
    if (!items.length) return "";
    return `
      <div class="verifyGroup">
        <div class="verifyGroupHead">${html(title)}</div>
        <div class="verifyCards">${items.map(renderHorizonCard).join("")}</div>
      </div>
    `;
  };

  els.verifyResult.innerHTML = `
    <div class="verifyHero">
      <div class="verifyHeroMain">
        <div class="verifyHeroTitle">
          <strong>${html(payload.name)}</strong>
          <span class="verifyHeroCode">${html(payload.code)}</span>
        </div>
        <div class="verifyHeroMeta">
          <span>${html(payload.entryModeLabel)}</span>
          <span>买入 ${html(payload.entryDate)}</span>
          <span>价格 ${price(payload.entryPrice)}</span>
          ${payload.latestDate ? `<span>最新 ${html(payload.latestDate)}</span>` : ""}
        </div>
        <div class="chipRow verifyMeta">${renderMetaChips(payload.meta)}</div>
      </div>
      <div class="verifyHeroSide">
        ${
          current
            ? `
          <div class="verifyHeroReturn ${pctClass(current.return)}">
            <span>当前收益</span>
            <strong>${pct(current.return)}</strong>
            <small>${current.exitDate ? `${html(current.exitDate)} 收盘 ${price(current.exitClose)}` : html(current.status || "")}</small>
            <small>当日涨跌 <b class="${pctClass(current.dayReturn)}">${signedPct(current.dayReturn)}</b></small>
          </div>
        `
            : ""
        }
        <a class="verifyQuoteLink" href="${quoteUrl(payload)}" target="_blank" rel="noreferrer">查看行情</a>
      </div>
    </div>
    ${renderGroup("持有收益", timed)}
  `;
}

function metricValue(value, formatter = pct) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : formatter(value);
}

function ratioValue(value) {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : `${Number(value).toFixed(2)}x`;
}

function renderEvaluation(payload) {
  if (!els.evaluationBody) return;
  const strategyName = payload.dataStrategy?.shortLabel || payload.dataStrategy?.label || "当前策略";
  els.evaluationSubtitle.textContent = `${strategyName} · ${payload.sampleCount} 个样本 · ${payload.dateCount} 个信号日`;
  const horizonCards = (payload.horizons || [])
    .map(
      (item) => `
        <article class="evaluationCard">
          <header>
            <strong>${html(item.label)}</strong>
            <span>${item.maturedCount}/${item.sampleCount} 到期</span>
          </header>
          <div class="evaluationMain ${pctClass(item.avg)}">${metricValue(item.avg)}</div>
          <div class="evaluationGrid">
            <span>中位 <b class="${pctClass(item.median)}">${metricValue(item.median)}</b></span>
            <span>胜率 <b>${metricValue(item.winRate, (value) => pct(value, 1))}</b></span>
            <span>盈亏比 <b>${ratioValue(item.profitFactor)}</b></span>
            <span>赔率 <b>${ratioValue(item.payoffRatio)}</b></span>
            <span>最好 <b class="${pctClass(item.best)}">${metricValue(item.best)}</b></span>
            <span>最差 <b class="${pctClass(item.worst)}">${metricValue(item.worst)}</b></span>
          </div>
        </article>
      `,
    )
    .join("");
  const feature = payload.featureStats || {};
  const worst = payload.daily?.worst20?.[0] || payload.daily?.worst5?.[0] || null;
  const best = payload.daily?.best20?.[0] || payload.daily?.best5?.[0] || null;
  els.evaluationBody.innerHTML = `
    <div class="evaluationSummary">
      <div>
        <span>样本/日期</span>
        <strong>${payload.sampleCount} / ${payload.dateCount}</strong>
        <small>日均 ${number(payload.avgCandidatesPerDate, 1)} 只候选</small>
      </div>
      <div>
        <span>平均上移</span>
        <strong>${number(feature.avgRankDelta20, 0)}</strong>
        <small>中位 ${number(feature.medianRankDelta20, 0)}</small>
      </div>
      <div>
        <span>量能中位</span>
        <strong>${number(feature.medianAmountRatio)}x</strong>
        <small>板块5日中位 ${metricValue(feature.medianBoardRet5)}</small>
      </div>
      <div>
        <span>最好/最差日</span>
        <strong class="${pctClass(best?.avg)}">${best ? metricValue(best.avg) : "-"}</strong>
        <small>${best?.date || "-"} / ${worst?.date || "-"}</small>
      </div>
    </div>
    <div class="evaluationCards">${horizonCards}</div>
  `;
}

function renderBoards(boards) {
  if (!boards.length) {
    els.boardList.innerHTML = '<div class="emptyState">这一天没有板块聚合结果。</div>';
    return;
  }
  els.boardList.innerHTML = boards
    .map((board) => {
      const stocks = board.stocks
        .slice(0, 6)
        .map((stock) => `<span class="chip">${html(stock.name)}</span>`)
        .join("");
      return `
        <div class="boardItem">
          <div class="boardTitle">
            <strong>${html(board.name)}</strong>
            <small>${boardTypeLabel(board.type)} / ${board.stockCount} 只候选</small>
            <div class="chipRow">${stocks}</div>
          </div>
          <div class="boardStat">
            <span>板块5日</span>
            <strong class="${pctClass(board.boardRet5)}">${pctValue(board.boardRet5)}</strong>
          </div>
          <div class="boardStat">
            <span>量能</span>
            <strong>${number(board.boardAmountRatio)}x</strong>
          </div>
          <div class="boardStat">
            <span>20日表现</span>
            <strong class="${pctClass(board.avgRet20)}">${pct(board.avgRet20)}</strong>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderTimeline() {
  if (!state.timeline.length) {
    els.timeline.innerHTML = '<div class="emptyState">暂无历史记录。</div>';
    return;
  }
  const maxCount = Math.max(...state.timeline.map((row) => row.count), 1);
  const header = `
    <div class="timelineHeader">
      <span class="timelineHeadLabel">信号日期<button class="helpTip" type="button" data-tip="策略在该交易日生成候选股票的日期。点击某一行可以切换到该日详情。">?</button></span>
      <span class="timelineHeadLabel">候选数<button class="helpTip" type="button" data-tip="该信号日期下，满足当前过滤条件的候选股票数量。开启过滤伪板块时，伪概念板块会被排除。">?</button></span>
      <span class="timelineHeadLabel">候选强度<button class="helpTip" type="button" data-tip="按当前历史列表里最大候选数归一化后的条形图，用来观察每天信号密度，不代表收益强弱。">?</button></span>
      <span class="timelineHeadLabel">5日均值<button class="helpTip" type="button" data-tip="当日全部候选按信号次一交易日开盘买入、持有5个交易日收盘卖出的平均收益；未到期样本显示为未到期。">?</button></span>
      <span class="timelineHeadLabel">20日均值<button class="helpTip" type="button" data-tip="当日全部候选按信号次一交易日开盘买入、持有20个交易日收盘卖出的平均收益，用来观察中期兑现情况。">?</button></span>
    </div>
  `;
  const rows = state.timeline
    .slice()
    .reverse()
    .map((row) => {
      const active = row.date === state.selectedDate ? "active" : "";
      const width = Math.max(6, Math.round((row.count / maxCount) * 100));
      const boards = row.topBoards?.length ? row.topBoards.join("、") : "-";
      return `
        <div class="timelineRow ${active}" data-date="${row.date}" role="button" tabindex="0">
          <strong>${row.date}</strong>
          <span>${row.count} 只</span>
          <div title="${html(boards)}">
            <div class="barTrack"><div class="barFill" style="width:${width}%"></div></div>
          </div>
          <span class="${pctClass(row.avgRet5)}">${pct(row.avgRet5)}</span>
          <span class="${pctClass(row.avgRet20)}">${pct(row.avgRet20)}</span>
        </div>
      `;
    })
    .join("");
  els.timeline.innerHTML = header + rows;
}

function updateNavButtons() {
  const dates = state.tradingDates.length ? state.tradingDates : state.availableDates;
  const current = els.dateInput.value || state.selectedDate;
  const previous = adjacentCalendarDate(dates, current, -1);
  const next = adjacentCalendarDate(dates, current, 1);
  els.prevDate.disabled = !previous;
  els.nextDate.disabled = !next;
}

function moveDate(step) {
  const dates = state.tradingDates.length ? state.tradingDates : state.availableDates;
  const next = adjacentCalendarDate(dates, els.dateInput.value || state.selectedDate, step);
  if (next) loadDaily(next);
}

function adjacentCalendarDate(dates, current, step) {
  if (!dates.length || !current) return null;
  const exact = dates.indexOf(current);
  if (exact >= 0) return dates[exact + step] || null;
  if (step > 0) return dates.find((date) => date > current) || null;
  const earlier = dates.filter((date) => date < current);
  return earlier[earlier.length - 1] || null;
}

async function reloadAll(date = state.selectedDate) {
  await loadOverview();
  await loadTimeline();
  await loadEvaluation();
  await loadDaily(date);
}

function initEvents() {
  els.dateInput.addEventListener("change", () => loadDaily(els.dateInput.value));
  els.prevDate.addEventListener("click", () => moveDate(-1));
  els.nextDate.addEventListener("click", () => moveDate(1));
  els.latestDate.addEventListener("click", () =>
    loadDaily(state.availableDates[state.availableDates.length - 1] || els.dateInput.value || state.selectedDate),
  );
  els.dataSourceSelect.addEventListener("change", async () => {
    state.dataSource = els.dataSourceSelect.value;
    els.lookupResult.innerHTML = '<div class="emptyVerify">输入股票代码或名称，查看历史命中日期和后续收益。</div>';
    await reloadAll(els.dateInput.value || state.selectedDate);
  });
  els.strategySelect.addEventListener("change", async () => {
    state.strategy = els.strategySelect.value;
    els.lookupResult.innerHTML = '<div class="emptyVerify">策略模式已变化，请重新查询。</div>';
    await reloadAll(els.dateInput.value || state.selectedDate);
  });
  els.refreshButton.addEventListener("click", () => reloadAll(state.selectedDate));
  els.evaluationRefresh?.addEventListener("click", () => loadEvaluation());
  els.saveStrategyButton?.addEventListener("click", () => saveStrategyFromEditor());
  els.resetStrategyButton?.addEventListener("click", () => renderStrategyEditor(state.currentStrategy));
  const verifyForm = document.querySelector("#verifyForm");
  verifyForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    verifyPosition();
  });
  els.lookupButton.addEventListener("click", () => lookupStockSignals());
  els.lookupInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") lookupStockSignals();
  });
  els.lookupResult.addEventListener("click", async (event) => {
    const button = event.target.closest(".openSignal");
    if (!button) return;
    state.focusCode = button.dataset.code;
    await loadDaily(button.dataset.date);
  });
  els.strictToggle.addEventListener("change", async () => {
    state.strict = els.strictToggle.checked;
    els.lookupResult.innerHTML = '<div class="emptyVerify">过滤条件已变化，请重新查询。</div>';
    await reloadAll(state.selectedDate);
  });
  els.timeline.addEventListener("click", (event) => {
    const row = event.target.closest(".timelineRow");
    if (row?.dataset.date) loadDaily(row.dataset.date);
  });
  els.timeline.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const row = event.target.closest(".timelineRow");
    if (row?.dataset.date) loadDaily(row.dataset.date);
  });
  els.stockRows.addEventListener("click", (event) => {
    const button = event.target.closest(".verifyStock");
    if (!button) return;
    verifyPosition(button.dataset.code, button.dataset.date);
  });
}

async function boot() {
  initEvents();
  const params = new URLSearchParams(window.location.search);
  state.strict = params.get("strict") !== "0";
  state.dataSource = params.get("source") === "ths" ? "ths" : "em";
  state.strategy = params.get("strategy") || "early";
  els.strictToggle.checked = state.strict;
  els.dataSourceSelect.value = state.dataSource;
  els.strategySelect.value = state.strategy;
  const date = params.get("date");
  try {
    await reloadAll(date);
  } catch (error) {
    document.body.innerHTML = `<main class="layout"><section class="panel"><div class="emptyState">加载失败：${html(
      error.message,
    )}</div></section></main>`;
  }
}

boot();
