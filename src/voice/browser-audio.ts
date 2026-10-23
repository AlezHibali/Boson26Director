export type Truncation = {
  item_id: string;
  content_index: number;
  audio_end_ms: number;
};
export interface AudioIO {
  play(delta: string, itemId: string, contentIndex: number): void;
  interrupt(): { truncations: Truncation[]; latencyMs: number };
  close(): void;
  isPlaying?(): boolean;
}
export async function openBrowserAudio(
  onPcm: (buffer: ArrayBuffer) => void,
  onEnded: () => void,
  signal: AbortSignal,
  onDrained?: () => void,
): Promise<AudioIO> {
  const context = new AudioContext({ sampleRate: 24000 });
  let stream: MediaStream | undefined;
  let node: AudioWorkletNode | undefined;
  let closed = false;
  let nextTime = 0;
  const sources = new Set<AudioBufferSourceNode>();
  const items = new Map<
    string,
    { start: number; end: number; duration: number; index: number }
  >();
  const stop = () => {
    sources.forEach((source) => {
      try {
        source.stop();
      } catch {}
    });
    sources.clear();
    items.clear();
    nextTime = 0;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stop();
    node?.disconnect();
    stream?.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => {});
  };
  const abort = () => close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await context.resume();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("请使用 HTTPS 或 localhost，并允许麦克风。");
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    if (signal.aborted) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Aborted", "AbortError");
    }
    stream.getTracks().forEach((track) =>
      track.addEventListener("ended", () => {
        if (!closed) onEnded();
      }),
    );
    await context.audioWorklet.addModule("/audio/pcm-capture.js");
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    node = new AudioWorkletNode(context, "pcm-capture");
    const source = context.createMediaStreamSource(stream);
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(context.destination);
    node.port.onmessage = ({ data }: { data: ArrayBuffer }) => {
      if (!closed) onPcm(data);
    };
    return {
      play(delta, itemId, index) {
        if (closed || !itemId || delta.length > 2000000) return;
        const bytes = Uint8Array.from(atob(delta), (char) =>
          char.charCodeAt(0),
        );
        if (!bytes.length || bytes.byteLength % 2) return;
        const buffer = context.createBuffer(1, bytes.byteLength / 2, 24000);
        const data = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer);
        for (let i = 0; i < data.length; i++)
          data[i] = view.getInt16(i * 2, true) / 32768;
        const audio = context.createBufferSource();
        audio.buffer = buffer;
        audio.connect(context.destination);
        const when = Math.max(context.currentTime + 0.02, nextTime);
        nextTime = when + buffer.duration;
        const previous = items.get(itemId);
        items.set(itemId, {
          start: previous?.start ?? when,
          end: nextTime,
          duration: (previous?.duration || 0) + buffer.duration,
          index,
        });
        for (const [key, item] of items)
          if (item.end < context.currentTime - 1) items.delete(key);
        sources.add(audio);
        audio.onended = () => {
          sources.delete(audio);
          if (!closed && sources.size === 0) onDrained?.();
        };
        audio.start(when);
      },
      interrupt() {
        const start = performance.now();
        const now = context.currentTime;
        const truncations: Truncation[] = [];
        for (const [id, item] of items)
          if (item.end > now)
            truncations.push({
              item_id: id,
              content_index: item.index,
              audio_end_ms: Math.max(
                0,
                Math.floor(Math.min(item.duration, now - item.start) * 1000),
              ),
            });
        stop();
        return { truncations, latencyMs: performance.now() - start };
      },
      isPlaying: () => sources.size > 0,
      close() {
        signal.removeEventListener("abort", abort);
        close();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    close();
    throw error;
  }
}
