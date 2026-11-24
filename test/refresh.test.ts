import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshOnPromotion, type RefreshOptions, type RefreshResult } from "../src/refresh";

const SECRET = "test-secret";
const ORIGIN = "https://example.com";
const LIVE = "dpl_live";

const promoted = (id = LIVE, createdAt = Date.now()) => ({
  type: "deployment.promoted",
  createdAt,
  payload: { deployment: { id } },
});

function delivery(body: unknown, secret = SECRET) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${ORIGIN}/api/webhooks/vercel`, {
    method: "POST",
    body: payload,
    headers: { "x-vercel-signature": createHmac("sha1", secret).update(payload).digest("hex") },
  });
}

function setup(answers: Record<string, (Response | Error)[]>, options: Partial<RefreshOptions> = {}) {
  const requests: string[] = [];
  const work: Promise<unknown>[] = [];
  const results: RefreshResult[] = [];
  vi.stubGlobal("fetch", async (url: URL) => {
    requests.push(url.pathname + url.search);
    const answer = answers[url.pathname + url.search]?.shift() ?? new Response("fresh");
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const handle = refreshOnPromotion({
    paths: ["/", "/about"],
    waitUntil: (promise) => void work.push(promise),
    gapMs: 1,
    onDone: (result) => void results.push(result),
    ...options,
  });
  const send = async (request: Request) => {
    const response = await handle(request);
    await Promise.all(work);
    return response;
  };
  return { send, requests, results };
}

const fallback = () => new Response("built", { headers: { "x-isr-fallback": "1" } });

describe("refresh after a promotion", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", SECRET);
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", LIVE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("requests every path on the live origin once when none answers with a fallback", async () => {
    const { send, requests, results } = setup({});
    expect((await send(delivery(promoted()))).status).toBe(200);
    expect(requests.sort()).toEqual(["/", "/about"]);
    expect(results).toEqual([
      {
        event: "deployment.promoted",
        deployment: LIVE,
        servedBy: LIVE,
        requested: 2,
        fallbacks: [],
        failed: [],
      },
    ]);
  });

  it("requests a path again until it stops answering with a fallback", async () => {
    const { send, requests, results } = setup({ "/about": [fallback(), fallback()] });
    await send(delivery(promoted()));
    expect(requests.filter((path) => path === "/about")).toHaveLength(3);
    expect(requests.filter((path) => path === "/")).toHaveLength(1);
    expect(results[0].fallbacks).toEqual([]);
  });

  it("reports the paths still on a fallback after the last pass, and the ones that failed", async () => {
    const { send, results } = setup(
      {
        "/about": [fallback(), fallback()],
        "/": [new Response("down", { status: 502 })],
        "/gone": [new Error("timeout")],
      },
      { passes: 2, paths: () => ["/", "/about", "/gone"] },
    );
    await send(delivery(promoted()));
    expect(results[0]).toMatchObject({ requested: 3, fallbacks: ["/about"] });
    expect(results[0].failed.sort()).toEqual(["/", "/gone"]);
  });

  it("uses a custom marker header and a path list built from the origin", async () => {
    const { send, requests, results } = setup(
      { "/pricing": [new Response("built", { headers: { "x-copy": "1" } })] },
      { header: "x-copy", passes: 1, paths: (origin) => (origin === ORIGIN ? ["/pricing"] : []) },
    );
    await send(delivery(promoted()));
    expect(requests).toEqual(["/pricing"]);
    expect(results[0].fallbacks).toEqual(["/pricing"]);
  });

  it("refreshes after a rollback to this deployment", async () => {
    const { send, results } = setup({});
    const rollback = {
      type: "deployment.rollback",
      createdAt: Date.now(),
      payload: { toDeploymentId: LIVE },
    };
    expect((await send(delivery(rollback))).status).toBe(200);
    expect(results[0]).toMatchObject({ event: "deployment.rollback", deployment: LIVE });
  });

  it("asks Vercel to send a recent event again when it reached another deployment", async () => {
    const { send, requests } = setup({});
    expect((await send(delivery(promoted("dpl_other")))).status).toBe(503);
    expect(requests).toEqual([]);
  });

  it("refreshes on an old event that names another deployment instead of asking again forever", async () => {
    const { send, results } = setup({});
    const old = promoted("dpl_other", Date.now() - 700_000);
    expect((await send(delivery(old))).status).toBe(200);
    expect(results[0]).toMatchObject({ deployment: "dpl_other", servedBy: LIVE });
  });

  it("acknowledges other events without requesting anything", async () => {
    const { send, requests } = setup({});
    expect((await send(delivery({ type: "deployment.created", payload: {} }))).status).toBe(200);
    expect(requests).toEqual([]);
  });

  it("rejects a wrong signature, an unreadable payload and a missing secret", async () => {
    const { send, requests } = setup({});
    expect((await send(delivery(promoted(), "wrong"))).status).toBe(400);
    expect((await send(delivery("not json"))).status).toBe(400);
    expect((await send(delivery([1])))).toMatchObject({ status: 400 });
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "");
    expect((await send(delivery(promoted()))).status).toBe(503);
    expect(requests).toEqual([]);
  });
});
