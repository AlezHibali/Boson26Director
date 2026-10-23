"use client";
import dynamic from "next/dynamic";
import { Component, useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { actors, type ActorCapabilities } from "@/lib/actors";
import RealtimePanel from "./realtime-panel";
const ActorView = dynamic(() => import("./actor-view"), {
  ssr: false,
  loading: () => <div className="stage-loading">加载角色查看器…</div>,
});
class AssetBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="stage-loading">角色加载失败。请刷新后重试。</div>
    ) : (
      this.props.children
    );
  }
}
type Job = {
  id: string;
  status: string;
  progress?: number;
  error?: string | null;
};
async function responseError(response: Response) {
  const data = await response.json().catch(() => null);
  return data?.error?.message || "请求失败，请手动重试。";
}
export default function Lab() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [actor, setActor] = useState(0),
    [eye, setEye] = useState(0),
    [face, setFace] = useState(0),
    [outfit, setOutfit] = useState("Casual"),
    [animation, setAnimation] = useState("Idle");
  const [capabilities, setCapabilities] = useState<ActorCapabilities | null>(
    null,
  );
  const [portrait, setPortrait] = useState<string | null>(null),
    [portraitVersion, setPortraitVersion] = useState(""),
    [capturedVersion, setCapturedVersion] = useState("");
  const capture = useRef<(() => string) | null>(null);
  const register = useCallback((fn: () => string) => {
    capture.current = fn;
  }, []);
  const inspect = useCallback(
    (value: ActorCapabilities) => setCapabilities(value),
    [],
  );
  const [text, setText] = useState("I didn't do it."),
    [emotion, setEmotion] = useState("fear");
  const [audio, setAudio] = useState<string | null>(null),
    [speechBusy, setSpeechBusy] = useState(false);
  const [reference, setReference] = useState("official"),
    [job, setJob] = useState<Job | null>(null),
    [videoId, setVideoId] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [unknown, setUnknown] = useState(false),
    [polling, setPolling] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null),
    busy = useRef(false);
  const version = actors[actor].id + ":" + eye + ":" + face + ":" + outfit;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void fetch("/api/diagnostics")
      .then((r) => r.json())
      .then((v) => setConfigured(v.configured))
      .catch(() => setConfigured(false));
    setVideoId(localStorage.getItem("director.lastVideoId") || "");
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      if (audio) URL.revokeObjectURL(audio);
    },
    [audio],
  );
  useEffect(() => {
    if (portrait) {
      setPortraitVersion(
        version === capturedVersion
          ? "已同步当前外形与服装"
          : "外形已变化，请重新截取",
      );
    }
  }, [version, capturedVersion, portrait]);
  async function speak() {
    setNotice("");
    setSpeechBusy(true);
    try {
      const response = await fetch("/api/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, emotion }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const url = URL.createObjectURL(await response.blob());
      setAudio(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "音频生成失败。");
    } finally {
      setSpeechBusy(false);
    }
  }
  async function create() {
    if (busy.current || unknown) return;
    busy.current = true;
    setAvatarBusy(true);
    setNotice("");
    try {
      if (reference === "capture" && (!portrait || version !== capturedVersion))
        throw new Error("请先截取当前外形的人像。");
      const response = await fetch("/api/avatar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ref_image:
            reference === "official"
              ? "https://docs.boson.ai/public/avatar/sample.jpg"
              : portrait,
          input_tts: { text, emotion },
          size: "640x640",
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        if (data.error?.code === "SUBMISSION_UNKNOWN") setUnknown(true);
        throw new Error(data.error?.message || "视频提交失败。");
      }
      const result = await response.json();
      setJob(result);
      setVideoId(result.id);
      localStorage.setItem("director.lastVideoId", result.id);
      setPolling(true);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "提交结果未知，请勿重复生成。",
      );
      if (error instanceof TypeError) setUnknown(true);
    } finally {
      busy.current = false;
      setAvatarBusy(false);
    }
  }
  const refresh = useCallback(async (id: string) => {
    if (!/^video_[a-zA-Z0-9_-]{1,120}$/.test(id))
      throw new Error("请输入有效的 video_ ID。");
    const response = await fetch("/api/avatar/" + encodeURIComponent(id));
    if (!response.ok) throw new Error(await responseError(response));
    const result = await response.json();
    if (mounted.current) {
      setJob(result);
      if (result.status === "failed" || result.status === "completed")
        setPolling(false);
    }
    return result;
  }, []);
  useEffect(() => {
    if (!polling || !job) return;
    let cancelled = false;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      try {
        const result = await refresh(job.id);
        if (cancelled) return;
        if (["completed", "failed"].includes(result.status)) return;
        if (Date.now() - started > 600000) {
          setNotice("仍在等待生成。已停止自动查询，可稍后用 ID 继续查询。");
          setPolling(false);
          return;
        }
        timer = setTimeout(poll, 5000);
      } catch (error) {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : "查询失败。");
          setPolling(false);
        }
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [polling, job?.id, refresh]);
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">D</span>DIRECTOR
          <span className="brand-sub"> / STUDIO</span>
        </a>
        <div className="stage-label">
          STAGE 01 <span>CAPABILITY LAB</span>
        </div>
        <span className="version">LOCAL BUILD · 0.1</span>
      </header>
      <div className="intro">
        <div>
          <p className="eyebrow">THE FIRST FRAME STARTS HERE</p>
          <h1>让角色，先活起来。</h1>
          <p className="intro-copy">
            验证可编辑角色与 Boson 声画能力，为你的第一个镜头做好准备。
          </p>
        </div>
        <div className="provider-status">
          <span className={configured ? "dot online" : "dot"} />
          {configured === null
            ? "检查配置…"
            : configured
              ? "Boson 已配置"
              : "Boson 未配置"}
          <small>配置状态 ≠ 真实接口验收通过</small>
        </div>
      </div>
      <div className="workspace">
        <section className="panel asset-panel">
          <div className="section-title">
            <span>01 / ACTOR ASSET</span>
            <span className="badge">ORIGINAL · CC0</span>
          </div>
          <div className="actor-tabs">
            {actors.map((item, i) => (
              <button
                key={item.id}
                className={actor === i ? "actor-tab selected" : "actor-tab"}
                onClick={() => {
                  if (i !== actor) {
                    setActor(i);
                    setCapabilities(null);
                  }
                }}
              >
                {item.name}
                <small>{item.description}</small>
              </button>
            ))}
          </div>
          <div className="actor-stage" data-testid="actor-stage">
            <AssetBoundary key={actors[actor].id}>
              <ActorView
                url={actors[actor].url}
                faceWidth={face}
                eyeSize={eye}
                outfit={outfit}
                animation={animation}
                onInspect={inspect}
                register={register}
              />
            </AssetBoundary>
            <span className="stage-caption">FRONT VIEW / ASSET INSPECTION</span>
          </div>
          <div className="asset-controls">
            <label>
              眼睛大小 <output>{eye.toFixed(2)}</output>
              <input
                aria-label="眼睛大小"
                type="range"
                min="0"
                max="1"
                step=".01"
                value={eye}
                onChange={(e) => setEye(Number(e.target.value))}
              />
            </label>
            <label>
              脸部宽度 <output>{face.toFixed(2)}</output>
              <input
                aria-label="脸部宽度"
                type="range"
                min="0"
                max="1"
                step=".01"
                value={face}
                onChange={(e) => setFace(Number(e.target.value))}
              />
            </label>
            <label>
              服装
              <select
                aria-label="服装"
                value={outfit}
                onChange={(e) => setOutfit(e.target.value)}
              >
                <option value="Casual">日常针织</option>
                <option value="Suit">黑色西装</option>
              </select>
            </label>
            <label>
              动作
              <select
                aria-label="动作"
                value={animation}
                onChange={(e) => setAnimation(e.target.value)}
              >
                <option value="Idle">Idle · 呼吸待机</option>
                <option value="Wave">Wave · 挥手</option>
              </select>
            </label>
          </div>
          <div className="asset-footer">
            <div data-testid="capabilities">
              {capabilities ? (
                <>
                  <strong>
                    {capabilities.meshes} meshes · {capabilities.bones.length}{" "}
                    bones
                  </strong>
                  <small>
                    {capabilities.morphs.join(" / ")} ·{" "}
                    {capabilities.animations.join(" / ")}
                  </small>
                </>
              ) : (
                <small>正在读取实际 GLB 能力…</small>
              )}
            </div>
            <button
              className="secondary"
              disabled={!capabilities}
              onClick={() => {
                if (capture.current) {
                  setPortrait(capture.current());
                  setCapturedVersion(version);
                }
              }}
            >
              截取角色人像
            </button>
          </div>
        </section>
        <div className="right-column">
          <RealtimePanel />
          <section className="panel">
            <div className="section-title">
              <span>03 / PERFORMANCE</span>
              <span className="badge">LIVE API</span>
            </div>
            <h2>给一句台词，一种情绪。</h2>
            <label>
              台词
              <textarea
                aria-label="台词"
                value={text}
                maxLength={300}
                onChange={(e) => setText(e.target.value)}
                rows={2}
              />
            </label>
            <div className="emotion-row">
              {[
                ["neutral", "平静"],
                ["fear", "恐惧"],
                ["anger", "愤怒"],
              ].map(([value, label]) => (
                <button
                  aria-pressed={emotion === value}
                  key={value}
                  className={emotion === value ? "chip selected" : "chip"}
                  onClick={() => setEmotion(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="performance-row">
              <button onClick={speak} disabled={speechBusy || !text.trim()}>
                {speechBusy ? "生成音频…" : "试听 TTS 3"}
              </button>
              <span className="muted small">默认声音 · 最多 300 字</span>
            </div>
            {audio && (
              <audio
                ref={audioRef}
                aria-label="生成的台词音频"
                controls
                src={audio}
              />
            )}
            <div className="divider" />
            <label>
              Avatar 参考人像
              <select
                aria-label="Avatar 参考人像"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              >
                <option value="official">Boson 官方示例（验证协议）</option>
                <option value="capture">当前角色截图（验证外观）</option>
              </select>
            </label>
            {reference === "official" ? (
              <p className="muted small">
                官方示例仅用于接口诊断，与左侧角色无关联。
              </p>
            ) : (
              <div className="portrait-row">
                {portrait ? (
                  <img
                    src={portrait}
                    alt="当前角色参考人像"
                    width={80}
                    height={80}
                  />
                ) : (
                  <div className="portrait-empty">未截取</div>
                )}
                <span className="muted small">
                  {portraitVersion || "先点击「截取角色人像」"}
                  <br />
                  风格化角色的生成质量需真实验证。
                </span>
              </div>
            )}
            <button
              className="wide"
              onClick={create}
              disabled={avatarBusy || unknown || polling || !text.trim()}
            >
              {avatarBusy
                ? "正在提交…"
                : unknown
                  ? "结果未知 · 请检查后再生成"
                  : polling
                    ? "正在等待视频…"
                    : "生成 Avatar 测试视频"}
            </button>
            <p className="muted small">
              会产生真实 API 调用；不会自动重试生成请求。
            </p>
            <div className="restore-row">
              <input
                aria-label="视频任务 ID"
                placeholder="video_… · 刷新后可恢复查询"
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
              />
              <button
                className="secondary"
                onClick={() => {
                  setNotice("");
                  void refresh(videoId).catch((e) => setNotice(e.message));
                }}
              >
                查询
              </button>
            </div>
            {job && (
              <div className="job-state" data-testid="job-state">
                <span>{job.status}</span>
                <code>{job.id}</code>
                {job.error && <p>{job.error}</p>}
              </div>
            )}
            {job?.status === "completed" && (
              <video
                key={job.id}
                aria-label="Avatar 生成视频"
                controls
                playsInline
                src={"/api/avatar/" + job.id + "/content"}
              />
            )}
            {notice && (
              <div role="alert" className="notice">
                {notice}
              </div>
            )}
          </section>
        </div>
      </div>
      <footer>
        FIRST STAGE / VERIFY BEFORE DIRECTING
        <span>
          3D 资产可编辑 · Avatar 输出为二维视频 · 不会自动同步镜头与身体动画
        </span>
      </footer>
    </main>
  );
}
