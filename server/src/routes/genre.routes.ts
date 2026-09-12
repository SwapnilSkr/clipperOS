import { Elysia } from "elysia";
import { listGenres } from "../controllers";

/** The available editorial rulesets. Static — no params, no body. */
export const genreRoutes = new Elysia({ prefix: "/api/genres" }).get("/", listGenres);
