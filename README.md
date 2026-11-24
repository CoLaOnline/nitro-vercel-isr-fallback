# nitro-vercel-isr-fallback

A Nitro module for the Vercel preset. At build time it renders your ISR pages
and ships each one as the page's
[fallback file](https://vercel.com/docs/build-output-api/v3/primitives#fallback-static-file),
so the first visitor after a deploy gets a ready page instead of waiting for a
cold server render.

It is two files you copy into your project. There is no package to install.

## The problem

On Vercel, every deployment starts with an empty ISR cache. With Nitro's `isr`
route rule, the first request to each page after a deploy waits for a full
server render. Nitro's `prerender` rule does not help: a prerendered page is a
static file and is never revalidated. Nitro's maintainers describe the two rules
as mutually exclusive
([nitrojs/nitro#4041](https://github.com/nitrojs/nitro/issues/4041), docs in
[#4461](https://github.com/nitrojs/nitro/pull/4461)).

Vercel's Build Output API has a primitive that gives both. A Prerender Function
can ship with a fallback file, which Vercel serves "while there is not yet a
cached version that was generated during runtime", and it starts the real render
in the background
([docs](https://vercel.com/docs/build-output-api/v3/primitives#fallback-static-file)).
Next.js uses it. Nitro passes a `fallback` name through to the function's config
but never writes the file. The request to fill that gap is
[nitrojs/nitro#2016](https://github.com/nitrojs/nitro/issues/2016), open since
2023.

| | First request after a deploy | Later requests |
| --- | --- | --- |
| `isr` rule alone | Waits for a server render | Served from the ISR cache |
| With this module | Served the build's HTML; the render runs in the background | Served from the ISR cache |

On the production site this was written for, a cold first request took
0.5–1.0 s to first byte and a fallback's first response took 0.20–0.35 s.

## Install

Copy [`src/isr-fallback.ts`](src/isr-fallback.ts) into your project. It imports
only `node:*` modules and types from `nitro`.

Register it as a Nitro module and list the pages to render:

```ts
// nitro.config.ts
import { defineConfig } from "nitro";
import isrFallback from "./isr-fallback";

export default defineConfig({
  preset: "vercel",
  routeRules: {
    "/**": { isr: 60 },
    "/api/**": { isr: false },
  },
  modules: [isrFallback({ routes: ["/", "/about", "/pricing"] })],
});
```

With TanStack Start, or any app that configures Nitro through Vite:

```ts
// vite.config.ts
import { nitro } from "nitro/vite";
import isrFallback from "./isr-fallback";

export default defineConfig({
  plugins: [
    tanstackStart(),
    nitro({
      preset: "vercel",
      routeRules: { "/**": { isr: 60 } },
      modules: [isrFallback({ routes: ["/", "/about", "/pricing"] })],
    }),
  ],
});
```

The module does nothing unless the build runs on Vercel (`VERCEL` is set) with
the `vercel` preset. To try it locally, run the build with `VERCEL=1` and look in
`.vercel/output/functions` for the `*-isr.prerender-fallback.html` files.

### Routes from a sitemap

`routes` can be a function. Its `fetch` asks the built server, so the list can
come from a route your app already serves:

```ts
isrFallback({
  routes: async ({ fetch }) => {
    const xml = await (await fetch("/sitemap.xml")).text();
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
  },
});
```

## Options

| Option | Default | |
| --- | --- | --- |
| `routes` | required | Paths to render, or a function returning them. The function receives `{ fetch(path) }`, which requests the built server. |
| `filter` | none | `(path) => boolean`. Return `false` to leave a path without a fallback. |
| `accept` | none | `(response, path) => string \| void`. Return a reason to refuse a rendered page. Runs after the built-in checks. |
| `origin` | `https://$VERCEL_PROJECT_PRODUCTION_URL`, else `http://localhost` | Origin of the URL the pages are rendered with. |
| `header` | `x-isr-fallback` | Response header sent with a fallback and not with a runtime render. `false` sends none. |
| `copyHeaders` | `content-type`, `cache-control`, `vary`, `x-robots-tag`, `link`, `content-language`, `referrer-policy` | Headers of the rendered page that the fallback is served with. |
| `requestHeaders` | `accept: text/html` and a `user-agent` naming this module | Headers of the render request. |
| `concurrency` | `4` | Pages rendered at once. |
| `timeoutMs` | `10000` | Limit for loading the server bundle and for each render. |
| `enabled` | `Boolean(process.env.VERCEL)` | |

## Which pages get a fallback

A page gets one only if all of these hold. Anything else is skipped, the build
log names the path and the reason, and the page is served as it was before.

- The path is a literal path whose segments use only letters, digits, `_` and
  `-`. No file extensions, no `:param` or `**` patterns.
- An `isr` route rule applies to it, and no `redirect`, `proxy` or `prerender`
  rule does.
- Its `isr` rule has no `allowQuery` entries. A page that varies by query string
  cannot be represented by one file.
- It has no `fallback` of its own already set in its route rule.
- It renders with status 200 and `content-type: text/html`, sets no cookie, and
  its `cache-control` has neither `private` nor `no-store`.
- Your `filter` and `accept` let it through.

A page that fails to render never fails the build. If the server bundle cannot
be loaded or the `routes` function throws, the build ships with no fallbacks and
a warning.

## Refreshing after a promotion (optional)

A fallback holds the page as it was at build time. Vercel replaces it with a
runtime render after the page's first request. Until that request arrives, a
page nobody has visited still holds build-time content, which matters if your
content changed between the build and the moment the deployment went live.

[`src/refresh.ts`](src/refresh.ts) closes that gap. It is a webhook handler:
when Vercel reports that a deployment was promoted or rolled back to, it
requests every path so each fallback is replaced, and repeats for the paths that
still answer with the `x-isr-fallback` header.

Copy the file and mount it at any route:

```ts
// server/routes/api/refresh.post.ts
import { defineHandler } from "nitro";
import refreshOnPromotion from "../../refresh";

export default defineHandler((event) =>
  refreshOnPromotion({
    paths: ["/", "/about", "/pricing"],
    waitUntil: (work) => event.waitUntil(work),
  })(event.req),
);
```

The handler takes a `Request` and returns a `Response`, so it mounts the same way
in any framework; outside Nitro, pass `waitUntil` from `@vercel/functions`. The
route must not have an `isr` rule.

Then in Vercel, create an
[account webhook](https://vercel.com/docs/webhooks#account-webhooks) (Pro and
Enterprise plans) for the project with the events `deployment.promoted` and `deployment.rollback`,
pointing at the route on your production domain, and store its secret as
`VERCEL_WEBHOOK_SECRET` in the Production environment. The handler checks the
`x-vercel-signature` header as
[Vercel documents](https://vercel.com/docs/webhooks/webhooks-api#securing-webhooks).

| Option | Default | |
| --- | --- | --- |
| `paths` | required | Paths to request, or a function given the live origin. |
| `waitUntil` | required | Keeps the function running after the response is sent. |
| `secret` | `process.env.VERCEL_WEBHOOK_SECRET` | |
| `header` | `x-isr-fallback` | Must match the build module's `header`. |
| `passes` | `8` | Most times a path is requested. |
| `gapMs` | `15000` | Wait between passes. |
| `concurrency` | `6` | |
| `timeoutMs` | `10000` | Per request. |
| `onDone` | logs the result | Receives `{ event, deployment, servedBy, requested, fallbacks, failed }`. |

## How it works

1. Nitro's Vercel preset writes the build output from its `compiled` hook. The
   module takes that hook's place and calls the preset's writer itself.
2. Before the writer runs, the module loads the built server bundle in a worker
   thread and requests each listed path from it. No network port is opened for a
   web-format bundle; a Node-handler bundle is served on a local port.
3. For each accepted page it adds an exact-path route rule whose `isr` object
   carries `fallback`, `initialStatus` and `initialHeaders`. Nitro spreads the
   `isr` object into `<name>-isr.prerender-config.json`, so these reach Vercel.
4. The preset writes its output. The module then writes
   `<name>-isr.prerender-fallback.html` beside each config, moves the pages'
   routes ahead of the other ISR routes and marks them `caseSensitive`.
5. It checks the output: each page has its function, its config names the
   fallback file, and its route is the first to match the page's path. If the
   check fails, the build fails, so a wrong output is never deployed.

## Limits

- It depends on the internals of Nitro's Vercel preset: the `compiled` hook, the
  `-isr` function naming and the `isr` object being passed through. A Nitro
  release can change these. The output check then fails the build with a message
  naming what is wrong. CI here runs the tests weekly against Nitro's `latest`.
- `fallback`, `initialStatus` and `initialHeaders` are not in Nitro's type for
  the `isr` rule. They are documented fields of
  [Vercel's prerender config](https://vercel.com/docs/build-output-api/v3/primitives#prerender-configuration-file).
- Every page with a fallback becomes its own function entry (a link to the one
  server function), a config file and an HTML file in the build output.
- The pages render during the build, so the build needs the same data sources
  and environment variables the running app does, and the build takes as long
  as the renders do.
- A `baseURL` other than `/` is not supported.
- Tested with Nitro `3.0.260903-beta` and `3.0.261103-rc`. Nitro v2
  (`nitropack`, which current Nuxt uses) is untested.

### Vercel behaviour observed, not documented

Seen on one production project in November 2026. Vercel's docs do not state
these, so treat them as observations.

- Route matching ignores letter case unless a route sets `caseSensitive`. That
  is why the module sets it: without it `/ABOUT` would be served `/about`'s
  fallback.
- A fallback requested in the first seconds after a promotion is served without
  starting the replacing render, and the edge keeps answering with it for about
  a minute. `x-vercel-cache` reads `HIT` during that time, so it cannot tell a
  fallback from a runtime render. The `x-isr-fallback` header can, and it is why
  the refresh handler makes repeat passes.
- About one in four `deployment.promoted` webhook deliveries reached the
  outgoing deployment instead of the new one. The refresh handler answers those
  with 503 so that Vercel sends the event again.

## Status

The approach has run in production since November 2026 on a TanStack Start site
on Nitro `3.0.260903-beta`. This repository is the generic version of that code.
Its tests build real Vercel output with Nitro, and the example app builds
locally with the expected files.

## Prior art

- [vercel/examples: on-demand ISR](https://github.com/vercel/examples/tree/main/build-output-api/on-demand-isr),
  the Build Output API example of a Prerender Function with a build-time copy.
- [npmx.dev `modules/isr-fallback.ts`](https://github.com/npmx-dev/npmx.dev/blob/main/modules/isr-fallback.ts),
  a Nuxt module that sets `isr.fallback` and writes an app shell as the fallback
  from the `compiled` hook.
- [pracht](https://github.com/JoviDeCroock/pracht), whose Vercel adapter ships
  prerendered pages as fallback files.

## Development

```sh
npm install
npm test
npm run typecheck
```

The example app is in [`example/`](example). Build it with
`VERCEL=1 npx nitro build` from that directory.

## License

MIT
