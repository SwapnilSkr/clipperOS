import { Elysia } from "elysia";
import {
  addLessonRoute,
  deleteLessonRoute,
  generateAssetRoute,
  getGenerationJobRoute,
  listGenerationJobsRoute,
  listLessonsRoute,
  pickSoundRoute,
  searchSoundsRoute,
  senseLibraryRoute,
  studioSourcesRoute,
} from "../controllers/studio.controller";
import { GenerateAssetBody, GenerationJobParams, LessonBody, LessonParams, SoundPickBody, SoundSearchQuery } from "../types/guards";

/** Generated assets, the harness's catalogue, the Director's memory. */
export const studioRoutes = new Elysia({ prefix: "/api/studio" })
  .post("/generate", generateAssetRoute, { body: GenerateAssetBody })
  .get("/jobs", listGenerationJobsRoute)
  .get("/jobs/:id", getGenerationJobRoute, { params: GenerationJobParams })
  .post("/sense-library", senseLibraryRoute)
  .get("/sources", studioSourcesRoute)
  .get("/sounds/search", searchSoundsRoute, { query: SoundSearchQuery })
  .post("/sounds/pick", pickSoundRoute, { body: SoundPickBody })
  .get("/lessons", listLessonsRoute)
  .post("/lessons", addLessonRoute, { body: LessonBody })
  .delete("/lessons/:id", deleteLessonRoute, { params: LessonParams });
