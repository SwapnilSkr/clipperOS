import { Elysia } from "elysia";
import { uploadFile } from "../controllers";

/** Multipart upload intake. The file is read straight off the Request so no
 *  body schema buffering is involved. */
export const uploadRoutes = new Elysia({ prefix: "/api/uploads" }).post("/", uploadFile);
