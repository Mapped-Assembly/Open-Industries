import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { applyWorldPoses, createWorld } from '../lib/world';
import { evaluateWorkspace, type Workspace } from '../lib/workspace';
import { regionBounds, type FloorRegion } from '../lib/gif';
import { updateCameraDepth } from '../lib/camera-depth';

type Props = { workspace: Workspace; selected: number; selectedPart: number; time: number | null; focus: number;
  region: FloorRegion | null; onSelect: (instance: number, part: number) => void };
export function WorkspaceViewer(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const key = props.workspace.items.map(item => `${item.id}:${item.asset.id}:${item.cloudVersionId??'local'}:${item.missing}`).join('|');
  const roomKey = props.workspace.room.join(',');
  useEffect(() => {
    const el = host.current!; const p = latest.current;
    const world = createWorld(p.workspace.items.map(item => item.asset), p.workspace.room);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); el.appendChild(renderer.domElement);
    const camera = new THREE.PerspectiveCamera(45, 1, .01, 100);
    const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
    const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2(); let down = [0,0];
    const onDown = (event: PointerEvent) => { down = [event.clientX, event.clientY]; };
    const onUp = (event: PointerEvent) => {
      if (event.button !== 0 || Math.hypot(event.clientX-down[0], event.clientY-down[1]) > 4) return;
      const rect = el.getBoundingClientRect();
      pointer.set((event.clientX-rect.left)/rect.width*2-1, -(event.clientY-rect.top)/rect.height*2+1);
      raycaster.setFromCamera(pointer,camera);
      const hit = raycaster.intersectObjects(world.groups.filter(g => g.visible).flatMap(g => g.children))[0];
      if (hit?.object.parent) latest.current.onSelect(world.groups.indexOf(hit.object.parent as THREE.Group), hit.object.parent.children.indexOf(hit.object));
    };
    renderer.domElement.addEventListener('pointerdown',onDown); renderer.domElement.addEventListener('pointerup',onUp);
    const resize = () => { camera.aspect = el.clientWidth / Math.max(1,el.clientHeight); camera.updateProjectionMatrix(); renderer.setSize(el.clientWidth,el.clientHeight); };
    const observer = new ResizeObserver(resize); observer.observe(el); resize();
    let lastFocus = ''; let lastRegion = ''; let outline: THREE.Box3Helper | null = null;
    renderer.setAnimationLoop(() => {
      const { workspace, selected, selectedPart, time, focus, region } = latest.current;
      applyWorldPoses(world.groups, evaluateWorkspace(workspace.items,workspace.animation,time));
      world.groups.forEach((group,i) => group.children.forEach((object,j) => {
        ((object as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.setHex(i === selected ? (j === selectedPart ? 0x516525 : 0x203012) : 0);
      }));
      const focusKey = `${selected}:${selectedPart}:${focus}`;
      if (focusKey !== lastFocus) {
        lastFocus = focusKey;
        const group = world.groups[selected];
        if (group) {
          const box = new THREE.Box3().setFromObject(selectedPart >= 0 ? group.children[selectedPart] ?? group : group);
          const center = box.getCenter(new THREE.Vector3()); const size = Math.max(box.getSize(new THREE.Vector3()).length(),.01);
          controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(size*1.3,size*.9,size*1.3));
        } else {
          controls.target.set(0,0,0);
          const generatedArchitecture = p.workspace.items.some(item => item.asset.source.kind === 'generated');
          camera.position.set(workspace.room[0] * (generatedArchitecture ? .35 : .9), Math.max(...workspace.room) * (generatedArchitecture ? 1.35 : .75), workspace.room[1] * (generatedArchitecture ? .35 : .9));
        }
      }
      const regionKey = JSON.stringify(region);
      if (regionKey !== lastRegion) {
        lastRegion = regionKey;
        if (outline) { world.scene.remove(outline); outline.geometry.dispose(); (outline.material as THREE.Material).dispose(); outline=null; }
        if (region) try { outline = new THREE.Box3Helper(regionBounds(region,workspace.room),0xc8ef82); world.scene.add(outline); } catch { /* Invalid region is explained in the export panel. */ }
      }
      controls.update();
      updateCameraDepth(camera, world.scene, controls.target);
      renderer.render(world.scene,camera);
    });
    return () => { observer.disconnect(); renderer.setAnimationLoop(null); renderer.domElement.removeEventListener('pointerdown',onDown); renderer.domElement.removeEventListener('pointerup',onUp); controls.dispose(); world.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); };
  }, [key,roomKey]);
  return <div className="viewport" ref={host} aria-label="Interactive 3D room" />;
}
