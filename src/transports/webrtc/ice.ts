import { NvrError } from "../../contracts";
export function cancellation(): NvrError {
  return new NvrError({
    code: "cancelled",
    message: "WebRTC session cancelled.",
  });
}
/** Also bounds non-cooperative browser methods and response-body promises. */
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancellation());
    if (signal.aborted) {
      void work.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work
      .then((value) => {
        if (signal.aborted) abort();
        else resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
/** HTTP signaling has no trickle endpoint. Send the gathered local SDP once. */
export function gatherIce(
  peer: RTCPeerConnection,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<"complete" | "timeout"> {
  return new Promise((resolve, reject) => {
    const finish = (result: "complete" | "timeout" | "cancelled") => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", changed);
      signal.removeEventListener("abort", aborted);
      if (result === "cancelled") reject(cancellation());
      else resolve(result);
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") finish("complete");
    };
    const aborted = () => finish("cancelled");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else changed();
  });
}
