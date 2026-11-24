# nitro-vercel-isr-fallback

A [Nitro](https://nitro.build) module for the Vercel preset. At build time it
renders your ISR pages and ships each one as the page's
[fallback file](https://vercel.com/docs/build-output-api/v3/primitives#fallback-static-file),
so the first visitor after a deploy gets a ready page while Vercel renders the
fresh one in the background.

Without it, every deploy starts with an empty ISR cache and the first request to
each page waits for a server render
([nitrojs/nitro#2016](https://github.com/nitrojs/nitro/issues/2016)).

[Live example](https://nitro-vercel-isr-fallback-example.vercel.app) ·
[Example source](example)

> [!NOTE]
> Requires Nitro v3 with the `vercel` preset. Tested on `3.0.260903-beta` and
> `3.0.261103-rc`. Nitro v2 (`nitropack`) is untested.

## Usage

There is no package to install. Copy [`src/isr-fallback.ts`](src/isr-fallback.ts)
into your project and register it as a module.

For **Nitro**, update `nitro.config.ts`:

```ts
import { defineConfig } from "nitro";
import isrFallback from "./isr-fallback";

export default defineConfig({
  preset: "vercel",
  routeRules: {
    "/**": { isr: 60 },
  },
  modules: [isrFallback({ routes: ["/", "/about", "/pricing"] })],
});
```

For **TanStack Start**, or any app that configures Nitro through Vite, update
`vite.config.ts`:

```ts
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

The module runs only in Vercel builds. To try it locally, build with `VERCEL=1`
and look for `*-isr.prerender-fallback.html` in `.vercel/output/functions`.

### Routes from a sitemap

`routes` can be a function. Its `fetch` requests the built server, so the list
can come from a route your app already serves:

```ts
isrFallback({
  routes: async ({ fetch }) => {
    const xml = await (await fetch("/sitemap.xml")).text();
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc).pathname);
  },
});
```

## Options

- `routes`: Paths to render, or a function returning them. Required.
- `filter`: `(path) => boolean`. Return `false` to leave a path without a fallback.
- `accept`: `(response, path) => string | void`. Return a reason to refuse a rendered page.
- `origin`: Origin the pages are rendered with (default `https://$VERCEL_PROJECT_PRODUCTION_URL`).
- `header`: Response header sent with a fallback and not with a fresh render (default `x-isr-fallback`). `false` sends none.
- `copyHeaders`: Headers of the rendered page that the fallback is served with (default `content-type`, `cache-control`, `vary`, `x-robots-tag`, `link`, `content-language`, `referrer-policy`).
- `requestHeaders`: Headers of the render request (default `accept: text/html` and a `user-agent` naming this module).
- `concurrency`: Pages rendered at once (default `4`).
- `timeoutMs`: Limit for loading the server bundle and for each render (default `10000`).
- `enabled`: Default `Boolean(process.env.VERCEL)`.

## Which pages get a fallback

A page gets a fallback when:

- its path is literal, with segments of letters, digits, `_` and `-` only
- an `isr` route rule applies to it, with no `allowQuery` entries and no
  `fallback` of its own
- no `redirect`, `proxy` or `prerender` rule applies to it
- it renders as `200` `text/html`, sets no cookie, and its `cache-control` has
  neither `private` nor `no-store`

Any other page is skipped and served as before. The build log lists each skipped
path with the reason. A page that fails to render never fails the build.

## Refresh after a promotion

A fallback holds the page as it was at build time until the page's first request
triggers a fresh render. To replace every fallback as soon as a deployment goes
live, copy [`src/refresh.ts`](src/refresh.ts) and mount it as a route:

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

Then create a Vercel
[account webhook](https://vercel.com/docs/webhooks#account-webhooks) for the
`deployment.promoted` and `deployment.rollback` events that points at the route,
and set its secret as `VERCEL_WEBHOOK_SECRET` in the Production environment.

The handler takes a `Request` and returns a `Response`, so it works in any
framework. Outside Nitro, pass `waitUntil` from `@vercel/functions`.

### Available options

- `paths`: Paths to request, or a function given the live origin. Required.
- `waitUntil`: Keeps the function running after the response is sent. Required.
- `secret`: Webhook secret (default `process.env.VERCEL_WEBHOOK_SECRET`).
- `header`: Must match the module's `header` (default `x-isr-fallback`).
- `passes`: Most times a path is requested (default `8`).
- `gapMs`: Wait between passes (default `15000`).
- `concurrency`: Requests at once (default `6`).
- `timeoutMs`: Limit per request (default `10000`).
- `onDone`: Receives `{ event, deployment, servedBy, requested, fallbacks, failed }`. Logs it by default.

## How it works

Nitro's Vercel preset writes the build output from its `compiled` hook. The
module takes that hook's place. It loads the built server bundle in a worker
thread, renders each listed path, and adds an exact-path `isr` rule carrying
Vercel's `fallback`, `initialStatus` and `initialHeaders` fields. It then calls
the preset's writer, writes `<name>-isr.prerender-fallback.html` beside each
function's config, and marks each page's route `caseSensitive` so `/ABOUT` is
not served `/about`'s fallback.

The module checks the output before it finishes and fails the build if a
fallback would not be served. It relies on the preset's internals, so a Nitro
upgrade can trigger that failure.

## Limitations

- Pages render during the build, so the build needs the app's data sources and
  environment variables.
- Vercel can keep serving a fallback for about a minute after its first request
  before the fresh render replaces it.
- Pages that vary by query string, and a `baseURL` other than `/`, are not
  supported.

## Development

- Clone this repository
- Install dependencies using `npm install`
- Run tests using `npm test` and `npm run typecheck`
- Build the example using `VERCEL=1 npx nitro build` in `example/`

## License

[MIT](./LICENSE)
