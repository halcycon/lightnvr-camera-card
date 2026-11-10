/** Local analysis only: never connect microphone audio to the output device. */
export function createLocalMeter(stream: MediaStream, report: (level: number) => void): () => void {
  if (!globalThis.AudioContext) return () => {};
  const context = new AudioContext();
  let source: MediaStreamAudioSourceNode | undefined;
  let analyser: AnalyserNode | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    source?.disconnect();
    analyser?.disconnect();
    void context.close().catch(() => {});
  };
  try {
    source = context.createMediaStreamSource(stream);
    analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    timer = setInterval(() => {
      analyser!.getByteTimeDomainData(samples);
      report(Math.min(1, Math.sqrt(samples.reduce((sum, n) => sum + ((n - 128) / 128) ** 2, 0) / samples.length)));
    }, 100);
    return stop;
  } catch { stop(); return () => {}; }
}
