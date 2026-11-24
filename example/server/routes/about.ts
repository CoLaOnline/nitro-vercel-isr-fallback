import { defineHandler } from "nitro";
import { page } from "../page";

export default defineHandler(() => page("About"));
