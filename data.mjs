const HEADLINE_METRICS = Object.freeze([
  "tickets_created",
  "tickets_completed",
  "pull_requests_opened",
  "pull_requests_merged",
]);

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
  const selected = snapshot.flow_series.filter(
    (fact) =>
      HEADLINE_METRICS.includes(fact.metric_id) &&
      fact.period === period &&
      (repository === "all" || fact.repository_key === repository) &&
      withinDateRange(fact, start, end),
  );

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
      status:
        expectedPoints === 0
          ? "unavailable"
          : observedPoints === expectedPoints
            ? "complete"
            : "partial",
    },
  };
}

export { HEADLINE_METRICS };
