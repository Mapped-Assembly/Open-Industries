import { BoxGeometry, Euler, Matrix4, Vector3 } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { finalizeAsset, type Asset, type Part, type Vec3 } from './scene';
import type { Workspace, SceneItem } from './workspace';

export type RunSnapshot = {
  run_id:string; scene_id:string; scene_revision:number; revision:number; mode:string; policy_mode:string;
  healthy:boolean; skills:string[];
  objects:{id:string;name:string;position_m:Vec3;size_m:Vec3}[];
  destination:{id:string;position_m:Vec3;size_m:Vec3};
  robot:{frames:Record<string,number[][]>;tcp_m:Vec3;model_sha256:string};
  task:null|{id:string;stage:string;progress:number;skill?:string;reason?:string;command_id:string;result?:unknown};
  messages:{id:string;role:string;text:string;task_id:string|null}[];
  observations:{id:string;kind:string;task_id:string}[];
};
type ModelManifest={links:Record<string,{url:string;origin:number[][];scale:Vec3}[]>};
const basis=new Matrix4().set(1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1);
const inverse=basis.clone().invert();
const matrix=(rows:number[][])=>new Matrix4().fromArray(rows.flat()).transpose();
const vector=(value:Vec3)=>new Vector3(...value).applyMatrix4(basis).toArray() as Vec3;

/** Load only pinned upstream meshes; each asset retains its source link coordinates. */
export async function loadRobotAssets():Promise<Record<string,Asset>> {
  const response=await fetch('/api/embodied/model');
  if(!response.ok)throw Error('Robot model unavailable; reconnect to the local station.');
  const manifest:ModelManifest=await response.json();
  const entries=await Promise.all(Object.entries(manifest.links).map(async([link,visuals])=>{
    if(!visuals.length)return [link,null] as const;
    const parts:Part[]=await Promise.all(visuals.map(async(visual,index)=>{
      const response=await fetch(visual.url);if(!response.ok)throw Error('Pinned robot mesh missing');
      const geometry=new STLLoader().parse(await response.arrayBuffer());
      geometry.scale(...visual.scale);geometry.applyMatrix4(matrix(visual.origin));geometry.applyMatrix4(basis);
      const vertices=Array.from(geometry.getAttribute('position').array);
      const indices=geometry.index?Array.from(geometry.index.array):Array.from({length:vertices.length/3},(_,i)=>i);
      geometry.dispose();
      return {id:`${link}:${index}`,name:link,vertices,indices,color:[.28,.36,.43],metadata:{source:'TheRobotStudio SO-101 pinned STL'}};
    }));
    return [link,finalizeAsset({id:`so101:${link}`,name:link,parts,hierarchy:{id:link,name:link,partIds:parts.map(p=>p.id),children:[]},source:{kind:'generated',filename:'so101_new_calib.urdf',digest:'pinned-upstream-so101',generator:'opencad-robot'},warnings:['Kinematic visualization; contact/collision not validated.']})] as const;
  }));
  return Object.fromEntries(entries.filter((entry):entry is readonly [string,Asset]=>entry[1]!==null));
}

/** Build a fixture primitive without assigning it any machine skills. */
function box(id:string,size:Vec3,color:Vec3):Asset {
  const geometry=new BoxGeometry(size[0],size[2],size[1]);
  const vertices=Array.from(geometry.getAttribute('position').array),indices=Array.from(geometry.index!.array);
  geometry.dispose();
  return finalizeAsset({id,name:id,source:{kind:'generated',filename:'tabletop-v1',digest:'tabletop-v1',generator:'form-industries'},
    parts:[{id,name:id,vertices,indices,color,metadata:{evidence:'authored fixture'}}],hierarchy:{id,name:id,partIds:[id],children:[]},warnings:[]});
}

/** Apply authoritative link/object transforms with empty keyframe tracks in Run mode. */
export function runWorkspace(run:RunSnapshot,assets:Record<string,Asset>):Workspace {
  const items:SceneItem[]=Object.entries(assets).map(([link,asset])=>{
    const transform=basis.clone().multiply(matrix(run.robot.frames[link])).multiply(inverse);
    const position=new Vector3(...asset.originOffset).applyMatrix4(transform).toArray() as Vec3;
    const rotation=new Euler().setFromRotationMatrix(transform).toArray().slice(0,3).map(v=>Number(v)*180/Math.PI) as Vec3;
    return {id:link,name:link,asset,position,rotation,visible:true};
  });
  for(const object of [...run.objects,{...run.destination,name:'Marked destination'}]) {
    const asset=box(object.id,object.size_m,object.id==='red-block'?[.9,.18,.12]:object.id==='blue-block'?[.12,.35,.9]:[.3,.8,.4]);
    // finalizeAsset moves the box's bottom to zero; restore its authored centre.
    const centre=vector(object.position_m);
    items.push({id:object.id,name:object.name,asset,position:[centre[0],centre[1]-object.size_m[2]/2,centre[2]],rotation:[0,0,0],visible:true});
  }
  return {room:[1,1,1],items,animation:{duration:0,loop:false,tracks:[]}};
}
