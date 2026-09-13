import { Elysia } from "elysia";
import { listAudioLibrary, streamBuiltinAudio } from "../controllers/audio.controller";
import { AudioLibraryQuery, BuiltinAudioParams } from "../types/guards";

export const audioLibraryRoutes = new Elysia({ prefix: "/api/audio-library" })
  .get("/", listAudioLibrary, { query: AudioLibraryQuery })
  .get("/:id", streamBuiltinAudio, { params: BuiltinAudioParams });
