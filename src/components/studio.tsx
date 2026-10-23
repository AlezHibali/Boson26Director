"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import { catalog, type Command, type SceneState } from "@/domain/scene";
import { createAssetLibrary } from "@/studio/assets";
import { createSceneController } from "@/studio/controller";
import type { RenderInfo } from "@/studio/stage-view";
import "@/app/studio.css";
const StageView = dynamic(() => import("@/studio/stage-view"), {
  ssr: false,
  loading: () => <div className="studio-canvas-loading">正在准备三维片场…</div>,
});
function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  unit = "",
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="studio-slider">
      {label}
      <output>
        {Number(value.toFixed(2))}
        {unit}
      </output>
      <input
        type="range"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
const cameraPresets: Record<string, SceneState["camera"]> = {
  全景: { distance: 5.7, azimuth: 0, height: 2.3, fov: 48, targetY: 1.1 },
  中景: { distance: 4.4, azimuth: 0, height: 1.9, fov: 38, targetY: 1.35 },
  特写: { distance: 2.6, azimuth: 0, height: 1.95, fov: 30, targetY: 1.72 },
};
export default function Studio() {
  const [{ library, controller }] = useState(() => {
    const library = createAssetLibrary();
    return {
      library,
      controller: createSceneController((asset) => library.load(asset)),
    };
  });
  const state = useStore(controller.store);
  const { scene, load, lastResult, log } = state;
  const { actor, camera, lights, performance } = scene;
  const [telemetry, setTelemetry] = useState<RenderInfo | null>(null);
  const onTelemetry = useCallback((info: RenderInfo) => setTelemetry(info), []);
  const [commandText, setCommandText] = useState(
    '{"type":"rotate_actor","actorId":"actor-1","mode":"relative","degrees":45}',
  );
  const [parseError, setParseError] = useState("");
  const asset = catalog[actor.presetId];
  const send = (command: Command) => {
    setParseError("");
    void controller.dispatch(command);
  };
  useEffect(() => {
    controller.activate();
    void controller.initialize();
    return () => controller.dispose();
  }, [controller]);
  function runJson() {
    try {
      const value: unknown = JSON.parse(commandText);
      setParseError("");
      void controller.dispatch(value);
    } catch {
      setParseError("JSON 格式无效，未修改场景。");
    }
  }
  return (
    <main className="studio">
      <header className="studio-header">
        <Link href="/" className="brand">
          <span className="brand-mark">D</span>DIRECTOR
          <span className="brand-sub"> / STUDIO</span>
        </Link>
        <span className="studio-mode">
          STAGE 02 <b>MANUAL DIRECTION</b>
        </span>
        <nav>
          <Link href="/lab">能力验证 / Lab ↗</Link>
          <button
            className="secondary"
            onClick={() => send({ type: "reset_scene" })}
          >
            重置片场
          </button>
        </nav>
      </header>
      <div className="studio-heading">
        <div>
          <p className="eyebrow">ONE ROOM. EVERY DECISION IS YOURS.</p>
          <h1>你的片场，准备就绪。</h1>
          <p>从演员到最后一道光，把脑海里的镜头摆出来。</p>
        </div>
        <div className="studio-project">
          <span className="dot online" />
          INTERROGATION ROOM <small>01 ACTOR / 01 SET</small>
        </div>
      </div>
      <div className="studio-layout">
        <aside className="studio-card studio-actor-panel">
          <div className="section-title">
            <span>01 / CAST & CHARACTER</span>
          </div>
          <h2>演员</h2>
          <div className="studio-actor-list">
            {Object.values(catalog).map((item) => (
              <button
                key={item.id}
                aria-pressed={actor.presetId === item.id}
                className={
                  actor.presetId === item.id
                    ? "studio-actor-choice selected"
                    : "studio-actor-choice"
                }
                onClick={() =>
                  send({
                    type: "select_actor",
                    actorId: actor.id,
                    presetId: item.id,
                  })
                }
              >
                <span className={"actor-avatar " + item.id}>
                  {item.name[0]}
                </span>
                <span>
                  {item.name}
                  <small>
                    {item.id === "mira"
                      ? "暖色肤调 · 青绿针织"
                      : "暖棕肤调 · 烟紫针织"}
                  </small>
                </span>
                <span className="actor-check">
                  {actor.presetId === item.id ? "●" : "○"}
                </span>
              </button>
            ))}
          </div>
          <div
            className={"studio-load " + load.status}
            data-testid="asset-load-status"
            role="status"
          >
            {load.status === "loading"
              ? "正在加载 " +
                (catalog[load.target]?.name || load.target) +
                "，保留当前片场…"
              : load.status === "error"
                ? load.error
                : "角色资产就绪"}
            {load.status === "error" && (
              <button
                className="secondary"
                onClick={() => void controller.retry()}
              >
                重试加载
              </button>
            )}
          </div>
          <div className="studio-divider" />
          <h3>外形</h3>
          {Object.entries(asset.morphs).map(([name, range]) => (
            <Slider
              key={name}
              label={name === "EyeSize" ? "眼睛大小" : "脸部宽度"}
              min={range.min}
              max={range.max}
              value={actor.appearance[name] ?? 0}
              onChange={(value) =>
                send({
                  type: "set_appearance",
                  actorId: actor.id,
                  morph: name,
                  value,
                })
              }
            />
          ))}
          <label className="studio-field">
            服装
            <select
              aria-label="服装"
              value={actor.outfit}
              onChange={(event) =>
                send({
                  type: "set_outfit",
                  actorId: actor.id,
                  outfit: event.target.value,
                })
              }
            >
              {asset.outfits.map((outfit) => (
                <option value={outfit} key={outfit}>
                  {outfit === "Suit" ? "黑色西装" : "日常针织"}
                </option>
              ))}
            </select>
          </label>
          <div className="studio-divider" />
          <h3>
            姿态与动作{" "}
            <span className="studio-animation" data-testid="animation-status">
              {actor.animation.name}
            </span>
          </h3>
          <Slider
            label="演员朝向"
            value={actor.rotationY}
            min={-180}
            max={180}
            step={1}
            unit="°"
            onChange={(degrees) =>
              send({
                type: "rotate_actor",
                actorId: actor.id,
                mode: "absolute",
                degrees,
              })
            }
          />
          <div className="studio-button-pair">
            <button
              className="secondary"
              onClick={() =>
                send({
                  type: "rotate_actor",
                  actorId: actor.id,
                  mode: "relative",
                  degrees: -45,
                })
              }
            >
              ← 左转 45°
            </button>
            <button
              className="secondary"
              onClick={() =>
                send({
                  type: "rotate_actor",
                  actorId: actor.id,
                  mode: "relative",
                  degrees: 45,
                })
              }
            >
              右转 45° →
            </button>
          </div>
          <div className="studio-button-pair">
            <button
              onClick={() =>
                send({
                  type: "play_animation",
                  actorId: actor.id,
                  animation: "Wave",
                })
              }
            >
              挥手 / Wave
            </button>
            <button
              className="secondary"
              onClick={() =>
                send({
                  type: "play_animation",
                  actorId: actor.id,
                  animation: "Idle",
                })
              }
            >
              回到 Idle
            </button>
          </div>
          <details className="studio-position">
            <summary>站位调整</summary>
            <Slider
              label="横向位置"
              value={actor.position.x}
              min={-0.75}
              max={0.75}
              unit=" m"
              onChange={(x) =>
                send({
                  type: "set_position",
                  actorId: actor.id,
                  x,
                  z: actor.position.z,
                })
              }
            />
            <Slider
              label="前后位置"
              value={actor.position.z}
              min={-0.8}
              max={0}
              unit=" m"
              onChange={(z) =>
                send({
                  type: "set_position",
                  actorId: actor.id,
                  x: actor.position.x,
                  z,
                })
              }
            />
          </details>
        </aside>
        <section className="studio-center">
          <div className="studio-viewport-card">
            <div className="studio-view-toolbar">
              <span>
                <span className="dot online" />
                LIVE SET{" "}
                <span className="studio-take-label">INTERVIEW / 01</span>
              </span>
              <span data-testid="fps-label">
                {telemetry ? telemetry.fps + " FPS" : "渲染启动中"} · REV{" "}
                {scene.revision}
              </span>
            </div>
            <div className="studio-viewport" data-testid="stage-viewport">
              <StageView
                controller={controller}
                library={library}
                onTelemetry={onTelemetry}
              />
              <div className="studio-frame-corners" />
              <div className="studio-frame-label">
                <span>CAM A</span>
                <span>
                  {camera.distance.toFixed(1)}m / {camera.fov}° FOV
                </span>
              </div>
            </div>
            <div className="studio-view-footer">
              <span data-testid="active-actor">
                {asset.name} / {actor.id}
              </span>
              <span>
                目标机位 · {camera.azimuth}° / {camera.height.toFixed(1)}m
              </span>
            </div>
          </div>
          <div
            className="studio-feedback"
            data-testid="command-feedback"
            role={
              (lastResult && !lastResult.ok) || parseError ? "alert" : "status"
            }
          >
            {parseError ? (
              parseError
            ) : lastResult ? (
              lastResult.ok ? (
                <>
                  <span className="studio-feedback-dot" />
                  已更新片场 · REV {lastResult.revision}
                  {lastResult.notices.length > 0 && (
                    <span>{lastResult.notices.join(" ")}</span>
                  )}
                </>
              ) : (
                lastResult.message
              )
            ) : (
              "准备好了。选择演员，或先摆一个机位。"
            )}
            <span>
              {load.status === "loading" ? "资产加载中" : "所有操作即时生效"}
            </span>
          </div>
          <section className="studio-card studio-script">
            <div className="section-title">
              <span>04 / SCRIPT & PERFORMANCE NOTES</span>
              <span>场景参数</span>
            </div>
            <div className="studio-script-grid">
              <label>
                台词
                <textarea
                  aria-label="台词"
                  value={performance.dialogue}
                  maxLength={300}
                  rows={2}
                  onChange={(event) =>
                    send({ type: "set_dialogue", text: event.target.value })
                  }
                />
              </label>
              <div>
                <label>表演情绪</label>
                <div className="studio-emotions">
                  {[
                    ["neutral", "平静"],
                    ["fear", "恐惧"],
                    ["anger", "愤怒"],
                  ].map(([emotion, label]) => (
                    <button
                      className={
                        performance.emotion === emotion
                          ? "chip selected"
                          : "chip"
                      }
                      aria-pressed={performance.emotion === emotion}
                      key={emotion}
                      onClick={() =>
                        send({
                          type: "set_emotion",
                          emotion:
                            emotion as SceneState["performance"]["emotion"],
                        })
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <small>切换演员时保留台词与情绪。</small>
              </div>
            </div>
          </section>
          <details className="studio-diagnostics">
            <summary>开发诊断 · 场景状态、渲染状态与命令</summary>
            <div className="studio-diagnostic-grid">
              <div>
                <h3>SceneState</h3>
                <pre data-testid="scene-state">
                  {JSON.stringify(scene, null, 2)}
                </pre>
              </div>
              <div>
                <h3>实际渲染采样</h3>
                <pre data-testid="render-state">
                  {JSON.stringify(telemetry, null, 2)}
                </pre>
              </div>
            </div>
            <label>
              导演命令 JSON
              <textarea
                aria-label="导演命令 JSON"
                value={commandText}
                onChange={(event) => setCommandText(event.target.value)}
                rows={4}
              />
            </label>
            <button className="secondary" onClick={runJson}>
              执行命令
            </button>
            <h3>最近操作</h3>
            <ol className="studio-command-log">
              {log.map((entry, index) => (
                <li key={index}>
                  <span>
                    {entry.ok ? "OK" : "ERR"} / REV {entry.revision}
                  </span>
                  {entry.message}
                </li>
              ))}
            </ol>
          </details>
        </section>
        <aside className="studio-card studio-camera-panel">
          <div className="section-title">
            <span>02 / CAMERA</span>
            <span className="studio-unit">WORLD / m</span>
          </div>
          <h2>找到你的机位。</h2>
          <div className="studio-presets">
            {Object.keys(cameraPresets).map((name) => (
              <button
                className="secondary"
                key={name}
                onClick={() =>
                  send({ type: "set_camera", camera: cameraPresets[name] })
                }
              >
                {name}
              </button>
            ))}
          </div>
          <Slider
            label="摄影机距离"
            value={camera.distance}
            min={2.2}
            max={6}
            step={0.1}
            unit=" m"
            onChange={(distance) =>
              send({ type: "set_camera", camera: { distance } })
            }
          />
          <div className="studio-button-pair">
            <button
              className="secondary"
              onClick={() => send({ type: "dolly", amount: 0.4 })}
            >
              推近 +
            </button>
            <button
              className="secondary"
              onClick={() => send({ type: "dolly", amount: -0.4 })}
            >
              拉远 −
            </button>
          </div>
          <Slider
            label="环绕角度"
            value={camera.azimuth}
            min={-60}
            max={60}
            step={1}
            unit="°"
            onChange={(azimuth) =>
              send({ type: "set_camera", camera: { azimuth } })
            }
          />
          <div className="studio-button-pair">
            <button
              className="secondary"
              onClick={() => send({ type: "orbit", degrees: -15 })}
            >
              ← 环绕 15°
            </button>
            <button
              className="secondary"
              onClick={() => send({ type: "orbit", degrees: 15 })}
            >
              环绕 15° →
            </button>
          </div>
          <Slider
            label="摄影机高度"
            value={camera.height}
            min={0.8}
            max={3}
            step={0.05}
            unit=" m"
            onChange={(height) =>
              send({ type: "set_camera", camera: { height } })
            }
          />
          <Slider
            label="镜头视角"
            value={camera.fov}
            min={25}
            max={65}
            step={1}
            unit="°"
            onChange={(fov) => send({ type: "set_camera", camera: { fov } })}
          />
          <div className="studio-divider" />
          <div className="section-title">
            <span>03 / LIGHTING</span>
          </div>
          <h3>用光，制造气氛。</h3>
          <Slider
            label="主光"
            value={lights.key}
            min={0}
            max={6}
            step={0.1}
            onChange={(key) => send({ type: "set_lighting", lights: { key } })}
          />
          <Slider
            label="补光"
            value={lights.fill}
            min={0}
            max={4}
            step={0.1}
            onChange={(fill) =>
              send({ type: "set_lighting", lights: { fill } })
            }
          />
          <Slider
            label="轮廓光"
            value={lights.rim}
            min={0}
            max={6}
            step={0.1}
            onChange={(rim) => send({ type: "set_lighting", lights: { rim } })}
          />
          <Slider
            label="环境光"
            value={lights.ambient}
            min={0.05}
            max={1.5}
            step={0.05}
            onChange={(ambient) =>
              send({ type: "set_lighting", lights: { ambient } })
            }
          />
          <label className="studio-field">
            主光色调
            <select
              aria-label="主光色调"
              value={lights.temperature}
              onChange={(event) =>
                send({
                  type: "set_lighting",
                  lights: {
                    temperature: event.target
                      .value as SceneState["lights"]["temperature"],
                  },
                })
              }
            >
              <option value="warm">暖色</option>
              <option value="neutral">中性</option>
              <option value="cool">冷色</option>
            </select>
          </label>
          <div className="studio-button-pair">
            <button
              className="secondary"
              onClick={() =>
                send({
                  type: "set_lighting",
                  lights: {
                    key: lights.key * 0.65,
                    fill: lights.fill * 0.65,
                    rim: lights.rim * 0.8,
                    ambient: Math.max(0.05, lights.ambient * 0.65),
                  },
                })
              }
            >
              调暗灯光
            </button>
            <button
              className="secondary"
              onClick={() =>
                send({
                  type: "set_lighting",
                  lights: {
                    key: 4.5,
                    fill: 0.25,
                    rim: 2,
                    ambient: 0.2,
                    temperature: "cool",
                  },
                })
              }
            >
              审讯氛围
            </button>
          </div>
        </aside>
      </div>
      <footer className="studio-footer">
        <span>SCENE 01 / THE INTERVIEW</span>
        <span>角色、镜头、灯光与表演参数均可独立调整</span>
        <span>
          MANUAL STAGING · {scene.revision.toString().padStart(3, "0")}
        </span>
      </footer>
    </main>
  );
}
