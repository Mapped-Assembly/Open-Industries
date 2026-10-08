/** Load the same local tileset in two independent runtimes, with source picking. */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TilesRenderer } from '3d-tiles-renderer';

const mode = new URLSearchParams(location.search).get('viewer') === 'three' ? 'three' : 'cesium';
const view = document.querySelector('#view');
const status = document.querySelector('#status');
const details = document.querySelector('#details');
const [provenance, tilesetJSON] = await Promise.all([
  fetch('/export/provenance.json').then(r => r.json()),
  fetch('/export/tileset.json').then(r => r.json()),
]);
const evidence = window.renderEvidence = {
  viewer: mode, loaded: false, picked: null, loadedModels: 0, errors: [], started: performance.now(),
  instances: provenance.instances.length, userAgent: navigator.userAgent,
};
const select = document.querySelector('#equipment');
for (const instance of provenance.instances) {
  const option = document.createElement('option');
  option.value = instance.instanceId;
  option.textContent = instance.name;
  select.append(option);
}

/** Inspect allowlisted sidecar provenance by exact instance identity. */
function inspect(id, fromGeometry = false) {
  const item = provenance.instances.find(i => i.instanceId === id);
  if (!item) throw new Error('Picked geometry has no matching source instance');
  select.value = id;
  details.textContent = JSON.stringify({
    instanceId: item.instanceId, assetId: item.assetId, sourceKind: item.sourceKind,
    sourceDigest: item.sourceDigest, projectId: item.projectId, projectRevision: item.projectRevision,
    sourceRevision: provenance.sourceRevision, placement: provenance.placement,
    licenseNote: provenance.licenseNote,
  }, null, 2);
  evidence.picked = { instanceId: id, assetId: item.assetId, fromGeometry };
}
document.querySelector('#inspect').addEventListener('click', () => inspect(select.value));
window.addEventListener('unhandledrejection', e => { evidence.errors.push(String(e.reason)); status.textContent = String(e.reason); });

if (mode === 'cesium') {
  const C = window.Cesium;
  evidence.version = C.VERSION;
  const viewer = new C.Viewer(view, {
    baseLayer: false, geocoder: false, homeButton: false, sceneModePicker: false,
    baseLayerPicker: false, navigationHelpButton: false, animation: false,
    timeline: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
    skyBox: false, skyAtmosphere: false, shouldAnimate: false,
  });
  viewer.scene.globe.baseColor = C.Color.fromCssColorString('#20363d');
  viewer.scene.backgroundColor = C.Color.fromCssColorString('#101b20');
  evidence.stage = 'loading-tileset';
  const tileset = await C.Cesium3DTileset.fromUrl('/export/tileset.json');
  evidence.stage = 'adding-tileset';
  viewer.scene.primitives.add(tileset);
  const frame = C.Matrix4.fromArray(tilesetJSON.root.transform);
  const origin = C.Matrix4.getTranslation(frame, new C.Cartesian3());
  viewer.camera.lookAt(origin, new C.HeadingPitchRange(C.Math.toRadians(provenance.anchor.heading) + 0.4, -0.7, 27));
  viewer.scene.screenSpaceCameraController.minimumZoomDistance = 1;
  tileset.allTilesLoaded.addEventListener(() => {
    if (!evidence.loaded) {
      evidence.loaded = true; evidence.loadMilliseconds = performance.now() - evidence.started;
      evidence.memoryBytes = tileset.totalMemoryUsageInBytes;
      status.textContent = 'CesiumJS · tiles loaded · click equipment';
    }
  });
  tileset.tileFailed.addEventListener(error => evidence.errors.push(error.message));
  const loadedIds = new Set();
  tileset.tileLoad.addEventListener(tile => {
    const id = tile.metadata?.getProperty('instanceId');
    if (id) loadedIds.add(id);
    evidence.loadedModels = loadedIds.size;
  });
  const handler = new C.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction(event => {
    evidence.clicks = (evidence.clicks ?? 0) + 1;
    evidence.clickPosition = event.position;
    const picked = viewer.scene.pick(event.position);
    evidence.lastPick = picked ? {
      type: picked.constructor?.name,
      assetId: typeof picked.getProperty === 'function' ? picked.getProperty('assetId') : null,
      hasContent: Boolean(picked.content), featureId: picked.featureId,
    } : null;
    if (picked && typeof picked.getProperty === 'function') {
      const id = C.Cesium3DTileFeature.getPropertyInherited(picked.content, picked.featureId, 'instanceId');
      if (id) inspect(id, true);
    }
  }, C.ScreenSpaceEventType.LEFT_CLICK);
  evidence.project = id => {
    const child = tilesetJSON.root.children.find(t => t.metadata.properties.instanceId === id);
    const world = C.Matrix4.multiply(frame, C.Matrix4.fromArray(child.transform), new C.Matrix4());
    const center = C.Cartesian3.fromArray(child.boundingVolume.box.slice(0, 3));
    const point = C.Matrix4.multiplyByPoint(world, center, new C.Cartesian3());
    const screen = C.SceneTransforms.worldToWindowCoordinates(viewer.scene, point);
    return screen ? { x: screen.x, y: screen.y } : null;
  };
  evidence.stage = 'rendering';
} else {
  evidence.version = '3d-tiles-renderer 0.5.3 / Three.js ' + THREE.REVISION;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  view.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#20363d');
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);
  camera.position.set(14, 13, 18);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0); controls.update();
  const tiles = new TilesRenderer('/export/tileset.json');
  // Recenter ECEF into OI local meters for precision, while loading the same tiles.
  const inverse = new THREE.Matrix4().fromArray(tilesetJSON.root.transform).invert();
  const zToY = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  tiles.group.matrixAutoUpdate = false;
  tiles.group.matrix.copy(zToY.multiply(inverse));
  scene.add(tiles.group);
  tiles.setCamera(camera);
  tiles.addEventListener('load-model', ({ scene: model, tile }) => {
    model.userData.instanceId = tile.metadata.properties.instanceId;
    evidence.loadedModels++;
  });
  tiles.addEventListener('load-error', event => evidence.errors.push(String(event.error)));
  const resize = () => {
    renderer.setSize(view.clientWidth, view.clientHeight);
    camera.aspect = view.clientWidth / view.clientHeight;
    camera.updateProjectionMatrix();
    tiles.setResolutionFromRenderer(camera, renderer);
  };
  resize(); window.addEventListener('resize', resize);
  const raycaster = new THREE.Raycaster();
  renderer.domElement.addEventListener('click', event => {
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObject(tiles.group, true)[0];
    if (hit) {
      let object = hit.object;
      while (object && !object.userData.instanceId) object = object.parent;
      if (object) inspect(object.userData.instanceId, true);
    }
  });
  evidence.project = id => {
    const child = tilesetJSON.root.children.find(t => t.metadata.properties.instanceId === id);
    const center = new THREE.Vector3(...child.boundingVolume.box.slice(0, 3));
    center.applyMatrix4(new THREE.Matrix4().fromArray(child.transform));
    center.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    center.project(camera);
    return { x: (center.x + 1) / 2 * view.clientWidth, y: (1 - center.y) / 2 * view.clientHeight };
  };
  renderer.setAnimationLoop(() => {
    controls.update(); camera.updateMatrixWorld(); tiles.update(); renderer.render(scene, camera);
    if (!evidence.loaded && evidence.loadedModels === provenance.instances.length) {
      evidence.loaded = true; evidence.loadMilliseconds = performance.now() - evidence.started;
      evidence.memory = renderer.info.memory;
      status.textContent = 'Three.js · all equipment loaded · click equipment';
    }
  });
}
