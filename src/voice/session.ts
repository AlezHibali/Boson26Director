import { directorInstructions, directorTools } from "./tools";
import { ToolBridge, type ToolLog } from "./tool-bridge";
import type { AudioIO } from "./browser-audio";
import type { Command, CommandResult, SceneState } from "@/domain/scene";
export type SocketLike = {
  readyState: number;
  bufferedAmount: number;
  send: (data: string) => void;
  close: () => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
export type VoiceState = {
  active: boolean;
  connected: boolean;
  phase:
    | "stopped"
    | "connecting"
    | "listening"
    | "speaking"
    | "working"
    | "reconnecting"
    | "error";
  status: string;
  heard: string;
  assistant: string;
  tools: ToolLog[];
  connections: number;
  reconnects: number;
  interruptionMs: number | null;
  pcmPackets: number;
};
type Deps = {
  getScene: () => SceneState;
  execute: (command: Command, signal: AbortSignal) => Promise<CommandResult>;
  subscribe: (changed: () => void) => () => void;
  mint: (signal: AbortSignal) => Promise<{ value: string; expires_at: number }>;
  socket: (secret: string) => SocketLike;
  audio: (
    pcm: (data: ArrayBuffer) => void,
    ended: () => void,
    signal: AbortSignal,
    drained: () => void,
  ) => Promise<AudioIO>;
  online: () => boolean;
};
export class VoiceSession {
  private state: VoiceState = {
    active: false,
    connected: false,
    phase: "stopped",
    status: "语音导演未连接",
    heard: "",
    assistant: "",
    tools: [],
    connections: 0,
    reconnects: 0,
    interruptionMs: null,
    pcmPackets: 0,
  };
  private listeners = new Set<() => void>();
  private desired = false;
  private packets = 0;
  private lifecycle = 0;
  private epoch = 0;
  private socket: SocketLike | null = null;
  private audio: AudioIO | null = null;
  private micAbort: AbortController | null = null;
  private connectionAbort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private connectionTimer: ReturnType<typeof setTimeout> | undefined;
  private contextTimer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribe: (() => void) | undefined;
  private ready = false;
  private inFlight = false;
  private currentResponse = "";
  private blocked = new Set<string>();
  private pendingContinuation = false;
  private continuationRounds = 0;
  private bridge: ToolBridge;
  constructor(private deps: Deps) {
    this.bridge = new ToolBridge({
      getScene: deps.getScene,
      execute: deps.execute,
      log: (entry) => {
        const rows = this.state.tools;
        const index = rows.findIndex((row) => row.callId === entry.callId);
        const tools =
          index < 0
            ? [entry, ...rows].slice(0, 16)
            : rows.map((row, i) => (i === index ? entry : row));
        this.patch({
          tools,
          ...(entry.status === "working"
            ? { phase: "working" as const, status: "正在执行导演指令…" }
            : {}),
        });
      },
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private patch(update: Partial<VoiceState>) {
    this.state = { ...this.state, ...update };
    this.listeners.forEach((listener) => listener());
  }
  private send(event: unknown) {
    if (this.desired && this.socket?.readyState === 1)
      this.socket.send(JSON.stringify(event));
  }
  private detach() {
    clearTimeout(this.connectionTimer);
    clearTimeout(this.contextTimer);
    this.connectionAbort?.abort();
    this.connectionAbort = null;
    if (this.socket) {
      this.socket.onopen =
        this.socket.onmessage =
        this.socket.onclose =
        this.socket.onerror =
          null;
      this.socket.close();
      this.socket = null;
    }
    this.ready = false;
    this.inFlight = false;
    this.currentResponse = "";
    this.pendingContinuation = false;
    this.blocked.clear();
    this.epoch++;
  }
  async start() {
    if (this.desired) return;
    this.desired = true;
    const run = ++this.lifecycle;
    this.micAbort = new AbortController();
    this.patch({
      active: true,
      connected: false,
      phase: "connecting",
      status: "等待麦克风权限…",
      reconnects: 0,
    });
    this.unsubscribe = this.deps.subscribe(() => {
      clearTimeout(this.contextTimer);
      this.contextTimer = setTimeout(() => this.syncContext(), 120);
    });
    try {
      const audio = await this.deps.audio(
        (data) => this.pcm(data),
        () => this.fail("麦克风已断开，请检查设备后重新连接。"),
        this.micAbort.signal,
        () => {
          if (
            this.desired &&
            this.ready &&
            !this.inFlight &&
            this.state.phase === "speaking"
          )
            this.patch({
              phase: "listening",
              status: "已连接 · 等待下一条指令",
            });
        },
      );
      if (!this.desired || run !== this.lifecycle) {
        audio.close();
        return;
      }
      this.audio = audio;
      await this.connect();
    } catch (error) {
      if (!this.desired || run !== this.lifecycle) return;
      const name = error instanceof DOMException ? error.name : "";
      this.fail(
        name === "NotAllowedError"
          ? "麦克风权限被拒绝，请在浏览器设置中允许后重试。"
          : name === "NotFoundError"
            ? "未找到麦克风设备。"
            : "麦克风启动失败，请检查设备和安全上下文。",
      );
    }
  }
  private async connect() {
    if (!this.desired) return;
    this.detach();
    const epoch = this.epoch;
    const abort = new AbortController();
    this.connectionAbort = abort;
    const current = () =>
      this.desired && epoch === this.epoch && !abort.signal.aborted;
    this.patch({
      connected: false,
      phase: this.state.reconnects ? "reconnecting" : "connecting",
      status: "正在获取新临时凭证并连接…",
    });
    this.connectionTimer = setTimeout(() => {
      if (current()) this.lost("连接超时");
    }, 15000);
    try {
      const token = await this.deps.mint(abort.signal);
      if (!current()) return;
      if (
        !token.value.startsWith("bai-eph-") ||
        token.expires_at * 1000 <= Date.now()
      )
        throw new Error("Invalid ephemeral credential.");
      const socket = this.deps.socket(token.value);
      this.socket = socket;
      socket.onopen = () => {
        if (!current()) return;
        this.send({
          type: "session.update",
          session: {
            model: "higgs-realtime",
            instructions: directorInstructions(this.deps.getScene()),
            tools: directorTools,
            tool_choice: "auto",
            output_modalities: ["audio"],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                turn_detection: { type: "server_vad" },
                transcription: { model: "higgs-stt-3.1" },
              },
              output: {
                format: { type: "audio/pcm", rate: 24000 },
                voice: "default",
              },
            },
          },
        });
      };
      socket.onmessage = (event) => {
        if (current()) this.message(event.data, epoch, abort.signal);
      };
      socket.onclose = (event) => {
        if (current())
          this.lost(event.code === 3000 ? "临时凭证失效" : "网络连接已关闭");
      };
      socket.onerror = () => {
        if (current()) this.lost("WebSocket 连接失败");
      };
    } catch {
      if (current()) this.lost("凭证获取或连接失败");
    }
  }
  private pcm(buffer: ArrayBuffer) {
    if (
      !this.ready ||
      !this.desired ||
      this.socket?.readyState !== 1 ||
      this.socket.bufferedAmount > 480000
    )
      return;
    let binary = "";
    for (const value of new Uint8Array(buffer))
      binary += String.fromCharCode(value);
    this.send({ type: "input_audio_buffer.append", audio: btoa(binary) });
    // Keep packet counter out of React's per-packet render path.
    this.packets++;
    if (this.packets % 10 === 0) this.patch({ pcmPackets: this.packets });
  }
  private message(raw: string, epoch: number, signal: AbortSignal) {
    if (raw.length > 2200000) return;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!event || typeof event.type !== "string") return;
    switch (event.type) {
      case "session.created":
      case "session.updated":
        if (!this.ready) {
          this.ready = true;
          clearTimeout(this.connectionTimer);
          this.patch({
            connected: true,
            phase: "listening",
            status: "已连接 · 请说出导演指令",
            connections: this.state.connections + 1,
          });
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string")
          this.patch({ heard: event.transcript.slice(0, 1000) });
        break;
      case "input_audio_buffer.speech_started": {
        if (this.currentResponse) this.blocked.add(this.currentResponse);
        const interrupted = this.audio?.interrupt();
        interrupted?.truncations.forEach((item) =>
          this.send({ type: "conversation.item.truncate", ...item }),
        );
        this.continuationRounds = 0;
        this.patch({
          phase: "listening",
          status: "正在聆听新指令…",
          assistant: "",
          interruptionMs: interrupted?.latencyMs ?? null,
        });
        break;
      }
      case "response.created":
        if (event.response?.id !== this.currentResponse)
          this.patch({ assistant: "" });
        this.inFlight = true;
        this.currentResponse = event.response?.id || "";
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (this.blocked.has(event.response_id || this.currentResponse)) return;
        if (
          typeof event.delta === "string" &&
          typeof event.item_id === "string"
        ) {
          try {
            this.audio?.play(
              event.delta,
              event.item_id,
              event.content_index || 0,
            );
            if (this.state.phase !== "speaking")
              this.patch({
                phase: "speaking",
                status: "正在播放导演助手回复…",
              });
          } catch {
            this.patch({ status: "回复音频格式无效，仍可继续发出指令。" });
          }
        }
        break;
      case "response.output_audio_transcript.delta":
        if (
          !this.blocked.has(event.response_id || this.currentResponse) &&
          typeof event.delta === "string"
        )
          this.patch({
            assistant: (this.state.assistant + event.delta).slice(-1000),
          });
        break;
      case "response.done": {
        if (
          !this.currentResponse ||
          event.response?.id === this.currentResponse
        )
          this.inFlight = false;
        const scope = {
          signal,
          active: () => this.desired && epoch === this.epoch && !signal.aborted,
          send: (value: unknown) => this.send(value),
          continueResponse: () => {
            this.pendingContinuation = true;
            this.flushContinuation();
          },
        };
        void this.bridge.handleDone(event, scope).then(() => {
          if (scope.active()) {
            this.flushContinuation();
            if (!this.inFlight && this.audio?.isPlaying?.())
              this.patch({
                phase: "speaking",
                status: "正在播放导演助手回复…",
              });
            else if (!this.inFlight)
              this.patch({
                phase: "listening",
                status: "已连接 · 等待下一条指令",
              });
          }
        });
        break;
      }
      case "error": {
        // An active response may reject response.create in manual mode; never blindly replay a command.
        this.fail(
          "Boson 会话报告错误。已停止连接，当前片场保留；请重连后重新发出指令。",
        );
        break;
      }
      case "session.idle_timeout":
      case "session.max_duration_reached":
        this.lost("会话已到时限");
        break;
    }
  }
  private flushContinuation() {
    if (
      !this.pendingContinuation ||
      !this.ready ||
      this.inFlight ||
      !this.desired
    )
      return;
    this.pendingContinuation = false;
    if (++this.continuationRounds > 6) {
      this.patch({
        phase: "listening",
        status: "已暂停连续工具调用，请重新说明你的指令。",
      });
      return;
    }
    this.syncContext();
    this.inFlight = true;
    this.send({ type: "response.create" });
  }
  private syncContext() {
    if (this.ready && this.desired)
      this.send({
        type: "session.update",
        session: { instructions: directorInstructions(this.deps.getScene()) },
      });
  }
  private lost(reason: string) {
    if (!this.desired) return;
    this.audio?.interrupt();
    this.detach();
    if (!this.deps.online()) {
      this.patch({
        connected: false,
        phase: "reconnecting",
        status: "网络离线 · 等待恢复，麦克风仍已开启",
      });
      return;
    }
    if (this.state.reconnects >= 2) {
      this.fail(reason + "。自动重连已停止，请手动重新连接。");
      return;
    }
    const retry = this.state.reconnects + 1;
    this.patch({
      connected: false,
      phase: "reconnecting",
      reconnects: retry,
      status: reason + " · 即将重新连接（" + retry + "/2）",
    });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => void this.connect(),
      retry === 1 ? 500 : 1500,
    );
  }
  networkChanged() {
    if (!this.desired) return;
    if (!this.deps.online()) this.lost("网络离线");
    else if (!this.socket) {
      clearTimeout(this.retryTimer);
      void this.connect();
    }
  }
  private fail(message: string) {
    this.stop();
    this.patch({ phase: "error", status: message });
  }
  stop() {
    this.desired = false;
    this.lifecycle++;
    clearTimeout(this.retryTimer);
    this.detach();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.micAbort?.abort();
    this.micAbort = null;
    this.audio?.close();
    this.audio = null;
    this.patch({
      active: false,
      connected: false,
      phase: "stopped",
      status: "已停止 · 麦克风已释放",
    });
  }
}
