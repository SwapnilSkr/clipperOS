import { Elysia } from "elysia";
import {
  createProject,
  listProjects,
  getProject,
  streamProjectMedia,
  ensureProjectMediaRoute,
  deleteProject,
  remineProject,
  writeProjectShareCopy,
  reconcileProject,
  deleteProjectAudio,
  streamProjectAudio,
  uploadProjectAudio,
  listProjectOutros,
  createProjectOutro,
  getProjectOutro,
  uploadOutroLogo,
  updateProjectOutro,
  rebuildOutroPreview,
  streamOutroPreview,
  streamOutroLogo,
  deleteProjectOutro,
} from "../controllers";
import {
  CreateProjectBody,
  CreateProjectOutroBody,
  ListProjectsQuery,
  ProjectAudioParams,
  ProjectOutroBody,
  ProjectOutroParams,
  ProjectParams,
  ReconcileQuery,
  RemineBody,
  ShareCopyBody,
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
  .get("/:id/outros", listProjectOutros, { params: ProjectParams })
  .post("/:id/outros", createProjectOutro, { params: ProjectParams, body: CreateProjectOutroBody })
  .get("/:id/outros/:outroId", getProjectOutro, { params: ProjectOutroParams })
  .patch("/:id/outros/:outroId", updateProjectOutro, { params: ProjectOutroParams, body: ProjectOutroBody })
  .post("/:id/outros/:outroId/logo", uploadOutroLogo, { params: ProjectOutroParams })
  .post("/:id/outros/:outroId/preview", rebuildOutroPreview, { params: ProjectOutroParams })
  .get("/:id/outros/:outroId/preview", streamOutroPreview, { params: ProjectOutroParams })
  .get("/:id/outros/:outroId/logo", streamOutroLogo, { params: ProjectOutroParams })
  .delete("/:id/outros/:outroId", deleteProjectOutro, { params: ProjectOutroParams })
  .post("/:id/remine", remineProject, { params: ProjectParams, body: RemineBody })
  .post("/:id/share-copy", writeProjectShareCopy, { params: ProjectParams, body: ShareCopyBody })
  .post("/:id/reconcile", reconcileProject, { params: ProjectParams, query: ReconcileQuery })
  .delete("/:id", deleteProject, { params: ProjectParams });
