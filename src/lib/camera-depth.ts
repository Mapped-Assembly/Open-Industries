import { Matrix4, PerspectiveCamera, Vector3, type BufferGeometry, type Object3D } from 'three';

const modelView = new Matrix4();
const corner = new Vector3();
const cameraPosition = new Vector3();

/**
 * Fit depth clipping to visible geometry and the current inspection distance.
 * Keeping the near plane proportional to zoom preserves millimeter separation
 * in rooms without imposing a room-sized near plane on tiny CAD parts.
 * Geometry enclosing the eye necessarily crosses the near plane; in that case
 * the orbit target supplies the inspection scale instead of a negative depth.
 */
export function updateCameraDepth(camera: PerspectiveCamera, root: Object3D, target: Vector3): void {
  root.updateWorldMatrix(true, true);
  camera.updateWorldMatrix(true, false);
  camera.getWorldPosition(cameraPosition);
  const distance = Math.max(cameraPosition.distanceTo(target), 1e-5);
  let near = distance / 50;
  let far = distance * 2;

  root.traverseVisible(object => {
    const geometry = (object as Object3D & { geometry?: BufferGeometry }).geometry;
    if (!geometry) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    if (!bounds || bounds.isEmpty()) return;
    modelView.multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? bounds.max.x : bounds.min.x, i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z);
      corner.applyMatrix4(modelView);
      minDepth = Math.min(minDepth, -corner.z);
      maxDepth = Math.max(maxDepth, -corner.z);
    }
    if (minDepth > 0) near = Math.min(near, minDepth / 2);
    far = Math.max(far, maxDepth * 1.1);
  });

  near = Math.max(near, 1e-7);
  far = Math.max(far, near * 2);
  if (camera.near !== near || camera.far !== far) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}
