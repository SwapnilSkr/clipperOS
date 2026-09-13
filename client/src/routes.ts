/**
 * Every URL the studio knows, in one place.
 *
 * A clip having an address is the whole point: it is what makes a refresh land
 * on the same clip, a link shareable, and the browser's Back button mean
 * "previous clip" instead of "throw away my state".
 */
export const routes = {
  root: "/",
  project: (projectId: string) => `/projects/${projectId}`,
  clip: (projectId: string, clipId: string) => `/projects/${projectId}/clips/${clipId}`,
  /** Picture is already cut; this desk is music / SFX before export. */
  clipMix: (projectId: string, clipId: string) => `/projects/${projectId}/clips/${clipId}?desk=mix`,
  /** Project-level logo sting library. `returnClip` sends you back to mix after. */
  outro: (projectId: string, returnClip?: string, outroId?: string) => {
    const path = outroId ? `/projects/${projectId}/outro/${outroId}` : `/projects/${projectId}/outro`;
    return returnClip ? `${path}?returnClip=${encodeURIComponent(returnClip)}` : path;
  },
  /** The board a clip belongs to — where Back goes. */
  clipParent: (projectId: string) => `/projects/${projectId}`,
} as const;
