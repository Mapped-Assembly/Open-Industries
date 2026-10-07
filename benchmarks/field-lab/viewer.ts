import * as THREE from 'three';
import {createWorld,applyWorldPoses} from '../../src/lib/world';
import {hydrateManifest,readManifest,evaluateWorkspace} from '../../src/lib/workspace';
import {renderGif} from '../../src/lib/gif';
const manifest=await (await fetch('/field-lab-assets/field-lab.oi.json')).json();
const evidence=await (await fetch('/field-lab-assets/field-lab-results.json')).json();
const ws=hydrateManifest(readManifest(manifest),[]),assets=ws.items.map(i=>i.asset);
const world=createWorld(assets,ws.room);world.environment.visible=false;world.scene.background=new THREE.Color('#e8e4d9');
world.scene.children.forEach(o=>{if(o instanceof THREE.HemisphereLight)o.intensity=2;if(o instanceof THREE.DirectionalLight){o.intensity=2.5;o.position.set(-6,12,9);o.castShadow=true;o.shadow.mapSize.set(2048,2048);o.shadow.camera.left=-12;o.shadow.camera.right=12;o.shadow.camera.top=12;o.shadow.camera.bottom=-12;o.shadow.bias=-.001;o.shadow.normalBias=.025;}});
world.scene.traverse((o:any)=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;if(o.material){o.material.roughness=.8;o.material.metalness=.05;}}});
const renderer=new THREE.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setSize(1110,688);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
const camera=new THREE.PerspectiveCamera(36,1110/688,.01,120);
const canvas=document.getElementById('output') as HTMLCanvasElement,ctx=canvas.getContext('2d')!;
const dark='#244b4d',muted='#6a7773',orange='#c47636',cream='#f5f2e9',teal='#46837c',line='#d3d8cf';
function txt(s:string,x:number,y:number,size=16,color=dark,weight=400){ctx.font=`${weight} ${size}px Arial, sans-serif`;ctx.fillStyle=color;ctx.fillText(s,x,y);}
function box(x:number,y:number,w:number,h:number,fill:string,r=0){ctx.fillStyle=fill;ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fill();}
function rule(x:number,y:number,w:number){box(x,y,w,1,line);}
function tag(s:string,x:number,y:number,fill=dark){ctx.font='bold 11px Arial';const w=ctx.measureText(s).width+20;box(x,y-16,w,23,fill,3);txt(s,x+10,y,11,'#fff',700);}
function label(name:string,pos:number[],dx=0,dy=0){const p=new THREE.Vector3(...pos).project(camera);const x=(p.x+1)*.5*1110,y=(1-p.y)*.5*688+108;const px=x+dx,py=y+dy;ctx.strokeStyle='#69847b';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(px,py);ctx.stroke();ctx.fillStyle=teal;ctx.beginPath();ctx.arc(x,y,3,0,Math.PI*2);ctx.fill();ctx.font='bold 12px Arial';const w=ctx.measureText(name).width+16;box(px-w/2,py-23,w,25,'#f7f4ec',3);txt(name,px-w/2+8,py-6,12,dark,700);}
function clock(m:number){const h=8+Math.floor(m/60);return `${String(h).padStart(2,'0')}:${String(Math.floor(m%60)).padStart(2,'0')}`;}
function resource(label:string,value:string,f:number,y:number,color=teal){txt(label,1140,y,12,muted,600);txt(value,1140,y+25,23,dark,600);box(1140,y+36,254,5,'#dbe0d6',2);box(1140,y+36,254*Math.max(0,Math.min(1,f)),5,color,2);}
function miniChart(y:number){txt('24-SAMPLE DAY / OUTCOMES',1140,y,11,muted,700);const titles=['Normal supply','Missed delivery','Low power','Water ration','Combined','With resilience'];evidence.results.forEach((r:any,i:number)=>{const yy=y+26+i*26;txt(titles[i],1140,yy,11,muted);box(1248,yy-9,117,9,'#e0e3d9',2);box(1248,yy-9,117*r.processed/24,9,i===5?teal:i===0?dark:orange,2);txt(String(r.processed),1375,yy,12,dark,700);});}
function sampleState(result:any,fraction:number){const n=Math.min(31,Math.max(0,Math.floor(fraction*32)));return result.timeline[n];}
function render(t:number,mode='film'){
 let scenario='baseline',f=Math.min(t/8,1),detail=t>=8&&t<13,phase='01 / THE FIELD LAB';
 if(t>=13&&t<18.5){scenario='combined';f=(t-13)/5.5;phase='03 / SUPPLY + POWER SHOCK';}
 if(t>=18.5){scenario='resilience';f=(t-18.5)/5.5;phase='04 / KEEP THE LAB RUNNING';}
 if(detail)phase='02 / PIPETTING WITH TIP CAMERA';
 const result=evidence.results.find((r:any)=>r.id===scenario),state=sampleState(result,f);
 const poseTime=(!detail&&state.reasons.length)?0:t%24;const poses=evaluateWorkspace(ws.items,ws.animation,poseTime);applyWorldPoses(world.groups,poses);
 const courier=world.groups[ws.items.findIndex(i=>i.id==='courier')];courier.visible=scenario==='baseline'&&!detail;
 if(mode==='hero'){detail=false;scenario='baseline';}
 if(detail){camera.position.set(1.4,2.76,1.3);camera.lookAt(-.77,1.52,-1.58);camera.fov=38;}
 else{const swing=mode==='hero'?0:Math.sin(t/24*Math.PI)*.5;camera.position.set(12.1+swing,12.8,16.7);camera.lookAt(.1,.25,.3);camera.fov=36;}
 camera.updateProjectionMatrix();renderer.render(world.scene,camera);
 box(0,0,1440,900,cream);box(0,0,1440,6,dark);txt('FIELD LAB / 01',36,41,13,teal,700);txt('A small lab. A fragile supply line.',36,86,35,dark,600);
 txt('OPEN-INDUSTRIES',1138,40,13,dark,700);txt('RESOURCE SCARCITY BENCHMARK',1138,63,10,muted,600);txt('Main 810f182  •  05 OCT 2026',1138,84,11,muted);
 ctx.drawImage(renderer.domElement,0,108);box(0,108,1110,1,line);box(1110,108,330,688,'#f8f6ee');box(1110,108,1,688,line);
 tag(phase,28,139,scenario==='combined'?orange:dark);tag(detail?'KINEMATIC DETAIL':'8-HOUR SYNTHETIC DAY',28,171,'#708779');
 if(!detail){label('PIPETTING + TIP CAMERA',[-.7,1.77,-1.7],-32,-49);label('WATER',[-5.25,1.8,3.0],-50,-34);label('SOLAR + STORAGE',[5.7,1.35,-1.8],65,-34);label('LOCAL REPAIR',[5.7,1.05,1.2],40,26);label('SAMPLE INTAKE',[-2.7,1.55,1.5],-56,39);}
 else{const gi=ws.items.findIndex(i=>i.id==='pipette');const cp=assets[gi].parts.find(p=>p.name==='camera')!;const cm=world.groups[gi].children.find(o=>o.userData.partId===cp.id)!;const cv=new THREE.Box3().setFromObject(cm).getCenter(new THREE.Vector3()).toArray();label('TIP CAMERA',cv,180,-90);label('SAMPLE RACK',[-1.05,1.32,-1.65],-96,60);label('ASSAY PLATE',[-.49,1.255,-1.66],108,67);}
 txt(detail?'Equipment detail':result.name,1140,143,19,dark,700);txt(detail?'Authored motion / no liquid solver':`Simulated time ${clock(state.minute)}  /  08:00–16:00`,1140,166,12,muted);
 txt(String(state.processed).padStart(2,'0'),1138,238,65,dark,600);txt('/ 24',1230,235,25,muted);txt('SAMPLE JOBS COMPLETED',1140,260,11,muted,700);
 rule(1140,280,254);resource('BATTERY',`${Math.round(state.batteryWh)} Wh`,state.batteryWh/1000,308,state.batteryWh<100?orange:teal);
 resource('CLEAN WATER',`${state.waterL.toFixed(1)} L`,state.waterL/16,385,state.waterL<1?orange:teal);
 txt('TIPS / ASSAY CONSUMABLES',1140,467,11,muted,700);txt(`${state.tips} tips  ·  ${state.kits} kits`,1140,492,22,dark,600);
 const stalled=state.reasons.length>0;tag(stalled?'WAIT: '+state.reasons.join(' + ').toUpperCase():state.processed===24?'DAILY TARGET COMPLETE':'RESOURCES AVAILABLE',1140,526,stalled?orange:teal);
 rule(1140,552,254);miniChart(578);
 box(28,728,660,44,'#f7f4ec',4);txt(scenario==='combined'?'No delivery · 20% solar · 350 Wh starting battery':scenario==='resilience'?'Spare kits + tips · 4.5 L extra water · 40 W deferred load':'District depot → motorbike → lab · local repair on site',44,756,16,dark,600);
 rule(32,810,1375);txt('40 m² LAB',34,839,12,dark,700);txt('24 SAMPLE JOBS',219,839,12,dark,700);txt('6 SCENARIOS',444,839,12,dark,700);txt('21 SCENE INSTANCES',631,839,12,dark,700);
 txt('Native OI geometry + animation  /  added deterministic resource ledger',34,872,13,muted);txt('Conceptual geometry. Synthetic loads. No assay or physics validation.',881,872,11,muted);
 const progress=Math.min(t/24,1);box(0,893,1440,7,'#c8d1c5');box(0,893,1440*progress,7,teal);
 document.getElementById('status')!.textContent=`${t.toFixed(1)} s · ${phase}`;
 return {scenario,processed:state.processed,detail,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles};
}
(window as any).frame=render;(window as any).ws=ws;(window as any).nativeGif=async()=>{const r=await renderGif(assets,ws.room,{scope:'room',assetIndex:0,region:{x:0,z:0,width:17,depth:12},motion:'animation',size:640,duration:3,fps:10,rangeStart:0,rangeEnd:3},new AbortController().signal,()=>{},ws);return{bytes:Array.from(new Uint8Array(await r.blob.arrayBuffer())),metadata:r.metadata};};
(window as any).ready=true;render(2,'hero');let playing=false,last=performance.now(),time=0;document.getElementById('play')!.onclick=()=>{playing=!playing;last=performance.now();};document.getElementById('time')!.oninput=(e:any)=>{time=Number(e.target.value);playing=false;render(time);};function tick(now:number){if(playing){time=(time+(now-last)/1000)%24;render(time);(document.getElementById('time') as HTMLInputElement).value=String(time);}last=now;requestAnimationFrame(tick);}requestAnimationFrame(tick);
