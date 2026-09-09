import type {
  PreparedAttachmentWrite,
  PreparedHousecallWrite,
  PreparedMaterialWrite,
} from "./types";

export const HOUSECALL_ORIGIN = "https://api.housecallpro.com" as const;
const MAX_CENTS = 2_147_483_647;

export function validateHousecallId(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(value))
    throw new Error("Invalid Housecall identifier");
  return value;
}
function referencePart(value: string): string {
  return validateHousecallId(value);
}
export async function housecallSha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function housecallRequestHash(value: unknown): Promise<string> {
  return housecallSha256(new TextEncoder().encode(stableJson(value)));
}

export async function prepareMaterialWrite(input: {
  jobId: string;
  intentId: string;
  receiptId: string;
  receiptLineId: string;
  description: string;
  approvedReference?: string;
  quantity: number;
  unitCostCents: number;
}): Promise<PreparedMaterialWrite> {
  const jobId = validateHousecallId(input.jobId);
  const reference = `SVL:${referencePart(input.intentId)}:${referencePart(input.receiptLineId)}`;
  referencePart(input.receiptId);
  if (
    input.approvedReference !== undefined &&
    (typeof input.approvedReference !== "string" || input.approvedReference.length > 500)
  )
    throw new Error("Invalid approved receipt reference");
  const approvedReference = input.approvedReference?.trim();
  const description = input.description.trim();
  if (!description || description.length > 1000) throw new Error("Invalid material description");
  if (
    !Number.isFinite(input.quantity) ||
    input.quantity <= 0 ||
    input.quantity > MAX_CENTS ||
    Math.abs(input.quantity * 1000 - Math.round(input.quantity * 1000)) > 1e-6
  )
    throw new Error("Invalid material quantity");
  if (
    !Number.isSafeInteger(input.unitCostCents) ||
    input.unitCostCents < 0 ||
    input.unitCostCents > MAX_CENTS
  )
    throw new Error("Invalid material unit cost");
  const extendedCents =
    (BigInt(Math.round(input.quantity * 1000)) * BigInt(input.unitCostCents) + BigInt(500)) /
    BigInt(1000);
  if (extendedCents > BigInt(MAX_CENTS)) throw new Error("Material extended cost exceeds limit");
  const request = {
    kind: "job_cost" as const,
    jobId,
    method: "PUT" as const,
    path: `/jobs/${jobId}/job_input_materials/bulk_update`,
    reference,
    body: {
      job_input_materials: [
        {
          name: description,
          description: `${approvedReference ? `${approvedReference}; ` : ""}Receipt ${input.receiptId}; ${reference}`,
          part_number: reference,
          quantity: input.quantity,
          unit_cost: input.unitCostCents,
        },
      ],
    },
  };
  return { ...request, requestHash: await housecallRequestHash(request) };
}

export async function prepareAttachmentWrite(input: {
  jobId: string;
  intentId: string;
  receiptId: string;
  pageId: string;
  bytes: Uint8Array;
  contentType: PreparedAttachmentWrite["contentType"];
}): Promise<PreparedAttachmentWrite> {
  const jobId = validateHousecallId(input.jobId);
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.length < 1 ||
    input.bytes.length > 20 * 1024 * 1024
  )
    throw new Error("Invalid receipt image size");
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[
    input.contentType
  ];
  if (!extension) throw new Error("Unsupported receipt image type");
  const bytes = new Uint8Array(input.bytes);
  const contentSha256 = await housecallSha256(bytes);
  const reference = `svl-${referencePart(input.receiptId)}-${referencePart(input.intentId)}-${referencePart(input.pageId)}-${contentSha256}`;
  const request = {
    kind: "attachment" as const,
    jobId,
    method: "POST" as const,
    path: `/jobs/${jobId}/attachments`,
    reference,
    fileName: `${reference}.${extension}`,
    contentType: input.contentType,
    contentSha256,
  };
  if (request.fileName.length > 255) throw new Error("Receipt reference filename exceeds limit");
  return { ...request, bytes, requestHash: await housecallRequestHash(request) };
}

/** Rehash the exact request immediately before dispatch, including the actual image bytes. */
export async function verifyPreparedHousecallWrite(
  write: PreparedHousecallWrite,
): Promise<boolean> {
  validateHousecallId(write.jobId);
  if (write.kind === "attachment") {
    const { bytes, requestHash, ...request } = write;
    return (
      write.method === "POST" &&
      write.path === `/jobs/${write.jobId}/attachments` &&
      write.fileName ===
        `${write.reference}.${{ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[write.contentType]}` &&
      write.fileName.length <= 255 &&
      !!{ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[write.contentType] &&
      write.bytes.length > 0 &&
      write.bytes.length <= 20 * 1024 * 1024 &&
      write.contentSha256 === (await housecallSha256(bytes)) &&
      requestHash === (await housecallRequestHash(request))
    );
  }
  const { requestHash, ...request } = write;
  const line = write.body.job_input_materials[0];
  return (
    write.method === "PUT" &&
    write.path === `/jobs/${write.jobId}/job_input_materials/bulk_update` &&
    write.body.job_input_materials.length === 1 &&
    !!line &&
    line.part_number === write.reference &&
    Object.keys(write.body).join() === "job_input_materials" &&
    Object.keys(line).sort().join() === "description,name,part_number,quantity,unit_cost" &&
    typeof line.name === "string" &&
    !!line.name.trim() &&
    line.name.length <= 1000 &&
    Number.isFinite(line.quantity) &&
    line.quantity > 0 &&
    line.quantity <= MAX_CENTS &&
    Math.abs(line.quantity * 1000 - Math.round(line.quantity * 1000)) <= 1e-6 &&
    Number.isSafeInteger(line.unit_cost) &&
    line.unit_cost >= 0 &&
    line.unit_cost <= MAX_CENTS &&
    (BigInt(Math.round(line.quantity * 1000)) * BigInt(line.unit_cost) + BigInt(500)) /
      BigInt(1000) <=
      BigInt(MAX_CENTS) &&
    requestHash === (await housecallRequestHash(request))
  );
}
