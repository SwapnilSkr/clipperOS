import { Elysia } from "elysia";
import {
  deleteMedia,
  listMediaLibrary,
  listTransitions,
  pickStockRoute,
  searchStockRoute,
  streamMedia,
  streamMediaThumb,
  uploadMedia,
} from "../controllers/media.controller";
import { MediaAssetParams, StockPickBody, StockSearchQuery } from "../types/guards";

/** Stills and videos for cutaways: the shared library, stock search, transitions. */
export const mediaLibraryRoutes = new Elysia({ prefix: "/api/media-library" })
  .get("/", listMediaLibrary)
  .post("/", uploadMedia)
  .get("/:id/file", streamMedia, { params: MediaAssetParams })
  .get("/:id/thumb", streamMediaThumb, { params: MediaAssetParams })
  .delete("/:id", deleteMedia, { params: MediaAssetParams });

export const stockRoutes = new Elysia({ prefix: "/api/stock" })
  .get("/search", searchStockRoute, { query: StockSearchQuery })
  .post("/pick", pickStockRoute, { body: StockPickBody });

export const transitionRoutes = new Elysia({ prefix: "/api/transitions" }).get("/", listTransitions);
