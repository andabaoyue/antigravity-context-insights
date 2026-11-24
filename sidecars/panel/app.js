// Context Insights Frontend Application
let currentRange = 'all';
let currentSort = 'recent';
let currentTypeFilter = 'all';
let selectedDate = null;
let searchQuery = '';
let searchDebounceTimer = null;
let cachedData = null;
let lastFetchAt = 0;
const expandedConvIds = new Set();

const svgIcon = (paths, size = 13) =>
  `<svg class="svg-icon" width="${size}" height="${size}" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const ICONS = {
  bot: svgIcon('<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/>', 12),
  link: svgIcon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', 12),
  compress: svgIcon('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>', 12),
  chart: svgIcon('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>', 13),
  clock: svgIcon('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>', 13),
  wrench: svgIcon('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>', 13),
  bolt: svgIcon('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>', 12),
  calendar: svgIcon('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>', 12),
  arrowUpRight: svgIcon('<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>', 12),
  chevronRight: svgIcon('<polyline points="9 18 15 12 9 6"/>', 12),
  chevronDown: svgIcon('<polyline points="6 9 12 15 18 9"/>', 12),
  close: svgIcon('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 11),
};

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Helpers: Unified B / M / k Token & Duration Formatting
function formatTokens(num) {
  if (!num || num <= 0) return '0';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'k';
  return num.toLocaleString();
}

function formatTokensCompact(num) {
  if (!num || num <= 0) return '0';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'k';
  return num.toLocaleString();
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalMin = Math.round(ms / 60000);
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours > 0) return `${hours}h${mins}m`;
  return `${mins}m`;
}

// Short spans (one model reply) — seconds, not minutes.
function formatShortMs(ms) {
  if (!ms || ms <= 0) return '--';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  return `${m}m${Math.round(sec % 60)}s`;
}

function formatDate(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${h}:${min}`;
}

function setTextAndTitle(id, text, titleText = text) {
  const el = document.getElementById(id);
  if (!el) return null;
  el.textContent = text;
  if (titleText) el.title = titleText;
  return el;
}

// Floating Tooltip Helpers (Never clipped, dynamic top/bottom flip)
function showFloatingTooltip(e, html) {
  const tip = document.getElementById('floatingTooltip');
  if (!tip) return;
  tip.innerHTML = html;
  tip.style.display = 'block';
  updateFloatingTooltipPos(e);
}

function updateFloatingTooltipPos(e) {
  const tip = document.getElementById('floatingTooltip');
  if (!tip || tip.style.display === 'none') return;
  const tipWidth = tip.offsetWidth || 160;
  const tipHeight = tip.offsetHeight || 65;

  let left = e.clientX - Math.round(tipWidth / 2);
  let top = e.clientY - tipHeight - 12;

  // Flip below cursor if too close to viewport top
  if (top < 15) {
    top = e.clientY + 18;
  }

  // Clamp horizontal position within viewport
  if (left < 10) left = 10;
  if (left + tipWidth > window.innerWidth - 10) {
    left = window.innerWidth - tipWidth - 10;
  }

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideFloatingTooltip() {
  const tip = document.getElementById('floatingTooltip');
  if (tip) tip.style.display = 'none';
}

// Data Fetching
async function fetchStats() {
  const currentConvId = window.sidecar ? window.sidecar.conversationId : null;
  const payload = { range: currentRange, currentConvId };
  const btnRefresh = document.getElementById('btnRefresh');
  if (btnRefresh) btnRefresh.classList.add('spinning');

  try {
    let res;
    if (window.sidecar && typeof window.sidecar.fetch === 'function') {
      res = await window.sidecar.fetch('/api/stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch('/api/stats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
    const data = await res.json();
    lastFetchAt = Date.now();
    cachedData = data;
    renderAll(data);
  } catch (err) {
    console.error('Failed to fetch stats:', err);
  } finally {
    if (btnRefresh) btnRefresh.classList.remove('spinning');
  }
}

// Render Master
function renderAll(data) {
  if (!data) return;
  hideFloatingTooltip();

  const kpis = data.kpis || {};
  const topModel = (data.modelCategories && data.modelCategories[0]) ? data.modelCategories[0] : null;

  // 1. KPIs
  document.getElementById('kpiActiveConvs').textContent = kpis.activeConversations || 0;
  setTextAndTitle(
    'kpiTotalConvs',
    `共 ${kpis.totalConversations || 0} 个 (主 ${kpis.mainConversationsCount || 0} / 子代理 ${kpis.subagentConversationsCount || 0})`
  );

  document.getElementById('kpiTokenLabel').textContent = '累计上下文消耗';
  const totalTokExact = `精确总量: ${(kpis.totalTokens || 0).toLocaleString()} tokens`;
  setTextAndTitle('kpiTotalTokens', formatTokensCompact(kpis.totalTokens), totalTokExact);

  const topModelText = topModel ? `${topModel.label}: ${formatTokensCompact(topModel.tokens)}` : `轮次 ${kpis.turnsCount || 0}`;
  setTextAndTitle('kpiTurns', `${topModelText} · 响应 ${(kpis.messagesCount || 0).toLocaleString()} 次`);

  const watermarkText = kpis.maxPeakContextTokens > 0
    ? `峰值水位 ${formatTokensCompact(kpis.maxPeakContextTokens)} · 压缩 ${kpis.totalCompactionEvents || 0} 次 (${kpis.compactedConversationsCount || 0} 会话)`
    : '峰值水位 -- · 压缩 0 次';
  setTextAndTitle('kpiWatermarkSummary', watermarkText);

  const hasPricedConvs = (kpis.pricedConvCount || 0) > 0;
  const activeConvs = kpis.activeConversations || 0;
  const kpiCostEl = document.getElementById('kpiCost');
  const grandUsdExact = kpis.costUsdExact ?? kpis.costUsd ?? 0;
  const grandYuanExact = kpis.costYuanExact ?? kpis.costYuan ?? 0;
  if (activeConvs > 0 && !hasPricedConvs) {
    kpiCostEl.textContent = '—';
    setTextAndTitle('kpiCostDetail', `未计价 (0/${activeConvs})`);
  } else {
    const showMicro = grandUsdExact > 0 && grandUsdExact < 10;
    const yuanText = showMicro ? grandYuanExact.toFixed(3) : (kpis.costYuan || 0).toFixed(2);
    kpiCostEl.textContent = showMicro ? `$${grandUsdExact.toFixed(3)}` : `$${(kpis.costUsd || 0).toFixed(2)}`;
    if ((kpis.unpricedTokens || 0) > 0) {
      setTextAndTitle('kpiCostDetail', `约 ¥${yuanText} · 覆盖 ${kpis.pricedTokenCoveragePct ?? 0}% (未计价 ${formatTokensCompact(kpis.unpricedTokens)})`);
    } else {
      setTextAndTitle('kpiCostDetail', `约 ¥${yuanText} · 已覆盖 ${kpis.pricedConvCount || 0}/${activeConvs} 会话`);
    }
  }
  const kpiCostCard = kpiCostEl.closest('.kpi-card');
  if (kpiCostCard) {
    if (hasPricedConvs) {
      const rate = kpis.usdCnyRate || 7.12;
      const baseUsd = kpis.baseCostUsd ?? grandUsdExact;
      const extraUsd = kpis.longContextExtraUsd || 0;
      const lcSteps = kpis.longContextSteps || 0;
      const tipLines = [
        `API 等效估算: $${grandUsdExact.toFixed(4)} (约 ¥${grandYuanExact.toFixed(4)}，汇率 ${rate})`,
        `基础计费: $${baseUsd.toFixed(4)} + >200K 长上下文加价: +$${extraUsd.toFixed(4)} (${lcSteps} 步)`,
        `Token 计价覆盖: ${kpis.pricedTokenCoveragePct ?? 100}% (${kpis.pricedConvCount || 0}/${activeConvs} 会话)`,
      ];
      const ps = kpis.pricingSync;
      if (ps) {
        if (ps.offline) {
          tipLines.push('价目来源: 内置官方价目表 (已开启离线模式)');
        } else if (ps.source === 'litellm' || ps.source === 'openrouter') {
          const label = ps.source === 'litellm' ? 'LiteLLM' : 'OpenRouter';
          const tsText = ps.updatedAt ? `更新于 ${formatDate(ps.updatedAt)}，` : '';
          tipLines.push(`价目来源: ${label} 自动同步 (${tsText}共 ${ps.modelCount || 0} 个模型)`);
        } else {
          tipLines.push('价目来源: 内置官方价目表 (离线兜底)');
        }
      }
      if ((kpis.unpricedTokens || 0) > 0) {
        const um = (kpis.unpricedModels || []).join(', ') || 'unknown';
        tipLines.push(`未计价: ${formatTokensCompact(kpis.unpricedTokens)} (${um})`);
      }
      kpiCostCard.title = tipLines.join('\n');
    } else {
      kpiCostCard.title = '暂无已计价模型消费';
    }
  }

  document.getElementById('kpiCacheRate').textContent = `${(kpis.cacheHitRate || 0).toFixed(1)}%`;
  setTextAndTitle(
    'kpiCacheTokens',
    `缓存读取 ${formatTokensCompact(kpis.cacheTokens || 0)}`,
    `缓存读取精确值: ${(kpis.cacheTokens || 0).toLocaleString()} tokens`
  );

  document.getElementById('kpiToolCalls').textContent = (kpis.toolCalls || 0).toLocaleString();
  setTextAndTitle('kpiToolTime', `模型生成 ${formatDuration(kpis.modelDurationMs)} · 工具 ${formatDuration(kpis.toolDurationMs)}`);
  setTextAndTitle(
    'kpiToolBreakdown',
    `文件与命令 ${(kpis.workToolCalls || 0).toLocaleString()} · 调度 ${(kpis.dispatchToolCalls || 0).toLocaleString()}`
  );

  document.getElementById('kpiDuration').textContent = formatDuration(kpis.activeDurationMs);
  const avgSpeed = kpis.generationSpeedTokPerSec || 0;
  setTextAndTitle(
    'kpiSpeed',
    avgSpeed > 0 ? `平均速率 ${avgSpeed} tok/s` : '平均速率 -- tok/s'
  );

  const lastEl = document.getElementById('kpiLastReply');
  const last = kpis.latestReply;
  if (lastEl) {
    if (last && last.tokPerSec > 0) {
      lastEl.classList.remove('muted');
      lastEl.textContent = `本次 ${last.tokPerSec} tok/s · ${formatShortMs(last.ms)}`;
      const parts = [
        `输出 ${last.out.toLocaleString()} tok`,
        last.think > 0 ? `其中思考 ${last.think.toLocaleString()}` : null,
        `模型 ${last.model || 'unknown'}`,
        `会话 ${last.convTitle || last.convId}`,
      ].filter(Boolean);
      lastEl.title = `最近一次回复：${formatShortMs(last.ms)}，${parts.join(' · ')}`;
    } else {
      lastEl.classList.add('muted');
      lastEl.textContent = '本次 -- tok/s';
      lastEl.title = '暂无单次回复的速率数据';
    }
  }

  setTextAndTitle('tokenTotalBadge', formatTokens(kpis.totalTokens), totalTokExact);
  document.getElementById('timeSpeedBadge').textContent = avgSpeed > 0 ? `${avgSpeed} tok/s` : '-- tok/s';

  const donutSubLabel = document.getElementById('donutSubLabel');
  if (donutSubLabel) {
    donutSubLabel.textContent = '全量上下文';
  }

  // 2. Daily Bar Chart (Dual bars)
  renderBarChart(data.timeline || []);

  // 3. Token & Model Donut Chart
  renderTokenAndModelChart(
    formatTokensCompact(kpis.totalTokens),
    data.tokenCategories || [],
    data.modelCategories || []
  );

  // 4. Time Donut Chart + Footer Stats
  renderDonutChart(
    'donutTimeSvg',
    'donutTimeCenter',
    'timeLegendList',
    formatDuration(kpis.activeDurationMs || 0),
    data.timeCategories || []
  );
  renderTimeBreakdownFooter(kpis);

  // 5. Activity Heatmap
  renderHeatmap(data.heatMap || {});

  // 6. Conversations List
  renderConversations(data.conversations || []);
}

// Render Token Donut (4 core components) + Separate Full Model Breakdown Section
function renderTokenAndModelChart(centerText, tokenCats, modelCats) {
  renderDonutChart('donutTokenSvg', 'donutTokenCenter', 'tokenLegendList', centerText, tokenCats);

  const section = document.getElementById('modelBreakdownSection');
  if (!section) return;

  const prevScrollEl = section.querySelector('.model-legend-scroll');
  const prevScrollTop = prevScrollEl ? prevScrollEl.scrollTop : 0;

  if (!modelCats || modelCats.length === 0) {
    section.style.display = 'none';
    section.innerHTML = '';
    return;
  }

  section.style.display = 'flex';
  section.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'model-breakdown-header';
  header.innerHTML = `<span>按模型消耗明细</span><span>共 ${modelCats.length} 个模型</span>`;
  section.appendChild(header);

  const scrollBox = document.createElement('div');
  scrollBox.className = 'model-legend-scroll';

  modelCats.forEach((m) => {
    const row = document.createElement('div');
    row.className = 'model-row-item';
    const costText = m.priced === false ? '—' : `$${m.costUsd}`;
    const barPct = m.tokens > 0 ? Math.max(m.percent || 0, 1) : 0;
    if (m.pricing) {
      const p = m.pricing;
      const lines = [
        `${m.label}${p.estimated ? ' (参考估算档)' : ''}`,
        `标准单价(/1M): 输入 $${p.in} · 输出 $${p.out} · 缓存 $${p.cache}`,
      ];
      if (p.longContext) {
        lines.push(`>${Math.round(p.longContext.threshold / 1000)}K 长上下文(/1M): 输入 $${p.longContext.in} · 输出 $${p.longContext.out} · 缓存 $${p.longContext.cache}`);
        if ((m.longContextSteps || 0) > 0) {
          lines.push(`已触发 >${Math.round(p.longContext.threshold / 1000)}K: ${m.longContextSteps} 步 (加价 +$${Number(m.longContextExtraUsd || 0).toFixed(4)})`);
        }
      }
      row.title = lines.join('\n');
    } else {
      row.title = `${m.label}: 暂无定价信息`;
    }
    row.innerHTML = `
      <div class="model-row-top">
        <div class="model-row-name" title="${escapeHtml(m.label)}">
          <div class="legend-dot" style="background: ${escapeHtml(m.color)}; border-radius: 50%;"></div>
          <span>${escapeHtml(m.label)}</span>
        </div>
        <span class="model-row-val">${m.percent}% · ${formatTokensCompact(m.tokens)} · ${escapeHtml(costText)}</span>
      </div>
      <div class="model-bar-bg">
        <div class="model-bar-fill" style="width:${barPct}%; background:${escapeHtml(m.color)};"></div>
      </div>
    `;
    scrollBox.appendChild(row);
  });

  section.appendChild(scrollBox);
  scrollBox.scrollTop = prevScrollTop;
}

function renderTimeBreakdownFooter(kpis) {
  const footer = document.getElementById('timeBreakdownFooter');
  if (!footer) return;
  const avgReplyMs = (kpis.messagesCount || 0) > 0 && (kpis.modelDurationMs || 0) > 0
    ? kpis.modelDurationMs / kpis.messagesCount
    : 0;
  const toolsPerTurn = (kpis.turnsCount || 0) > 0
    ? `${(kpis.toolCalls / kpis.turnsCount).toFixed(1)} 次`
    : '--';
  const interTurnStr = formatDuration(kpis.interTurnDurationMs || 0);

  footer.innerHTML = `
    <div class="time-stat-box" title="平均每次模型生成耗时 (t6 - t1)">
      <span class="time-stat-label">单次生成均值</span>
      <span class="time-stat-val">${escapeHtml(formatShortMs(avgReplyMs))}</span>
    </div>
    <div class="time-stat-box" title="平均每个用户轮次触发的工具调用数">
      <span class="time-stat-label">每轮工具密度</span>
      <span class="time-stat-val">${escapeHtml(toolsPerTurn)}</span>
    </div>
    <div class="time-stat-box" title="各步之间等待/思考/调度间隔累计 (非活跃生成)">
      <span class="time-stat-label">跨轮累计间隔</span>
      <span class="time-stat-val">${escapeHtml(interTurnStr)}</span>
    </div>
  `;
}

// Render SVG Donut Chart (with proportional arc normalization so total <= 100%)
function renderDonutChart(svgId, centerId, legendId, centerText, categories) {
  const svg = document.getElementById(svgId);
  const legend = document.getElementById(legendId);
  const centerEl = document.getElementById(centerId);

  centerEl.textContent = centerText;
  svg.innerHTML = '';
  legend.innerHTML = '';

  const radius = 38;
  const cx = 50;
  const cy = 50;
  const circumference = 2 * Math.PI * radius;

  const activeItems = (categories || []).map((cat) => {
    const hasVolume = (cat.tokens || 0) > 0 || (cat.ms || 0) > 0;
    const rawArcPct = Math.max(cat.percent || 0, hasVolume ? 0.6 : 0);
    return { cat, rawArcPct };
  });

  const arcSum = activeItems.reduce((acc, item) => acc + item.rawArcPct, 0);
  const normFactor = arcSum > 100 ? (100 / arcSum) : 1;

  let offset = 0;

  activeItems.forEach(({ cat, rawArcPct }) => {
    const arcPct = rawArcPct * normFactor;
    if (arcPct > 0) {
      const strokeDash = (arcPct / 100) * circumference;
      const strokeGap = Math.max(0, circumference - strokeDash);

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', cx);
      circle.setAttribute('cy', cy);
      circle.setAttribute('r', radius);
      circle.setAttribute('fill', 'transparent');
      circle.setAttribute('stroke', cat.color);
      circle.setAttribute('stroke-width', '14');
      circle.setAttribute('stroke-dasharray', `${strokeDash} ${strokeGap}`);
      circle.setAttribute('stroke-dashoffset', -offset);
      circle.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
      circle.style.transition = 'stroke-dasharray 0.5s ease';

      svg.appendChild(circle);
      offset += strokeDash;
    }

    const item = document.createElement('div');
    item.className = 'legend-item';
    const valStr = cat.tokens !== undefined
      ? formatTokensCompact(cat.tokens)
      : (cat.ms !== undefined ? formatDuration(cat.ms) : '');
    item.innerHTML = `
      <div class="legend-dot" style="background: ${escapeHtml(cat.color)};"></div>
      <div class="legend-info">
        <span class="legend-label" title="${escapeHtml(cat.label)} ${cat.percent}%">${escapeHtml(cat.label)} ${cat.percent}%</span>
        <span class="legend-val">${escapeHtml(valStr)}</span>
      </div>
    `;
    legend.appendChild(item);
  });
}

// Render Dual Bar Chart (Token + Cost) with Peak Scale & Floating Tooltip
function renderBarChart(timeline) {
  const container = document.getElementById('barChartContainer');
  const peakScaleEl = document.getElementById('barChartPeakScale');
  container.innerHTML = '';

  if (!timeline || timeline.length === 0) {
    if (peakScaleEl) peakScaleEl.innerHTML = '';
    container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; margin:auto;">暂无近期活跃记录</div>';
    return;
  }

  const rawMaxTokens = Math.max(...timeline.map((t) => t.tokens || 0), 0);
  const rawMaxCost = Math.max(...timeline.map((t) => t.costUsd || t.cost || 0), 0);
  if (peakScaleEl) {
    peakScaleEl.innerHTML = (rawMaxTokens > 0 || rawMaxCost > 0)
      ? `<span>峰值 Token: <strong>${escapeHtml(formatTokens(rawMaxTokens))}</strong></span><span>峰值费用: <strong>$${rawMaxCost.toFixed(2)}</strong></span>`
      : '<span>暂无活跃用量</span>';
  }

  const maxTokens = Math.max(rawMaxTokens, 1000);
  const maxCost = Math.max(rawMaxCost, 0.1);
  const isCompact = timeline.length > 14;
  const thinLabels = timeline.length > 16;

  timeline.forEach((item, idx) => {
    const tokenHeight = item.tokens > 0 ? Math.max(6, Math.round((item.tokens / maxTokens) * 100)) : 2;
    const costVal = item.costUsd || item.cost || 0;
    const costHeight = costVal > 0 ? Math.max(6, Math.round((costVal / maxCost) * 100)) : 2;
    const showDateLabel = !thinLabels || idx % 3 === 0 || idx === timeline.length - 1;

    const col = document.createElement('div');
    col.className = `bar-col${isCompact ? ' compact-col' : ''}${selectedDate === item.fullDate ? ' selected' : ''}`;
    col.title = '点击按该日筛选会话';
    col.innerHTML = `
      <div class="bar-track">
        <div class="bar-pill token-bar" style="height: ${tokenHeight}%;"></div>
        <div class="bar-pill cost-bar" style="height: ${costHeight}%;"></div>
      </div>
      <span class="bar-date">${showDateLabel ? escapeHtml(item.date) : ''}</span>
    `;

    const costTooltip = item.priced === false ? '—' : `$${item.costUsd} (¥${item.cost})`;
    const tooltipContent = `
      <div class="tip-title">${escapeHtml(item.fullDate)}</div>
      <div class="tip-row">
        <span class="tip-muted">当日总 Token:</span>
        <span class="tip-accent-blue">${escapeHtml(formatTokens(item.tokens))}</span>
      </div>
      <div class="tip-row">
        <span class="tip-muted">API 等效估算:</span>
        <span class="tip-accent-green">${escapeHtml(costTooltip)}</span>
      </div>
      <div class="tip-sub">
        模型响应: ${item.messages || 0} 次 · 步数: ${item.steps} 步 · 工具: ${item.toolCalls} 次
      </div>
      <div class="tip-hint">点击柱状图筛选当日会话</div>
    `;

    col.addEventListener('mouseenter', (e) => showFloatingTooltip(e, tooltipContent));
    col.addEventListener('mousemove', (e) => updateFloatingTooltipPos(e));
    col.addEventListener('mouseleave', () => hideFloatingTooltip());
    col.addEventListener('click', () => toggleDateFilter(item.fullDate));

    container.appendChild(col);
  });
}

function toggleDateFilter(dateStr) {
  hideFloatingTooltip();
  selectedDate = selectedDate === dateStr ? null : dateStr;
  if (cachedData) {
    renderBarChart(cachedData.timeline || []);
    renderHeatmap(cachedData.heatMap || {});
    renderConversations(cachedData.conversations || []);
  }
}

// Render Heatmap (Aligned by weeks, Local Date, collision-free month labels & auto-scroll to latest)
function renderHeatmap(heatMapData) {
  const grid = document.getElementById('heatmapGrid');
  const monthsEl = document.getElementById('heatmapMonths');
  const badgeEl = document.getElementById('heatmapSummaryBadge');
  const footerEl = document.getElementById('heatmapFooter');
  grid.innerHTML = '';
  if (monthsEl) monthsEl.innerHTML = '';

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const weeksToShow = 16;
  const startDate = new Date(today);
  startDate.setHours(0, 0, 0, 0);
  startDate.setDate(startDate.getDate() - (weeksToShow * 7));
  const dayOffset = startDate.getDay();
  startDate.setDate(startDate.getDate() - dayOffset);

  const totalDays = weeksToShow * 7 + 7;
  let activeDays = 0;
  let totalSteps = 0;
  let maxDayCount = 0;
  let maxDayDate = '';

  const weekMonths = [];
  for (let i = 0; i <= totalDays; i++) {
    const current = new Date(startDate.getTime() + i * 24 * 3600 * 1000);
    if (current > today) break;

    const weekIdx = Math.floor(i / 7);
    const monthNum = current.getMonth() + 1;
    const dayNum = current.getDate();
    if (weekMonths[weekIdx] === undefined) {
      weekMonths[weekIdx] = { month: monthNum, hasMonthStart: dayNum === 1 };
    } else if (dayNum === 1) {
      weekMonths[weekIdx] = { month: monthNum, hasMonthStart: true };
    }

    const y = current.getFullYear();
    const m = String(monthNum).padStart(2, '0');
    const day = String(dayNum).padStart(2, '0');
    const dateStr = `${y}-${m}-${day}`;
    const count = heatMapData[dateStr] || 0;

    if (count > 0) {
      activeDays++;
      totalSteps += count;
      if (count > maxDayCount) {
        maxDayCount = count;
        maxDayDate = dateStr;
      }
    }

    let level = '';
    if (count > 200) level = 'l4';
    else if (count > 50) level = 'l3';
    else if (count > 10) level = 'l2';
    else if (count > 0) level = 'l1';

    const cell = document.createElement('div');
    cell.className = `heat-cell ${level}${selectedDate === dateStr ? ' selected' : ''}`;

    const heatHtml = `
      <div class="tip-title">${escapeHtml(dateStr)}</div>
      <div class="tip-accent-blue">活跃步数: ${count} 步操作</div>
      <div class="tip-hint">点击筛选当日会话</div>
    `;
    cell.addEventListener('mouseenter', (e) => showFloatingTooltip(e, heatHtml));
    cell.addEventListener('mousemove', (e) => updateFloatingTooltipPos(e));
    cell.addEventListener('mouseleave', () => hideFloatingTooltip());
    cell.addEventListener('click', () => toggleDateFilter(dateStr));

    grid.appendChild(cell);
  }

  if (monthsEl) {
    let lastLabeledMonth = null;
    let lastLabeledWeekIdx = -99;
    weekMonths.forEach((wk, wIdx) => {
      const mCell = document.createElement('div');
      mCell.className = 'heatmap-month-cell';
      const nextWk = weekMonths[wIdx + 1];
      const nextStartsNewMonth = wIdx === 0 && nextWk && nextWk.month !== wk.month;
      if (wIdx === 0 && !nextStartsNewMonth) {
        mCell.textContent = `${wk.month}月`;
        lastLabeledMonth = wk.month;
        lastLabeledWeekIdx = wIdx;
      } else if (
        wk.month !== lastLabeledMonth &&
        (wk.hasMonthStart || wIdx > 0) &&
        (wIdx - lastLabeledWeekIdx >= 2)
      ) {
        mCell.textContent = `${wk.month}月`;
        lastLabeledMonth = wk.month;
        lastLabeledWeekIdx = wIdx;
      }
      monthsEl.appendChild(mCell);
    });
  }

  if (badgeEl) {
    badgeEl.textContent = `近16周 · 活跃 ${activeDays} 天`;
  }

  if (footerEl) {
    const peakText = maxDayCount > 0
      ? ` · 单日峰值 <strong>${maxDayCount.toLocaleString()}</strong> 步 (${escapeHtml(maxDayDate.slice(5))})`
      : '';
    footerEl.innerHTML = `
      <span class="heatmap-stats">累计 <strong>${totalSteps.toLocaleString()}</strong> 步${peakText}</span>
      <span class="heatmap-scale">
        <span>少</span>
        <span class="heat-legend-box"></span>
        <span class="heat-legend-box l1"></span>
        <span class="heat-legend-box l2"></span>
        <span class="heat-legend-box l3"></span>
        <span class="heat-legend-box l4"></span>
        <span>多</span>
      </span>
    `;
  }

  const heatmapContainer = grid.closest('.heatmap-container');
  if (heatmapContainer) {
    heatmapContainer.scrollLeft = heatmapContainer.scrollWidth;
  }
}

function focusConversationInPanel(targetId) {
  if (!targetId) return;
  currentTypeFilter = 'all';
  selectedDate = null;
  searchQuery = targetId;
  expandedConvIds.add(targetId);

  const searchInput = document.getElementById('searchConv');
  if (searchInput) searchInput.value = targetId;
  const clearBtn = document.getElementById('btnClearSearch');
  if (clearBtn) clearBtn.style.display = 'flex';

  document.querySelectorAll('#convTypeFilter .sort-btn').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-type') === 'all');
  });

  if (cachedData) {
    renderBarChart(cachedData.timeline || []);
    renderHeatmap(cachedData.heatMap || {});
    renderConversations(cachedData.conversations || []);
  }
}

function buildConvDetailDrawer(conv) {
  const drawer = document.createElement('div');
  drawer.className = 'conv-detail-drawer';

  const series = conv.contextSeries || [];
  const maxCtx = Math.max(conv.peakContextTokens || 0, 1);
  const visibleOutput = Math.max(0, (conv.outputTokens || 0) - (conv.reasoningTokens || 0));

  const compactionPills = (conv.compactionEvents || []).length > 0
    ? `<div class="drawer-chips">${conv.compactionEvents.map((ev) =>
        `<span class="drawer-chip compaction">#${ev.idx}: ${formatTokensCompact(ev.before)} → ${formatTokensCompact(ev.after)} (-${ev.dropPct}%)</span>`
      ).join('')}</div>`
    : '<div style="font-size:11px; color:var(--text-muted);">未触发上下文压缩</div>';

  const toolChipsHtml = (conv.topTools || []).length > 0
    ? conv.topTools.map((t) =>
        `<span class="drawer-chip ${t.category === 'dispatch' ? 'dispatch' : ''}">${escapeHtml(t.name)} ×${t.count}</span>`
      ).join('')
    : '<span style="font-size:11px; color:var(--text-muted);">无工具调用</span>';

  drawer.innerHTML = `
    <div class="drawer-box drawer-box-full">
      <div class="drawer-box-title">
        <span class="drawer-title-group">${ICONS.chart} 上下文水位演进 (${series.length} 采样点)</span>
        <span>峰值 ${formatTokensCompact(conv.peakContextTokens)} · 压缩 ${conv.compactionCount || 0} 次</span>
      </div>
      <div class="ctx-sparkline"></div>
      ${compactionPills}
    </div>
    <div class="drawer-bottom-grid">
      <div class="drawer-box">
        <div class="drawer-box-title">
          <span class="drawer-title-group">${ICONS.clock} 耗时与 Token 拆解</span>
          <span>ID: ${escapeHtml(conv.id.slice(0, 8))}</span>
        </div>
        <div class="drawer-kv-list">
          <div class="drawer-kv"><span class="drawer-kv-k">模型生成</span><span class="drawer-kv-v">${escapeHtml(formatDuration(conv.modelDurationMs))}</span></div>
          <div class="drawer-kv"><span class="drawer-kv-k">缓存读取</span><span class="drawer-kv-v">${formatTokensCompact(conv.cacheTokens)}</span></div>
          <div class="drawer-kv"><span class="drawer-kv-k">工具执行</span><span class="drawer-kv-v">${escapeHtml(formatDuration(conv.toolDurationMs))}</span></div>
          <div class="drawer-kv"><span class="drawer-kv-k">新输入量</span><span class="drawer-kv-v">${formatTokensCompact(conv.inputTokens)}</span></div>
          <div class="drawer-kv"><span class="drawer-kv-k">窗口收尾</span><span class="drawer-kv-v">${escapeHtml(formatDuration(conv.waitDurationMs))}</span></div>
          <div class="drawer-kv"><span class="drawer-kv-k">常规输出</span><span class="drawer-kv-v">${formatTokensCompact(visibleOutput)}</span></div>
          <div class="drawer-kv"><span class="drawer-kv-k">壁钟跨度</span><span class="drawer-kv-v">${escapeHtml(formatDuration(conv.wallSpanMs))}</span></div>
          <div class="drawer-kv"><span class="drawer-kv-k">思考推理</span><span class="drawer-kv-v">${formatTokensCompact(conv.reasoningTokens)}</span></div>
        </div>
      </div>
      <div class="drawer-box">
        <div class="drawer-box-title">
          <span class="drawer-title-group">${ICONS.wrench} 工具调用明细</span>
          <span>执行 ${conv.workToolCalls ?? 0} · 调度 ${conv.dispatchToolCalls ?? 0}</span>
        </div>
        <div class="drawer-chips">${toolChipsHtml}</div>
      </div>
    </div>
    <div class="drawer-relations"></div>
  `;

  const sparklineEl = drawer.querySelector('.ctx-sparkline');
  if (sparklineEl) {
    if (series.length > 0) {
      series.forEach((pt) => {
        const h = Math.max(8, Math.round((pt.ctx / maxCtx) * 100));
        const cls = pt.isCompaction ? 'compaction' : (pt.ctx === conv.peakContextTokens ? 'peak' : '');
        const bar = document.createElement('div');
        bar.className = `ctx-bar ${cls}`;
        bar.style.height = `${h}%`;
        const tipHtml = pt.isCompaction
          ? `<div class="tip-title tip-title-amber">步 #${pt.idx} · 上下文压缩</div><div>${formatTokensCompact(pt.before)} → ${formatTokensCompact(pt.ctx)} (-${pt.dropPct}%)</div>`
          : `<div class="tip-title tip-title-blue">步 #${pt.idx}${pt.ctx === conv.peakContextTokens ? ' (峰值)' : ''}</div><div>上下文水位: ${formatTokens(pt.ctx)}</div>`;
        bar.addEventListener('mouseenter', (e) => showFloatingTooltip(e, tipHtml));
        bar.addEventListener('mousemove', (e) => updateFloatingTooltipPos(e));
        bar.addEventListener('mouseleave', () => hideFloatingTooltip());
        sparklineEl.appendChild(bar);
      });
    } else {
      sparklineEl.innerHTML = '<span style="color:var(--text-muted); font-size:11px; margin:auto;">暂无上下文序列</span>';
    }
  }

  const relContainer = drawer.querySelector('.drawer-relations');
  if (conv.isSubagent && conv.parentId) {
    const label = document.createElement('span');
    label.style.cssText = 'font-size:11px; color:var(--text-muted);';
    label.textContent = '父会话归属:';
    relContainer.appendChild(label);

    const pBtn = document.createElement('button');
    pBtn.type = 'button';
    pBtn.className = 'drawer-link-chip';
    pBtn.innerHTML = `${ICONS.arrowUpRight} <span>${escapeHtml(conv.parentTitle || conv.parentId.slice(0, 8))}</span>`;
    pBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      focusConversationInPanel(conv.parentId);
    });
    relContainer.appendChild(pBtn);
  }
  if (conv.childSubagents && conv.childSubagents.length > 0) {
    const label = document.createElement('span');
    label.style.cssText = 'font-size:11px; color:var(--text-muted);';
    label.textContent = `关联子代理 (${conv.childSubagents.length}):`;
    relContainer.appendChild(label);

    const SUB_LIMIT = 6;
    const hasOverflow = conv.childSubagents.length > SUB_LIMIT;
    const hiddenButtons = [];
    let isExpandedSubs = false;

    conv.childSubagents.forEach((sub, idx) => {
      const cBtn = document.createElement('button');
      cBtn.type = 'button';
      cBtn.className = 'drawer-link-chip';
      cBtn.innerHTML = `${ICONS.bot} <span>${escapeHtml(sub.agentName || 'subagent')} · ${escapeHtml(formatTokensCompact(sub.totalTokens))}</span>`;
      if (hasOverflow && idx >= SUB_LIMIT) {
        cBtn.style.display = 'none';
        hiddenButtons.push(cBtn);
      }
      cBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        focusConversationInPanel(sub.id);
      });
      relContainer.appendChild(cBtn);
    });

    if (hasOverflow) {
      const rest = conv.childSubagents.length - SUB_LIMIT;
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'drawer-subagents-toggle';
      toggleBtn.textContent = `展开其余 ${rest} 个子代理`;
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        isExpandedSubs = !isExpandedSubs;
        hiddenButtons.forEach((b) => {
          b.style.display = isExpandedSubs ? 'inline-flex' : 'none';
        });
        toggleBtn.textContent = isExpandedSubs ? '收起子代理' : `展开其余 ${rest} 个子代理`;
      });
      relContainer.appendChild(toggleBtn);
    }
  }
  if (!relContainer.hasChildNodes()) {
    relContainer.remove();
  }

  return drawer;
}

// Render Conversations List
function renderConversations(convs) {
  const container = document.getElementById('convListContainer');
  container.innerHTML = '';

  const dateChip = document.getElementById('dateFilterChip');
  if (dateChip) {
    if (selectedDate) {
      dateChip.style.display = 'inline-flex';
      dateChip.innerHTML = `${ICONS.calendar} <span>日期筛选: ${escapeHtml(selectedDate)}</span> ${ICONS.close}`;
    } else {
      dateChip.style.display = 'none';
    }
  }

  const dateScoped = selectedDate
    ? convs.filter((c) => Array.isArray(c.activeDates) && c.activeDates.includes(selectedDate))
    : convs;

  const mainCount = dateScoped.filter((c) => !c.isSubagent).length;
  const subCount = dateScoped.length - mainCount;
  const countAllEl = document.getElementById('countAllConvs');
  const countMainEl = document.getElementById('countMainConvs');
  const countSubEl = document.getElementById('countSubConvs');
  if (countAllEl) countAllEl.textContent = dateScoped.length;
  if (countMainEl) countMainEl.textContent = mainCount;
  if (countSubEl) countSubEl.textContent = subCount;

  let filtered = dateScoped.filter((c) => {
    if (currentTypeFilter === 'main' && c.isSubagent) return false;
    if (currentTypeFilter === 'subagent' && !c.isSubagent) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return c.title.toLowerCase().includes(q)
      || c.id.toLowerCase().includes(q)
      || (c.primaryModel || '').toLowerCase().includes(q)
      || (c.agentName || '').toLowerCase().includes(q)
      || (c.parentTitle || '').toLowerCase().includes(q);
  });

  if (currentSort === 'tokens') {
    filtered.sort((a, b) => b.totalTokens - a.totalTokens);
  } else if (currentSort === 'peak') {
    filtered.sort((a, b) => (b.peakContextTokens || 0) - (a.peakContextTokens || 0));
  } else if (currentSort === 'steps') {
    filtered.sort((a, b) => b.steps - a.steps);
  } else if (currentSort === 'speed') {
    filtered.sort((a, b) => (b.speedTokPerSec || 0) - (a.speedTokPerSec || 0));
  } else {
    filtered.sort((a, b) => b.lastModified - a.lastModified);
  }

  document.getElementById('convCount').textContent = filtered.length;

  if (filtered.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted); padding:16px; text-align:center;">没有匹配的会话</div>';
    return;
  }

  filtered.forEach((conv) => {
    const isExpanded = expandedConvIds.has(conv.id);
    const wrapper = document.createElement('div');
    wrapper.className = `conv-card-wrapper ${conv.isCurrent ? 'active-conv' : ''}`;

    const item = document.createElement('div');
    item.className = 'conv-item';
    item.title = '点击展开/收起会话透视详情';

    const convUsdExact = conv.costUsdExact ?? conv.costUsd ?? 0;
    const convYuanExact = conv.costYuanExact ?? conv.costYuan ?? 0;
    const isSmallConvCost = conv.priced !== false && convUsdExact > 0 && convUsdExact < 1;
    const costLabel = conv.priced === false
      ? '— (未计价)'
      : `$${isSmallConvCost ? convUsdExact.toFixed(3) : Number(conv.costUsd || 0).toFixed(2)} (约 ¥${isSmallConvCost ? convYuanExact.toFixed(3) : Number(conv.costYuan || 0).toFixed(2)}${conv.partiallyPriced ? ' · 部分未计价' : ''})`;
    const costTitleParts = conv.priced === false
      ? ['未计价']
      : [`精确费用: $${convUsdExact.toFixed(4)} (约 ¥${convYuanExact.toFixed(4)})`];
    if (conv.priced !== false && (conv.longContextSteps || 0) > 0) {
      costTitleParts.push(`>200K 长上下文加价: +$${Number(conv.longContextExtraUsd || 0).toFixed(4)} (${conv.longContextSteps} 步)`);
    }
    if ((conv.unpricedTokens || 0) > 0) {
      costTitleParts.push(`未计价 Token: ${formatTokensCompact(conv.unpricedTokens)} (覆盖 ${conv.pricedTokenPct ?? 0}%)`);
    }
    const costExactTitle = costTitleParts.join('\n');
    const modelLabel = conv.primaryModel || '未知模型';
    const compactSummary = (conv.compactionEvents || [])
      .map((ev) => `#${ev.idx}: ${formatTokensCompact(ev.before)} → ${formatTokensCompact(ev.after)} (-${ev.dropPct}%)`)
      .join('\n');

    item.innerHTML = `
      <div class="conv-main">
        <div class="conv-title-row">
          <span class="conv-title">${escapeHtml(conv.title)}</span>
          ${conv.isCurrent ? '<span class="tag-current">当前会话</span>' : ''}
          ${conv.isSubagent ? `<span class="tag-subagent">${ICONS.bot} ${escapeHtml(conv.agentName || '子代理')}</span>` : ''}
          ${conv.childSubagentCount > 0 ? `<span class="tag-has-sub" title="关联子代理消耗 ${formatTokensCompact(conv.childSubagentTokens)}">${ICONS.link} ${conv.childSubagentCount} 子代理</span>` : ''}
          ${conv.compactionCount > 0 ? `<span class="tag-compact" title="${escapeHtml(compactSummary)}">${ICONS.compress} 压缩 ${conv.compactionCount} 次</span>` : ''}
          <span class="conv-expand-hint">${isExpanded ? `${ICONS.chevronDown} 收起` : `${ICONS.chevronRight} 详情`}</span>
        </div>
        <div class="conv-meta">
          <span>更新: ${escapeHtml(formatDate(conv.lastModified))}</span>
          <span class="conv-watermark">水位: 当前 ${formatTokensCompact(conv.currentContextTokens)} / 峰值 ${formatTokensCompact(conv.peakContextTokens)}</span>
          <span>响应: ${conv.messages} 次 (${conv.steps} 步 / ${conv.turns} 轮)</span>
          <span>工具: ${conv.workToolCalls ?? conv.toolCalls} 执行 / ${conv.dispatchToolCalls ?? 0} 调度</span>
          <span>活跃时长: ${escapeHtml(formatDuration(conv.durationMs))}</span>
          <span>缓存命中: ${conv.cacheHitRate}%</span>
        </div>
        <div class="conv-model-footer">
          <span class="model-dot"></span>
          <span class="model-routelabel">主要路由模型:</span>
          <span class="model-routename" title="${escapeHtml(modelLabel)}">${escapeHtml(modelLabel)}</span>
          <span class="model-route-pct">${conv.primaryModelPercent ?? 0}%</span>
        </div>
      </div>
      <div class="conv-stats">
        <div class="conv-stats-top">
          <span class="conv-tokens" title="精确消耗: ${(conv.totalTokens || 0).toLocaleString()} tokens">${formatTokens(conv.totalTokens)}</span>
          <button class="btn-jump-conv" type="button" title="在主窗口打开此会话">跳转会话 ${ICONS.arrowUpRight}</button>
        </div>
        <span class="conv-cost" title="${escapeHtml(costExactTitle)}">${escapeHtml(costLabel)}</span>
        <span class="conv-speed ${conv.speedTokPerSec > 0 ? '' : 'empty'}" title="${conv.speedTokPerSec > 0 ? '平均输出速率: ' + conv.speedTokPerSec + ' tok/s' : '暂无速率数据'}">
          ${conv.speedTokPerSec > 0 ? `${ICONS.bolt} ${conv.speedTokPerSec} tok/s` : '-- tok/s'}
        </span>
        <span class="conv-last-speed ${conv.lastReplySpeedTokPerSec > 0 ? '' : 'empty'}" title="${conv.lastReplySpeedTokPerSec > 0 ? `本次回复: ${conv.lastReplyOutTok} tok / ${formatShortMs(conv.lastReplyMs)}` : '暂无单次回复数据'}">
          ${conv.lastReplySpeedTokPerSec > 0 ? `↳ 本次 ${conv.lastReplySpeedTokPerSec} tok/s` : ''}
        </span>
      </div>
    `;

    const jumpBtn = item.querySelector('.btn-jump-conv');
    if (jumpBtn) {
      jumpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.sidecar && window.sidecar.ui && typeof window.sidecar.ui.toggleConversation === 'function') {
          window.sidecar.ui.toggleConversation(conv.id);
        }
      });
    }

    item.addEventListener('click', () => {
      const hintEl = item.querySelector('.conv-expand-hint');
      const existingDrawer = wrapper.querySelector('.conv-detail-drawer');
      if (expandedConvIds.has(conv.id)) {
        expandedConvIds.delete(conv.id);
        if (hintEl) hintEl.innerHTML = `${ICONS.chevronRight} 详情`;
        if (existingDrawer) existingDrawer.remove();
        hideFloatingTooltip();
      } else {
        expandedConvIds.add(conv.id);
        if (hintEl) hintEl.innerHTML = `${ICONS.chevronDown} 收起`;
        if (!existingDrawer) wrapper.appendChild(buildConvDetailDrawer(conv));
      }
    });

    wrapper.appendChild(item);
    if (isExpanded) {
      wrapper.appendChild(buildConvDetailDrawer(conv));
    }
    container.appendChild(wrapper);
  });
}

// Global Event Listeners & Shortcuts
document.addEventListener('DOMContentLoaded', () => {
  // Range tabs
  document.querySelectorAll('#rangeTabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#rangeTabs .tab-btn').forEach((b) => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      currentRange = e.currentTarget.getAttribute('data-range');
      fetchStats();
    });
  });

  // Conversation type filter (all / main / subagent)
  document.querySelectorAll('#convTypeFilter .sort-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#convTypeFilter .sort-btn').forEach((b) => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      currentTypeFilter = e.currentTarget.getAttribute('data-type') || 'all';
      if (cachedData) renderConversations(cachedData.conversations || []);
    });
  });

  // Sort buttons
  document.querySelectorAll('#sortGroup .sort-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('#sortGroup .sort-btn').forEach((b) => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      currentSort = e.currentTarget.getAttribute('data-sort');
      if (cachedData) renderConversations(cachedData.conversations || []);
    });
  });

  // Date filter chip clear
  const dateFilterChip = document.getElementById('dateFilterChip');
  if (dateFilterChip) {
    dateFilterChip.addEventListener('click', () => {
      selectedDate = null;
      if (cachedData) {
        renderBarChart(cachedData.timeline || []);
        renderHeatmap(cachedData.heatMap || {});
        renderConversations(cachedData.conversations || []);
      }
    });
  }

  // Search input with 100ms debounce & clear button
  const searchInputEl = document.getElementById('searchConv');
  const clearSearchBtn = document.getElementById('btnClearSearch');
  if (searchInputEl) {
    searchInputEl.addEventListener('input', (e) => {
      const rawVal = e.target.value;
      if (clearSearchBtn) clearSearchBtn.style.display = rawVal.length > 0 ? 'flex' : 'none';
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        searchQuery = rawVal.trim();
        if (cachedData) renderConversations(cachedData.conversations || []);
      }, 100);
    });
  }
  if (clearSearchBtn && searchInputEl) {
    clearSearchBtn.addEventListener('click', () => {
      clearTimeout(searchDebounceTimer);
      searchInputEl.value = '';
      searchQuery = '';
      clearSearchBtn.style.display = 'none';
      if (cachedData) renderConversations(cachedData.conversations || []);
      searchInputEl.focus();
    });
  }

  // Hide floating tooltip whenever page or inner scroll containers scroll
  window.addEventListener('scroll', hideFloatingTooltip, true);

  // Refresh button (Shift+Click forces live pricing sync + reload)
  document.getElementById('btnRefresh').addEventListener('click', async (e) => {
    if (e.shiftKey) {
      try {
        const req = (window.sidecar && typeof window.sidecar.fetch === 'function')
          ? window.sidecar.fetch('/api/sync-pricing', { method: 'POST', body: '{}' })
          : fetch('/api/sync-pricing', { method: 'POST' });
        await Promise.race([req, new Promise((r) => setTimeout(r, 3000))]);
      } catch {}
      location.reload();
    } else {
      fetchStats();
    }
  });

  // Close button
  document.getElementById('btnClose').addEventListener('click', () => {
    if (window.sidecar && window.sidecar.ui && typeof window.sidecar.ui.toggleAuxPane === 'function') {
      window.sidecar.ui.toggleAuxPane({ open: false });
    }
  });

  // Keyboard shortcut: Esc blurs/clears focused inputs first, otherwise closes pane; Ctrl+R reloads
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const active = document.activeElement;
      if (active === searchInputEl) {
        clearTimeout(searchDebounceTimer);
        if (searchInputEl.value || searchQuery) {
          searchInputEl.value = '';
          searchQuery = '';
          if (clearSearchBtn) clearSearchBtn.style.display = 'none';
          if (cachedData) renderConversations(cachedData.conversations || []);
        }
        searchInputEl.blur();
        return;
      }
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        active.blur();
        return;
      }
      if (window.sidecar && window.sidecar.ui && typeof window.sidecar.ui.toggleAuxPane === 'function') {
        window.sidecar.ui.toggleAuxPane({ open: false });
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
      location.reload();
    }
  });

  // Initial load
  fetchStats();

  // Auto-refresh every 30 seconds only while visible
  setInterval(() => {
    if (!document.hidden) fetchStats();
  }, 30000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastFetchAt > 15000) {
      fetchStats();
    }
  });
});
