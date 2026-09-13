import { Elysia } from "elysia";
import { listAudioLibrary, streamBuiltinAudio, streamSharedAudio } from "../controllers/audio.controller";
import { AudioLibraryQuery, BuiltinAudioParams, SharedAudioParams } from "../types/guards";

export const audioLibraryRoutes = new Elysia({ prefix: "/api/audio-library" })
  .get("/", listAudioLibrary, { query: AudioLibraryQuery })
  .get("/custom/:fileId", streamSharedAudio, { params: SharedAudioParams })
  .get("/:id", streamBuiltinAudio, { params: BuiltinAudioParams });
