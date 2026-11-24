import { defineConfig } from "nitro";
import isrFallback from "../src/isr-fallback";

export default defineConfig({
  serverDir: "./server",
  preset: "vercel",
  routeRules: {
    "/**": { isr: 60 },
    "/api/**": { isr: false },
  },
  modules: [isrFallback({ routes: ["/", "/about", "/blog/first-post"] })],
});
