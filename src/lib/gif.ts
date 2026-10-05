import * as THREE from 'three';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import type { Asset } from './scene';
import { applyWorldPoses, createWorld } from './world';
import { appendAssets, emptyWorkspace, evaluateWorkspace, type Workspace } from './workspace';
import { updateCameraDepth } from './camera-depth';

export type FloorRegion = { x: number; z: number; width: number; depth: number };
export type GifOptions = {
  scope: 'room' | 'section' | 'asset'; assetIndex: number; region: FloorRegion;
  motion: 'turntable' | 'sample' | 'animation'; size: number; duration: number; fps: number;
  rangeStart?: number; rangeEnd?: number; snapshotTime?: number | null;
};
export type GifResult = { blob: Blob; filename: string; metadata: GifMetadata };
export type GifMetadata = {
  schemaVersion: 1; units: 'm'; upAxis: 'Y'; scope: GifOptions['scope']; motion: GifOptions['motion'];
  width: number; height: number; frameCount: number; frameDelayMs: number; durationSeconds: number;
  room: number[]; region?: FloorRegion;
  assets: { id: string; instanceId: string; name: string; source: Asset['source']; position: number[]; rotation: number[]; visible: boolean; warnings: string[] }[];
  note: string; animation?: Workspace['animation'];
  frames?: { time: number; instances: { id: string; position: number[]; rotation: number[]; visible: boolean; parts: Record<string, unknown> }[] }[];
};
export function regionBounds(region: FloorRegion, room: number[]) {
  const { x,z,width,depth }=region;
  if (![x,z,width,depth].every(Number.isFinite)||width<=0||depth<=0) throw new Error('Section dimensions must be positive, with finite center coordinates.');
  if (Math.abs(x)+width/2>room[0]/2+1e-8||Math.abs(z)+depth/2>room[1]/2+1e-8) throw new Error('The floor section must fit inside the room. Coordinates are measured from the room center.');
  return new THREE.Box3(new THREE.Vector3(x-width/2,-.04,z-depth/2),new THREE.Vector3(x+width/2,room[2],z+depth/2));
}
export async function renderGif(assets: Asset[], room: number[], options: GifOptions, signal: AbortSignal, progress: (value:number)=>void, layout?: Pick<Workspace,'items'|'animation'>): Promise<GifResult> {
  if(!assets.length) throw new Error('Import an asset before rendering a GIF.');
  if(!['room','section','asset'].includes(options.scope)||!['turntable','sample','animation'].includes(options.motion)) throw new Error('Unsupported GIF scope or motion.');
  if(![320,480,640].includes(options.size)||![2,3,4].includes(options.duration)||![10,15].includes(options.fps)) throw new Error('Unsupported GIF size or timing.');
  if(options.motion==='sample'&&options.scope!=='asset') throw new Error('Sample motion is available for individual assets.');
  if(options.scope==='asset'&&!assets[options.assetIndex]) throw new Error('Select an asset to render.');
  const state=layout??appendAssets(emptyWorkspace(),assets);
  if(state.items.some(i=>i.missing&&(options.scope!=='asset'||i===state.items[options.assetIndex]))) throw new Error('Reimport missing geometry before exporting a review GIF.');
  const start=options.rangeStart??0; const end=options.rangeEnd??Math.min(state.animation.duration,3);
  if(options.motion==='animation'&&(!state.animation.tracks.length||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>state.animation.duration||end-start>4)) throw new Error('Choose an authored animation range of at most 4 seconds within the timeline.');
  const delay=Math.round(100/options.fps)*10;
  const frames=options.motion==='animation'?Math.ceil((end-start)*1000/delay):options.duration*options.fps;
  const section=options.scope==='section'?regionBounds(options.region,room):undefined;
  const world=createWorld(assets,room); let renderer:THREE.WebGLRenderer|undefined;
  const snapshots=Array.from({length:frames},(_,frame)=>evaluateWorkspace(state.items,state.animation,options.motion==='animation'?start+frame*delay/1000:options.snapshotTime??null));
  const isolated=options.scope==='asset'&&options.motion!=='animation';
  const eligible=(index:number)=>options.scope!=='asset'||index===options.assetIndex;
  try {
    if(signal.aborted) throw new DOMException('Export cancelled','AbortError');
    renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true}); renderer.setPixelRatio(1); renderer.setSize(options.size,options.size);
    world.environment.visible=options.scope!=='asset';
    let bounds=section?.clone()??(options.scope==='asset'?new THREE.Box3():new THREE.Box3(new THREE.Vector3(-room[0]/2,0,-room[1]/2),new THREE.Vector3(room[0]/2,room[2],room[1]/2)));
    const included=new Set<number>();
    for(const poses of snapshots){
      applyWorldPoses(world.groups,poses);
      if(isolated) world.groups[options.assetIndex].position.set(0,0,0);
      world.groups.forEach((group,i)=>{
        if(!eligible(i)||!poses[i].visible)return;
        const box=new THREE.Box3().setFromObject(group);
        if(!section||section.intersectsBox(box)){included.add(i);if(!section)bounds.union(box);}
      });
    }
    if(!included.size) throw new Error('This export contains no visible assets. Adjust its scope or floor section.');
    if(section) renderer.clippingPlanes=[new THREE.Plane(new THREE.Vector3(1,0,0),-section.min.x),new THREE.Plane(new THREE.Vector3(-1,0,0),section.max.x),new THREE.Plane(new THREE.Vector3(0,0,1),-section.min.z),new THREE.Plane(new THREE.Vector3(0,0,-1),section.max.z),new THREE.Plane(new THREE.Vector3(0,1,0),-section.min.y),new THREE.Plane(new THREE.Vector3(0,-1,0),section.max.y)];
    const center=bounds.getCenter(new THREE.Vector3());const size=bounds.getSize(new THREE.Vector3());const radius=Math.max(size.length()/2,.01);
    const camera=new THREE.PerspectiveCamera(40,1,.01,100);const distance=radius/Math.sin(THREE.MathUtils.degToRad(20))*1.15;
    const lift=size.y*.3;if(options.motion==='sample')center.y+=lift/2;
    const canvas=document.createElement('canvas');canvas.width=options.size;canvas.height=options.size;const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('This browser cannot capture GIF frames.');
    const gif=GIFEncoder();
    const metadata:GifMetadata={schemaVersion:1,units:'m',upAxis:'Y',scope:options.scope,motion:options.motion,width:options.size,height:options.size,frameCount:frames,frameDelayMs:delay,durationSeconds:frames*delay/1000,room:[...room],...(section?{region:{...options.region}}:{}),
      assets:[...included].map(i=>({id:assets[i].id,instanceId:state.items[i].id,name:state.items[i].name,source:{...assets[i].source},position:[...snapshots[0][i].position],rotation:[...snapshots[0][i].rotation],visible:snapshots[0][i].visible,warnings:[...assets[i].warnings]})),
      note:options.motion==='animation'?'Authored timeline evaluated at the recorded frame times; fixed review camera.':options.motion==='sample'?'Synthetic lift-and-return preview; isolated asset. Not an authored physical process.':`${isolated?'Isolated asset camera orbit; metadata retains room coordinates.':'Camera orbit around current instance poses.'} Floor-section geometry is clipped at its boundaries.`,
      ...(options.motion==='animation'?{animation:structuredClone(state.animation),frames:[]}:{}),
    };
    for(let frame=0;frame<frames;frame++){
      if(signal.aborted)throw new DOMException('Export cancelled','AbortError');
      const poses=snapshots[frame];applyWorldPoses(world.groups,poses);
      if(isolated)world.groups[options.assetIndex].position.set(0,0,0);
      if(options.motion==='sample')world.groups[options.assetIndex].position.y=lift*(1-Math.cos(frame/frames*Math.PI*2))/2;
      world.groups.forEach((group,i)=>{group.visible=eligible(i)&&poses[i].visible&&(!section||section.intersectsBox(new THREE.Box3().setFromObject(group)));});
      const angle=Math.PI/4+(options.motion==='turntable'?frame/frames*Math.PI*2:0);
      camera.position.set(center.x+Math.sin(angle)*distance*.82,center.y+distance*.58,center.z+Math.cos(angle)*distance*.82);camera.lookAt(center);
      updateCameraDepth(camera,world.scene,center);renderer.render(world.scene,camera);
      metadata.frames?.push({time:start+frame*delay/1000,instances:[...included].map(i=>({id:state.items[i].id,position:poses[i].position,rotation:poses[i].rotation,visible:poses[i].visible,parts:poses[i].parts}))});
      context.drawImage(renderer.domElement,0,0);context.fillStyle='#101716';context.fillRect(0,options.size-29,options.size,29);context.fillStyle='#dfe7df';context.font='11px sans-serif';context.fillText(`ASTRA | ${options.scope.toUpperCase()} | ${options.motion.toUpperCase()} | meters`,10,options.size-11);
      const pixels=context.getImageData(0,0,options.size,options.size).data;const palette=quantize(pixels,256);gif.writeFrame(applyPalette(pixels,palette),options.size,options.size,{palette,delay,repeat:options.motion==='animation'&&!state.animation.loop?-1:0});
      progress((frame+1)/frames);await new Promise(resolve=>setTimeout(resolve,0));
    }
    if(signal.aborted)throw new DOMException('Export cancelled','AbortError');gif.finish();
    const name=options.scope==='asset'?state.items[options.assetIndex].name:`floor-${options.scope}`;
    return{blob:new Blob([new Uint8Array(gif.bytes())],{type:'image/gif'}),filename:`${name.replace(/[^a-z0-9_-]+/gi,'-').slice(0,80)||'asset'}-${options.motion}.gif`,metadata};
  }finally{world.dispose();renderer?.dispose();renderer?.forceContextLoss();}
}
