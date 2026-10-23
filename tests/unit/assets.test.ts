import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
describe("actual exported GLB assets", () => {
  it.each(["mira", "ren"])(
    "%s has deforming geometry, usable skin, clothing and keyed animations",
    async (id) => {
      const bytes = await readFile("public/actors/" + id + ".glb");
      const gltf = await new GLTFLoader().parseAsync(
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ),
        "",
      );
      let rigs = 0,
        changedVertices = 0;
      const morphs = new Set<string>();
      gltf.scene.traverse((o) => {
        if (o instanceof THREE.SkinnedMesh) {
          rigs++;
          expect(o.skeleton.bones.length).toBeGreaterThanOrEqual(7);
          expect(o.geometry.getAttribute("skinWeight")).toBeTruthy();
        }
        if (o instanceof THREE.Mesh && o.morphTargetDictionary) {
          Object.keys(o.morphTargetDictionary).forEach((name) =>
            morphs.add(name),
          );
          const target = o.geometry.morphAttributes.position?.[0];
          const base = o.geometry.attributes.position;
          if (target)
            for (let i = 0; i < target.count; i++) {
              if (
                o.geometry.morphTargetsRelative
                  ? Math.abs(target.getX(i)) + Math.abs(target.getY(i)) > 1e-6
                  : Math.abs(target.getX(i) - base.getX(i)) +
                      Math.abs(target.getY(i) - base.getY(i)) >
                    1e-6
              )
                changedVertices++;
            }
        }
      });
      expect(rigs).toBeGreaterThan(0);
      expect([...morphs]).toEqual(
        expect.arrayContaining(["EyeSize", "FaceWidth"]),
      );
      expect(changedVertices).toBeGreaterThan(100);
      expect(gltf.scene.getObjectByName("Outfit_Casual")).toBeTruthy();
      expect(gltf.scene.getObjectByName("Outfit_Suit")).toBeTruthy();
      expect(gltf.animations.map((c) => c.name)).toEqual(["Idle", "Wave"]);
      const shoulder = gltf.scene.getObjectByName("RightShoulder")!;
      const before = shoulder.quaternion.clone();
      const mixer = new THREE.AnimationMixer(gltf.scene);
      mixer.clipAction(gltf.animations[1]).play();
      mixer.update(0.7);
      expect(before.angleTo(shoulder.quaternion)).toBeGreaterThan(0.5);
      const manifest = JSON.parse(
        await readFile("public/actors/manifest.json", "utf8"),
      );
      expect(manifest.find((v: { id: string }) => v.id === id).sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    },
  );
});
