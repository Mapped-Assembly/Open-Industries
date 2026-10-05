import assert from 'node:assert/strict';
import { BoxGeometry, Group, Mesh, PerspectiveCamera, Scene, Vector3 } from 'three';
import { updateCameraDepth } from '../src/lib/camera-depth';

/** Approximate world-space distance represented by one 24-bit depth step. */
function depthStep(camera: PerspectiveCamera, distance: number): number {
  return distance ** 2 * (camera.far - camera.near) / (camera.far * camera.near * (2 ** 24 - 1));
}

/** Check floor precision and clipping across room, zoom, and CAD scales. */
function verifyScale(size: number): void {
  const scene = new Scene();
  const floor = new Mesh(new BoxGeometry(size, size / 1000, size));
  scene.add(floor);
  const target = new Vector3();
  const camera = new PerspectiveCamera(45, 1, .0001, 10000);
  for (const zoom of [1, 3, 10]) {
    camera.position.set(size * zoom, size * zoom, size * zoom);
    camera.lookAt(target);
    updateCameraDepth(camera, scene, target);
    const distance = camera.position.length();
    assert.ok(depthStep(camera, distance) < size / 10000, 'depth resolution must preserve thin separated surfaces');
    for (const x of [-size / 2, size / 2]) for (const z of [-size / 2, size / 2]) {
      const projected = new Vector3(x, 0, z).project(camera);
      assert.ok(projected.z > -1 && projected.z < 1, 'floor must remain between clipping planes');
    }
  }
}

for (const size of [.0001, .01, 10, 1000]) verifyScale(size);

// Reproduce the reported floor/grid gap using projected 24-bit depth values.
const room = new Scene();
room.add(new Mesh(new BoxGeometry(10, .025, 10)));
const roomCamera = new PerspectiveCamera(45, 1, .0001, 10000);
roomCamera.position.set(15, 15, 15);
roomCamera.lookAt(0, 0, 0);
roomCamera.updateMatrixWorld();
/** Number of depth-buffer steps separating the grid and floor at the origin. */
function floorSeparation(): number {
  const floor = new Vector3(0, -.0055, 0).project(roomCamera);
  const grid = new Vector3(0, 0, 0).project(roomCamera);
  return Math.abs(floor.z - grid.z) / 2 * (2 ** 24 - 1);
}
assert.ok(floorSeparation() < 1, 'original camera cannot resolve the floor/grid gap');
updateCameraDepth(roomCamera, room, new Vector3());
assert.ok(floorSeparation() > 10, 'adaptive camera must clearly resolve the floor/grid gap');

const scene = new Scene();
const moving = new Group();
moving.add(new Mesh(new BoxGeometry(1, 1, 1)));
scene.add(moving);
const camera = new PerspectiveCamera(45, 1, .0001, 10000);
camera.position.set(0, 0, 10);
const target = new Vector3();
camera.lookAt(target);
updateCameraDepth(camera, scene, target);
const initialFar = camera.far;
moving.position.z = -1000;
updateCameraDepth(camera, scene, target);
assert.ok(camera.far > 1010, 'animated distant geometry must remain visible');
moving.visible = false;
updateCameraDepth(camera, scene, target);
assert.equal(camera.far, initialFar, 'hidden geometry must not expand clipping');
moving.visible = true;
moving.position.z = 9.499;
updateCameraDepth(camera, scene, target);
assert.ok(camera.near < .001, 'nearby geometry must not be clipped by target-based near distance');
moving.position.z = 10;
updateCameraDepth(camera, scene, target);
assert.ok(Number.isFinite(camera.near) && camera.near > 0 && camera.far > camera.near, 'camera inside geometry must remain valid');
console.log('PASS depth precision at four scales, orbit/zoom, close surfaces, animated transforms, hidden geometry, and camera inside geometry.');
