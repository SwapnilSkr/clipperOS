/**
 * Structural shape of the Elysia request context our controllers consume.
 *
 * Deliberately loose: each route supplies a different `body`/`params` schema,
 * so a single concrete type cannot be both correct and assignable to every
 * route handler. Handlers narrow `body` themselves.
 */
export interface ApiContext {
  body: unknown;
  query: unknown;
  params: Record<string, string>;
  set: {
    status?: number | string;
    /**
     * Response headers. Elysia merges these into whatever the handler returns,
     * which is how a `Bun.file` body can be served with the right content type
     * while the runtime still applies the client's Range header.
     *
     * Values may be numeric — Elysia's own header bag accepts a number for
     * things like content-length — so this mirrors that rather than narrowing
     * to strings.
     */
    headers: Record<string, string | number>;
  };
  request: Request;
}
