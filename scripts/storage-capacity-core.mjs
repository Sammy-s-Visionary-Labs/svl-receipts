export const STORAGE_ALERT_THRESHOLDS = Object.freeze({
  warning: 70,
  high: 85,
  critical: 95,
});

const LEVEL_RANK = Object.freeze({ normal: 0, warning: 1, high: 2, critical: 3 });

export function storageAlertLevel(usagePercent) {
  assertFiniteNonnegative(usagePercent, "usage_percent");
  if (usagePercent >= STORAGE_ALERT_THRESHOLDS.critical) return "critical";
  if (usagePercent >= STORAGE_ALERT_THRESHOLDS.high) return "high";
  if (usagePercent >= STORAGE_ALERT_THRESHOLDS.warning) return "warning";
  return "normal";
}

export function buildCapacityEvaluation({
  snapshots,
  quotaBytes,
  quotaScope = "shared",
  testUsagePercent = null,
}) {
  if (!Array.isArray(snapshots) || snapshots.length === 0)
    throw new Error("storage_snapshots_required");
  assertFinitePositive(quotaBytes, "storage_quota_bytes");
  if (!["shared", "separate"].includes(quotaScope)) throw new Error("storage_quota_scope_invalid");

  const scopes = snapshots.map((snapshot) =>
    capacityScope(snapshot.environment, snapshot.storageBytes, quotaBytes),
  );
  if (quotaScope === "shared" && snapshots.length > 1) {
    scopes.push(
      capacityScope(
        "combined organization",
        snapshots.reduce((sum, item) => sum + item.storageBytes, 0),
        quotaBytes,
      ),
    );
  }

  const syntheticPercent = testUsagePercent === null ? null : Number(testUsagePercent);
  if (syntheticPercent !== null)
    assertFiniteNonnegative(syntheticPercent, "storage_test_usage_percent");
  const alertPercent = syntheticPercent ?? Math.max(...scopes.map((scope) => scope.usagePercent));
  const level = storageAlertLevel(alertPercent);
  const alertScope =
    syntheticPercent === null
      ? scopes.reduce((highest, scope) =>
          scope.usagePercent > highest.usagePercent ? scope : highest,
        )
      : {
          name: "synthetic verification",
          storageBytes: Math.round((quotaBytes * syntheticPercent) / 100),
          usagePercent: syntheticPercent,
        };

  return {
    level,
    alertPercent,
    alertScope,
    quotaBytes,
    quotaScope,
    scopes,
    snapshots,
    synthetic: syntheticPercent !== null,
  };
}

export function decideIssueAction(previousLevel, currentLevel) {
  if (!(currentLevel in LEVEL_RANK) || (previousLevel !== null && !(previousLevel in LEVEL_RANK))) {
    throw new Error("storage_alert_level_invalid");
  }
  if (currentLevel === "normal")
    return previousLevel && previousLevel !== "normal" ? "resolve" : "none";
  if (!previousLevel || previousLevel === "normal") return "create";
  if (LEVEL_RANK[currentLevel] > LEVEL_RANK[previousLevel]) return "escalate";
  if (LEVEL_RANK[currentLevel] < LEVEL_RANK[previousLevel]) return "downgrade";
  return "update";
}

export function buildCapacityReport(evaluation, observedAt = new Date().toISOString()) {
  const mode = evaluation.synthetic ? "Synthetic alert verification" : "Live storage measurement";
  const lines = [
    `## ${mode}`,
    "",
    `- Alert level: **${evaluation.level.toUpperCase()}**`,
    `- Highest usage: **${evaluation.alertPercent.toFixed(2)}%** (${evaluation.alertScope.name})`,
    `- Configured quota: **${formatBytes(evaluation.quotaBytes)}**`,
    `- Quota scope: **${evaluation.quotaScope}**`,
    `- Observed at: ${observedAt}`,
    "",
    "| Environment / scope | Stored bytes | Usage | Objects | Avg object | Confirmed receipts | Avg confirmed receipt |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const scope of evaluation.scopes) {
    const snapshot = evaluation.snapshots.find((item) => item.environment === scope.name);
    lines.push(
      `| ${scope.name} | ${formatBytes(scope.storageBytes)} | ${scope.usagePercent.toFixed(2)}% | ${snapshot?.objectCount ?? "—"} | ${snapshot ? formatBytes(snapshot.averageObjectBytes) : "—"} | ${snapshot?.confirmedReceiptCount ?? "—"} | ${snapshot ? formatBytes(snapshot.averageConfirmedReceiptBytes) : "—"} |`,
    );
  }
  if (evaluation.synthetic) {
    lines.push(
      "",
      `Synthetic percentage: **${evaluation.alertPercent.toFixed(2)}%**. Live measurements above were not altered.`,
    );
  }
  lines.push(
    "",
    "Thresholds: 70% warning, 85% high, 95% critical.",
    "",
    "Runbook: `docs/storage-capacity-runbook.md`",
  );
  return lines.join("\n");
}

export function formatBytes(value) {
  assertFiniteNonnegative(value, "byte_value");
  if (value < 1000) return `${Math.round(value)} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let amount = value;
  let unit = -1;
  do {
    amount /= 1000;
    unit += 1;
  } while (amount >= 1000 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function capacityScope(name, storageBytes, quotaBytes) {
  assertFiniteNonnegative(storageBytes, "storage_bytes");
  return { name, storageBytes, usagePercent: (storageBytes / quotaBytes) * 100 };
}

function assertFiniteNonnegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name}_invalid`);
}

function assertFinitePositive(value, name) {
  assertFiniteNonnegative(value, name);
  if (value === 0) throw new Error(`${name}_invalid`);
}
