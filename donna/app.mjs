import { buildChartPath, createDashboardView, dateRangeError } from "./data.mjs";

const METRICS = {
  tickets_created: { label: "Tickets created", accent: "coral" },
  tickets_completed: { label: "Tickets completed", accent: "ink" },
  pull_requests_opened: { label: "PRs opened", accent: "violet" },
  pull_requests_merged: { label: "PRs merged", accent: "sage" },
};

const state = { period: "daily", repository: "all", start: "", end: "" };
const snapshot = await fetch("./data/snapshot.json").then((response) => {
  if (!response.ok) throw new Error(`Snapshot request failed: ${response.status}`);
  return response.json();
});

if (snapshot.operator_key) {
  const operatorName = snapshot.operator_key[0].toUpperCase() + snapshot.operator_key.slice(1);
  document.querySelector("#brand-label").textContent = `Agent flow — ${operatorName}`;
  document.title = `${operatorName} agent flow`;
}
const datasetHeading = document.querySelector("#dataset-heading");
const datasetDetail = document.querySelector("#dataset-detail");
if (snapshot.dataset_kind === "synthetic_demo") {
  datasetHeading.textContent = "Synthetic demo data";
  datasetDetail.textContent = "Every value in this preview is fabricated and does not describe production history.";
} else {
  datasetHeading.textContent = "Measured private aggregate data";
  datasetDetail.textContent = "Bounded Workboard and GitHub counts. Directional workflow proxy, not individual productivity.";
}

const repositoryFilter = document.querySelector("#repository-filter");
const allRepositories = [...new Set(snapshot.flow_series.map((fact) => fact.repository_key))].sort();
for (const repository of allRepositories) {
  repositoryFilter.add(new Option(repository, repository));
}

function formatDate(value, period) {
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    ...(period === "weekly" ? { timeZone: "UTC" } : { weekday: "short", timeZone: "UTC" }),
  }).format(date);
}

function comparisonText(change, period) {
  if (change === null) return "No prior complete period";
  if (change === 0) return `No change vs prior ${period === "daily" ? "day" : "week"}`;
  return `${change > 0 ? "+" : ""}${change} vs prior ${period === "daily" ? "day" : "week"}`;
}

function renderKpis(view) {
  const grid = document.querySelector("#kpi-grid");
  grid.replaceChildren();
  for (const [metricId, config] of Object.entries(METRICS)) {
    const kpi = view.kpis[metricId];
    const card = document.createElement("article");
    card.className = `kpi-card ${config.accent}`;
    card.innerHTML = `
      <div class="kpi-label"><span class="metric-icon" aria-hidden="true"></span>${config.label}</div>
      <div class="kpi-value">${kpi.current ?? "—"}</div>
      <div class="kpi-change ${kpi.change > 0 ? "up" : kpi.change < 0 ? "down" : ""}">
        ${comparisonText(kpi.change, view.filters.period)}
      </div>`;
    grid.append(card);
  }
}

function chartMarkup(primary, secondary, colors, period) {
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

function renderDelta(selector, value, positiveLabel, negativeLabel) {
  const element = document.querySelector(selector);
  if (value === null) {
    element.textContent = "Flow delta unavailable";
    element.className = "delta-chip neutral";
    return;
  }
  element.textContent = value === 0 ? "Balanced flow" : `${Math.abs(value)} ${value > 0 ? positiveLabel : negativeLabel}`;
  element.className = `delta-chip ${value > 0 ? "warm" : "cool"}`;
}

function render() {
  const rangeError = dateRangeError(state.start, state.end);
  const filterError = document.querySelector("#filter-error");
  const startFilter = document.querySelector("#start-filter");
  const endFilter = document.querySelector("#end-filter");
  filterError.textContent = rangeError;
  startFilter.setAttribute("aria-invalid", String(Boolean(rangeError)));
  endFilter.setAttribute("aria-invalid", String(Boolean(rangeError)));
  if (rangeError) return;

  const view = createDashboardView(snapshot, {
    period: state.period,
    repository: state.repository,
    start: state.start || undefined,
    end: state.end || undefined,
  });
  renderKpis(view);
  document.querySelector("#ticket-chart").innerHTML = chartMarkup(
    view.series.tickets_created,
    view.series.tickets_completed,
    ["#ef725e", "#17231f"],
    state.period,
  );
  document.querySelector("#pr-chart").innerHTML = chartMarkup(
    view.series.pull_requests_opened,
    view.series.pull_requests_merged,
    ["#7d63c7", "#4e8e73"],
    state.period,
  );
  renderDelta("#ticket-delta", view.deltas.ticket_backlog_flow, "more created", "more completed");
  renderDelta("#pr-delta", view.deltas.pull_request_flow, "more opened", "more merged");

  const quality = document.querySelector("#quality-pill");
  quality.dataset.status = view.coverage.status;
  document.querySelector("#quality-label").textContent = `${view.coverage.status[0].toUpperCase()}${view.coverage.status.slice(1)} coverage`;
  document.querySelector("#coverage-detail").textContent = view.coverage.expected_points === 0
    ? "No complete periods match the current filters."
    : `${view.coverage.observed_points} of ${view.coverage.expected_points} selected metric points are observed.`;
}

document.querySelectorAll(".period-button").forEach((button) => {
  button.addEventListener("click", () => {
    state.period = button.dataset.period;
    document.querySelectorAll(".period-button").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    render();
  });
});

for (const [selector, key] of [["#repository-filter", "repository"], ["#start-filter", "start"], ["#end-filter", "end"]]) {
  document.querySelector(selector).addEventListener("change", (event) => {
    state[key] = event.target.value;
    render();
  });
}

document.querySelector("#reset-filters").addEventListener("click", () => {
  Object.assign(state, { repository: "all", start: "", end: "" });
  repositoryFilter.value = "all";
  document.querySelector("#start-filter").value = "";
  document.querySelector("#end-filter").value = "";
  render();
});

render();
