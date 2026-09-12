// ============================================
// Bun compatibility shim, loaded via bunfig.toml `preload`.
//
// bson (pulled in by mongodb/mongoose) probes
// `process.getBuiltinModule("v8").startupSnapshot.isBuildingSnapshot()` at
// import time. Bun implements `v8` and `startupSnapshot`, but NOT that method,
// so the call throws ERR_NOT_IMPLEMENTED and every mongoose import dies.
//
// We narrow the blast radius to exactly that lookup: `v8.startupSnapshot`
// resolves to undefined, which is precisely what bson already handles via its
// optional chaining (it is only ever set inside a Node SEA snapshot build).
// Every other builtin module passes through untouched.
// ============================================

const getBuiltinModule = process.getBuiltinModule?.bind(process);

/**
 * Feature-detect before patching. On Node, and on any future Bun that implements
 * the method, the real module is left completely alone — we only shadow a
 * broken implementation, never a working one.
 */
function needsShim(): boolean {
  if (!getBuiltinModule) return false;
  try {
    const v8 = getBuiltinModule("v8") as
      | { startupSnapshot?: { isBuildingSnapshot?: () => boolean } }
      | undefined;
    const probe = v8?.startupSnapshot;
    if (typeof probe?.isBuildingSnapshot !== "function") return true;
    try {
      probe.isBuildingSnapshot();
      return false; // A real, working implementation is present.
    } catch {
      return true; // Present but throwing: exactly the bug being worked around.
    }
  } catch {
    return true;
  }
}

if (getBuiltinModule && needsShim()) {
  process.getBuiltinModule = ((id: string) => {
    const mod = getBuiltinModule(id) as object | undefined;
    if (id === "v8" && mod) {
      return new Proxy(mod, {
        get(target, prop, receiver) {
          if (prop === "startupSnapshot") return undefined;
          return Reflect.get(target, prop, receiver);
        },
      });
    }
    return mod;
  }) as typeof process.getBuiltinModule;
}
