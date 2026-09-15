import { createHash } from "node:crypto";

// Synthetic, loopback-only persistence. Browser tests use normal application APIs,
// cookie/bearer guards, signed uploads and checksum confirmation against this service.
const receipts = new Map();
const pages = new Map();
const objects = new Map();
const signedKeys = new Set();
export function fieldQueueRows() {
  return [...receipts.values()]
    .filter((row) => row.submitted_at)
    .map((row) => ({
      id: row.id,
      status: row.status,
      submittedAt: row.submitted_at,
      submitterId: row.owner_user_id,
      vendor: null,
      reference: null,
      pageCount: pages.get(row.id)?.length ?? 0,
      housecallStatus: "not_started",
      hasThumbnail: false,
      warnings: [],
      duplicate: "unmarked",
    }));
}
export async function handleFieldFixture(request, response, url, profile, send) {
  const path = url.pathname;
  const service = request.headers.authorization === "Bearer sb_secret_ra27_browser_fixture_only";
  const body = async () => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  const json = async () => JSON.parse((await body()).toString() || "{}");
  const finish = (code, value) => {
    send(code, value);
    return true;
  };
  if (path === "/__field/reset") {
    receipts.clear();
    pages.clear();
    objects.clear();
    signedKeys.clear();
    return finish(200, { ok: true });
  }
  if (path === "/__field/state")
    return finish(200, {
      receipts: [...receipts.values()],
      pages: [...pages.values()].flat(),
      objectCount: objects.size,
    });
  if (path.startsWith("/storage/v1/object/")) {
    const prefix = path.includes("/upload/sign/")
      ? "/storage/v1/object/upload/sign/receipts/"
      : path.includes("/sign/")
        ? "/storage/v1/object/sign/receipts/"
        : "/storage/v1/object/receipts/";
    const key = decodeURIComponent(path.slice(prefix.length));
    if (request.method === "POST" && service) {
      if (path === "/storage/v1/object/sign/receipts") {
        const input = await json();
        return finish(
          200,
          input.paths.map((item) => ({
            path: item,
            signedURL: `/object/sign/receipts/${item}?token=fixture`,
            error: null,
          })),
        );
      }
      if (path.includes("/upload/sign/")) {
        signedKeys.add(key);
        return finish(200, { url: `/object/upload/sign/receipts/${key}?token=fixture` });
      }
      return finish(200, { signedURL: `/object/sign/receipts/${key}?token=fixture` });
    }
    if (
      request.method === "PUT" &&
      url.searchParams.get("token") === "fixture" &&
      signedKeys.has(key)
    ) {
      if (objects.has(key)) return finish(409, { error: "Duplicate" });
      objects.set(key, await body());
      return finish(200, { Key: key });
    }
    if (request.method === "GET" && (service || url.searchParams.get("token") === "fixture")) {
      const bytes = objects.get(key);
      if (!bytes) return finish(404, { error: "not_found" });
      response.setHeader("Content-Type", "image/jpeg");
      response.writeHead(200);
      response.end(bytes);
      return true;
    }
    return finish(403, { error: "Forbidden" });
  }
  if (path === "/rest/v1/rpc/create_upload_pending_receipt_set" && service) {
    const input = await json();
    if (!receipts.has(input.p_receipt_id)) {
      receipts.set(input.p_receipt_id, {
        id: input.p_receipt_id,
        owner_user_id: input.p_actor_id,
        status: "upload_pending",
        submitted_at: null,
        cleanup_claimed_at: null,
        content_deleted_at: null,
        storage_key: input.p_pages[0].storageKey,
      });
      pages.set(
        input.p_receipt_id,
        input.p_pages.map((page) => ({
          receipt_id: input.p_receipt_id,
          page_index: page.pageIndex,
          storage_key: page.storageKey,
          content_type: page.contentType,
          checksum: null,
          byte_size: null,
          confirmed_at: null,
        })),
      );
    }
    return finish(200, null);
  }
  if (path === "/rest/v1/rpc/submit_confirmed_receipt_set" && service) {
    const input = await json();
    const row = receipts.get(input.p_receipt_id);
    if (!row || row.owner_user_id !== input.p_actor_id) return finish(403, { code: "42501" });
    row.submitted_at ??= new Date().toISOString();
    row.status = "submitted";
    for (const page of pages.get(row.id)) {
      const bytes = objects.get(page.storage_key);
      const expected = input.p_pages[page.page_index];
      if (createHash("sha256").update(bytes).digest("hex") !== expected.checksum)
        return finish(409, { code: "checksum_mismatch" });
      Object.assign(page, {
        checksum: expected.checksum,
        byte_size: bytes.length,
        confirmed_at: row.submitted_at,
      });
    }
    return finish(200, { id: row.id, status: "submitted", submittedAt: row.submitted_at });
  }
  if (path === "/rest/v1/rpc/claim_receipt_work" && service) return finish(200, []);
  if (
    ["/rest/v1/receipts", "/rest/v1/receipt_pages", "/rest/v1/readability_checks"].includes(path)
  ) {
    if (!service && (!profile || profile.disabled)) return finish(401, { code: "bad_jwt" });
    if (path === "/rest/v1/readability_checks")
      return finish(200, request.headers.accept?.includes("vnd.pgrst.object") ? null : []);
    const own = [...receipts.values()].filter(
      (row) => service || profile.role !== "worker" || row.owner_user_id === profile.id,
    );
    const id = url.searchParams.get("id")?.replace(/^eq\./, "");
    if (path === "/rest/v1/receipts") {
      let selected = own.filter((row) => !id || row.id === id);
      const owner = url.searchParams.get("owner_user_id")?.replace(/^eq\./, "");
      if (owner) selected = selected.filter((row) => row.owner_user_id === owner);
      if (url.searchParams.get("submitted_at") === "not.is.null")
        selected = selected.filter((row) => row.submitted_at);
      return finish(
        200,
        request.headers.accept?.includes("vnd.pgrst.object") ? (selected[0] ?? null) : selected,
      );
    }
    const receiptFilter = url.searchParams.get("receipt_id");
    let selected = [...pages.values()]
      .flat()
      .filter((page) => own.some((row) => row.id === page.receipt_id));
    if (receiptFilter?.startsWith("eq."))
      selected = selected.filter((page) => page.receipt_id === receiptFilter.slice(3));
    if (receiptFilter?.startsWith("in.("))
      selected = selected.filter((page) => receiptFilter.includes(page.receipt_id));
    const pageFilter = url.searchParams.get("page_index");
    if (pageFilter)
      selected = selected.filter((page) => page.page_index === Number(pageFilter.slice(3)));
    return finish(
      200,
      request.headers.accept?.includes("vnd.pgrst.object") ? (selected[0] ?? null) : selected,
    );
  }
  return false;
}
