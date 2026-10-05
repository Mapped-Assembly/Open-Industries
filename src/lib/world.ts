import * as THREE from 'three';
import type { Asset } from './scene';
import type { EvaluatedPose } from './workspace';

/** The same geometry, materials and instance placement feed the viewport and GIFs. */
export function createWorld(assets: Asset[], room: number[], selected = -1, selectedPart = -1, poses?: EvaluatedPose[]) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#192322');
  scene.add(new THREE.HemisphereLight(0xffffff, 0x63736b, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(4, 8, 5); scene.add(light);
  const environment = new THREE.Group();
  const floor = new THREE.Mesh(new THREE.BoxGeometry(room[0], .025, room[1]), new THREE.MeshStandardMaterial({ color: '#34433c', roughness: .95 }));
  floor.position.y = -.018; environment.add(floor);
  if (!assets.some(asset => asset.source.kind === 'generated')) environment.add(new THREE.GridHelper(Math.max(room[0], room[1]), Math.max(2, Math.round(Math.max(room[0], room[1]) * 2)), 0x82917b, 0x46594d));
  const box = new THREE.BoxGeometry(room[0], room[2], room[1]);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x7e9784, transparent: true, opacity: .35 }));
  box.dispose(); edges.position.y = room[2] / 2; environment.add(edges);
  scene.add(environment);
  const groups = assets.map((asset, index) => {
    const group = new THREE.Group();
    asset.parts.forEach(part => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(part.vertices, 3));
      geometry.setIndex(part.indices); geometry.computeVertexNormals();
      const material = new THREE.MeshStandardMaterial({
         color: part.color ? new THREE.Color(...part.color) : index === selected && assets[index].parts.indexOf(part) === selectedPart ? '#e8ffb5' : index === selected ? '#c8ef82' : '#b9c9c5',
        metalness: .2, roughness: .55,
      });
      const mesh = new THREE.Mesh(geometry, material);
      geometry.computeBoundingBox(); mesh.userData.pivot = geometry.boundingBox!.getCenter(new THREE.Vector3()); mesh.userData.partId = part.id;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    });
    scene.add(group);
    return group;
  });
  if (poses) applyWorldPoses(groups, poses);
  return { scene, groups, environment, dispose: () => disposeScene(scene) };
}

export function applyWorldPoses(groups: THREE.Group[], poses: EvaluatedPose[]) {
  groups.forEach((group, index) => {
    const pose = poses[index]; if (!pose) return;
    group.position.fromArray(pose.position); group.rotation.set(...pose.rotation.map(THREE.MathUtils.degToRad) as [number,number,number]); group.visible = pose.visible;
    group.children.forEach(object => {
      const mesh = object as THREE.Mesh;
      const part = pose.parts[mesh.userData.partId];
      mesh.matrix.identity();
      if (part) {
        const pivot = mesh.userData.pivot as THREE.Vector3;
        mesh.matrix.makeTranslation(pivot.x + part.position[0], pivot.y + part.position[1], pivot.z + part.position[2]);
        mesh.matrix.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...part.rotation.map(THREE.MathUtils.degToRad) as [number,number,number])));
        mesh.matrix.multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
      }
      mesh.matrixWorldNeedsUpdate = true;
    });
    group.updateMatrixWorld(true);
  });
}

export function disposeScene(scene: THREE.Object3D) {
  scene.traverse(object => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
  });
}
