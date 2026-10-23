"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { VoiceSession, type SocketLike } from "@/voice/session";
import { openBrowserAudio } from "@/voice/browser-audio";
import type { TakeController } from "@/studio/take-controller";
import type { SceneController } from "@/studio/controller";
export default function VoiceDirector({
  controller,
  takes,
  onSession,
}: {
  controller: SceneController;
  takes: TakeController;
  onSession?: (session: VoiceSession | null) => void;
}) {
  const [session] = useState(
    () =>
      new VoiceSession({
        getScene: () => controller.store.getState().scene,
        effect: takes.effect,
        performanceContext: takes.context,
        execute: (command, signal) =>
          controller.dispatch(command, undefined, signal),
        subscribe: (changed) => {
          const a = controller.store.subscribe((state, previous) => {
            if (state.scene.revision !== previous.scene.revision) changed();
          });
          const b = takes.store.subscribe((s, p) => {
            if (s.takes !== p.takes || s.selectedId !== p.selectedId) changed();
          });
          return () => {
            a();
            b();
          };
        },
        mint: async (signal) => {
          const response = await fetch("/api/realtime/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal,
          });
          if (!response.ok) throw new Error("临时凭证获取失败。");
          return response.json();
        },
        socket: (secret) =>
          new WebSocket("wss://api.boson.ai/v1/realtime", [
            "realtime",
            "bai-client-secret." + secret,
          ]) as unknown as SocketLike,
        audio: openBrowserAudio,
        online: () => navigator.onLine,
      }),
  );
  useEffect(() => {
    onSession?.(session);
    return () => onSession?.(null);
  }, [onSession, session]);
  const state = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  useEffect(
    () => takes.bindReplyStop(() => session.cutPlayback()),
    [takes, session],
  );
  useEffect(() => {
    const changed = () => session.networkChanged();
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => {
      window.removeEventListener("online", changed);
      window.removeEventListener("offline", changed);
      session.stop();
    };
  }, [session]);
  return (
    <section className="voice-director studio-card" aria-label="语音导演">
      <div className="voice-director-bar">
        <div>
          <span className={state.active ? "dot online" : "dot"} />
          <strong>VOICE DIRECTOR</strong>
          <span className="voice-mic-label">
            {state.active ? "麦克风已开启" : "麦克风未开启"}
          </span>
        </div>
        <div className="voice-director-buttons">
          <button onClick={() => void session.start()} disabled={state.active}>
            连接语音导演
          </button>
          <button
            className="secondary"
            onClick={() => session.stop()}
            disabled={!state.active}
          >
            停止语音
          </button>
        </div>
      </div>
      <div
        className="voice-director-status"
        role="status"
        data-testid="voice-status"
      >
        {state.status}
        <span>
          {state.interruptionMs === null
            ? "中文 / ENGLISH"
            : "本地打断 " + state.interruptionMs.toFixed(1) + " ms"}
        </span>
      </div>
      <p className="voice-examples">
        试着说：“换成 Ren，穿黑色西装，右转 45 度并挥手。” 或 “Move the camera a
        little closer.”
      </p>
      <div className="voice-transcripts">
        <div>
          <span>听到的指令</span>
          <p data-testid="voice-heard">
            {state.heard || "连接后，说出你的导演指令。"}
          </p>
        </div>
        <div>
          <span>助手回复</span>
          <p data-testid="voice-assistant">
            {state.assistant || "工具执行后反馈实际结果。"}
          </p>
        </div>
      </div>
      {state.tools.length > 0 && (
        <details className="voice-tool-details">
          <summary>执行记录 · {state.tools.length}</summary>
          <ol data-testid="voice-tools">
            {state.tools.map((tool) => (
              <li key={tool.callId} data-status={tool.status}>
                <span className="voice-tool-badge">
                  {tool.status === "working"
                    ? "执行中"
                    : tool.status === "success"
                      ? "已执行"
                      : "未执行"}
                </span>
                <strong>{tool.name}</strong>
                <span>
                  {tool.message}
                  {tool.cached ? "（复用结果）" : ""} · REV {tool.revision}
                  {tool.elapsedMs !== undefined
                    ? " · 执行 " + tool.elapsedMs + " ms"
                    : ""}
                </span>
                <details>
                  <summary>参数</summary>
                  <code>{tool.arguments}</code>
                </details>
              </li>
            ))}
          </ol>
        </details>
      )}
      <details className="voice-runtime">
        <summary>语音连接诊断</summary>
        <pre data-testid="voice-runtime">
          {JSON.stringify(
            {
              phase: state.phase,
              connected: state.connected,
              connections: state.connections,
              reconnects: state.reconnects,
              interruptionMs: state.interruptionMs,
              pcmPackets: state.pcmPackets,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}
