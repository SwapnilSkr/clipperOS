import { Elysia } from "elysia";
import {
  createProject,
  deleteProject,
  ensureProjectMediaRoute,
  getProject,
  listProjects,
  reconcileProject,
  remineProject,
  streamProjectMedia,
} from "../controllers";
import {
  CreateProjectBody,
  ListProjectsQuery,
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
  .post("/:id/remine", remineProject, { params: ProjectParams, body: RemineBody })
  .post("/:id/reconcile", reconcileProject, { params: ProjectParams, query: ReconcileQuery })
  .delete("/:id", deleteProject, { params: ProjectParams });
