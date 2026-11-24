import { defineHandler } from "nitro";
import { page } from "../../page";

export default defineHandler((event) => page(`Blog: ${event.context.params?.slug}`));
