"use client";
import { useEffect, useState, type RefObject } from "react";
import { useStore } from "zustand";
import { activeTake, type TakeInput } from "@/domain/take";
import type { TakeController } from "@/studio/take-controller";
import type { SceneController } from "@/studio/controller";
import { commandsToRestore } from "@/studio/restore";
export default function TakePanel({
  takes,
  controller,
  videoRef,
}: {
  takes: TakeController;
  controller: SceneController;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const state = useStore(takes.store);
  const [emotion, setEmotion] = useState<TakeInput["emotion"]>("anger");
  const [videoError, setVideoError] = useState("");
  const [confirmedId, setConfirmedId] = useState("");
  const [restoreMessage, setRestoreMessage] = useState("");
  const [notAccepted, setNotAccepted] = useState(false);
  const selected = state.takes.find((t) => t.id === state.selectedId);
  const busy =
    !state.loaded ||
    state.submitting ||
    state.uncertain ||
    state.takes.some(activeTake);
  useEffect(() => takes.start(), [takes]);
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      video?.pause();
      video?.removeAttribute("src");
      video?.load();
    };
  }, [selected?.id, selected?.status, videoRef]);
  useEffect(() => {
    setVideoError("");
    setRestoreMessage("");
    setConfirmedId("");
    setNotAccepted(false);
  }, [state.selectedId]);
  return (
    <section className="studio-card take-panel" aria-label="Take 历史">
      <div className="section-title">
        <span>05 / ACTION & TAKES</span>
        <span>{state.takes.length} TAKES</span>
      </div>
      <div className="take-actions">
        <button
          data-testid="action"
          disabled={busy}
          onClick={() => void takes.action()}
        >
          Action · 生成表演
        </button>
        <button className="secondary" onClick={() => takes.stopPlayback()}>
          Cut · 停止播放
        </button>
        <button
          className="secondary"
          onClick={() => void takes.refresh().then(() => takes.resume())}
        >
          检查记录 / 继续查询
        </button>
      </div>
      <p className="take-explainer">
        生成使用当前外形与服装的正面人像、台词和情绪。片场机位、灯光、站位与挥手仅用于三维预演，不直接控制云端视频。音色固定为
        default。
      </p>
      {(state.error || state.uncertain) && (
        <p role="alert">
          {state.error ||
            "上次提交未收到确认，请检查历史记录；不会自动重复生成。"}
        </p>
      )}
      {state.uncertain && state.loaded && !state.takes.some(activeTake) && (
        <div>
          <label>
            <input
              type="checkbox"
              checked={notAccepted}
              onChange={(e) => setNotAccepted(e.target.checked)}
            />
            我已检查历史与 Boson，确认上次提交没有对应云端任务
          </label>
          <button
            className="secondary"
            disabled={!notAccepted || state.submitting}
            onClick={() => {
              takes.resolveLocalUncertainty();
              setNotAccepted(false);
            }}
          >
            确认无任务并解除本地锁
          </button>
        </div>
      )}
      {state.submitting && <p role="status">正在冻结人像并提交一次生成…</p>}
      <div className="take-history" data-testid="take-history">
        {state.takes.length === 0 && (
          <p>还没有 Take。准备台词和演员后，点击 Action。</p>
        )}
        {state.takes.map((t, i) => (
          <button
            key={t.id}
            data-testid={"take-" + t.id}
            className={
              "take-card" + (state.selectedId === t.id ? " selected" : "")
            }
            aria-pressed={state.selectedId === t.id}
            onClick={() => takes.select(t.id)}
          >
            <strong>
              Take {state.takes.length - i} ·{" "}
              {t.input.diagnostic ? "LAB" : t.input.scene.actor.presetId} /{" "}
              {t.input.emotion}
            </strong>
            <span>
              {t.status}
              {t.progress !== null ? " · " + t.progress + "%" : ""}
            </span>
            <small>
              {t.input.scene.actor.outfit} ·{" "}
              {t.input.diagnostic ? "Lab 人像，未同步片场" : "已同步外形人像"} ·{" "}
              {new Date(t.createdAt).toLocaleString()}
            </small>
            <span>{t.input.scene.performance.dialogue}</span>
            <small>
              {t.id}
              {t.baseTakeId ? " · Retake" : ""}
            </small>
          </button>
        ))}
      </div>
      {selected && (
        <div className="take-selected" data-testid="selected-take">
          <h3>
            已选 Take · {selected.input.emotion} / {selected.status}
          </h3>
          <p>选择只切换回放，不改动当前片场。</p>
          <div className="take-media">
            {/* Local owned actor reference, never a remote arbitrary URL. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={"/api/takes/" + selected.id + "/portrait"}
              alt="此 Take 冻结的正面参考人像"
              width={120}
              height={120}
            />
            {selected.status === "completed" ? (
              <video
                ref={videoRef}
                key={selected.id}
                data-testid="take-video"
                controls
                preload="metadata"
                src={"/api/takes/" + selected.id + "/content"}
                onError={() =>
                  setVideoError(
                    "视频不可用，供应商资源可能已过期或下载暂时失败。可重新加载播放；这不会重新生成。",
                  )
                }
              />
            ) : (
              <p>状态：{selected.status}。云端完成后可播放。</p>
            )}
          </div>
          {videoError && (
            <p role="alert">
              {videoError}{" "}
              <button
                className="secondary"
                onClick={() => {
                  setVideoError("");
                  videoRef.current?.load();
                }}
              >
                重新加载视频
              </button>
            </p>
          )}
          {selected.error && <p role="alert">{selected.error}</p>}
          {selected.status === "submission_unknown" && (
            <div>
              <p>
                先在 Boson 控制台核实同一输入的任务，再关联已确认的 video
                ID。此操作只查询，不创建新任务。
              </p>
              <input
                aria-label="已确认的 Boson 视频 ID"
                value={confirmedId}
                onChange={(e) => setConfirmedId(e.target.value)}
              />
              <button
                className="secondary"
                disabled={!/^video_[a-zA-Z0-9_-]+$/.test(confirmedId)}
                onClick={() => void takes.reconcile(selected.id, confirmedId)}
              >
                关联已确认任务
              </button>
              <label>
                <input
                  type="checkbox"
                  checked={notAccepted}
                  onChange={(e) => setNotAccepted(e.target.checked)}
                />
                我已在 Boson 核实该提交未被接收、没有对应任务
              </label>
              <button
                className="secondary"
                disabled={!notAccepted}
                onClick={() => void takes.reconcile(selected.id, "", true)}
              >
                确认未接收并解除本地锁
              </button>
            </div>
          )}
          <div className="take-actions">
            <select
              aria-label="Retake 情绪"
              value={emotion}
              onChange={(e) =>
                setEmotion(e.target.value as TakeInput["emotion"])
              }
            >
              <option value="anger">愤怒 / anger</option>
              <option value="fear">恐惧 / fear</option>
              <option value="neutral">平静 / neutral</option>
            </select>
            <button
              disabled={busy || !!selected.input.diagnostic}
              onClick={() => void takes.retake(emotion)}
            >
              Retake · 只改情绪
            </button>
            <button
              className="secondary"
              onClick={async () => {
                const r = await controller.dispatch(
                  commandsToRestore(
                    selected.input.scene,
                    selected.input.emotion,
                  ),
                );
                setRestoreMessage(r.message);
              }}
            >
              恢复此 Take 的片场
            </button>
          </div>
          <small>
            {restoreMessage} 来源：{selected.baseTakeId || "Action"} · 参考版本{" "}
            {selected.input.reference.version} ·{" "}
            {selected.input.reference.hash.slice(0, 12)}
          </small>
          <details>
            <summary>冻结输入与校验 hash</summary>
            <pre data-testid="take-input">
              {JSON.stringify(
                {
                  input: selected.input,
                  inputHash: selected.inputHash,
                  invariantHash: selected.invariantHash,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </div>
      )}
    </section>
  );
}
