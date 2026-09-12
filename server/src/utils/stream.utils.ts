// ============================================
// LOCAL MEDIA STREAMING
//
// Return the `Bun.file` ITSELF — do not wrap it in `new Response(...)`.
//
// The runtime's file responses implement HTTP range requests correctly: given a
// `Bun.file` body it answers 206 with the right `Content-Range`, `Content-Length`
// and partial body, plus 416 for an unsatisfiable range. That behaviour is
// switched OFF the moment a handler builds its own `Response`, which is why the
// previous `new Response(Bun.file(path), { "Accept-Ranges": "bytes" })` was so
// damaging: it advertised range support, then answered every range request with
// 200 and the whole file. For a 259 MB source video a browser will not start
// playback and cannot seek, so the player looks broken.
//
// Equally, do NOT slice the file and set range headers by hand: the runtime
// still applies the client's `Range` to the body it is given, so a sliced body
// gets ranged twice and reports a bogus total.
// ============================================

/** The slice of Elysia's context this helper needs. */
interface HeaderSink {
  headers: Record<string, string | number>;
}

/**
 * Hand back a local video file, with correct range semantics for free.
 *
 * `extraHeaders` (e.g. `Content-Disposition`) ride along on both the 200 and the
 * 206, so a download link still downloads when the browser sends a range.
 */
export function serveLocalVideo(
  set: HeaderSink,
  filePath: string,
  extraHeaders: Record<string, string> = {}
): ReturnType<typeof Bun.file> {
  set.headers["content-type"] = "video/mp4";
  set.headers["accept-ranges"] = "bytes";
  Object.assign(set.headers, extraHeaders);
  return Bun.file(filePath);
}
