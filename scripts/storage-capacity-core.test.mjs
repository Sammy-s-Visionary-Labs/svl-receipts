import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCapacityEvaluation,
  buildCapacityReport,
  decideIssueAction,
  storageAlertLevel,
} from "./storage-capacity-core.mjs";

const snapshot = (environment, storageBytes) => ({
  environment,
  storageBytes,
  objectCount: 10,
  averageObjectBytes: storageBytes / 10,
  confirmedPageBytes: storageBytes,
  confirmedPageCount: 10,
  averageConfirmedPageBytes: storageBytes / 10,
  confirmedReceiptCount: 5,
  averageConfirmedReceiptBytes: storageBytes / 5,
});

test("maps exact storage thresholds", () => {
  assert.equal(storageAlertLevel(69.999), "normal");
  assert.equal(storageAlertLevel(70), "warning");
  assert.equal(storageAlertLevel(85), "high");
  assert.equal(storageAlertLevel(95), "critical");
});

test("combines projects when they share an organization quota", () => {
  const evaluation = buildCapacityEvaluation({
    snapshots: [snapshot("development", 350), snapshot("production", 360)],
    quotaBytes: 1000,
    quotaScope: "shared",
  });
  assert.equal(evaluation.level, "warning");
  assert.equal(evaluation.alertScope.name, "combined organization");
  assert.equal(evaluation.alertPercent, 71);
});

test("keeps projects separate when configured", () => {
  const evaluation = buildCapacityEvaluation({
    snapshots: [snapshot("development", 350), snapshot("production", 360)],
    quotaBytes: 1000,
    quotaScope: "separate",
  });
  assert.equal(evaluation.level, "normal");
  assert.equal(evaluation.scopes.length, 2);
});

test("supports synthetic threshold verification without replacing live measurements", () => {
  const evaluation = buildCapacityEvaluation({
    snapshots: [snapshot("development", 10), snapshot("production", 20)],
    quotaBytes: 1000,
    testUsagePercent: 95,
  });
  assert.equal(evaluation.level, "critical");
  assert.equal(evaluation.synthetic, true);
  assert.match(buildCapacityReport(evaluation), /Live measurements above were not altered/);
});

test("chooses quiet update, escalation, downgrade, and resolution actions", () => {
  assert.equal(decideIssueAction(null, "normal"), "none");
  assert.equal(decideIssueAction(null, "warning"), "create");
  assert.equal(decideIssueAction("warning", "warning"), "update");
  assert.equal(decideIssueAction("warning", "critical"), "escalate");
  assert.equal(decideIssueAction("critical", "high"), "downgrade");
  assert.equal(decideIssueAction("high", "normal"), "resolve");
});

test("report contains aggregate metrics and no database object identifiers", () => {
  const evaluation = buildCapacityEvaluation({
    snapshots: [snapshot("development", 700)],
    quotaBytes: 1000,
  });
  const report = buildCapacityReport(evaluation, "2026-09-03T12:00:00.000Z");
  assert.match(report, /Confirmed receipts/);
  assert.match(report, /70\.00%/);
  assert.doesNotMatch(report, /storage_key|signed|token|receipt id/i);
});
