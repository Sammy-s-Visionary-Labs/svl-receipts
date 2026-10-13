import { type LaborWorkerDayAllocation, normalizeLaborWorkerName } from "./labor-allocation";

export interface LaborPaySettings {
  readonly workerRates: readonly {
    readonly workerName: string;
    readonly hourlyRateCents: number | null;
    /** Employment status does not remove imported historical hours. */
    readonly active: boolean;
  }[];
  readonly overtime: {
    readonly thresholdHours: number;
    readonly multiplier: number;
    /** Sunday is 0; Thursday is 4. */
    readonly weekStartsOn: number;
  };
}

export interface LaborPayInput {
  readonly workerDays: readonly LaborWorkerDayAllocation[];
  readonly settings: LaborPaySettings;
  /** Complete source coverage, including dates on which a worker did not work. */
  readonly completeDates?: readonly string[];
}

export interface LaborWorkerWeekPay {
  readonly workerName: string;
  readonly weekStart: string;
  readonly weekEnd: string;
  readonly grossHours: number;
  readonly lunchAdjustmentHours: number;
  readonly paidHours: number;
  readonly regularHours: number;
  readonly overtimeHours: number;
  readonly hourlyRateCents: number | null;
  readonly regularPayCents: number | null;
  readonly overtimePayCents: number | null;
  readonly estimatedPayCents: number | null;
  readonly active: boolean;
  readonly complete: boolean;
}

export interface LaborPayReport {
  readonly workerWeeks: readonly LaborWorkerWeekPay[];
  readonly totals: {
    readonly paidHours: number;
    readonly regularHours: number;
    readonly overtimeHours: number;
    readonly knownEstimatedPayCents: number;
    readonly unpricedHours: number;
  };
  readonly warnings: readonly string[];
}

function hourHundredths(value: number, label: string): number {
  const scaled = Math.round(value * 100);
  if (
    !Number.isFinite(value) ||
    !Number.isSafeInteger(scaled) ||
    Math.abs(value * 100 - scaled) > 0.000001
  )
    throw new Error(`${label} requires finite hours with at most two decimal places.`);
  return scaled;
}

function checkedSum(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("Payroll hours exceed the supported range.");
  return result;
}

function calendarDate(value: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Payroll dates must be valid calendar dates.");
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error("Payroll dates must be valid calendar dates.");
  return date;
}

function addDays(value: string, days: number): string {
  const date = calendarDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekStart(value: string, startsOn: number): string {
  const day = calendarDate(value).getUTCDay();
  return addDays(value, -((day - startsOn + 7) % 7));
}

function multiplierRatio(value: number): { numerator: bigint; denominator: bigint } {
  const decimal = String(value).match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!Number.isFinite(value) || value < 1 || !decimal)
    throw new Error("Overtime multiplier must be at least one with at most six decimal places.");
  const fraction = decimal[2] ?? "";
  return {
    numerator: BigInt(`${decimal[1]}${fraction}`),
    denominator: BigInt(10) ** BigInt(fraction.length),
  };
}

function safeCents(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Estimated pay exceeds the supported currency range.");
  return Number(value);
}

/** Round a nonnegative rational amount once, half up, at the weekly component boundary. */
function payCents(hours: number, rate: number, numerator = BigInt(1), denominator = BigInt(1)) {
  const amount = BigInt(hours) * BigInt(rate) * numerator;
  const divisor = BigInt(100) * denominator;
  return safeCents((BigInt(2) * amount + divisor) / (BigInt(2) * divisor));
}

/** Current-rate pay estimates only; allocation decisions and source costs are unchanged. */
export function estimateLaborPay(input: LaborPayInput): LaborPayReport {
  const settings = input.settings;
  if (!settings || !Array.isArray(settings.workerRates) || !settings.overtime)
    throw new Error("Payroll settings require worker rates and overtime rules.");
  const threshold = hourHundredths(settings.overtime.thresholdHours, "Overtime threshold");
  if (threshold <= 0) throw new Error("Overtime threshold must be positive.");
  const startsOn = settings.overtime.weekStartsOn;
  if (!Number.isInteger(startsOn) || startsOn < 0 || startsOn > 6)
    throw new Error("Payroll week start must be an integer from zero to six.");
  const multiplier = multiplierRatio(settings.overtime.multiplier);
  const rates = new Map<string, LaborPaySettings["workerRates"][number]>();
  for (const rate of settings.workerRates) {
    if (
      !rate ||
      typeof rate.workerName !== "string" ||
      !rate.workerName.trim() ||
      typeof rate.active !== "boolean" ||
      (rate.hourlyRateCents !== null &&
        (!Number.isSafeInteger(rate.hourlyRateCents) || rate.hourlyRateCents < 0))
    )
      throw new Error(
        "Worker pay settings require an exact name, active status and integer cents or null.",
      );
    const owner = normalizeLaborWorkerName(rate.workerName);
    if (rates.has(owner))
      throw new Error("Repeated normalized worker pay settings require review.");
    rates.set(owner, rate);
  }
  const completeDates = new Set(input.completeDates ?? []);
  for (const date of completeDates) calendarDate(date);
  const days = new Set<string>();
  const weeks = new Map<
    string,
    { owner: string; workerName: string; start: string; gross: number; lunch: number; paid: number }
  >();
  for (const day of input.workerDays) {
    if (typeof day.workerName !== "string" || !day.workerName.trim())
      throw new Error("Payroll worker days require an exact worker name.");
    const owner = normalizeLaborWorkerName(day.workerName);
    const dateKey = JSON.stringify([owner, day.date]);
    if (days.has(dateKey))
      throw new Error("Repeated worker-day owners require payroll identity review.");
    days.add(dateKey);
    const start = weekStart(day.date, startsOn);
    const gross = hourHundredths(day.grossHours, "Gross worker-day hours");
    const lunch = hourHundredths(day.lunchAdjustmentHours, "Worker-day lunch adjustment");
    const paid = hourHundredths(day.netHours, "Paid worker-day hours");
    if (gross < 0 || lunch > 0 || paid < 0 || paid !== gross + lunch)
      throw new Error(
        "Paid worker-day hours must preserve gross plus the single lunch adjustment.",
      );
    const key = JSON.stringify([owner, start]);
    const week = weeks.get(key) ?? {
      owner,
      workerName: rates.get(owner)?.workerName ?? day.workerName,
      start,
      gross: 0,
      lunch: 0,
      paid: 0,
    };
    week.gross = checkedSum(week.gross, gross);
    week.lunch = checkedSum(week.lunch, lunch);
    week.paid = checkedSum(week.paid, paid);
    weeks.set(key, week);
  }
  const missingRates = new Set<string>();
  let paidTotal = 0;
  let regularTotal = 0;
  let overtimeTotal = 0;
  let unpricedTotal = 0;
  let knownPayTotal = BigInt(0);
  const workerWeeks = [...weeks.values()]
    .map((week): LaborWorkerWeekPay => {
      const rate = rates.get(week.owner);
      const hourlyRateCents = rate?.hourlyRateCents ?? null;
      const regular = Math.min(week.paid, threshold);
      const overtime = Math.max(0, week.paid - threshold);
      const regularPayCents = hourlyRateCents === null ? null : payCents(regular, hourlyRateCents);
      const overtimePayCents =
        hourlyRateCents === null
          ? null
          : payCents(overtime, hourlyRateCents, multiplier.numerator, multiplier.denominator);
      const estimatedPayCents =
        regularPayCents === null || overtimePayCents === null
          ? null
          : safeCents(BigInt(regularPayCents) + BigInt(overtimePayCents));
      paidTotal = checkedSum(paidTotal, week.paid);
      regularTotal = checkedSum(regularTotal, regular);
      overtimeTotal = checkedSum(overtimeTotal, overtime);
      if (estimatedPayCents === null) {
        unpricedTotal = checkedSum(unpricedTotal, week.paid);
        missingRates.add(week.workerName);
      } else knownPayTotal += BigInt(estimatedPayCents);
      return Object.freeze({
        workerName: week.workerName,
        weekStart: week.start,
        weekEnd: addDays(week.start, 6),
        grossHours: week.gross / 100,
        lunchAdjustmentHours: week.lunch / 100,
        paidHours: week.paid / 100,
        regularHours: regular / 100,
        overtimeHours: overtime / 100,
        hourlyRateCents,
        regularPayCents,
        overtimePayCents,
        estimatedPayCents,
        active: rate?.active ?? true,
        complete: Array.from({ length: 7 }, (_, index) => addDays(week.start, index)).every(
          (date) => completeDates.has(date),
        ),
      });
    })
    .sort(
      (a, b) => b.weekStart.localeCompare(a.weekStart) || a.workerName.localeCompare(b.workerName),
    );
  const warnings = [...missingRates]
    .sort()
    .map((worker) => `Hourly rate is not configured for ${worker}; estimated pay remains unknown.`);
  const incompleteCount = workerWeeks.filter((week) => !week.complete).length;
  if (incompleteCount)
    warnings.push(
      `${incompleteCount} worker week${incompleteCount === 1 ? " is" : "s are"} missing complete seven-day source coverage; pay remains an estimate.`,
    );
  return Object.freeze({
    workerWeeks: Object.freeze(workerWeeks),
    totals: Object.freeze({
      paidHours: paidTotal / 100,
      regularHours: regularTotal / 100,
      overtimeHours: overtimeTotal / 100,
      knownEstimatedPayCents: safeCents(knownPayTotal),
      unpricedHours: unpricedTotal / 100,
    }),
    warnings: Object.freeze(warnings),
  });
}
