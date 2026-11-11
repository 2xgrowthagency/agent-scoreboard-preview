import {
  buildChartPath, createDashboardView, dateRangeError, defaultDateRange,
  loadSnapshot, measuredRangeError, numericScale, rangeTotals, snapshotFreshness,
} from "./data.mjs";

const METRICS = {
  tickets_created: { label: "Tickets created", accent: "coral" },
  tickets_completed: { label: "Tickets completed", accent: "ink" },
  pull_requests_opened: { label: "PRs opened", accent: "violet" },
  pull_requests_merged: { label: "PRs merged", accent: "sage" },
};
const $ = selector => document.querySelector(selector);
let snapshot = null;
let usingDefaultRange = true;
let initialized = false;
let loading = false;
let measured = location.pathname !== "/" && !location.pathname.endsWith("/index.html");
const state = { period: "daily", repository: "all", start: "", end: "" };
const repositoryFilter = $("#repository-filter");

const loadNotice = document.createElement("section");
loadNotice.id = "load-notice";
loadNotice.className = "load-notice";
loadNotice.setAttribute("aria-live", "polite");
loadNotice.innerHTML = '<span id="load-message">Loading aggregate data…</span><button type="button" id="retry-load" hidden>Retry</button>';
$("#demo-notice").after(loadNotice);
$("#retry-load").addEventListener("click", refresh);

function formatDate(value, period) {
  return new Intl.DateTimeFormat("en", {
    month: "short", day: "numeric", timeZone: "UTC",
    ...(period === "weekly" ? {} : { weekday: "short" }),
  }).format(new Date(`${value}T00:00:00Z`));
}
function periodLabel(start, end) {
  if (!start || !end) return "No complete periods";
  return start === end ? start : `${start} to ${end}`;
}
function comparisonText(change, period) {
  if (change === null) return "No prior complete period";
  if (change === 0) return `No change vs prior ${period === "daily" ? "day" : "week"}`;
  return `${change > 0 ? "+" : ""}${change} vs prior ${period === "daily" ? "day" : "week"}`;
}
function installMeasuredControls() {
  document.body.classList.add("measured");
  const freshness = document.createElement("section");
  freshness.id = "freshness";
  freshness.className = "freshness";
  freshness.setAttribute("aria-label", "Data freshness");
  $("#demo-notice").after(freshness);
  const preset = document.createElement("label");
  preset.className = "preset-control";
  preset.innerHTML = '<span>Range</span><select id="range-preset"><option value="7">Latest 7 periods</option><option value="30">Latest 30 periods</option><option value="all">All available</option><option value="custom">Custom dates</option></select>';
  $("#reset-filters").before(preset);
  $("#range-preset").addEventListener("change", event => {
    if (event.target.value === "custom") { $("#start-filter").focus(); return; }
    const count = event.target.value === "all" ? Number.MAX_SAFE_INTEGER : Number(event.target.value);
    Object.assign(state, defaultDateRange(snapshot.flow_series, state.period, count));
    usingDefaultRange = count === 7;
    syncDates(); render();
  });
  const help = document.createElement("p");
  help.className = "date-help"; help.id = "date-help";
  help.textContent = "Dates are inclusive, in Pacific time (America/Vancouver). Weekly view includes only whole Monday–Sunday weeks.";
  $("#filter-error").before(help);
  for (const selector of ["#start-filter", "#end-filter"]) {
    $(selector).required = true;
    $(selector).setAttribute("aria-describedby", "date-help filter-error");
  }
  const summary = document.createElement("p");
  summary.id = "range-summary"; summary.className = "range-summary"; summary.setAttribute("aria-live", "polite");
  $("#kpi-grid").before(summary);
  $("#kpi-grid").setAttribute("aria-label", "Selected-range totals and latest period counts");
}
function syncDates() {
  $("#start-filter").value = state.start;
  $("#end-filter").value = state.end;
}
function renderFreshness() {
  if (!measured || !snapshot) return;
  const freshness = snapshotFreshness(snapshot);
  const parts = [];
  if (freshness.generatedAt) {
    const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" }).format(new Date(freshness.generatedAt));
    parts.push(`Snapshot refreshed ${time} Pacific.`);
  } else parts.push("Refresh timestamp unavailable.");
  parts.push(freshness.latest ? `Latest covered day: ${freshness.latest} Pacific.` : "No covered day available.");
  if (freshness.stale) parts.push("Stale snapshot: the midnight Pacific collection is overdue. Data is kept visible.");
  if (freshness.metadataMissing) parts.push("Freshness could not be verified.");
  if (!freshness.sources.length) parts.push("Per-source collection freshness is unavailable.");
  for (const source of freshness.sources) {
    if (source.name === "workboard") parts.push(`Legacy Workboard history through ${source.date}; not authoritative Linear coverage.`);
    else {
      const collected = source.collectedAt ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", dateStyle: "medium", timeStyle: "short" }).format(new Date(source.collectedAt)) + " Pacific" : "unverified time";
      parts.push(`${source.name === "github" ? "GitHub" : source.name === "linear" ? "Linear" : source.name}: through ${source.date}, collected ${collected}${source.limited ? " (limited freshness or coverage)" : ""}.`);
    }
  }
  const node = $("#freshness"); node.replaceChildren();
  const text = document.createElement("p"); text.textContent = parts.join(" "); node.append(text);
  node.dataset.status = freshness.stale || freshness.metadataMissing || !freshness.sources.length || freshness.sources.some(s => !s.legacy && s.limited) ? "warning" : "current";
  const button = document.createElement("button"); button.type = "button"; button.textContent = "Refresh data"; button.disabled = loading; button.addEventListener("click", refresh); node.append(button);
}
function renderKpis(view) {
  const totals = rangeTotals(view);
  const grid = $("#kpi-grid"); grid.replaceChildren();
  for (const [metricId, config] of Object.entries(METRICS)) {
    const kpi = view.kpis[metricId];
    const card = document.createElement("article"); card.className = `kpi-card ${config.accent}`;
    const last = view.series[metricId].at(-1);
    card.innerHTML = `
      <div class="kpi-label"><span class="metric-icon" aria-hidden="true"></span>${config.label}</div>
      ${measured ? '<div class="kpi-period">Selected-range total</div>' : ""}
      <div class="kpi-value">${(measured ? totals[metricId].value : kpi.current) ?? "—"}</div>
      ${measured ? `<div class="kpi-latest">Latest ${state.period === "daily" ? "day" : "week"}: <strong>${kpi.current ?? "—"}${last?.value !== null && last?.complete === false ? " (partial)" : ""}</strong><span>${periodLabel(last?.period_start, last?.period_end)}</span></div>` : ""}
      <div class="kpi-change ${kpi.change > 0 ? "up" : kpi.change < 0 ? "down" : ""}">${comparisonText(kpi.change, view.filters.period)}</div>
      ${measured && totals[metricId].value === null && totals[metricId].expected ? '<div class="partial-note">Total unavailable: some observations are missing or partial.</div>' : ""}`;
    grid.append(card);
  }
}
function legacyChartMarkup(primary, secondary, colors, period) {
  const points = primary.map((item, index) => ({
    period_start: item.period_start,
    primary: item.value,
    secondary: secondary[index]?.value ?? null,
  }));
  if (points.length === 0) return '<div class="empty-state">No complete periods in this range</div>';

  const width = 680;
  const height = 240;
  const pad = { x: 28, top: 18, bottom: 34 };
  const values = points.flatMap((point) => [point.primary, point.secondary]).filter((value) => value !== null);
  const max = Math.max(1, ...values);
  const x = (index) => pad.x + (index * (width - pad.x * 2)) / Math.max(1, points.length - 1);
  const y = (value) => pad.top + ((max - value) * (height - pad.top - pad.bottom)) / max;
  const path = (key) => buildChartPath(points, key, x, y);
  const labels = points.map((point, index) => {
    const show = points.length <= 7 || index === 0 || index === points.length - 1 || index % Math.ceil(points.length / 5) === 0;
    return show ? `<text x="${x(index)}" y="229" text-anchor="middle">${formatDate(point.period_start, period)}</text>` : "";
  }).join("");
  const dots = (key, color) => points.map((point, index) => point[key] === null ? "" : `<circle cx="${x(index)}" cy="${y(point[key])}" r="3.5" fill="${color}"><title>${formatDate(point.period_start, period)}: ${point[key]}</title></circle>`).join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Trend chart across ${points.length} complete periods">
    <line class="axis" x1="${pad.x}" y1="${height - pad.bottom}" x2="${width - pad.x}" y2="${height - pad.bottom}" />
    <line class="gridline" x1="${pad.x}" y1="${pad.top}" x2="${width - pad.x}" y2="${pad.top}" />
    <line class="gridline" x1="${pad.x}" y1="${y(max / 2)}" x2="${width - pad.x}" y2="${y(max / 2)}" />
    <path d="${path("primary")}" fill="none" stroke="${colors[0]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
    <path d="${path("secondary")}" fill="none" stroke="${colors[1]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
    ${dots("primary", colors[0])}${dots("secondary", colors[1])}${labels}
  </svg>`;
}

function measuredChartMarkup(primary, secondary, colors, labels, width) {
  const buckets = new Map();
  for (const [key, series] of [["primary", primary], ["secondary", secondary]]) {
    for (const fact of series) {
      const id = `${fact.period_start}|${fact.period_end}`;
      const point = buckets.get(id) ?? { start: fact.period_start, end: fact.period_end, primary: null, secondary: null };
      point[key] = fact.value; point[`${key}Complete`] = fact.complete !== false; buckets.set(id, point);
    }
  }
  const points = [...buckets.values()].sort((a, b) => a.start.localeCompare(b.start));
  if (!points.length) return '<div class="empty-state">No complete periods in this range</div>';
  width = Math.max(240, Math.round(width || 500));
  const height = 230, left = 42, right = 20, top = 25, bottom = 40;
  const scale = numericScale(points.flatMap(p => [p.primary, p.secondary]));
  const x = i => points.length === 1 ? (left + width - right) / 2 : left + i * (width - left - right) / (points.length - 1);
  const y = n => top + (scale.max - n) * (height - top - bottom) / scale.max;
  const ticks = scale.ticks.map(n => `<line class="gridline" x1="${left}" x2="${width - right}" y1="${y(n)}" y2="${y(n)}"/><text class="y-tick" x="${left - 9}" y="${y(n) + 4}" text-anchor="end">${n}</text>`).join("");
  const maxLabels = width < 400 ? 3 : 5;
  const tickIndices = new Set(Array.from({ length: Math.min(maxLabels, points.length) }, (_, i) => Math.round(i * (points.length - 1) / Math.max(1, Math.min(maxLabels, points.length) - 1))));
  const dates = [...tickIndices].map(i => `<text x="${x(i)}" y="${height - 12}" text-anchor="${points.length === 1 ? "middle" : i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}">${formatDate(points[i].start, "weekly")}</text>`).join("");
  const paths = ["primary", "secondary"].map((key, n) => `<path d="${buildChartPath(points, key, x, y)}" fill="none" stroke="${colors[n]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${points.map((p, i) => p[key] === null ? "" : `<circle cx="${x(i)}" cy="${y(p[key])}" r="3.5" fill="${colors[n]}"><title>${labels[n]} · ${periodLabel(p.start, p.end)}: ${p[key]}</title></circle>`).join("")}`).join("");
  const exactValue = (p, key) => p[key] === null ? "Unavailable" : `${p[key]}${p[`${key}Complete`] ? "" : " (partial)"}`;
  const rows = points.map(p => `<tr><th scope="row">${periodLabel(p.start, p.end)}</th><td>${exactValue(p, "primary")}</td><td>${exactValue(p, "secondary")}</td></tr>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${labels.join(" and ")}: trend chart across ${points.length} complete periods. Exact values are available below."><text class="axis-unit" x="${left}" y="13">Count</text>${ticks}${paths}${dates}</svg>
    <details class="chart-values"><summary>Inspect exact values</summary><p>Pacific dates. Unavailable means missing, not zero. Partial counts may be lower bounds.</p><table><caption>${labels.join(" and ")} by ${state.period === "daily" ? "day" : "week"}</caption><thead><tr><th scope="col">Period</th><th scope="col">${labels[0]}</th><th scope="col">${labels[1]}</th></tr></thead><tbody>${rows}</tbody></table></details>`;
}
function renderDelta(selector, value, positiveLabel, negativeLabel) {
  const element = $(selector);
  element.textContent = value === null ? "Flow delta unavailable" : value === 0 ? "Balanced flow" : `${Math.abs(value)} ${value > 0 ? positiveLabel : negativeLabel}`;
  element.className = `delta-chip ${value === null ? "neutral" : value > 0 ? "warm" : "cool"}`;
  if (measured) element.title = "Selected-range flow difference";
}
function clearInvalidResults(message) {
  $("#kpi-grid").replaceChildren();
  for (const selector of ["#ticket-chart", "#pr-chart"]) $(selector).innerHTML = '<div class="empty-state">Choose a valid date range to view results.</div>';
  for (const selector of ["#ticket-delta", "#pr-delta"]) renderDelta(selector, null);
  $("#quality-pill").dataset.status = "unavailable";
  $("#quality-label").textContent = "Invalid date range";
  $("#coverage-detail").textContent = "Results are hidden until the date range is valid.";
  $("#range-summary").textContent = message;
}
function render() {
  if (!snapshot) return;
  const bounds = defaultDateRange(snapshot.flow_series, "daily", Number.MAX_SAFE_INTEGER);
  const rangeError = measured && bounds.start ? measuredRangeError(state.start, state.end, bounds) : dateRangeError(state.start, state.end);
  $("#filter-error").textContent = rangeError;
  for (const selector of ["#start-filter", "#end-filter"]) $(selector).setAttribute("aria-invalid", String(Boolean(rangeError)));
  if (rangeError) { if (measured) clearInvalidResults(rangeError); return; }
  const view = createDashboardView(snapshot, { ...state, start: state.start || undefined, end: state.end || undefined });
  renderKpis(view);
  const chartConfigs = [
    ["#ticket-chart", "tickets_created", "tickets_completed", ["#ef725e", "#17231f"], ["Created", "Completed"]],
    ["#pr-chart", "pull_requests_opened", "pull_requests_merged", ["#7d63c7", "#4e8e73"], ["Opened", "Merged"]],
  ];
  for (const [selector, first, second, colors, labels] of chartConfigs) {
    const container = $(selector), expanded = container.querySelector("details")?.open;
    container.innerHTML = measured
      ? measuredChartMarkup(view.series[first], view.series[second], colors, labels, container.clientWidth)
      : legacyChartMarkup(view.series[first], view.series[second], colors, state.period);
    if (expanded && container.querySelector("details")) container.querySelector("details").open = true;
  }
  const totals = rangeTotals(view);
  const difference = (a, b) => totals[a].value === null || totals[b].value === null ? null : totals[a].value - totals[b].value;
  renderDelta("#ticket-delta", measured ? difference("tickets_created", "tickets_completed") : view.deltas.ticket_backlog_flow, "more created", "more completed");
  renderDelta("#pr-delta", measured ? difference("pull_requests_opened", "pull_requests_merged") : view.deltas.pull_request_flow, "more opened", "more merged");
  $("#quality-pill").dataset.status = view.coverage.status;
  $("#quality-label").textContent = `${view.coverage.status[0].toUpperCase()}${view.coverage.status.slice(1)} coverage`;
  $("#coverage-detail").textContent = view.coverage.expected_points === 0 ? "No complete periods match the current filters." : `${view.coverage.observed_points} of ${view.coverage.expected_points} selected metric points are observed.${view.coverage.partial_points ? " Some observed counts have partial source coverage; totals are unavailable." : ""}`;
  if (measured) {
    const periods = Object.values(view.series).flat().sort((a, b) => a.period_start.localeCompare(b.period_start));
    const actual = periods.length ? periodLabel(periods[0].period_start, periods.at(-1).period_end) : "No complete periods";
    $("#range-summary").textContent = `Selected range: ${periodLabel(state.start, state.end)} Pacific · Totals cover ${actual}${state.period === "weekly" ? " (whole weeks only)" : ""}.`;
  }
}

async function refresh() {
  if (loading) return;
  loading = true; loadNotice.hidden = false; $("#retry-load").hidden = true;
  $("#load-message").textContent = snapshot ? "Refreshing… Previous data remains visible." : "Loading aggregate data…";
  if (!snapshot) document.querySelectorAll(".controls button, .controls input, .controls select").forEach(e => e.disabled = true);
  renderFreshness();
  try {
    const next = await loadSnapshot();
    snapshot = next;
    if (!initialized) {
      measured = snapshot.dataset_kind !== "synthetic_demo";
      if (measured) installMeasuredControls();
      Object.assign(state, defaultDateRange(snapshot.flow_series));
      initialized = true;
    }
    if (snapshot.operator_key) {
      const name = snapshot.operator_key[0].toUpperCase() + snapshot.operator_key.slice(1);
      $("#brand-label").textContent = `Agent flow — ${name}`; document.title = `${name} agent flow`;
    }
    $("#dataset-heading").textContent = measured ? "Measured private aggregate data" : "Synthetic demo data";
    $("#dataset-detail").textContent = measured ? "Bounded ticket and GitHub counts. Directional workflow proxy, not individual productivity." : "Every value in this preview is fabricated and does not describe production history.";
    repositoryFilter.replaceChildren(new Option("All repositories", "all"));
    for (const repo of [...new Set(snapshot.flow_series.map(f => f.repository_key))].sort()) repositoryFilter.add(new Option(repo, repo));
    repositoryFilter.value = state.repository;
    if (!repositoryFilter.value) { state.repository = "all"; repositoryFilter.value = "all"; }
    if (usingDefaultRange) Object.assign(state, defaultDateRange(snapshot.flow_series, state.period));
    syncDates();
    if (measured) {
      const bounds = defaultDateRange(snapshot.flow_series, "daily", Number.MAX_SAFE_INTEGER);
      for (const selector of ["#start-filter", "#end-filter"]) { $(selector).min = bounds.start; $(selector).max = bounds.end; }
    }
    loadNotice.hidden = true; render();
  } catch {
    $("#load-message").textContent = snapshot ? "Refresh failed. Previous data remains visible and may be out of date. Retry to check for updates." : "Data could not be loaded. Check your connection and retry. No counts are available.";
    $("#retry-load").hidden = false;
    if (!snapshot) { $("#quality-label").textContent = "Data unavailable"; $("#quality-pill").dataset.status = "unavailable"; $("#dataset-heading").textContent = "Data unavailable"; $("#dataset-detail").textContent = "The aggregate request failed or timed out."; }
  } finally {
    loading = false;
    if (snapshot) document.querySelectorAll(".controls button, .controls input, .controls select").forEach(e => e.disabled = false);
    renderFreshness();
  }
}

document.querySelectorAll(".period-button").forEach(button => button.addEventListener("click", () => {
  state.period = button.dataset.period;
  if (usingDefaultRange) { Object.assign(state, defaultDateRange(snapshot.flow_series, state.period)); syncDates(); }
  document.querySelectorAll(".period-button").forEach(item => { const active = item === button; item.classList.toggle("active", active); item.setAttribute("aria-pressed", String(active)); });
  if (measured) { $("#range-preset").value = usingDefaultRange ? "7" : "custom"; updatePresetLabels(); }
  render();
}));
function updatePresetLabels() {
  if (!measured || !$("#range-preset")) return;
  for (const count of [7, 30]) $("#range-preset").querySelector(`[value="${count}"]`).textContent = `Latest ${count} ${state.period === "daily" ? "days" : "weeks"}`;
}
repositoryFilter.addEventListener("change", event => { state.repository = event.target.value; render(); });
for (const [selector, key] of [["#start-filter", "start"], ["#end-filter", "end"]]) {
  $(selector).addEventListener("change", event => { state[key] = event.target.value; usingDefaultRange = false; if (measured) $("#range-preset").value = "custom"; render(); });
}
$("#reset-filters").addEventListener("click", () => {
  Object.assign(state, { repository: "all", ...defaultDateRange(snapshot.flow_series, state.period) });
  usingDefaultRange = true; repositoryFilter.value = "all"; syncDates();
  if (measured) $("#range-preset").value = "7";
  render();
});
let resizeTimer;
window.addEventListener("resize", () => { if (measured && snapshot) { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 100); } });
await refresh();
updatePresetLabels();
