import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { createHousecallClient, HOUSECALL_ORIGIN, HousecallError } from "@svl/integrations";
import { expect, test } from "vitest";

// Explicitly opted-in, GET-only account verification. Never enables app exports.
test.skipIf(process.env.RA6_LIVE_HOUSECALL_READS !== "1")(
  "verify only the privately inventoried test customers and jobs",
  async () => {
    const directory = resolve(".local/ra6");
    const inventory = JSON.parse(await readFile(resolve(directory, "test-jobs.json"), "utf8")) as {
      jobs: Array<{
        customerId: string;
        customerName: string;
        housecallJobId: string;
        initialTestCandidate: boolean;
      }>;
    };
    expect(inventory.jobs.length).toBe(4);
    const env = parseEnv(await readFile(process.env.RA6_ENV_FILE || "apps/web/.env.local", "utf8"));
    expect(env.HOUSECALL_EXPORT_MODE).toBe("disabled");
    expect(env.HOUSECALL_TEST_JOB_IDS || "").toBe("");
    const allowedUrls = new Set(
      inventory.jobs.flatMap((job) => [
        `${HOUSECALL_ORIGIN}/jobs/${job.housecallJobId}?expand%5B%5D=attachments`,
        `${HOUSECALL_ORIGIN}/jobs/${job.housecallJobId}/job_input_materials`,
        `${HOUSECALL_ORIGIN}/jobs?page=1&page_size=100&customer_id=${job.customerId}`,
      ]),
    );
    const requests: Array<Record<string, unknown>> = [];
    const jobs: Array<Record<string, unknown>> = [];
    const startedAt = new Date().toISOString();
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method !== "GET" || init.body != null || !allowedUrls.has(url))
        throw new Error("read_only_scope_violation");
      if (requests.length >= 12) throw new Error("read_budget_exhausted");
      const entry: Record<string, unknown> = {
        method: "GET",
        path: url.slice(HOUSECALL_ORIGIN.length),
      };
      requests.push(entry);
      const response = await fetch(input, init);
      entry.httpStatus = response.status;
      // Record structural diagnostics only; no raw customer data, URLs or credentials.
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      if (body && typeof body === "object")
        entry.responseFieldTypes = Object.fromEntries(
          Object.entries(body).map(([key, value]) => [
            key,
            value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
          ]),
        );
      return response;
    };
    const client = createHousecallClient({ apiKey: env.HOUSECALL_API_KEY || "", fetch: transport });
    let passed = false;
    let failure: Record<string, unknown> | null = null;
    try {
      for (const expected of inventory.jobs) {
        const job = await client.getJob(expected.housecallJobId, { includeAttachments: true });
        expect(job.customerId).toBe(expected.customerId);
        expect(job.customerName.replace(/\s/g, "")).toBe(expected.customerName.replace(/\s/g, ""));
        expect(job.canceled || job.deleted || job.locked).toBe(false);
        expect(job.active).toBe(true);
        if (expected.initialTestCandidate) expect(job.customerNotificationsEnabled).toBe(false);
        const materials = await client.listJobInputMaterials(job.id);
        const catalog = await client.listJobs({ customerId: expected.customerId });
        expect(catalog.totalPages).toBeLessThanOrEqual(1);
        expect(catalog.jobs.length).toBe(catalog.totalItems);
        expect(catalog.jobs.every((row) => row.customerId === expected.customerId)).toBe(true);
        expect(catalog.jobs.some((row) => row.id === job.id)).toBe(true);
        jobs.push({
          ...job,
          address: undefined,
          description: undefined,
          attachments: job.attachments?.map(({ url: _url, ...attachment }) => attachment),
          materials,
          customerFilteredCatalog: {
            page: catalog.page,
            totalPages: catalog.totalPages,
            totalItems: catalog.totalItems,
            jobIds: catalog.jobs.map((row) => row.id),
          },
        });
      }
      passed = true;
    } catch (cause) {
      failure =
        cause instanceof HousecallError
          ? { code: cause.code, httpStatus: cause.httpStatus, retryAfterMs: cause.retryAfterMs }
          : { code: "verification_failed" };
      throw new Error(`Read-only verification failed: ${failure.code}`);
    } finally {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        resolve(directory, "housecall-readonly-results.json"),
        `${JSON.stringify({ startedAt, completedAt: new Date().toISOString(), passed, liveWritesApproved: false, writeCount: 0, requests, jobs, failure }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
  },
);
