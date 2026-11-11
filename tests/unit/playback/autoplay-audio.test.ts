import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTalkController } from "../../../src/audio";
import { controllers, deferred, flush, harness, mockClient } from "./fixture";

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  const cleanup = Promise.all(controllers.splice(0).map((c) => c.dispose()));
  await vi.advanceTimersByTimeAsync(2100);
  await cleanup;
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("autoplay suspension and explicit bounded play gesture", () => {
  it("retains the adapter and cancels fallback while waiting for a gesture", async () => {
    const h = harness();
    await h.start();
    h.last().fail("autoplay");
    await flush();
    await vi.advanceTimersByTimeAsync(100000);
    expect(h.controller.snapshot).toMatchObject({
      state: "suspended",
      failure: { code: "autoplay" },
    });
    expect(h.adapters).toHaveLength(1);
    expect(h.last().stop).not.toHaveBeenCalled();
    expect(h.talk.start).not.toHaveBeenCalled();
  });
  it("explicit retry calls video.play synchronously, without a new connection or mic", async () => {
    const h = harness();
    await h.start({ audio: { listen: false } });
    h.last().fail("autoplay");
    const retried = h.controller.retry();
    expect(h.video.play).toHaveBeenCalledOnce();
    await retried;
    expect(h.controller.snapshot.state).toBe("connecting");
    h.last().frame();
    expect(h.controller.snapshot.state).toBe("playing");
    expect(h.adapters).toHaveLength(1);
    expect(h.api.client.connect).toHaveBeenCalledOnce();
    expect(h.talk.start).not.toHaveBeenCalled();
    expect(h.video.muted).toBe(true);
  });
  it("successful play without a decoded frame restores a deadline and falls back once", async () => {
    const h = harness();
    await h.start();
    h.last().fail("autoplay");
    await h.controller.retry();
    await vi.advanceTimersByTimeAsync(499);
    expect(h.adapters).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.adapters.map((a) => a.kind)).toEqual(["webrtc", "mse"]);
    expect(h.adapters[0]!.stop).toHaveBeenCalledOnce();
    expect(h.talk.start).not.toHaveBeenCalled();
  });
  it("a hanging explicit play is also bounded and cannot revive a retired generation", async () => {
    const h = harness(),
      played = deferred<void>();
    await h.start();
    h.last().fail("autoplay");
    h.video.play.mockReturnValueOnce(played.promise);
    const retry = h.controller.retry();
    await vi.advanceTimersByTimeAsync(500);
    await retry;
    h.last().frame();
    played.resolve();
    await flush();
    expect(h.controller.snapshot).toMatchObject({
      state: "playing",
      transport: "mse",
    });
  });
  it("NotAllowedError on repeated explicit retries stays suspended without network retries", async () => {
    const h = harness();
    await h.start();
    h.last().fail("autoplay");
    h.video.play.mockRejectedValue(
      new DOMException("private browser text", "NotAllowedError"),
    );
    await h.controller.retry();
    await h.controller.retry();
    await vi.advanceTimersByTimeAsync(100000);
    expect(h.adapters).toHaveLength(1);
    expect(h.last().stop).not.toHaveBeenCalled();
    expect(h.controller.snapshot).toMatchObject({
      state: "suspended",
      failure: { code: "autoplay" },
    });
    expect(h.controller.snapshot.failure?.message).not.toContain("private");
    expect(h.talk.start).not.toHaveBeenCalled();
  });
  it("already decoded retained media resumes without a new network start", async () => {
    const h = harness();
    await h.start();
    h.last().frame();
    h.last().fail("autoplay");
    h.video.paused = true;
    await h.controller.retry();
    expect(h.controller.snapshot.state).toBe("playing");
    await vi.advanceTimersByTimeAsync(100000);
    expect(h.adapters).toHaveLength(1);
    expect(h.last().stop).not.toHaveBeenCalled();
  });
  it("speaker unblock of a retained adapter also restores a first-frame deadline", async () => {
    const h = harness();
    await h.start();
    h.last().fail("autoplay");
    await h.controller.setListening(true);
    expect(h.controller.snapshot.state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.adapters.map((a) => a.kind)).toEqual(["webrtc", "mse"]);
  });
  it("overlapping retry gestures retain the adapter and ignore an older play rejection", async () => {
    const h = harness(),
      oldPlay = deferred<void>();
    await h.start();
    h.last().fail("autoplay");
    h.video.play.mockReturnValueOnce(oldPlay.promise);
    const first = h.controller.retry(),
      second = h.controller.retry();
    await second;
    h.last().frame();
    oldPlay.reject(new DOMException("stale rejection", "NotAllowedError"));
    await first;
    expect(h.controller.snapshot.state).toBe("playing");
    expect(h.adapters).toHaveLength(1);
    expect(h.api.client.connect).toHaveBeenCalledOnce();
    expect(h.talk.start).not.toHaveBeenCalled();
  });
});

describe("speaker and microphone independence", () => {
  it("speaker actions do not stop talk, renegotiate, or acquire another microphone", async () => {
    const h = harness();
    await h.start({ audio: { microphone: true } });
    h.last().frame();
    await h.controller.startTalk(new AbortController().signal);
    const stops = vi.mocked(h.talk.stop).mock.calls.length;
    await h.controller.setListening(true);
    await h.controller.setListening(false);
    expect(h.controller.snapshot.talking).toBe(true);
    expect(h.talk.stop).toHaveBeenCalledTimes(stops);
    expect(h.talk.start).toHaveBeenCalledOnce();
    expect(h.adapters).toHaveLength(1);
    expect(h.last().context!.config.audio.listen).toBe(true);
  });
  it("persists user speaker choice across fallback but resets on an explicit disabled config", async () => {
    const h = harness();
    await h.start();
    expect(h.last().context!.config.audio.muted).toBe(true);
    await h.controller.setListening(true);
    h.last().fail("ice");
    await flush();
    expect(h.last().context!.config.audio).toMatchObject({
      listen: true,
      muted: false,
    });
    await h.start({ audio: { listen: false, muted: false } });
    expect(h.last().context!.config.audio.muted).toBe(true);
    await expect(h.controller.setListening(true)).rejects.toMatchObject({
      failure: { code: "policy" },
    });
  });
  it.each(["config", "server", "camera"])(
    "honors separate listen denial from %s",
    async (where) => {
      const api = mockClient();
      if (where === "server") api.settings.audioDisabled = true;
      if (where === "camera")
        api.camera.capabilities = { "audio.listen": "denied" };
      const h = harness({ api });
      await h.start(
        where === "config"
          ? { audio: { listen: false, microphone: true } }
          : {},
      );
      await expect(h.controller.setListening(true)).rejects.toMatchObject({
        failure: { code: "policy" },
      });
      expect(h.talk.start).not.toHaveBeenCalled();
    },
  );
  it("talk requires playing WebRTC and an explicit permitted microphone config", async () => {
    const h = harness();
    await h.start();
    h.last().frame();
    await expect(
      h.controller.startTalk(new AbortController().signal),
    ).rejects.toMatchObject({ failure: { code: "policy" } });
    await h.start({ transports: ["hls"], audio: { microphone: false } });
    h.last().frame();
    await expect(
      h.controller.startTalk(new AbortController().signal),
    ).rejects.toMatchObject({ failure: { code: "policy" } });
    expect(h.talk.start).not.toHaveBeenCalled();
  });
  it("keeps gesture abort effective after talk attachment completes", async () => {
    const h = harness();
    await h.start({ audio: { microphone: true } });
    h.last().frame();
    const gesture = new AbortController();
    await h.controller.startTalk(gesture.signal);
    expect(h.controller.snapshot.talking).toBe(true);
    gesture.abort();
    expect(h.controller.snapshot.talking).toBe(false);
  });
  it("never starts capture while hidden even if video continues", async () => {
    const h = harness();
    await h.start({
      audio: { microphone: true },
      playback_visibility: { offscreen: "continue" },
    });
    h.last().frame();
    await h.controller.setVisible(false);
    await expect(
      h.controller.startTalk(new AbortController().signal),
    ).rejects.toMatchObject({ failure: { code: "policy" } });
    expect(h.talk.start).not.toHaveBeenCalled();
  });
  it("removal invalidates delayed microphone permission and releases the late stream", async () => {
    const permission = deferred<MediaStream>(),
      stopped = vi.fn();
    const track = Object.assign(new EventTarget(), {
      kind: "audio",
      readyState: "live",
      enabled: true,
      stop: stopped,
    }) as unknown as MediaStreamTrack;
    const sender = {
      replaceTrack: vi.fn(async () => {}),
    } as unknown as RTCRtpSender;
    const acquire = vi.fn(() => permission.promise);
    const talk = createTalkController({
      getUserMedia: acquire,
      isSecureContext: () => true,
      createMeter: () => () => {},
    });
    const h = harness({
      talk,
      setup: async (a) => {
        a.getAudioSender = () => sender;
      },
    });
    await h.start({ audio: { microphone: true } });
    h.last().frame();
    const speaking = h.controller
      .startTalk(new AbortController().signal)
      .catch(() => {});
    await flush();
    expect(h.controller.snapshot.talk.pending).toBe(true);
    await h.controller.dispose();
    await speaking;
    permission.resolve({
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream);
    await flush();
    expect(stopped).toHaveBeenCalledOnce();
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledOnce();
    expect(h.controller.snapshot.talking).toBe(false);
  });
  it("closes the peer before waiting on serialized sender detach, preserving detach order", async () => {
    const attach = deferred<void>(),
      detach = deferred<void>(),
      trackStop = vi.fn(),
      operations: (MediaStreamTrack | null)[] = [];
    const track = Object.assign(new EventTarget(), {
      kind: "audio",
      readyState: "live",
      enabled: true,
      stop: trackStop,
    }) as unknown as MediaStreamTrack;
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream;
    const sender = {
      replaceTrack: vi.fn((value: MediaStreamTrack | null) => {
        operations.push(value);
        return value ? attach.promise : detach.promise;
      }),
    } as unknown as RTCRtpSender;
    const acquire = vi.fn(async () => stream);
    const talk = createTalkController({
      getUserMedia: acquire,
      isSecureContext: () => true,
      createMeter: () => () => {},
    });
    const h = harness({
      talk,
      setup: async (a) => {
        if (a.kind !== "webrtc") return;
        a.getAudioSender = () => sender;
        a.stop = vi.fn(async () => {
          expect(trackStop).toHaveBeenCalledOnce();
          attach.resolve();
        });
      },
    });
    await h.start({ audio: { microphone: true } });
    h.last().frame();
    const speaking = h.controller.startTalk(new AbortController().signal);
    await flush();
    expect(operations).toEqual([track]);
    const cancelled = speaking.catch(() => {});
    h.last().fail("ice");
    expect(trackStop).toHaveBeenCalledOnce();
    expect(h.adapters[0]!.stop).toHaveBeenCalledOnce();
    await flush();
    expect(operations).toEqual([track, null]);
    expect(h.adapters).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await cancelled;
    expect(h.adapters.map((a) => a.kind)).toEqual(["webrtc", "mse"]);
    expect(acquire).toHaveBeenCalledOnce();
    expect(h.controller.snapshot.talking).toBe(false);
    detach.resolve();
    await flush();
    expect(operations).toEqual([track, null]);
  });
  it("noncooperative cleanup cannot block config replacement or disposal forever", async () => {
    const pending = deferred<void>();
    const h = harness();
    await h.start();
    vi.mocked(h.last().stop).mockReturnValue(pending.promise);
    vi.mocked(h.talk.stop).mockReturnValue(pending.promise);
    const replacement = h.start({ transports: ["hls"] });
    await flush();
    expect(h.adapters).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await replacement;
    expect(h.adapters.map((a) => a.kind)).toEqual(["webrtc", "hls"]);
    vi.mocked(h.talk.dispose).mockReturnValue(pending.promise);
    const disposed = h.controller.dispose();
    await vi.advanceTimersByTimeAsync(2000);
    await disposed;
    expect(h.controller.snapshot.state).toBe("stopped");
    expect(h.api.client.dispose).not.toHaveBeenCalled();
    pending.resolve();
  });
  it("repeated disposal shares the same bounded shutdown operation", async () => {
    const pending = deferred<void>(),
      h = harness();
    await h.start();
    vi.mocked(h.talk.dispose).mockReturnValue(pending.promise);
    const one = h.controller.dispose(),
      two = h.controller.dispose();
    expect(one).toBe(two);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all([one, two]);
    expect(h.talk.dispose).toHaveBeenCalledOnce();
    expect(h.last().stop).toHaveBeenCalledOnce();
    pending.resolve();
  });
});
