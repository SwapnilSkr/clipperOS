import { Elysia } from "elysia";
import { effectInfo } from "../config/effects";
import { ok } from "../utils/response.utils";

/** The effects registry: what the desk offers and the Director may name. */
export const effectRoutes = new Elysia({ prefix: "/api/effects" }).get("/", () => ok(effectInfo()));
