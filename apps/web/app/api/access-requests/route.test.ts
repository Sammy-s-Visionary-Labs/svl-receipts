import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { POST } from "./route";

vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));
const createUser = vi.fn();
const rpc = vi.fn();
const body = {
  fullName: "Test Worker",
  email: "test@example.invalid",
  phone: "",
  password: "test-password-only",
};
function request(data = body, origin = "https://receipts.example") {
  return new Request("https://receipts.example/api/access-requests", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      "x-vercel-forwarded-for": "192.0.2.1",
    },
    body: JSON.stringify(data),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "unit-test-secret-only");
  vi.mocked(createServiceRoleClient).mockReturnValue({
    rpc,
    auth: { admin: { createUser } },
  } as never);
  rpc.mockResolvedValue({ data: true, error: null });
  createUser.mockResolvedValue({ error: null });
});
describe("worker registration", () => {
  it("uses Supabase Auth, never accepts a requested role, and hashes rate-limit identifiers", async () => {
    const response = await POST(
      request({
        ...body,
        role: "admin",
        app_metadata: { svl_access_approved: true },
      } as typeof body),
    );
    expect(response.status).toBe(202);
    expect(createUser).toHaveBeenCalledWith({
      email: body.email,
      password: body.password,
      email_confirm: true,
      user_metadata: { full_name: body.fullName, phone: "" },
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(body.email);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("192.0.2.1");
    expect(await response.text()).not.toContain(body.password);
  });
  it("rejects cross-origin registration before creating an account", async () => {
    expect((await POST(request(body, "https://unrelated.invalid"))).status).toBe(403);
    expect(createUser).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does not create accounts when the throttle or database refuses", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    expect((await POST(request())).status).toBe(429);
    expect(createUser).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    expect((await POST(request())).status).toBe(503);
    expect(createUser).not.toHaveBeenCalled();
  });
  it("does not reveal or replace an existing account", async () => {
    const normal = await (await POST(request())).text();
    createUser.mockResolvedValue({ error: { code: "email_exists" } });
    expect(await (await POST(request())).text()).toBe(normal);
  });
  it("rejects short passwords without sending them to Auth", async () => {
    expect((await POST(request({ ...body, password: "short" }))).status).toBe(400);
    expect(createUser).not.toHaveBeenCalled();
  });
});
