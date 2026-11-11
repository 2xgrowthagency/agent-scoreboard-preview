const HEADLINE_METRICS = Object.freeze([
  "tickets_created",
  "tickets_completed",
  "pull_requests_opened",
  "pull_requests_merged",
]);

export function defaultDateRange(flowSeries, period = "daily", periods = 7) {
  if (!Array.isArray(flowSeries)) {
    throw new TypeError("flowSeries must be an array");
  }
  if (!new Set(["daily", "weekly"]).has(period)) {
    throw new RangeError("period must be daily or weekly");
  }
  if (!Number.isInteger(periods) || periods < 1) {
    throw new RangeError("periods must be a positive integer");
  }
  const buckets = [...new Map(
    flowSeries
      .filter((fact) => fact.period === period && fact.period_start && fact.period_end)
      .map((fact) => [`${fact.period_start}|${fact.period_end}`, fact]),
  ).values()].sort(comparePeriods);
  const selected = buckets.slice(-periods);
  return selected.length > 0
    ? { start: selected[0].period_start, end: selected.at(-1).period_end }
    : { start: "", end: "" };
}

export function dateRangeError(start, end) {
  return start && end && start > end
    ? "From date must be on or before To date."
    : "";
}

export function buildChartPath(points, key, x, y) {
  let drawing = false;
  return points
    .map((point, index) => {
      if (point[key] === null) {
        drawing = false;
        return null;
      }
      const command = drawing ? "L" : "M";
      drawing = true;
      return `${command}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
}

function comparePeriods(left, right) {
  return left.period_start.localeCompare(right.period_start);
}

function observedValue(fact) {
  return fact?.value_status === "observed" ? fact.value : null;
}

function comparison(current, previous) {
  const currentValue = observedValue(current);
  const previousValue = observedValue(previous);

  return {
    current: currentValue,
    previous: previousValue,
    change:
      currentValue === null || previousValue === null
        ? null
        : currentValue - previousValue,
  };
}

function withinDateRange(fact, start, end) {
  return (!start || fact.period_start >= start) && (!end || fact.period_end <= end);
}

function metricSeries(flowFacts, metricId) {
  const groups = new Map();
  for (const fact of flowFacts.filter((item) => item.metric_id === metricId)) {
    const key = `${fact.period_start}|${fact.period_end}`;
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  const confidenceRank = { high: 0, medium: 1, low: 2, unavailable: 3 };
  return [...groups.values()]
    .map((facts) => {
      const missing = facts.some((fact) => fact.value_status !== "observed");
      return {
        period_start: facts[0].period_start,
        period_end: facts[0].period_end,
        value: missing
          ? null
          : facts.reduce((sum, fact) => sum + fact.value, 0),
        value_status: missing ? "missing" : "observed",
        complete: !missing && facts.every(fact => fact.confidence_grade === "high"),
        confidence_grade: facts
          .map((fact) => fact.confidence_grade)
          .sort(
            (left, right) => confidenceRank[right] - confidenceRank[left],
          )[0],
      };
    })
    .sort(comparePeriods);
}

function flowDelta(left, right) {
  const leftValue = left?.at(-1)?.value ?? null;
  const rightValue = right?.at(-1)?.value ?? null;
  return leftValue === null || rightValue === null ? null : leftValue - rightValue;
}

/**
 * Builds the small, presentation-ready model used by the static v1 dashboard.
 * Date boundaries only include complete buckets, so weekly filters never imply
 * that a partial week is a complete weekly measurement.
 */
export function createDashboardView(
  snapshot,
  { period = "daily", repository = "all", start, end } = {},
) {
  if (!snapshot || !Array.isArray(snapshot.flow_series)) {
    throw new TypeError("snapshot.flow_series must be an array");
  }
  if (!new Set(["daily", "weekly"]).has(period)) {
    throw new RangeError("period must be daily or weekly");
  }
  if (dateRangeError(start, end)) {
    throw new RangeError("start must not be after end");
  }

  const repositories = [
    ...new Set(snapshot.flow_series.map((fact) => fact.repository_key)),
  ].sort();
  let selected = snapshot.flow_series.filter(
    (fact) =>
      HEADLINE_METRICS.includes(fact.metric_id) &&
      fact.period === period &&
      (repository === "all" || fact.repository_key === repository) &&
      withinDateRange(fact, start, end),
  );


  if (snapshot.dataset_kind !== "synthetic_demo") {
    // An omitted row must not masquerade as an observed zero or a complete sum.
    const bounds = defaultDateRange(snapshot.flow_series, period, Number.MAX_SAFE_INTEGER);
    const buckets = [];
    if (bounds.start) {
      const stride = period === "weekly" ? 7 : 1;
      for (let time = Date.parse(`${bounds.start}T00:00:00Z`); time <= Date.parse(`${bounds.end}T00:00:00Z`); time += stride * 86400000) {
        const first = new Date(time).toISOString().slice(0, 10);
        const last = new Date(time + (stride - 1) * 86400000).toISOString().slice(0, 10);
        if (last <= bounds.end && withinDateRange({ period_start: first, period_end: last }, start, end)) buckets.push([first, last]);
      }
    }
    const keys = new Set(selected.map(f => [f.repository_key, f.metric_id, f.period_start, f.period_end].join("|")));
    const chosenRepositories = repository === "all" ? repositories : repositories.filter(r => r === repository);
    for (const [first, last] of buckets) for (const repo of chosenRepositories) for (const metric of HEADLINE_METRICS) {
      if (!keys.has([repo, metric, first, last].join("|"))) selected.push({ repository_key: repo, metric_id: metric, period,
        period_start: first, period_end: last, value: null, value_status: "missing", confidence_grade: "unavailable" });
    }
  }

  const series = Object.fromEntries(
    HEADLINE_METRICS.map((metricId) => [
      metricId,
      metricSeries(selected, metricId),
    ]),
  );
  const kpis = Object.fromEntries(
    HEADLINE_METRICS.map((metricId) => {
      const facts = series[metricId];
      return [metricId, comparison(facts.at(-1), facts.at(-2))];
    }),
  );
  const partialPoints = snapshot.dataset_kind === "synthetic_demo" ? 0 : selected.filter(fact => fact.value_status === "observed" && fact.confidence_grade !== "high").length;
  const expectedPoints = selected.length;
  const observedPoints = selected.filter(
    (fact) => fact.value_status === "observed",
  ).length;

  return {
    dataset: {
      kind: snapshot.dataset_kind,
      label: snapshot.dataset_label,
      is_demo: snapshot.dataset_kind === "synthetic_demo",
    },
    filters: { period, repository, start: start ?? null, end: end ?? null },
    repositories,
    kpis,
    series,
    deltas: {
      ticket_backlog_flow: flowDelta(
        series.tickets_created,
        series.tickets_completed,
      ),
      pull_request_flow: flowDelta(
        series.pull_requests_opened,
        series.pull_requests_merged,
      ),
    },
    coverage: {
      observed_points: observedPoints,
      expected_points: expectedPoints,
      missing_points: expectedPoints - observedPoints,
      partial_points: partialPoints,
      status:
        expectedPoints === 0
          ? "unavailable"
          : observedPoints === expectedPoints && partialPoints === 0
            ? "complete"
            : "partial",
    },
  };
}

export { HEADLINE_METRICS };

// Measured UI helpers are kept separate from the synthetic design fixture.
export function isCalendarDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function measuredRangeError(start, end, bounds) {
  if (!start || !end) return "Choose both dates, or use Reset to restore the latest periods.";
  if (!isCalendarDate(start) || !isCalendarDate(end)) return "Enter valid calendar dates.";
  if (start > end) return "From date must be on or before To date.";
  if (bounds.start && (start < bounds.start || end > bounds.end)) {
    return `Choose dates from ${bounds.start} through ${bounds.end}.`;
  }
  return "";
}

export function rangeTotals(view) {
  const periods = new Set(Object.values(view.series).flat().map(f => `${f.period_start}|${f.period_end}`));
  const totals = Object.fromEntries(HEADLINE_METRICS.map(id => {
    const series = view.series[id];
    const known = series.filter(f => f.value !== null);
    return [id, {
      value: periods.size && known.length === periods.size && known.every(f => f.complete !== false) ? known.reduce((sum, f) => sum + f.value, 0) : null,
      observed: known.length, expected: periods.size,
    }];
  }));
  return totals;
}

export function validateSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.flow_series)) throw new Error("Invalid aggregate snapshot.");
  if (snapshot.source_statuses !== undefined && !Array.isArray(snapshot.source_statuses)) throw new Error("Invalid source freshness metadata.");
  if (snapshot.operator_key !== undefined && (typeof snapshot.operator_key !== "string" || !/^[a-z][a-z0-9-]*$/.test(snapshot.operator_key))) throw new Error("Invalid operator metadata.");
  const seen = new Set();
  for (const fact of snapshot.flow_series) {
    if (!fact || !HEADLINE_METRICS.includes(fact.metric_id) || !["daily", "weekly"].includes(fact.period)
      || !isCalendarDate(fact.period_start) || !isCalendarDate(fact.period_end)
      || fact.period_start > fact.period_end || typeof fact.repository_key !== "string"
      || (fact.period === "daily" && fact.period_start !== fact.period_end)
      || (fact.period === "weekly" && (new Date(`${fact.period_start}T00:00:00Z`).getUTCDay() !== 1
        || Date.parse(`${fact.period_end}T00:00:00Z`) - Date.parse(`${fact.period_start}T00:00:00Z`) !== 6 * 86400000))
      || !["observed", "missing"].includes(fact.value_status)
      || (fact.value_status === "observed" && (!Number.isSafeInteger(fact.value) || fact.value < 0))) {
      throw new Error("Invalid aggregate snapshot.");
    }
    const key = [fact.repository_key, fact.metric_id, fact.period, fact.period_start, fact.period_end].join("|");
    if (seen.has(key)) throw new Error("Duplicate aggregate observations.");
    seen.add(key);
  }
  return snapshot;
}

export async function loadSnapshot({ fetcher = fetch, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher("./data/snapshot.json", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(`Snapshot request failed (${response.status}).`);
        return validateSnapshot(await response.json());
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error("Snapshot request timed out.")); }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export const FRESHNESS_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export function snapshotFreshness(snapshot, now = new Date()) {
  const latest = defaultDateRange(snapshot.flow_series, "daily", 1).end;
  const timestamp = Date.parse(snapshot.generated_at);
  const age = now.getTime() - timestamp;
  // Midnight Pacific collection: allow one daily interval plus twelve hours for recovery.
  const pacific = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map(p => [p.type, p.value]));
  const today = `${pacific.year}-${pacific.month}-${pacific.day}`;
  const expectedDay = new Date(Date.parse(`${today}T00:00:00Z`) - (Number(pacific.hour) < 12 ? 2 : 1) * 86400000).toISOString().slice(0, 10);
  const stale = (Number.isFinite(age) && age > FRESHNESS_MAX_AGE_MS) || Boolean(latest && latest < expectedDay);
  const metadataMissing = !Number.isFinite(timestamp) || timestamp > now.getTime() + 5 * 60 * 1000 || !latest;
  const sourceMap = new Map();
  for (const source of snapshot.source_statuses ?? []) {
    if (source && typeof source.source === "string" && isCalendarDate(source.date)) {
      const previous = sourceMap.get(source.source);
      if (!previous || source.date >= previous.date) sourceMap.set(source.source, source);
    }
  }
  const sources = [...sourceMap.values()].map(s => {
    const sourceTime = Date.parse(s.collected_at);
    const invalidTimestamp = !Number.isFinite(sourceTime) || sourceTime > now.getTime() + 5 * 60 * 1000;
    const legacy = s.source === "workboard" && sourceMap.has("linear");
    return {
      name: s.source, date: s.date, collectedAt: invalidTimestamp ? null : s.collected_at,
      invalidTimestamp, legacy,
      limited: invalidTimestamp || now.getTime() - sourceTime > FRESHNESS_MAX_AGE_MS
        || s.coverage_grade !== "complete" || s.failure_code !== "none" || s.date < latest,
    };
  });
  return { latest, generatedAt: metadataMissing ? null : snapshot.generated_at, stale, metadataMissing, sources };
}

export function numericScale(values) {
  const max = Math.max(1, ...values.filter(v => v !== null));
  const raw = max / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].find(n => n * power >= raw) * power);
  const ceiling = Math.ceil(max / step) * step;
  return { max: ceiling, ticks: Array.from({ length: Math.round(ceiling / step) + 1 }, (_, i) => i * step) };
}
