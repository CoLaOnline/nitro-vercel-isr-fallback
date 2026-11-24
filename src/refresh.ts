import { createHmac, timingSafeEqual } from "node:crypto";

export type RefreshResult = {
  event: string;
  /** Deployment the event names. */
  deployment: unknown;
  /** Deployment that handled the event. */
  servedBy: string | undefined;
  requested: number;
  /** Paths still answered with a fallback after the last pass. */
  fallbacks: string[];
  /** Paths that answered 5xx or not at all. */
  failed: string[];
};

export type RefreshOptions = {
  /** Paths to request, or a function returning them for the live origin. */
  paths: string[] | ((origin: string) => string[] | Promise<string[]>);
  /** Keeps the function alive after the response, e.g. `waitUntil` from `@vercel/functions`. */
  waitUntil: (work: Promise<unknown>) => void;
  /** Vercel webhook secret. Defaults to `process.env.VERCEL_WEBHOOK_SECRET`. */
  secret?: string;
  /** Response header that marks a fallback. Must match the build module's `header`. */
  header?: string;
  passes?: number;
  gapMs?: number;
  concurrency?: number;
  timeoutMs?: number;
  onDone?: (result: RefreshResult) => void;
};

type Live = { event: string; id: unknown; sentAt: unknown };

const REDELIVERY_WINDOW_MS = 600_000;

const json = (value: unknown, status: number) =>
  Response.json(value, { status, headers: { "cache-control": "private, no-store" } });

const record = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function signed(payload: string, secret: string, signature: string) {
  const expected = Buffer.from(createHmac("sha1", secret).update(payload).digest("hex"));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function liveDeployment(body: Record<string, unknown>): Live | undefined {
  const payload = record(body.payload);
  const sentAt = body.createdAt;
  if (body.type === "deployment.promoted")
    return { event: body.type, id: record(payload?.deployment)?.id, sentAt };
  if (body.type === "deployment.rollback")
    return { event: body.type, id: payload?.toDeploymentId, sentAt };
}

const misdelivered = ({ id, sentAt }: Live) =>
  id !== process.env.VERCEL_DEPLOYMENT_ID &&
  typeof sentAt === "number" &&
  Date.now() - sentAt < REDELIVERY_WINDOW_MS;

function report({ fallbacks, failed, ...rest }: RefreshResult) {
  console.log("isr-fallback-refresh", { ...rest, fallbacks, failed });
  if (fallbacks.length || failed.length)
    console.error("isr-fallback-refresh-incomplete", { fallbacks, failed });
}

export function refreshOnPromotion(options: RefreshOptions) {
  const {
    paths,
    waitUntil,
    header = "x-isr-fallback",
    passes = 8,
    gapMs = 15_000,
    concurrency = 6,
    timeoutMs = 10_000,
    onDone = report,
  } = options;

  async function requestAll(origin: string, wanted: string[]) {
    const queue = [...wanted];
    const fallbacks: string[] = [];
    const failed: string[] = [];
    const requestNext = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        try {
          const response = await fetch(new URL(path, origin), {
            signal: AbortSignal.timeout(timeoutMs),
          });
          await response.text();
          if (response.status >= 500) failed.push(path);
          else if (response.headers.has(header)) fallbacks.push(path);
        } catch {
          failed.push(path);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, requestNext));
    return { fallbacks, failed };
  }

  async function refresh(origin: string, live: Live) {
    const failed: string[] = [];
    let requested: string[] = [];
    try {
      requested = Array.isArray(paths) ? paths : await paths(origin);
    } catch {
      failed.push("(paths)");
    }
    let fallbacks = requested;
    for (let pass = 0; pass < passes && fallbacks.length; pass++) {
      if (pass) await new Promise((resolve) => setTimeout(resolve, gapMs));
      const answered = await requestAll(origin, fallbacks);
      fallbacks = answered.fallbacks;
      failed.push(...answered.failed);
    }
    onDone({
      event: live.event,
      deployment: live.id,
      servedBy: process.env.VERCEL_DEPLOYMENT_ID,
      requested: requested.length,
      fallbacks,
      failed,
    });
  }

  return async function handle(request: Request): Promise<Response> {
    const secret = options.secret ?? process.env.VERCEL_WEBHOOK_SECRET;
    if (!secret) return json({ error: "Webhook secret is not configured" }, 503);
    const payload = await request.text();
    if (!signed(payload, secret, request.headers.get("x-vercel-signature") ?? ""))
      return json({ error: "Webhook signature rejected" }, 400);
    let body: Record<string, unknown> | undefined;
    try {
      body = record(JSON.parse(payload));
    } catch {
      body = undefined;
    }
    if (!body) return json({ error: "Unrecognized webhook payload" }, 400);
    const live = liveDeployment(body);
    if (live && misdelivered(live))
      return json({ error: "Delivered to another deployment; send again" }, 503);
    if (live) waitUntil(refresh(new URL(request.url).origin, live));
    return json({ received: true }, 200);
  };
}

export default refreshOnPromotion;
