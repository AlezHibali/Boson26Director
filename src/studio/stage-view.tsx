"use client";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import type { SceneState } from "@/domain/scene";
import type { SceneController } from "./controller";
import type { createAssetLibrary } from "./assets";
import { createActorPlayer } from "./actor-player";
export type RenderInfo = {
  fps: number;
  renderer: string;
  drawCalls: number;
  actors: number;
  loadedPreset: string | null;
  rotationY: number;
  animation: string;
  camera: { x: number; y: number; z: number; fov: number };
  morphs: Record<string, number>;
};
type Library = ReturnType<typeof createAssetLibrary>;
type Props = {
  controller: SceneController;
  library: Library;
  onTelemetry: (info: RenderInfo) => void;
};

function Box({
  position,
  size,
  color,
  ...rest
}: {
  position: [number, number, number];
  size: [number, number, number];
  color: string;
  rotation?: [number, number, number];
}) {
  return (
    <mesh position={position} {...rest}>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  );
}
function Chair({
  position,
  rotation = 0,
}: {
  position: [number, number, number];
  rotation?: number;
}) {
  return (
    <group position={position} rotation={[0, rotation, 0]}>
      <Box position={[0, 0.48, 0]} size={[0.57, 0.12, 0.58]} color="#444f51" />
      <Box
        position={[0, 0.91, -0.24]}
        size={[0.55, 0.77, 0.1]}
        color="#424e51"
      />
      {[-1, 1].flatMap((x) =>
        [-1, 1].map((z) => (
          <Box
            key={x + ":" + z}
            position={[x * 0.23, 0.22, z * 0.23]}
            size={[0.045, 0.45, 0.045]}
            color="#242f34"
          />
        )),
      )}
    </group>
  );
}
function Placard() {
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 150;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#263638";
    context.fillRect(0, 0, 640, 150);
    context.fillStyle = "#d4d2bd";
    context.font = "500 62px Segoe UI";
    context.textAlign = "center";
    context.fillText("INTERVIEW  /  01", 320, 95);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <mesh position={[2.8, 2.8, -3.38]}>
      <planeGeometry args={[1.6, 0.375]} />
      <meshBasicMaterial map={texture} />
    </mesh>
  );
}
function Room() {
  return (
    <group name="InterrogationRoom">
      <Box position={[0, -0.09, 0]} size={[11, 0.16, 12]} color="#394548" />
      <Box position={[0, 2.1, -3.55]} size={[11, 4.2, 0.18]} color="#536362" />
      <Box position={[-5.5, 2.1, 0]} size={[0.18, 4.2, 7]} color="#455654" />
      <Box position={[5.5, 2.1, 0]} size={[0.18, 4.2, 7]} color="#455654" />
      <Box
        position={[0, 0.12, -3.41]}
        size={[11, 0.18, 0.06]}
        color="#303d3f"
      />
      <Box
        position={[-2.4, 2.1, -3.41]}
        size={[2.9, 1.65, 0.08]}
        color="#26383d"
      />
      <Box
        position={[-2.4, 2.1, -3.35]}
        size={[2.65, 1.4, 0.03]}
        color="#162b33"
      />
      <Box
        position={[3.25, 1.35, -3.4]}
        size={[1.2, 2.65, 0.1]}
        color="#354443"
      />
      <mesh position={[3.68, 1.32, -3.3]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.035, 0.035, 0.18, 10]} />
        <meshStandardMaterial color="#aaa99e" metalness={0.6} roughness={0.3} />
      </mesh>
      {[0, 1, 2, 3].map((n) => (
        <Box
          key={n}
          position={[-4.6 + n * 2.8, 3.9, -3.42]}
          size={[0.025, 0.55, 0.04]}
          color="#657370"
        />
      ))}
      <Placard />
      <group name="InterviewTable">
        <Box
          position={[0, 0.86, 0.85]}
          size={[2.8, 0.12, 1.1]}
          color="#796853"
        />
        <Box
          position={[0, 0.78, 0.85]}
          size={[2.65, 0.09, 0.97]}
          color="#303b3e"
        />
        {[-1, 1].flatMap((x) =>
          [-1, 1].map((z) => (
            <Box
              key={x + ":" + z}
              position={[x * 1.12, 0.38, 0.85 + z * 0.38]}
              size={[0.07, 0.76, 0.07]}
              color="#253035"
            />
          )),
        )}
        <Box
          position={[0.58, 0.938, 0.8]}
          size={[0.42, 0.015, 0.3]}
          color="#c8c4ad"
        />
        <mesh position={[-0.8, 0.99, 0.72]}>
          <cylinderGeometry args={[0.055, 0.055, 0.16, 12]} />
          <meshStandardMaterial color="#d2d2bf" />
        </mesh>
      </group>
      <Chair position={[0, 0, -1.03]} />
      <Chair position={[-1.95, 0, 1.4]} rotation={Math.PI * 0.84} />
      <Box position={[0, 3.55, 0.1]} size={[1.2, 0.08, 0.44]} color="#283334" />
      <mesh position={[0, 3.5, 0.1]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[1.06, 0.34]} />
        <meshBasicMaterial color="#e4dab8" />
      </mesh>
      <Box
        position={[0, 3.9, 0.1]}
        size={[0.025, 0.6, 0.025]}
        color="#303b3f"
      />
    </group>
  );
}

function Actor({
  gltf,
  controller,
}: {
  gltf: GLTF;
  controller: SceneController;
}) {
  const actor = useStore(controller.store, (s) => s.scene.actor);
  const scene = useMemo(() => clone(gltf.scene), [gltf]);
  const player = useRef<ReturnType<typeof createActorPlayer> | null>(null);
  useEffect(() => {
    const active = createActorPlayer(scene, gltf.animations, (token) =>
      controller.finishAnimation(actor.presetId, token),
    );
    player.current = active;
    return () => {
      active.dispose();
      // Skeleton clones own their bone texture; geometry/materials remain cached.
      scene.traverse((node) => {
        if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose();
      });
      if (player.current === active) player.current = null;
    };
  }, [scene, gltf, controller, actor.presetId]);
  useEffect(() => {
    player.current?.play(actor.animation.name, actor.animation.token);
  }, [
    actor.animation.name,
    actor.animation.token,
    scene,
    gltf,
    controller,
    actor.presetId,
  ]);
  useEffect(() => {
    scene.traverse((object) => {
      if (
        object instanceof THREE.Mesh &&
        object.morphTargetDictionary &&
        object.morphTargetInfluences
      )
        for (const [name, index] of Object.entries(
          object.morphTargetDictionary,
        ))
          object.morphTargetInfluences[index] = actor.appearance[name] ?? 0;
      if (object.name.startsWith("Outfit_"))
        object.visible = object.name === "Outfit_" + actor.outfit;
    });
  }, [scene, actor.appearance, actor.outfit]);
  useFrame((_, delta) => player.current?.update(Math.min(delta, 0.1)));
  return (
    <group
      name="StageActor"
      position={[actor.position.x, actor.position.y, actor.position.z]}
      rotation={[0, THREE.MathUtils.degToRad(actor.rotationY), 0]}
      userData={{ presetId: actor.presetId, animation: actor.animation.name }}
    >
      <primitive object={scene} dispose={null} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, 0]}>
        <circleGeometry args={[0.37, 32]} />
        <meshBasicMaterial color="#1b272a" transparent opacity={0.3} />
      </mesh>
    </group>
  );
}
function Lights({ controller }: { controller: SceneController }) {
  const lights = useStore(controller.store, (s) => s.scene.lights);
  const warmth =
    lights.temperature === "warm"
      ? "#ffe3b9"
      : lights.temperature === "cool"
        ? "#c6deff"
        : "#ffffff";
  return (
    <>
      <ambientLight intensity={lights.ambient} />
      <directionalLight
        position={[2.5, 4, 3]}
        intensity={lights.key}
        color={warmth}
      />
      <directionalLight
        position={[-3, 2, 2]}
        intensity={lights.fill}
        color="#c5e3ed"
      />
      <directionalLight
        position={[1, 3, -3]}
        intensity={lights.rim}
        color="#9bcbce"
      />
    </>
  );
}
function cameraGoal(scene: SceneState) {
  const angle = THREE.MathUtils.degToRad(scene.camera.azimuth);
  return new THREE.Vector3(
    scene.actor.position.x + Math.sin(angle) * scene.camera.distance,
    scene.camera.height,
    scene.actor.position.z + Math.cos(angle) * scene.camera.distance,
  );
}
function CameraAndTelemetry({
  controller,
  onTelemetry,
}: Pick<Props, "controller" | "onTelemetry">) {
  const { camera, gl, scene: world } = useThree();
  const lookAt = useRef(new THREE.Vector3(0, 1.2, -0.45));
  const sample = useRef({ frames: 0, seconds: 0 });
  const renderer = useMemo(() => {
    const context = gl.getContext();
    const ext = context.getExtension("WEBGL_debug_renderer_info");
    return ext
      ? String(context.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(context.getParameter(context.RENDERER));
  }, [gl]);
  useFrame((_, delta) => {
    const state = controller.store.getState().scene;
    const alpha = 1 - Math.exp(-8 * Math.min(delta, 0.1));
    camera.position.lerp(cameraGoal(state), alpha);
    lookAt.current.lerp(
      new THREE.Vector3(
        state.actor.position.x,
        state.camera.targetY,
        state.actor.position.z,
      ),
      alpha,
    );
    camera.lookAt(lookAt.current);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = THREE.MathUtils.damp(
        camera.fov,
        state.camera.fov,
        8,
        Math.min(delta, 0.1),
      );
      camera.updateProjectionMatrix();
    }
    sample.current.frames++;
    sample.current.seconds += delta;
    if (sample.current.seconds >= 1) {
      let count = 0;
      let active: THREE.Object3D | undefined;
      world.traverse((node) => {
        if (node.name === "StageActor") {
          count++;
          active = node;
        }
      });
      const morphs: Record<string, number> = {};
      active?.traverse((node) => {
        if (
          node instanceof THREE.Mesh &&
          node.morphTargetDictionary &&
          node.morphTargetInfluences
        )
          for (const [name, index] of Object.entries(
            node.morphTargetDictionary,
          ))
            morphs[name] = node.morphTargetInfluences[index];
      });
      onTelemetry({
        fps: Math.round(sample.current.frames / sample.current.seconds),
        renderer,
        drawCalls: gl.info.render.calls,
        actors: count,
        loadedPreset: active?.userData.presetId || null,
        rotationY: active ? THREE.MathUtils.radToDeg(active.rotation.y) : 0,
        animation: active?.userData.animation || "none",
        camera: {
          x: Number(camera.position.x.toFixed(3)),
          y: Number(camera.position.y.toFixed(3)),
          z: Number(camera.position.z.toFixed(3)),
          fov:
            camera instanceof THREE.PerspectiveCamera
              ? Number(camera.fov.toFixed(3))
              : 0,
        },
        morphs,
      });
      sample.current = { frames: 0, seconds: 0 };
    }
  });
  return null;
}
function World({ controller, library, onTelemetry }: Props) {
  const state = useStore(controller.store);
  const gltf = library.get(state.scene.actor.presetId);
  return (
    <>
      <color attach="background" args={["#142026"]} />
      <fog attach="fog" args={["#142026", 10, 22]} />
      <Room />
      <Lights controller={controller} />
      {gltf && (
        <Actor
          key={state.scene.actor.presetId}
          gltf={gltf}
          controller={controller}
        />
      )}
      <CameraAndTelemetry controller={controller} onTelemetry={onTelemetry} />
    </>
  );
}
export default function StageView(props: Props) {
  return (
    <Canvas
      aria-label="审讯室三维片场"
      camera={{
        position: cameraGoal(props.controller.store.getState().scene).toArray(),
        fov: 40,
        near: 0.1,
        far: 40,
      }}
      dpr={1}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      onCreated={({ camera }) => camera.lookAt(0, 1.2, -0.45)}
    >
      <World {...props} />
    </Canvas>
  );
}
