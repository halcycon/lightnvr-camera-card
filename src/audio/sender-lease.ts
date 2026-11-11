/** Internal bridge: a microphone belongs to one negotiated peer generation. */
interface Lease {
  valid: () => boolean;
  listeners: Set<() => void>;
}
const leases = new WeakMap<RTCRtpSender, Lease>();
export function registerSender(
  sender: RTCRtpSender,
  valid: () => boolean,
): () => void {
  const lease: Lease = { valid, listeners: new Set() };
  leases.set(sender, lease);
  return () => {
    lease.valid = () => false;
    // oxlint-disable-next-line unicorn/no-useless-spread -- Callbacks may mutate subscriptions; notify a fixed snapshot.
    for (const listener of [...lease.listeners]) listener();
    lease.listeners.clear();
  };
}
export function senderIsValid(sender: RTCRtpSender): boolean {
  return (
    (leases.get(sender)?.valid() ?? true) &&
    sender.transport?.state !== "closed"
  );
}
export function watchSender(
  sender: RTCRtpSender,
  onInvalid: () => void,
): () => void {
  const lease = leases.get(sender);
  lease?.listeners.add(onInvalid);
  return () => {
    lease?.listeners.delete(onInvalid);
  };
}
