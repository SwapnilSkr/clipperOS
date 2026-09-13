import { Elysia } from "elysia";
import {
  createProject,
  deleteProject,
  deleteProjectAudio,
  ensureProjectMediaRoute,
  getProject,
  listProjects,
  reconcileProject,
  remineProject,
  streamProjectAudio,
  streamProjectMedia,
  uploadProjectAudio,
} from "../controllers";
import {
  CreateProjectBody,
  ListProjectsQuery,
  ProjectAudioParams,
  ProjectParams,
  ReconcileQuery,
  RemineBody,
} from "../types/guards";

export const projectRoutes = new Elysia({ prefix: "/api/projects" })
  .post("/", createProject, { body: CreateProjectBody })
  .get("/", listProjects, { query: ListProjectsQuery })
  .get("/:id", getProject, { params: ProjectParams })
  .get("/:id/media", streamProjectMedia, { params: ProjectParams })
  .post("/:id/media/ensure", ensureProjectMediaRoute, { params: ProjectParams })
  .get("/:id/audio/:fileId", streamProjectAudio, { params: ProjectAudioParams })
  .post("/:id/audio", uploadProjectAudio, { params: ProjectParams })
  .delete("/:id/audio/:fileId", deleteProjectAudio, { params: ProjectAudioParams })
  .post("/:id/remine", remineProject, { params: ProjectParams, body: RemineBody })
  .post("/:id/reconcile", reconcileProject, { params: ProjectParams, query: ReconcileQuery })
  .delete("/:id", deleteProject, { params: ProjectParams });
