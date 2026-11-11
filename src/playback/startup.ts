import { failure } from "../api/safety";

interface Waiter {
  grant: () => void;
}
interface Pool {
  active: number;
  queue: Waiter[];
}
const pools = new Map<string, Pool>();

/** FIFO per cookie scope. Permits cover setup through first decoded frame, never playback. */
export function acquireStartup(
  scope: string,
  signal: AbortSignal,
  waitMs = 30000,
): Promise<() => void> {
  if (signal.aborted) return Promise.reject(failure("cancelled"));
  let pool = pools.get(scope);
  if (!pool) {
    pool = { active: 0, queue: [] };
    pools.set(scope, pool);
  }
  const p = pool;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prune = () => {
      if (!p.active && !p.queue.length) pools.delete(scope);
    };
    const remove = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      const index = p.queue.indexOf(waiter);
      if (index !== -1) p.queue.splice(index, 1);
    };
    const cancel = (timedOut = false) => {
      if (settled) return;
      settled = true;
      remove();
      prune();
      reject(failure(timedOut ? "timeout" : "cancelled"));
    };
    const abort = () => cancel();
    const waiter: Waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        remove();
        p.active++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          signal.removeEventListener("abort", release);
          p.active--;
          p.queue[0]?.grant();
          prune();
        };
        signal.addEventListener("abort", release, { once: true });
        resolve(release);
      },
    };
    signal.addEventListener("abort", abort, { once: true });
    if (p.active < 2 && !p.queue.length) waiter.grant();
    else {
      p.queue.push(waiter);
      timer = setTimeout(() => cancel(true), waitMs);
    }
  });
}
