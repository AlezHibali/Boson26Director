import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { catalog } from "../../src/domain/scene";
import { verifyAsset } from "../../src/studio/assets";
import { createActorPlayer } from "../../src/studio/actor-player";
it.each(["mira", "ren"])(
  "loaded %s matches its command capability manifest",
  async (id) => {
    const bytes = await readFile("public" + catalog[id].url);
    const gltf = await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "",
    );
    expect(() => verifyAsset(gltf, catalog[id])).not.toThrow();
    expect(() =>
      verifyAsset(gltf, {
        ...catalog[id],
        morphs: { Nonexistent: { min: 0, max: 1 } },
      }),
    ).toThrow();
  },
);
it("Wave plays once, restarts cleanly and reports only the current token", async () => {
  const bytes = await readFile("public/actors/mira.glb");
  const gltf = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
  const finished: number[] = [];
  const player = createActorPlayer(gltf.scene, gltf.animations, (token) =>
    finished.push(token),
  );
  player.play("Wave", 1);
  player.update(1);
  player.play("Wave", 2);
  player.update(1);
  expect(finished).toEqual([]);
  player.update(2);
  expect(finished).toEqual([2]);
  player.update(10);
  expect(finished).toEqual([2]);
  player.play("Idle", 3);
  player.update(10);
  expect(finished).toEqual([2]);
  player.dispose();
});
