import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { Nitro, NitroRouteRules } from "nitro/types";

export type IsrFallbackContext = {
  /** Requests a path from the built server. */
  fetch: (path: string) => Promise<Response>;
};

export type IsrFallbackOptions = {
  routes: string[] | ((context: IsrFallbackContext) => string[] | Promise<string[]>);
  /** Return false to leave a path without a fallback. */
  filter?: (path: string) => boolean;
  /** Return a reason to refuse a rendered page. */
  accept?: (response: Response, path: string) => string | void | Promise<string | void>;
  /** Origin of the request URL the pages are rendered with. */
  origin?: string;
  /** Response header that marks a fallback. `false` sends none. */
  header?: string | false;
  /** Headers of the rendered page that the fallback is served with. */
  copyHeaders?: string[];
  requestHeaders?: Record<string, string>;
  concurrency?: number;
  /** Limit for loading the server bundle and for each render. */
  timeoutMs?: number;
  /** Defaults to true on Vercel builds only. */
  enabled?: boolean;
};

const CONFIG_SUFFIX = ".prerender-config.json";
const FALLBACK_SUFFIX = ".prerender-fallback.html";
const PLAIN_PATH = /^\/$|^(?:\/[A-Za-z0-9_-]+)+$/;
const NULL_BODY = new Set([101, 204, 205, 304]);
const COPIED_HEADERS = [
  "content-type",
  "cache-control",
  "vary",
  "x-robots-tag",
  "link",
  "content-language",
  "referrer-policy",
];
const REQUEST_HEADERS = {
  accept: "text/html",
  "user-agent": "nitro-vercel-isr-fallback (build bot)",
};

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const http = require("node:http");

async function sender(app) {
  if (app && typeof app.fetch === "function")
    return (url) =>
      app.fetch(new Request(url, { headers: workerData.headers }), { waitUntil() {} });
  if (typeof app !== "function") throw new Error("the server bundle has no fetch or node handler");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const { port } = server.address();
  return (url) => {
    const { host, pathname, search, protocol } = new URL(url);
    return fetch("http://127.0.0.1:" + port + pathname + search, {
      redirect: "manual",
      headers: {
        ...workerData.headers,
        "x-forwarded-host": host,
        "x-forwarded-proto": protocol.slice(0, -1),
      },
    });
  };
}

import(workerData.entry)
  .then((bundle) => sender(bundle.default))
  .then(
    (send) => {
      parentPort.on("message", async ({ id, url }) => {
        try {
          const response = await send(url);
          const body = await response.text();
          parentPort.postMessage({ id, status: response.status, headers: [...response.headers], body });
        } catch (error) {
          parentPort.postMessage({ id, error: String(error) });
        }
      });
      parentPort.postMessage({ ready: true });
    },
    (error) => parentPort.postMessage({ failed: String(error) }),
  );`;

type Rendered = { status: number; headers: [string, string][]; body: string };
type Message = Partial<Rendered> & { id?: number; ready?: true; failed?: string; error?: string };
type Bundle = { fetch: (url: string) => Promise<Rendered | string>; close: () => Promise<number> };
type Fallback = { path: string; fn: string; html: string; headers: Record<string, string> };
type Route = {
  src?: string;
  dest?: string;
  has?: unknown;
  missing?: unknown;
  continue?: boolean;
  caseSensitive?: boolean;
};
type IsrRule = Exclude<NitroRouteRules["isr"], number | boolean | undefined> & {
  fallback?: string;
  initialStatus?: number;
  initialHeaders?: Record<string, string>;
};
type Settings = Required<Omit<IsrFallbackOptions, "filter" | "accept" | "enabled">> &
  Pick<IsrFallbackOptions, "filter" | "accept">;

const functionName = (path: string) => `${path.slice(1) || "index"}-isr`;

async function openBundle(
  entry: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Bundle> {
  const worker = new Worker(WORKER, {
    eval: true,
    workerData: { entry: pathToFileURL(entry).href, headers },
  });
  const pending = new Map<number, (result: Rendered | string) => void>();
  let next = 0;
  let stopped: string | undefined;
  const stop = (reason: string) => {
    stopped ??= reason;
    for (const settle of pending.values()) settle(stopped);
  };
  let timer: NodeJS.Timeout | undefined;
  await new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("the server bundle did not load")), timeoutMs);
    worker.on("error", (error) => {
      stop(`renderer failed: ${String(error)}`);
      reject(error);
    });
    worker.on("exit", () => {
      stop("renderer exited");
      reject(new Error("the server bundle exited while loading"));
    });
    worker.on("message", (message: Message) => {
      if (message.ready) resolve();
      else if (message.failed) reject(new Error(message.failed));
      else pending.get(message.id!)?.(message.error ?? (message as Rendered));
    });
  })
    .catch(async (error) => {
      await worker.terminate();
      throw error;
    })
    .finally(() => clearTimeout(timer));
  return {
    fetch(url) {
      const id = next++;
      return new Promise((resolve) => {
        if (stopped) return resolve(stopped);
        const timer = setTimeout(() => resolve(`no response in ${timeoutMs} ms`), timeoutMs);
        pending.set(id, (result) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(result);
        });
        worker.postMessage({ id, url });
      });
    },
    close: () => worker.terminate(),
  };
}

const toResponse = ({ status, headers, body }: Rendered) =>
  new Response(NULL_BODY.has(status) ? null : body, { status, headers });

function refusal(response: Response): string | undefined {
  if (response.status !== 200) return `status ${response.status}`;
  if (!response.headers.get("content-type")?.startsWith("text/html")) return "not HTML";
  if (response.headers.has("set-cookie")) return "sets a cookie";
  if (/private|no-store/i.test(response.headers.get("cache-control") ?? "")) return "private";
}

function isrRule(nitro: Nitro, path: string): IsrRule | string {
  const matched = nitro.routing.routeRules.matchAll("", path) as NitroRouteRules[];
  if (matched.some((rule) => rule.redirect || rule.proxy)) return "redirect or proxy rule";
  if (matched.some((rule) => rule.prerender)) return "prerendered";
  const isr = matched.findLast((rule) => rule.isr !== undefined)?.isr;
  if (!isr) return "no isr rule";
  const rule = isr === true ? { expiration: false as const } : isr;
  const page: IsrRule = typeof rule === "number" ? { expiration: rule } : rule;
  if (page.allowQuery?.length) return "varies by query";
  const own = nitro.options.routeRules[path]?.isr as IsrRule | number | boolean | undefined;
  if (typeof own === "object" && own.fallback) return "has its own fallback";
  return page;
}

async function render(nitro: Nitro, settings: Settings) {
  const entry = join(nitro.options.output.serverDir, "index.mjs");
  if (!existsSync(entry)) throw new Error(`no server bundle at ${entry}`);
  if (nitro.options.baseURL !== "/") throw new Error("a baseURL other than / is not supported");
  const bundle = await openBundle(entry, settings.requestHeaders, settings.timeoutMs);
  const request = (path: string) => bundle.fetch(new URL(path, settings.origin).href);
  try {
    const listed = Array.isArray(settings.routes)
      ? settings.routes
      : await settings.routes({
          async fetch(path) {
            const rendered = await request(path);
            if (typeof rendered === "string") throw new Error(`${path}: ${rendered}`);
            return toResponse(rendered);
          },
        });
    const fallbacks: (Fallback & { isr: IsrRule })[] = [];
    const skipped: string[] = [];
    const queue = [...new Set(listed)];
    const renderNext = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const outcome = await renderOne(nitro, settings, request, path);
        if (typeof outcome === "string") skipped.push(`${path} (${outcome})`);
        else fallbacks.push(outcome);
      }
    };
    await Promise.all(Array.from({ length: settings.concurrency }, renderNext));
    nitro.logger.info(`ISR fallbacks: ${fallbacks.length} written, ${skipped.length} skipped`);
    if (skipped.length) nitro.logger.info(`ISR fallbacks skipped: ${skipped.join(", ")}`);
    return fallbacks;
  } finally {
    await bundle.close();
  }
}

async function renderOne(
  nitro: Nitro,
  settings: Settings,
  request: (path: string) => Promise<Rendered | string>,
  path: string,
) {
  if (!PLAIN_PATH.test(path)) return "not a plain path";
  if (settings.filter && !settings.filter(path)) return "filtered out";
  const isr = isrRule(nitro, path);
  if (typeof isr === "string") return isr;
  const rendered = await request(path);
  if (typeof rendered === "string") return rendered;
  const response = toResponse(rendered);
  const reason = refusal(response) ?? (await settings.accept?.(response.clone(), path));
  if (reason) return reason;
  const headers = Object.fromEntries(
    settings.copyHeaders.flatMap((name) =>
      response.headers.has(name) ? [[name, response.headers.get(name)!]] : [],
    ),
  );
  return { path, fn: functionName(path), html: rendered.body, headers, isr };
}

const routeFor = (routes: Route[], { fn }: Fallback) =>
  routes.findIndex((route) => route.dest?.startsWith(`/${fn}?`));

function firstMatch(routes: Route[], path: string) {
  return routes.findIndex(({ src, dest, has, missing, continue: passes, caseSensitive }) => {
    if (!src || !dest || has || missing || passes) return false;
    try {
      return new RegExp(`^(?:${src})$`, caseSensitive ? "" : "i").test(path);
    } catch {
      return false;
    }
  });
}

async function placeRoutes(nitro: Nitro, fallbacks: Fallback[]) {
  const file = join(nitro.options.output.dir, "config.json");
  const config = JSON.parse(await readFile(file, "utf8")) as { routes: Route[] };
  const own = fallbacks.flatMap((fallback) => {
    const at = routeFor(config.routes, fallback);
    return at === -1 ? [] : [{ ...config.routes[at], caseSensitive: true }];
  });
  const rest = config.routes.filter((route) => !fallbacks.some((f) => route.dest?.startsWith(`/${f.fn}?`)));
  const first = rest.findIndex((route) => route.src?.includes("(?<__isr_route>"));
  rest.splice(first === -1 ? rest.length : first, 0, ...own);
  config.routes = rest;
  await writeFile(file, JSON.stringify(config, null, 2));
}

async function verify(nitro: Nitro, fallbacks: Fallback[]) {
  const functions = join(nitro.options.output.serverDir, "..");
  const { routes } = JSON.parse(
    await readFile(join(nitro.options.output.dir, "config.json"), "utf8"),
  ) as { routes: Route[] };
  const problems: string[] = [];
  for (const fallback of fallbacks) {
    const config = join(functions, `${fallback.fn}${CONFIG_SUFFIX}`);
    const file = join(functions, `${fallback.fn}${FALLBACK_SUFFIX}`);
    const at = routeFor(routes, fallback);
    const named =
      existsSync(config) &&
      (JSON.parse(await readFile(config, "utf8")) as { fallback?: string }).fallback ===
        basename(file);
    const found = [
      !existsSync(join(functions, `${fallback.fn}.func`)) && "no function",
      !existsSync(file) && "no fallback file",
      !named && "config names no fallback",
      (at === -1 || firstMatch(routes, fallback.path) !== at) && "route out of order",
      routes[at]?.caseSensitive !== true && "route ignores letter case",
    ].filter((problem) => problem !== false);
    if (found.length) problems.push(`${fallback.path}: ${found.join(", ")}`);
  }
  if (problems.length)
    throw new Error(`ISR fallbacks: wrong Vercel output. ${problems.join("; ")}`);
}

export function isrFallback(options: IsrFallbackOptions) {
  const {
    enabled = Boolean(process.env.VERCEL),
    filter,
    accept,
    routes,
    origin = process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost",
    header = "x-isr-fallback",
    copyHeaders = COPIED_HEADERS,
    requestHeaders = REQUEST_HEADERS,
    concurrency = 4,
    timeoutMs = 10_000,
  } = options;
  const settings = { routes, filter, accept, origin, header, copyHeaders, requestHeaders, concurrency, timeoutMs };
  return {
    name: "nitro-vercel-isr-fallback",
    setup(nitro: Nitro) {
      if (!enabled) return;
      if (nitro.options.preset !== "vercel") return;
      const write = nitro.options.hooks.compiled;
      if (typeof write !== "function")
        throw new Error("ISR fallbacks: the Vercel preset registered no output writer");
      nitro.hooks.removeHook("compiled", write);
      nitro.hooks.hook("compiled", async () => {
        let fallbacks: Awaited<ReturnType<typeof render>> = [];
        try {
          fallbacks = await render(nitro, settings);
        } catch (error) {
          nitro.logger.warn(`ISR fallbacks: none written, ${String(error)}`);
        }
        for (const { path, fn, headers, isr } of fallbacks) {
          nitro.options.routeRules[path] = {
            ...nitro.options.routeRules[path],
            isr: {
              ...isr,
              allowQuery: [],
              fallback: `${basename(fn)}${FALLBACK_SUFFIX}`,
              initialStatus: 200,
              initialHeaders: header ? { ...headers, [header]: "1" } : headers,
            } as IsrRule,
          };
        }
        await write(nitro);
        if (!fallbacks.length) return;
        await placeRoutes(nitro, fallbacks);
        const functions = join(nitro.options.output.serverDir, "..");
        await Promise.all(
          fallbacks.map(({ fn, html }) => writeFile(join(functions, `${fn}${FALLBACK_SUFFIX}`), html)),
        );
        await verify(nitro, fallbacks);
      });
    },
  };
}

export default isrFallback;
