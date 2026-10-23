"use client";
import { useCallback, useEffect, useRef, useState } from "react";
type Resources = {
  context?: AudioContext;
  stream?: MediaStream;
  ws?: WebSocket;
  node?: AudioWorkletNode;
  sources: Set<AudioBufferSourceNode>;
  timer?: ReturnType<typeof setTimeout>;
};
export default function RealtimePanel() {
  const [status, setStatus] = useState("未连接");
  const [active, setActive] = useState(false);
  const [events, setEvents] = useState<string[]>([]);
  const resources = useRef<Resources>({ sources: new Set() });
  const epoch = useRef(0);
  const release = useCallback(() => {
    const r = resources.current;
    clearTimeout(r.timer);
    r.ws?.close();
    r.node?.disconnect();
    r.stream?.getTracks().forEach((t) => t.stop());
    r.sources.forEach((s) => {
      try {
        s.stop();
      } catch {}
    });
    void r.context?.close().catch(() => {});
    resources.current = { sources: new Set() };
  }, []);
  const stop = useCallback(() => {
    epoch.current++;
    release();
    setActive(false);
    setStatus("已停止 · 麦克风已释放");
  }, [release]);
  useEffect(
    () => () => {
      epoch.current++;
      release();
    },
    [release],
  );
  async function start() {
    const run = ++epoch.current;
    release();
    setEvents([]);
    setActive(true);
    setStatus("等待麦克风权限…");
    const r: Resources = { sources: new Set() };
    resources.current = r;
    let nextTime = 0;
    let itemId = "";
    let itemStart = 0;
    let itemDuration = 0;
    const current = () => epoch.current === run;
    const fail = (message: string) => {
      if (current()) {
        epoch.current++;
        release();
        setActive(false);
        setStatus(message);
      }
    };
    try {
      r.context = new AudioContext({ sampleRate: 24000 });
      await r.context.resume();
      if (!current()) return;
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("需要 HTTPS 或 localhost，并允许使用麦克风。");
      r.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (!current()) {
        r.stream.getTracks().forEach((t) => t.stop());
        return;
      }
      await r.context.audioWorklet.addModule("/audio/pcm-capture.js");
      if (!current()) return;
      r.node = new AudioWorkletNode(r.context, "pcm-capture");
      const source = r.context.createMediaStreamSource(r.stream);
      const mute = r.context.createGain();
      mute.gain.value = 0;
      source.connect(r.node);
      r.node.connect(mute);
      mute.connect(r.context.destination);
      setStatus("正在连接 Boson…");
      const response = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const token = await response.json();
      if (!current()) return;
      if (!response.ok)
        throw new Error(token.error?.message || "临时凭证获取失败。");
      const ws = new WebSocket("wss://api.boson.ai/v1/realtime", [
        "realtime",
        "bai-client-secret." + token.value,
      ]);
      r.ws = ws;
      const send = (data: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
      };
      r.timer = setTimeout(() => fail("连接超时，请停止后重新连接。"), 15000);
      r.node.port.onmessage = ({ data }: { data: ArrayBuffer }) => {
        if (
          !current() ||
          ws.readyState !== WebSocket.OPEN ||
          ws.bufferedAmount > 480000
        )
          return;
        const bytes = new Uint8Array(data);
        let binary = "";
        for (const value of bytes) binary += String.fromCharCode(value);
        send({ type: "input_audio_buffer.append", audio: btoa(binary) });
      };
      ws.onopen = () => {
        if (!current()) return;
        send({
          type: "session.update",
          session: {
            model: "higgs-realtime",
            instructions:
              "You are a brief microphone diagnostic assistant. Reply in the user's language in one short sentence. Do not claim to control a scene.",
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                turn_detection: { type: "server_vad" },
              },
              output: {
                format: { type: "audio/pcm", rate: 24000 },
                voice: "default",
              },
            },
          },
        });
      };
      ws.onmessage = (event) => {
        if (!current()) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (typeof message.type !== "string") return;
        if (!message.type.endsWith(".delta"))
          setEvents((previous) => [...previous.slice(-7), message.type]);
        if (
          message.type === "session.created" ||
          message.type === "session.updated"
        ) {
          clearTimeout(r.timer);
          setStatus("已连接 · 请说一句话");
        }
        if (message.type === "error") {
          fail("Boson 会话报错，请检查账户与会话配置后重连。");
          return;
        }
        if (message.type === "input_audio_buffer.speech_started") {
          r.sources.forEach((s) => {
            try {
              s.stop();
            } catch {}
          });
          r.sources.clear();
          nextTime = 0;
          if (itemId && r.context)
            send({
              type: "conversation.item.truncate",
              item_id: itemId,
              content_index: 0,
              audio_end_ms: Math.max(
                0,
                Math.floor(
                  Math.min(itemDuration, r.context.currentTime - itemStart) *
                    1000,
                ),
              ),
            });
          itemId = "";
          setStatus("正在聆听…");
        }
        if (
          (message.type === "response.output_audio.delta" ||
            message.type === "response.audio.delta") &&
          typeof message.delta === "string" &&
          r.context
        ) {
          const bytes = Uint8Array.from(atob(message.delta), (c) =>
            c.charCodeAt(0),
          );
          if (bytes.byteLength % 2) return;
          const buffer = r.context.createBuffer(1, bytes.byteLength / 2, 24000);
          const channel = buffer.getChannelData(0);
          const view = new DataView(bytes.buffer);
          for (let i = 0; i < channel.length; i++)
            channel[i] = view.getInt16(i * 2, true) / 32768;
          const audio = r.context.createBufferSource();
          audio.buffer = buffer;
          audio.connect(r.context.destination);
          const when = Math.max(r.context.currentTime + 0.02, nextTime);
          if (itemId !== message.item_id) {
            itemId = message.item_id;
            itemStart = when;
            itemDuration = 0;
          }
          itemDuration += buffer.duration;
          nextTime = when + buffer.duration;
          r.sources.add(audio);
          audio.onended = () => r.sources.delete(audio);
          audio.start(when);
          setStatus("正在播放回复…");
        }
        if (message.type === "response.done")
          setStatus("已连接 · 等待下一句话");
      };
      ws.onerror = () => fail("WebSocket 连接失败，请检查网络或凭证。");
      ws.onclose = (event) =>
        fail(
          event.code === 3000
            ? "临时凭证失效，请重新连接。"
            : "连接已关闭（" + event.code + "），请重新连接。",
        );
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      fail(
        name === "NotAllowedError"
          ? "麦克风权限被拒绝，请在浏览器设置中允许后重试。"
          : name === "NotFoundError"
            ? "未找到麦克风设备。"
            : error instanceof Error
              ? error.message
              : "连接失败。",
      );
    }
  }
  return (
    <section className="panel realtime">
      <div className="section-title">
        <span>02 / REALTIME</span>
        <span className={active ? "dot online" : "dot"} />
      </div>
      <h2>先说声你好。</h2>
      <p className="muted">
        真实麦克风 → Higgs Realtime → 语音回复。当前仅做连接验证。
      </p>
      <div
        className="connection-status"
        role="status"
        data-testid="realtime-status"
      >
        {status}
      </div>
      <div className="button-row">
        <button onClick={start} disabled={active}>
          连接麦克风
        </button>
        <button className="secondary" onClick={stop} disabled={!active}>
          停止连接
        </button>
      </div>
      <details>
        <summary>会话事件（不记录音频和凭证）</summary>
        <ul className="events">
          {events.map((event, i) => (
            <li key={i}>{event}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}
