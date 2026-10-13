import {
  housecallRequestHash,
  isHousecallQuantitySupported,
  validateHousecallId,
} from "./payloads";
import type { PreparedMaterialWrite } from "./types";

export type LaborMaterialCostPolicy =
  | "hours_only_zero_placeholder"
  | "approved_unit_cost"
  | "approved_total_cost";
interface LaborMaterialBase {
  jobId: string;
  /** Hash of the frozen core approval snapshot, before adding this provider intent. */
  snapshotHash: string;
  period: { from: string; to: string };
  hours: number;
}
export interface LaborMaterialWorker {
  workerName: string;
  /** Original allocated source hours before the approved daily lunch policy. */
  hours: number;
}
export interface LaborMaterialCostWorker extends LaborMaterialWorker {
  paidHours: number;
  regularHours: number;
  overtimeHours: number;
  costCents: number;
}
export interface LaborMaterialLegacyInput extends LaborMaterialBase {
  workers: readonly LaborMaterialWorker[];
  costPolicy: "hours_only_zero_placeholder" | "approved_unit_cost";
  /** Explicit server-approved input; never inferred from source costs or weekly payroll. */
  unitCostCents: number;
}
export interface LaborMaterialTotalCostInput extends LaborMaterialBase {
  workers: readonly LaborMaterialCostWorker[];
  costPolicy: "approved_total_cost";
  paidHours: number;
  regularHours: number;
  overtimeHours: number;
  /** Frozen server estimate under separately reviewed lunch and weekly overtime rules. */
  totalCostCents: number;
}
export type LaborMaterialInput = LaborMaterialLegacyInput | LaborMaterialTotalCostInput;

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hourHundredths(value: number): number {
  if (value !== 0 && !isHousecallQuantitySupported(value))
    throw new Error("Approved paid hours must be nonnegative and exact to at most two decimals");
  return Math.round(value * 100);
}

function validCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

function reviewedWorkers<T extends LaborMaterialWorker>(values: readonly T[], hours: number): T[] {
  if (!Array.isArray(values) || !values.length || values.length > 500)
    throw new Error("Approved labor worker rollup is required");
  const workerNames = new Set<string>();
  const workers = values.map((worker) => {
    if (
      typeof worker.workerName !== "string" ||
      !worker.workerName.trim() ||
      worker.workerName.length > 200 ||
      /\p{Cc}/u.test(worker.workerName) ||
      !isHousecallQuantitySupported(worker.hours)
    )
      throw new Error("Invalid approved worker hours");
    const workerName = worker.workerName.trim().replace(/\s+/gu, " ");
    const key = workerName.normalize("NFKC").toLowerCase();
    if (workerNames.has(key)) throw new Error("Duplicate worker rollup requires review");
    workerNames.add(key);
    return { ...worker, workerName };
  });
  workers.sort((a, b) => (a.workerName < b.workerName ? -1 : a.workerName > b.workerName ? 1 : 0));
  if (
    workers.reduce((total, worker) => total + Math.round(worker.hours * 100), 0) !==
    Math.round(hours * 100)
  )
    throw new Error("Approved worker hours do not match the approved job hours");
  return workers;
}

/** One approved job/period becomes one internal Job Inputs > Materials row.
 * Housecall's public API has no miscellaneous category or native employee-time
 * destination. Official bundled Housecall v1 OpenAPI inspected 2026-10-13:
 * https://docs.housecallpro.com/docs/housecall-public-api/a4ca20a18010c-housecall-v1-api
 * JobInputMaterial supports name/description/part_number/quantity/unit_cost;
 * omitting uuid adds a new entry. Preparation performs no provider calls or approval. */
export async function prepareLaborMaterialWrite(
  input: LaborMaterialInput,
): Promise<PreparedMaterialWrite> {
  const jobId = validateHousecallId(input.jobId);
  if (typeof input.snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(input.snapshotHash))
    throw new Error("Invalid labor approval snapshot hash");
  if (
    !validDate(input.period?.from) ||
    !validDate(input.period?.to) ||
    input.period.from > input.period.to
  )
    throw new Error("Invalid approved labor period");
  if (!isHousecallQuantitySupported(input.hours))
    throw new Error("Approved labor hours must be positive and exact to at most two decimals");
  const reference = `SVL-LAB-${input.snapshotHash.slice(0, 24)}`;
  let quantity: number;
  let unitCostCents: number;
  let name: string;
  let description: string;
  if (input.costPolicy === "approved_total_cost") {
    const workers = reviewedWorkers(input.workers, input.hours);
    const paid = hourHundredths(input.paidHours);
    const regular = hourHundredths(input.regularHours);
    const overtime = hourHundredths(input.overtimeHours);
    if (paid > Math.round(input.hours * 100) || regular + overtime !== paid)
      throw new Error("Approved paid, regular and overtime hours do not reconcile");
    if (!validCents(input.totalCostCents)) throw new Error("Invalid approved total labor cost");
    for (const worker of workers) {
      const workerPaid = hourHundredths(worker.paidHours);
      if (
        workerPaid > Math.round(worker.hours * 100) ||
        hourHundredths(worker.regularHours) + hourHundredths(worker.overtimeHours) !== workerPaid
      )
        throw new Error("Approved worker paid, regular and overtime hours do not reconcile");
      if (!validCents(worker.costCents)) throw new Error("Invalid approved worker labor cost");
    }
    for (const field of ["paidHours", "regularHours", "overtimeHours"] as const) {
      if (
        workers.reduce((total, worker) => total + hourHundredths(worker[field]), 0) !==
        hourHundredths(input[field])
      )
        throw new Error(`Approved worker ${field} do not match the approved job totals`);
    }
    if (workers.reduce((total, worker) => total + worker.costCents, 0) !== input.totalCostCents)
      throw new Error("Approved worker costs do not match the approved total labor cost");
    quantity = 1;
    unitCostCents = input.totalCostCents;
    name = `Labor - ${input.paidHours.toFixed(2)} paid hours (${input.period.from} to ${input.period.to})`;
    description = [
      "Estimated labor cost under approved lunch and overtime rules.",
      `Period: ${input.period.from} through ${input.period.to}.`,
      `Gross allocated: ${input.hours.toFixed(2)}h. Paid: ${input.paidHours.toFixed(2)}h; regular: ${input.regularHours.toFixed(2)}h; overtime: ${input.overtimeHours.toFixed(2)}h.`,
      `Workers: ${workers.map((worker) => `${worker.workerName}: gross ${worker.hours.toFixed(2)}h, paid ${worker.paidHours.toFixed(2)}h (${worker.regularHours.toFixed(2)}h regular/${worker.overtimeHours.toFixed(2)}h overtime), $${(worker.costCents / 100).toFixed(2)}`).join("; ")}.`,
      `Approval snapshot: ${input.snapshotHash}. Reference: ${reference}.`,
    ].join(" ");
  } else {
    const workers = reviewedWorkers(input.workers, input.hours);
    if (
      !validCents(input.unitCostCents) ||
      !["hours_only_zero_placeholder", "approved_unit_cost"].includes(input.costPolicy) ||
      (input.costPolicy === "hours_only_zero_placeholder" && input.unitCostCents !== 0) ||
      (input.costPolicy === "approved_unit_cost" && input.unitCostCents === 0)
    )
      throw new Error("Labor input requires an explicit matching cost policy and unit cost");
    const extendedCents =
      (BigInt(Math.round(input.hours * 100)) * BigInt(input.unitCostCents) + BigInt(50)) /
      BigInt(100);
    if (extendedCents > BigInt(2_147_483_647))
      throw new Error("Approved labor input cost exceeds limit");
    const costDescription =
      input.costPolicy === "hours_only_zero_placeholder"
        ? "Hours-only record: unit cost is an approved $0 placeholder, not payroll or calculated labor cost."
        : "Unit cost was explicitly approved for this input; payroll and overtime allocation are separate.";
    quantity = input.hours;
    unitCostCents = input.unitCostCents;
    name = `Labor hours (${input.period.from} to ${input.period.to})`;
    description = [
      costDescription,
      `Period: ${input.period.from} through ${input.period.to}.`,
      `Workers: ${workers.map((worker) => `${worker.workerName}: ${worker.hours.toFixed(2)}h`).join("; ")}.`,
      `Approval snapshot: ${input.snapshotHash}. Reference: ${reference}.`,
    ].join(" ");
  }
  if (description.length > 1000)
    throw new Error(
      "Approved worker rollup exceeds the provider description limit; review a smaller period",
    );
  const request = {
    kind: "job_cost" as const,
    jobId,
    method: "PUT" as const,
    path: `/jobs/${jobId}/job_input_materials/bulk_update`,
    reference,
    body: {
      job_input_materials: [
        {
          name,
          description,
          part_number: reference,
          quantity,
          unit_cost: unitCostCents,
        },
      ],
    },
  };
  return { ...request, requestHash: await housecallRequestHash(request) };
}
