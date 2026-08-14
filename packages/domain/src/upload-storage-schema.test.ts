import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_RECEIPT_BYTES } from "./upload";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260814180000_receipts_storage_private.sql",
  ),
  "utf8",
);

describe("RA-17 receipts bucket", () => {
  it("keeps the receipts bucket private with the same size cap as the domain", () => {
    expect(sql).toContain("public = false");
    expect(sql).toContain(`file_size_limit = ${MAX_RECEIPT_BYTES}`);
    expect(sql).toContain("'image/jpeg'");
    expect(sql).toContain("'image/png'");
    expect(sql).toContain("'image/webp'");
    expect(sql).toContain("where id = 'receipts'");
  });
});
