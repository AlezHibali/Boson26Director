"use client";
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import type { ActorCapabilities } from "@/lib/actors";

function Model({
  url,
  faceWidth,
  eyeSize,
  outfit,
  animation,
  onInspect,
}: {
  url: string;
  faceWidth: number;
  eyeSize: number;
  outfit: string;
  animation: string;
  onInspect: (v: ActorCapabilities) => void;
}) {
  const gltf = useLoader(GLTFLoader, url);
  const scene = useMemo(() => clone(gltf.scene), [gltf.scene]);
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene]);
  useEffect(() => {
    const found: ActorCapabilities = {
      meshes: 0,
      bones: [],
      morphs: [],
      outfits: [],
      animations: gltf.animations.map((c) => c.name),
    };
    scene.traverse((o) => {
      if (o instanceof THREE.Bone) found.bones.push(o.name);
      if (o instanceof THREE.Mesh) {
        found.meshes++;
        found.morphs.push(...Object.keys(o.morphTargetDictionary || {}));
      }
      if (o.name.startsWith("Outfit_"))
        found.outfits.push(o.name.replace("Outfit_", ""));
    });
    found.morphs = [...new Set(found.morphs)];
    onInspect(found);
    return () => {
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    };
  }, [scene, gltf.animations, mixer, onInspect]);
  useEffect(() => {
    scene.traverse((o) => {
      if (
        o instanceof THREE.Mesh &&
        o.morphTargetInfluences &&
        o.morphTargetDictionary
      ) {
        for (const [name, index] of Object.entries(o.morphTargetDictionary)) {
          o.morphTargetInfluences[index] =
            name === "EyeSize" ? eyeSize : name === "FaceWidth" ? faceWidth : 0;
        }
      }
      if (o.name.startsWith("Outfit_"))
        o.visible = o.name === "Outfit_" + outfit;
    });
  }, [scene, eyeSize, faceWidth, outfit]);
  useEffect(() => {
    mixer.stopAllAction();
    const clip = gltf.animations.find((c) => c.name === animation);
    if (clip) mixer.clipAction(clip).reset().play();
  }, [animation, gltf.animations, mixer]);
  useFrame((_, delta) => mixer.update(Math.min(delta, 0.05)));
  return <primitive object={scene} />;
}
function Capture({ register }: { register: (fn: () => string) => void }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    register(() => {
      const size = gl.getSize(new THREE.Vector2());
      const target = new THREE.WebGLRenderTarget(640, 640, {
        format: THREE.RGBAFormat,
      });
      target.texture.colorSpace = THREE.SRGBColorSpace;
      const portraitCamera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
      portraitCamera.position.set(0, 1.79, 2.65);
      portraitCamera.lookAt(0, 1.72, 0);
      const before = gl.getRenderTarget();
      try {
        gl.setRenderTarget(target);
        gl.render(scene, portraitCamera);
        const pixels = new Uint8Array(640 * 640 * 4);
        gl.readRenderTargetPixels(target, 0, 0, 640, 640, pixels);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 640;
        const context = canvas.getContext("2d")!;
        const image = context.createImageData(640, 640);
        for (let y = 0; y < 640; y++)
          image.data.set(
            pixels.subarray((639 - y) * 640 * 4, (640 - y) * 640 * 4),
            y * 640 * 4,
          );
        context.putImageData(image, 0, 0);
        return canvas.toDataURL("image/png");
      } finally {
        gl.setRenderTarget(before);
        target.dispose();
        gl.setSize(size.x, size.y, false);
        gl.render(scene, camera);
      }
    });
  }, [gl, scene, camera, register]);
  return null;
}
export type ActorViewProps = {
  url: string;
  faceWidth: number;
  eyeSize: number;
  outfit: string;
  animation: string;
  onInspect: (v: ActorCapabilities) => void;
  register: (fn: () => string) => void;
};
export default function ActorView(props: ActorViewProps) {
  return (
    <Canvas
      aria-label="3D actor preview"
      camera={{ position: [0, 1.43, 4.2], fov: 35 }}
      dpr={[1, 1.5]}
      gl={{ antialias: true }}
      onCreated={({ camera }) => camera.lookAt(0, 1.13, 0)}
    >
      <color attach="background" args={["#e8e4dc"]} />
      <ambientLight intensity={1.5} />
      <directionalLight position={[2, 4, 4]} intensity={3} />
      <directionalLight position={[-3, 2, 1]} intensity={1} />
      <Suspense fallback={null}>
        <Model {...props} />
      </Suspense>
      <Capture register={props.register} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <circleGeometry args={[1.6, 64]} />
        <meshStandardMaterial color="#ded8ce" />
      </mesh>
    </Canvas>
  );
}
