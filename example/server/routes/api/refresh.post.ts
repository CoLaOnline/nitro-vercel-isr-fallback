import { defineHandler } from "nitro";
import refreshOnPromotion from "../../../../src/refresh";
import { paths } from "../../page";

export default defineHandler((event) =>
  refreshOnPromotion({ paths, waitUntil: (work) => event.waitUntil(work) })(event.req),
);
