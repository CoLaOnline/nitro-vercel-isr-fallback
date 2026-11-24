import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNitro } from "nitro/builder";
import type { Nitro, NitroConfig } from "nitro/types";
import { beforeAll, describe, expect, it } from "vitest";
import { isrFallback, type IsrFallbackOptions } from "../src/isr-fallback";

type VercelRoute = { src?: string; dest?: string; handle?: string; caseSensitive?: boolean };
type PrerenderConfig = Record<string, unknown>;
type Build = {
  routes: VercelRoute[];
  configs: Record<string, PrerenderConfig>;
  fallbacks: Record<string, string>;
  logs: string[];
};

const CONFIG = ".prerender-config.json";
const FALLBACK = ".prerender-fallback.html";
const HTML = { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0" };
const routeRules: NitroConfig["routeRules"] = {
  "/**": { isr: 60 },
  "/api/**": { isr: false },
  "/search": { isr: { expiration: 60, allowQuery: ["q"] } },
  "/old": { redirect: "/about" },
  "/:section/latest": { isr: 30 },
};
const LISTED = [
  "/",
  "/about",
  "/blog/first-post",
  "/news/latest",
  "/broken",
  "/moved",
  "/private",
  "/cookie",
  "/text",
  "/slow",
  "/search",
  "/old",
  "/api/items",
  "/files/report.pdf",
  "/blog/:slug",
];

const page = (status: number, headers: Record<string, string> = HTML) => ({ status, headers });
const PAGES = {
  "/": page(200),
  "/about": page(200, { ...HTML, "x-robots-tag": "noindex", "x-internal": "1" }),
  "/blog/first-post": page(200),
  "/news/latest": page(200),
  "/search": page(200),
  "/api/items": page(200),
  "/broken": page(500),
  "/moved": page(308, { ...HTML, location: "/about" }),
  "/private": page(200, { ...HTML, "cache-control": "private, no-store" }),
  "/cookie": page(200, { ...HTML, "set-cookie": "a=1" }),
  "/text": page(200, { ...HTML, "content-type": "text/plain" }),
};

const answer = `
const pages = ${JSON.stringify(PAGES)};
function answer(path, agent) {
  if (path === "/slow") return undefined;
  if (path === "/routes.json") return { status: 200, headers: {}, body: JSON.stringify(${JSON.stringify(LISTED)}) };
  if (!/bot/i.test(agent ?? "")) return { status: 400, headers: {}, body: "not the build bot" };
  const page = pages[path] ?? { status: 404, headers: ${JSON.stringify(HTML)} };
  return { ...page, body: "<html>" + path + "</html>" };
}`;

const webBundle = (crashes = false) => `${answer}
export default {
  async fetch(request) {
    if (${crashes}) return new Promise(() => setTimeout(() => { throw new Error("data source down"); }));
    const found = answer(new URL(request.url).pathname, request.headers.get("user-agent"));
    return found ? new Response(found.body, found) : new Promise(() => {});
  },
};`;

const nodeBundle = `${answer}
export default function handler(req, res) {
  const found = answer(req.url.split("?")[0], req.headers["user-agent"]);
  if (!found) return;
  res.writeHead(found.status, { ...found.headers, "x-seen-host": req.headers["x-forwarded-host"] });
  res.end(found.body);
}`;

async function build(config: Partial<NitroConfig> = {}, bundle?: string): Promise<Build> {
  const rootDir = await mkdtemp(join(tmpdir(), "isr-fallback-"));
  const logs: string[] = [];
  try {
    const nitro = await createNitro({
      rootDir,
      preset: "vercel",
      dev: false,
      logLevel: 0,
      routeRules,
      ...config,
    });
    nitro.logger.info = nitro.logger.warn = ((message: string) => logs.push(message)) as never;
    try {
      if (bundle) {
        await mkdir(nitro.options.output.serverDir, { recursive: true });
        await writeFile(join(nitro.options.output.serverDir, "index.mjs"), bundle);
      }
      await nitro.hooks.callHook("compiled", nitro);
      const output = nitro.options.output.dir;
      const functions = join(output, "functions");
      const names = (await readdir(functions, { recursive: true })).filter(
        (name) => name.endsWith(CONFIG) || name.endsWith(FALLBACK),
      );
      const files = await Promise.all(
        names.map(async (name): Promise<[string, string]> => [
          `/${name}`,
          await readFile(join(functions, name), "utf8"),
        ]),
      );
      const { routes } = JSON.parse(await readFile(join(output, "config.json"), "utf8"));
      return {
        routes,
        logs,
        configs: Object.fromEntries(
          files
            .filter(([name]) => name.endsWith(CONFIG))
            .map(([name, text]) => [name.slice(0, -CONFIG.length), JSON.parse(text)]),
        ),
        fallbacks: Object.fromEntries(
          files
            .filter(([name]) => name.endsWith(FALLBACK))
            .map(([name, text]) => [name.slice(0, -FALLBACK.length), text]),
        ),
      };
    } finally {
      await nitro.close();
    }
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

function servedBy({ routes }: Build, path: string) {
  for (const { src, dest, caseSensitive } of routes)
    if (src && dest && new RegExp(`^(?:${src})$`, caseSensitive ? "" : "i").test(path))
      return dest.split("?")[0];
}

const withModule = (options: Partial<IsrFallbackOptions> = {}): Partial<NitroConfig> => ({
  modules: [isrFallback({ enabled: true, timeoutMs: 300, routes: LISTED, ...options })],
});

describe("ISR fallbacks in the Vercel build output", () => {
  let plain: Build;
  let built: Build;

  beforeAll(async () => {
    plain = await build();
    built = await build(withModule(), webBundle());
  });

  it("gives each rendered page its own ISR function, with the build's HTML as the fallback and the page's own headers", () => {
    expect(servedBy(built, "/about")).toBe("/about-isr");
    expect(servedBy(built, "/")).toBe("/index-isr");
    expect(servedBy(built, "/blog/first-post")).toBe("/blog/first-post-isr");
    expect(built.configs["/about-isr"]).toEqual({
      expiration: 60,
      allowQuery: ["__isr_route"],
      fallback: "about-isr.prerender-fallback.html",
      initialStatus: 200,
      initialHeaders: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=0",
        "x-robots-tag": "noindex",
        "x-isr-fallback": "1",
      },
    });
    expect(built.configs["/blog/first-post-isr"].fallback).toBe(
      "first-post-isr.prerender-fallback.html",
    );
    expect(built.fallbacks["/about-isr"]).toBe("<html>/about</html>");
    expect(built.fallbacks["/index-isr"]).toBe("<html>/</html>");
  });

  it("does not serve a page's fallback to an address that differs only by letter case", () => {
    expect(servedBy(built, "/ABOUT")).toBe("/[...]-isr");
    expect(servedBy(built, "/Blog/First-Post")).toBe("/[...]-isr");
  });

  it("serves a page's fallback ahead of a pattern rule that also matches its address", () => {
    expect(servedBy(plain, "/news/latest")).toBe("/[section]/latest-isr");
    expect(servedBy(built, "/news/latest")).toBe("/news/latest-isr");
    expect(built.configs["/news/latest-isr"].expiration).toBe(30);
    expect(servedBy(built, "/sport/latest")).toBe("/[section]/latest-isr");
  });

  it("writes no fallback for a page that failed, redirected, is private, sets a cookie, is not HTML or never finished", () => {
    expect(Object.keys(built.fallbacks).sort()).toEqual([
      "/about-isr",
      "/blog/first-post-isr",
      "/index-isr",
      "/news/latest-isr",
    ]);
    const skipped = built.logs.find((line) => line.startsWith("ISR fallbacks skipped"));
    for (const reason of [
      "/broken (status 500)",
      "/moved (status 308)",
      "/private (private)",
      "/cookie (sets a cookie)",
      "/text (not HTML)",
      "/slow (no response in 300 ms)",
    ])
      expect(skipped).toContain(reason);
  });

  it("writes no fallback where the route rules cannot hold one, and leaves those rules as they were", () => {
    const skipped = built.logs.find((line) => line.startsWith("ISR fallbacks skipped"));
    for (const reason of [
      "/search (varies by query)",
      "/old (redirect or proxy rule)",
      "/api/items (no isr rule)",
      "/files/report.pdf (not a plain path)",
      "/blog/:slug (not a plain path)",
    ])
      expect(skipped).toContain(reason);
    expect(built.configs["/search-isr"]).toEqual(plain.configs["/search-isr"]);
    expect(built.configs["/[...]-isr"]).toEqual(plain.configs["/[...]-isr"]);
    expect(servedBy(built, "/api/items")).toBe("/__server");
  });

  it("reads the routes from the built server, applies the filter and the project's own acceptance check, and omits the marker header when asked", async () => {
    const custom = await build(
      withModule({
        header: false,
        copyHeaders: ["content-type", "x-internal"],
        filter: (path) => path !== "/",
        accept: (response, path) =>
          path === "/blog/first-post" && response.status === 200 ? "unpublished" : undefined,
        routes: async ({ fetch }) => (await fetch("/routes.json")).json() as Promise<string[]>,
      }),
      webBundle(),
    );
    expect(Object.keys(custom.fallbacks).sort()).toEqual(["/about-isr", "/news/latest-isr"]);
    expect(custom.configs["/about-isr"].initialHeaders).toEqual({
      "content-type": "text/html; charset=utf-8",
      "x-internal": "1",
    });
    const skipped = custom.logs.find((line) => line.startsWith("ISR fallbacks skipped"));
    expect(skipped).toContain("/ (filtered out)");
    expect(skipped).toContain("/blog/first-post (unpublished)");
  });

  it("renders through a Node request handler bundle with the configured origin", async () => {
    const node = await build(
      withModule({ origin: "https://example.com", copyHeaders: ["x-seen-host"] }),
      nodeBundle,
    );
    expect(Object.keys(node.fallbacks).sort()).toEqual(Object.keys(built.fallbacks).sort());
    expect(node.fallbacks["/about-isr"]).toBe("<html>/about</html>");
    expect(node.configs["/about-isr"].initialHeaders).toEqual({
      "x-seen-host": "example.com",
      "x-isr-fallback": "1",
    });
  });

  it("keeps a fallback the project set on a page itself", async () => {
    const own = await build(
      {
        ...withModule(),
        routeRules: {
          ...routeRules,
          "/about": { isr: { expiration: 5, fallback: "shell.html" } as never },
        },
      },
      webBundle(),
    );
    expect(own.configs["/about-isr"].fallback).toBe("shell.html");
    expect(own.fallbacks["/about-isr"]).toBeUndefined();
  });

  it.each([
    ["the renderer crashes", withModule({ timeoutMs: 60_000 }), webBundle(true)],
    ["the route source fails", withModule({ routes: () => Promise.reject(new Error("down")) }), webBundle()],
    ["there is no server bundle", withModule(), undefined],
  ])("ships the build with no fallbacks when %s", async (_, config, bundle) => {
    const failed = await build(config, bundle);
    expect(failed.routes).toEqual(plain.routes);
    expect(failed.configs).toEqual(plain.configs);
    expect(failed.fallbacks).toEqual({});
  });

  it.each([
    ["no function", (functions: string) => rm(join(functions, "about-isr.func"))],
    [
      "config names no fallback",
      (functions: string) =>
        writeFile(join(functions, `about-isr${CONFIG}`), JSON.stringify({ expiration: 60 })),
    ],
  ])("fails the build when the Vercel output for a page is wrong (%s)", async (problem, damage) => {
    const changedWriter = {
      setup(nitro: Nitro) {
        const write = nitro.options.hooks.compiled as (nitro: Nitro) => Promise<void>;
        const damaged = async (built: Nitro) => {
          await write(built);
          await damage(join(built.options.output.serverDir, ".."));
        };
        nitro.hooks.removeHook("compiled", write);
        nitro.options.hooks.compiled = damaged;
        nitro.hooks.hook("compiled", damaged);
      },
    };
    await expect(
      build({ modules: [changedWriter, ...withModule().modules!] }, webBundle()),
    ).rejects.toThrow(`/about: ${problem}`);
  });

  it("fails the build when another route would answer a page's address first", async () => {
    const shadowed = {
      ...withModule(),
      vercel: { config: { version: 3 as const, routes: [{ src: "/about", dest: "/elsewhere" }] } },
    };
    await expect(build(shadowed, webBundle())).rejects.toThrow("/about: route out of order");
  });

  it("writes exactly what Nitro writes when disabled or on another preset", async () => {
    const off = await build(withModule({ enabled: false }), webBundle());
    expect(off.routes).toEqual(plain.routes);
    expect(off.configs).toEqual(plain.configs);
    expect(off.fallbacks).toEqual({});
  });
});
