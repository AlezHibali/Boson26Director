import * as THREE from "three";
import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob) {
    void blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob: Blob) {
    void blob.arrayBuffer().then((value) => {
      this.result =
        "data:application/octet-stream;base64," +
        Buffer.from(value).toString("base64");
      this.onloadend?.();
    });
  }
}
Object.assign(globalThis, { FileReader: NodeFileReader });
const material = (color: string, roughness = 0.75) =>
  new THREE.MeshStandardMaterial({ color, roughness });
function part(
  parent: THREE.Object3D,
  name: string,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  xyz: number[],
) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.position.set(xyz[0], xyz[1], xyz[2]);
  parent.add(mesh);
  return mesh;
}
function ellipsoid(
  parent: THREE.Object3D,
  name: string,
  radii: number[],
  xyz: number[],
  mat: THREE.Material,
) {
  const geo = new THREE.SphereGeometry(1, 24, 18);
  geo.scale(radii[0], radii[1], radii[2]);
  return part(parent, name, geo, mat, xyz);
}
function morph(mesh: THREE.Mesh, name: string, sx: number, sy: number) {
  const position = mesh.geometry.attributes.position;
  const values = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    values[i * 3] = position.getX(i) * sx;
    values[i * 3 + 1] = position.getY(i) * sy;
    values[i * 3 + 2] = position.getZ(i);
  }
  mesh.geometry.morphAttributes.position = [
    new THREE.Float32BufferAttribute(values, 3),
  ];
  mesh.updateMorphTargets();
  mesh.morphTargetDictionary = { [name]: 0 };
}
function quaternionTrack(node: string, times: number[], angles: number[]) {
  const values = angles.flatMap((z) =>
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, z)).toArray(),
  );
  return new THREE.QuaternionKeyframeTrack(node + ".quaternion", times, values);
}
function actor(
  id: string,
  skinColor: string,
  hairColor: string,
  shirtColor: string,
) {
  const root = new THREE.Group();
  root.name = id;
  const skin = material(skinColor);
  const hair = material(hairColor);
  const shirt = material(shirtColor);
  const black = material("#202b3a");
  const pants = material("#28354a");
  const hips = new THREE.Bone();
  hips.name = "Hips";
  root.add(hips);
  const spine = new THREE.Bone();
  spine.name = "Spine";
  spine.position.y = 1.25;
  hips.add(spine);
  const neck = new THREE.Bone();
  neck.name = "Neck";
  neck.position.y = 0.6;
  spine.add(neck);
  const bones = [hips, spine, neck];
  const bodyGeo = new THREE.BoxGeometry(0.53, 0.62, 0.26, 2, 2, 2);
  bodyGeo.translate(0, 1.25, 0);
  const count = bodyGeo.attributes.position.count;
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    indices[i * 4] = 1;
    weights[i * 4] = 1;
  }
  bodyGeo.setAttribute(
    "skinIndex",
    new THREE.Uint16BufferAttribute(indices, 4),
  );
  bodyGeo.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(weights, 4),
  );
  const torso = new THREE.SkinnedMesh(bodyGeo, shirt);
  torso.name = "RiggedTorso";
  root.add(torso);
  for (const sign of [-1, 1]) {
    const shoulder = new THREE.Bone();
    shoulder.name = sign < 0 ? "RightShoulder" : "LeftShoulder";
    shoulder.position.set(sign * 0.34, 0.25, 0);
    spine.add(shoulder);
    bones.push(shoulder);
    ellipsoid(
      shoulder,
      "Sleeve" + sign,
      [0.105, 0.235, 0.11],
      [0, -0.17, 0],
      shirt,
    );
    const elbow = new THREE.Bone();
    elbow.name = sign < 0 ? "RightElbow" : "LeftElbow";
    elbow.position.y = -0.37;
    shoulder.add(elbow);
    bones.push(elbow);
    ellipsoid(
      elbow,
      "Forearm" + sign,
      [0.078, 0.18, 0.08],
      [0, -0.14, 0],
      skin,
    );
    ellipsoid(
      elbow,
      "Hand" + sign,
      [0.083, 0.105, 0.045],
      [0, -0.34, 0.01],
      skin,
    );
    ellipsoid(
      root,
      "Leg" + sign,
      [0.12, 0.39, 0.13],
      [sign * 0.145, 0.51, 0],
      pants,
    );
    ellipsoid(
      root,
      "Shoe" + sign,
      [0.135, 0.095, 0.21],
      [sign * 0.145, 0.095, 0.055],
      black,
    );
  }
  const head = ellipsoid(neck, "Head", [0.305, 0.365, 0.285], [0, 0, 0], skin);
  morph(head, "FaceWidth", 1.18, 1);
  ellipsoid(neck, "Hair", [0.31, 0.19, 0.285], [0, 0.265, -0.035], hair);
  ellipsoid(neck, "HairBack", [0.302, 0.3, 0.13], [0, 0.03, -0.21], hair);
  for (const sign of [-1, 1]) {
    ellipsoid(
      neck,
      "Ear" + sign,
      [0.055, 0.09, 0.06],
      [sign * 0.3, -0.005, 0],
      skin,
    );
    const eye = ellipsoid(
      neck,
      "EyeWhite" + sign,
      [0.073, 0.08, 0.036],
      [sign * 0.115, 0.055, 0.26],
      material("#f8f6ec"),
    );
    morph(eye, "EyeSize", 1.6, 1.6);
    const pupil = ellipsoid(
      neck,
      "Iris" + sign,
      [0.032, 0.043, 0.014],
      [sign * 0.115, 0.055, 0.292],
      material("#29364a"),
    );
    morph(pupil, "EyeSize", 1.6, 1.6);
    ellipsoid(
      neck,
      "EyeGlint" + sign,
      [0.01, 0.014, 0.009],
      [sign * 0.115 - 0.009, 0.072, 0.303],
      material("#ffffff"),
    );
    const brow = part(
      neck,
      "Brow" + sign,
      new THREE.BoxGeometry(0.105, 0.019, 0.02),
      hair,
      [sign * 0.12, 0.158, 0.265],
    );
    brow.rotation.z = sign * -0.1;
  }
  ellipsoid(neck, "Nose", [0.043, 0.063, 0.065], [0, -0.035, 0.28], skin);
  ellipsoid(
    neck,
    "Mouth",
    [0.077, 0.016, 0.02],
    [0, -0.148, 0.247],
    material("#8e4a49"),
  );
  const casual = new THREE.Group();
  casual.name = "Outfit_Casual";
  spine.add(casual);
  part(
    casual,
    "ShirtPanel",
    new THREE.BoxGeometry(0.54, 0.63, 0.27),
    shirt,
    [0, 0, 0],
  );
  part(
    casual,
    "Collar",
    new THREE.BoxGeometry(0.13, 0.05, 0.29),
    material("#e6dfd2"),
    [0, 0.3, 0],
  );
  const suit = new THREE.Group();
  suit.name = "Outfit_Suit";
  spine.add(suit);
  part(
    suit,
    "BlackJacket",
    new THREE.BoxGeometry(0.56, 0.65, 0.29),
    black,
    [0, 0, 0],
  );
  part(
    suit,
    "WhiteShirt",
    new THREE.BoxGeometry(0.19, 0.55, 0.012),
    material("#f2efe7"),
    [0, 0.03, 0.151],
  );
  const tie = part(
    suit,
    "Tie",
    new THREE.BoxGeometry(0.043, 0.34, 0.016),
    material("#c87f50"),
    [0, 0.08, 0.165],
  );
  tie.rotation.z = -0.025;
  for (const sign of [-1, 1]) {
    const lapel = part(
      suit,
      "Lapel" + sign,
      new THREE.BoxGeometry(0.09, 0.35, 0.015),
      material("#354258"),
      [sign * 0.14, 0.14, 0.16],
    );
    lapel.rotation.z = sign * 0.3;
  }
  root.updateMatrixWorld(true);
  torso.bind(new THREE.Skeleton(bones));
  root.userData = {
    license: "CC0-1.0",
    generator: "scripts/generate-actors.ts",
    originalProceduralAsset: true,
  };
  const clips = [
    new THREE.AnimationClip("Idle", 3, [
      quaternionTrack("Spine", [0, 1.5, 3], [0, 0.018, 0]),
    ]),
    new THREE.AnimationClip("Wave", 2.8, [
      quaternionTrack(
        "RightShoulder",
        [0, 0.5, 1, 1.5, 2, 2.8],
        [0, -2.3, -2.5, -2.2, -2.5, 0],
      ),
      quaternionTrack(
        "RightElbow",
        [0, 0.5, 1, 1.5, 2, 2.8],
        [0, 0.5, -0.2, 0.5, -0.2, 0],
      ),
    ]),
  ];
  return { root, clips };
}
await mkdir("public/actors", { recursive: true });
const variants = [
  ["mira", "#cd9576", "#2a222b", "#3d6c70"],
  ["ren", "#bb8a69", "#252d3b", "#79618e"],
];
const manifest = [];
for (const [id, skin, hair, shirt] of variants) {
  const { root, clips } = actor(id, skin, hair, shirt);
  const output = await new GLTFExporter().parseAsync(root, {
    binary: true,
    animations: clips,
    onlyVisible: false,
  });
  if (!(output instanceof ArrayBuffer)) throw new Error("Expected binary GLB");
  const bytes = Buffer.from(output);
  await writeFile("public/actors/" + id + ".glb", bytes);
  manifest.push({
    id,
    name: id === "mira" ? "Mira" : "Ren",
    url: "/actors/" + id + ".glb",
    license: "CC0-1.0",
    source: "Original procedural geometry generated in this repository",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    morphs: ["FaceWidth", "EyeSize"],
    outfits: ["Casual", "Suit"],
    animations: clips.map((c) => c.name),
    bones:
      root.getObjectByName("RiggedTorso") instanceof THREE.SkinnedMesh
        ? bonesCount(root)
        : 0,
  });
}
function bonesCount(root: THREE.Object3D) {
  let count = 0;
  root.traverse((o) => {
    if (o instanceof THREE.Bone) count++;
  });
  return count;
}
await writeFile(
  "public/actors/manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  "Generated " +
    manifest.length +
    " original GLB actors with morph targets, rig, outfit groups and animation clips.",
);
