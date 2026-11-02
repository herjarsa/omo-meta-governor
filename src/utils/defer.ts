/**
 * Deferral helper for plugin-startup background work.
 *
 * Why this exists: OpenCode aborts a location whose plugins have not finished
 * activating within ~13s. `setup()` therefore must not perform blocking I/O or
 * spawn synchronous subprocesses, and it must not schedule that work as a
 * microtask either:
 *
 * - an `async` function runs its prologue synchronously, so a "fire-and-forget"
 *   call such as `void runCliAnythingSync()` still blocks the factory;
 * - `queueMicrotask` drains before the factory's own awaited continuations, so
 *   the work lands inside activation anyway;
 * - `setTimeout(..., 0)` is the first point guaranteed to run after the host
 *   has observed the resolved `setup()` promise.
 */

export interface DeferOptions {
  /** Delay before the task starts. Defaults to 0 (next macrotask). */
  delayMs?: number
  /**
   * Reports a synchronous throw from `task`. Async failures belong to the
   * caller's own `.catch`; this only covers construction errors.
   */
  onError?: (err: unknown) => void
}

/**
 * Schedule `task` on the next macrotask so plugin activation completes first.
 * The timer is unref'd when the runtime supports it (Node), so a convenience
 * task never keeps the host process alive.
 */
export function deferBackgroundTask(
  task: () => void,
  opts: DeferOptions = {},
): void {
  const fire = (): void => {
    try {
      task()
    } catch (err) {
      if (!opts.onError) return
      try {
        opts.onError(err)
      } catch {
        // A reporting failure must never escape into the host event loop.
      }
    }
  }

  const handle: unknown = setTimeout(fire, opts.delayMs ?? 0)
  const maybeUnref = handle as { unref?: () => void }
  if (typeof maybeUnref?.unref === "function") maybeUnref.unref()
}
