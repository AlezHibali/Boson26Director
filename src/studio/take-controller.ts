import { createStore } from "zustand/vanilla";
import { activeTake, type Take, type TakeInput } from "@/domain/take";
import type { CommandResult, SceneState } from "@/domain/scene";
export type PerformanceResult = CommandResult & {
  takeId?: string;
  status?: string;
};
type Deps = {
  scene: () => SceneState;
  capture: (snapshot: SceneState) => Promise<string>;
  transport?: typeof fetch;
  stopPlayback: () => void;
};
export function createTakeController(deps: Deps) {
  const transport = deps.transport || fetch;
  const store = createStore<{
    takes: Take[];
    selectedId: string | null;
    submitting: boolean;
    error: string;
    paused: boolean;
    uncertain: boolean;
    loaded: boolean;
  }>(() => ({
    takes: [],
    selectedId: null,
    submitting: false,
    error: "",
    paused: false,
    uncertain: false,
    loaded: false,
  }));
  let generation = 0;
  let version = 0,
    refreshSequence = 0;
  let started = 0;
  let stopReply = () => {};
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let subscription: (() => void) | undefined;
  let pendingId: string | null = null;
  const upsert = (t: Take) => {
    version++;
    store.setState((s) => ({
      takes: [t, ...s.takes.filter((x) => x.id !== t.id)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    }));
  };
  function stopPlayback() {
    deps.stopPlayback();
    stopReply();
  }
  function result(ok: boolean, message: string, t?: Take): PerformanceResult {
    const revision = deps.scene().revision;
    return ok
      ? {
          ok: true,
          revision,
          message,
          notices: [],
          ...(t ? { takeId: t.id, status: t.status } : {}),
        }
      : {
          ok: false,
          revision,
          code: "PERFORMANCE_ERROR",
          message,
          ...(t ? { takeId: t.id, status: t.status } : {}),
        };
  }
  async function request(url: string, init?: RequestInit) {
    const res = await transport(url, { cache: "no-store", ...init });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      const error = new Error(
        payload?.error?.message || "请求失败，请检查网络后查询历史。",
      ) as Error & { retryAfter?: number; definite?: boolean };
      error.retryAfter = retryDelay(res.headers.get("retry-after"));
      error.definite =
        res.status >= 400 && res.status < 500 && res.status !== 408;
      throw error;
    }
    return res.json();
  }
  async function refresh() {
    const epoch = generation,
      snapshotVersion = version,
      ticket = ++refreshSequence;
    try {
      const data = await request("/api/takes");
      if (
        epoch !== generation ||
        ticket !== refreshSequence ||
        snapshotVersion !== version
      )
        return;
      store.setState({ takes: data.takes, loaded: true, error: "" });
      if (
        pendingId &&
        data.takes.some((t: Take) => t.requestId === pendingId)
      ) {
        pendingId = null;
        localStorage.removeItem("director-pending-request");
        store.setState({ uncertain: false });
      }
    } catch (e) {
      store.setState({ error: (e as Error).message });
    }
  }
  function schedule(ms: number, epoch: number) {
    clearTimeout(pollTimer);
    if (epoch !== generation) return;
    pollTimer = setTimeout(() => void poll(epoch), ms);
  }
  async function poll(epoch: number) {
    if (epoch !== generation || store.getState().paused) return;
    const active = store
      .getState()
      .takes.find((t) => activeTake(t) && t.status !== "submission_unknown");
    if (!active) return;
    if (Date.now() - started > 10 * 60 * 1000) {
      store.setState({
        paused: true,
        error: "等待已超过 10 分钟；云端任务未取消。点击继续查询。",
      });
      return;
    }
    let delay = Date.now() - started < 30000 ? 2000 : 5000;
    try {
      const t = await request("/api/takes/" + active.id);
      if (epoch !== generation) return;
      upsert(t);
      store.setState({ error: "" });
    } catch (e) {
      if (epoch !== generation) return;
      delay = Math.max(
        delay,
        (e as Error & { retryAfter?: number }).retryAfter || 5000,
      );
      store.setState({ error: (e as Error).message });
    }
    schedule(
      typeof document !== "undefined" && document.hidden
        ? Math.max(delay, 15000)
        : delay,
      epoch,
    );
  }
  async function submit(
    kind: "action" | "retake",
    requestId: string,
    emotion?: TakeInput["emotion"],
    baseId?: string,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) return result(false, "旧连接调用已取消。");
    const state = store.getState();
    if (!state.loaded) return result(false, "历史尚未加载，请稍候。");
    if (state.submitting || state.uncertain || state.takes.some(activeTake))
      return result(false, "已有任务或提交结果未知；请先查询并核实。");
    const base = baseId || state.selectedId;
    if (kind === "retake" && !base)
      return result(false, "请先选择一个历史 Take，再指定重拍情绪。");
    const snapshot = structuredClone(deps.scene()); // Freeze before the first await.
    store.setState({ submitting: true, error: "" });
    let posted = false;
    try {
      const payload =
        kind === "action"
          ? {
              requestId,
              scene: snapshot,
              portrait: await deps.capture(snapshot),
            }
          : {
              requestId,
              baseTakeId: base,
              overrides: { emotion: emotion || "neutral" },
            };
      if (signal?.aborted) return result(false, "旧连接调用已取消，未提交。");
      pendingId = requestId;
      localStorage.setItem("director-pending-request", requestId);
      posted = true;
      // Once sent, do not abort/retry a paid submission when voice disconnects.
      const t: Take = await request(
        kind === "action" ? "/api/takes" : "/api/takes/retake",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      upsert(t);
      pendingId = null;
      localStorage.removeItem("director-pending-request");
      store.setState({ uncertain: false, error: t.error || "" });
      started = Date.now();
      schedule(2000, generation);
      return result(
        t.status !== "failed" && t.status !== "submission_unknown",
        t.error ||
          "已保存 Take " +
            t.id +
            "；状态 " +
            t.status +
            "，生成完成前不能播放。",
        t,
      );
    } catch (e) {
      const definite = (e as Error & { definite?: boolean }).definite;
      if (!posted || definite) {
        pendingId = null;
        localStorage.removeItem("director-pending-request");
      } else store.setState({ uncertain: true });
      const message =
        posted && !definite
          ? "提交响应中断，可能已创建。请检查历史；禁止自动重新生成。"
          : (e as Error).message;
      store.setState({ error: message });
      if (posted) await refresh();
      return result(false, message);
    } finally {
      store.setState({ submitting: false });
    }
  }
  return {
    store,
    archive: async (id: string) => {
      try {
        upsert(
          await request("/api/takes/" + id + "/archive", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        );
        store.setState({ error: "" });
      } catch (e) {
        store.setState({ error: (e as Error).message });
      }
    },
    refresh,
    upsert,
    stopPlayback,
    resolveLocalUncertainty: () => {
      if (
        !store.getState().loaded ||
        store.getState().takes.some(activeTake) ||
        store.getState().submitting
      )
        return;
      pendingId = null;
      localStorage.removeItem("director-pending-request");
      store.setState({
        uncertain: false,
        error: "用户已核实没有对应云端任务；可手动创建新 Take。",
      });
    },
    bindReplyStop: (stop: () => void) => {
      stopReply = stop;
      return () => {
        stopReply = () => {};
      };
    },
    select: (id: string) => {
      stopPlayback();
      store.setState({ selectedId: id, error: "" });
    },
    action: (id = crypto.randomUUID(), signal?: AbortSignal) =>
      submit("action", id, undefined, undefined, signal),
    retake: (
      emotion: TakeInput["emotion"],
      id = crypto.randomUUID(),
      baseId?: string,
      signal?: AbortSignal,
    ) => submit("retake", id, emotion, baseId, signal),
    effect: async (
      name: string,
      args: Record<string, unknown>,
      callId: string,
      signal: AbortSignal,
    ) => {
      if (name === "stop_playback") {
        stopPlayback();
        return result(true, "已停止本地播放；已提交的云端任务继续生成。");
      }
      return name === "perform"
        ? submit("action", "voice:" + callId, undefined, undefined, signal)
        : submit(
            "retake",
            "voice:" + callId,
            args.emotion as TakeInput["emotion"],
            args.baseTakeId as string | undefined,
            signal,
          );
    },
    context: () => ({
      selectedTakeId: store.getState().selectedId,
      takes: store
        .getState()
        .takes.slice(0, 12)
        .map((t) => ({ id: t.id, status: t.status, emotion: t.input.emotion })),
    }),
    resume: () => {
      started = Date.now();
      store.setState({ paused: false });
      schedule(0, generation);
    },
    reconcile: async (
      id: string,
      videoId: string,
      confirmedNotAccepted = false,
    ) => {
      try {
        upsert(
          await request("/api/takes/" + id + "/reconcile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(
              confirmedNotAccepted
                ? { confirmedNotAccepted: true }
                : { videoId },
            ),
          }),
        );
        started = Date.now();
        schedule(0, generation);
      } catch (e) {
        store.setState({ error: (e as Error).message });
      }
    },
    start: () => {
      const epoch = ++generation;
      started = Date.now();
      pendingId = localStorage.getItem("director-pending-request");
      store.setState({ uncertain: !!pendingId });
      void refresh().then(() => schedule(2000, epoch));
      subscription = store.subscribe((s, p) => {
        if (
          s.takes !== p.takes &&
          s.takes.some((t) => activeTake(t) && t.videoId)
        )
          schedule(2000, epoch);
      });
      return () => {
        generation++;
        clearTimeout(pollTimer);
        subscription?.();
        stopPlayback();
      };
    },
  };
}
export function retryDelay(value: string | null, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}
export type TakeController = ReturnType<typeof createTakeController>;
