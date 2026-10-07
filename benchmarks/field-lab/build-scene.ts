import * as T from 'three';
import {createHash} from 'node:crypto';
import {writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import assert from 'node:assert/strict';
import {finalizeAsset,type Part,type Asset,type Vec3} from '../../src/lib/scene.ts';
import {makeManifest,readManifest,hydrateManifest,evaluateWorkspace,type Workspace} from '../../src/lib/workspace.ts';
import {importForm} from '../../src/lib/form.ts';
const out=process.argv[2]??'../../deliverables';mkdirSync(out,{recursive:true});
const colors={plaster:'#e1dbc7',floor:'#bfbcb0',teal:'#417b7c',dark:'#2d4148',steel:'#9eaeb0',white:'#eeeee2',orange:'#e59145',blue:'#48779c',soil:'#bda987',wood:'#a7774b',leaf:'#59785d',black:'#26353a',water:'#74aeb8'};
const hash=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const ws:Workspace={room:[17,12,3.5],items:[],animation:{duration:24,loop:true,tracks:[]}};
const specs:any[]=[];
class Shape{
 groups=new Map<string,Part>(); records:any[]=[];
 constructor(public id:string,public name:string){}
 mesh(g:T.BufferGeometry,xyz:number[],color:string,name='body',rot=[0,0,0]){
  g.applyMatrix4(new T.Matrix4().makeRotationFromEuler(new T.Euler(...rot as [number,number,number])));g.translate(...xyz as Vec3);
  const p=this.groups.get(name)??{id:this.id+'/'+name,name,vertices:[],indices:[],color:new T.Color(color).toArray() as Vec3,metadata:{representation:'Scenario-authored parametric geometry',source:'FIELD-LAB-01'}};
  const base=p.vertices.length/3;p.vertices.push(...Array.from(g.attributes.position.array).map(n=>+Number(n).toFixed(6)));p.indices.push(...Array.from(g.index!.array).map(n=>n+base));this.groups.set(name,p);g.dispose();
 }
 box(x:number,y:number,z:number,w:number,h:number,d:number,c:string,n='body',rot=[0,0,0]){this.mesh(new T.BoxGeometry(w,h,d),[x,y,z],c,n,rot);this.records.push({type:'box',position:[x,y,z],size:[w,h,d],color:c,name:n,rotation:rot});}
 cyl(x:number,y:number,z:number,r:number,h:number,c:string,n='body',rot=[0,0,0],rt=r){this.mesh(new T.CylinderGeometry(rt,r,h,20),[x,y,z],c,n,rot);this.records.push({type:'cylinder',position:[x,y,z],radius:r,topRadius:rt,height:h,color:c,name:n,rotation:rot});}
 torus(x:number,y:number,z:number,r:number,t:number,c:string,n='body'){this.mesh(new T.TorusGeometry(r,t,8,16),[x,y,z],c,n,[Math.PI/2,0,0]);this.records.push({type:'torus',position:[x,y,z],radius:r,tube:t,color:c,name:n});}
 sphere(x:number,y:number,z:number,r:number,c:string,n='body'){this.mesh(new T.SphereGeometry(r,16,10),[x,y,z],c,n);}
 add(pos:Vec3=[0,0,0],kind:'generated'|'form'='generated'){
  const parts=[...this.groups.values()];let asset:Asset;
  if(kind==='form'){
   const project={format:'form-project',version:1,project_id:'field-lab-pipette-v1',revision:1,agent:'scenario-author',project_ir:{hardware_ir_version:'0.2',overview:{title:this.name,description:'Deterministic benchmark fixture authored for this run. Not output of live Forma inference.'},assembly_metadata:{project_id:'field-lab-pipette-v1',revision:1},components:[{ref_des:'FRAME',name:'Aluminium extrusion gantry'},{ref_des:'HEAD',name:'Single-channel pipette carriage'},{ref_des:'CAM',name:'Tip inspection camera'}],bom:[{name:'Aluminium extrusion frame',quantity:1},{name:'Motion axes',quantity:3},{name:'Single-channel pipette',quantity:1},{name:'Tip inspection camera',quantity:1},{name:'Sample rack',quantity:1},{name:'Assay plate',quantity:1}],validation:{warning:[{description:'Visualization geometry; no volume accuracy, contamination, wiring, motion safety or fabrication validation.'}]},cad_model:{meshes:parts.map(p=>({name:p.name,vertices:p.vertices.flatMap((_,i,a)=>i%3===0?[a[i]*1000,-a[i+2]*1000,a[i+1]*1000]:[]),faces:p.indices}))}}};
   writeFileSync(out+'/field-lab-pipette.form.json',JSON.stringify(project));asset=importForm(project,'field-lab-pipette.form.json',hash(project));asset.parts.forEach((p,i)=>p.color=parts[i].color);
   writeFileSync(out+'/pipette-geometry-spec.json',JSON.stringify(this.records,null,2));
  }else asset=finalizeAsset({id:this.id,name:this.name,source:{kind:'generated',filename:this.id+'.generated.json',digest:hash(parts),generator:'form-industries'},parts,hierarchy:{id:this.id+'/root',name:this.name,partIds:parts.map(p=>p.id),children:[]},warnings:['Scenario-authored visualization geometry; dimensions and utility loads are benchmark assumptions.']});
  const offset=asset.originOffset;ws.items.push({id:this.id,name:this.name,asset,visible:true,position:pos.map((n,i)=>n+offset[i]) as Vec3,rotation:[0,0,0]});specs.push({id:this.id,name:this.name,position:pos,parts:parts.length,dimensions:asset.dimensions});return asset;
 }
}
const a=new Shape('site','Field-lab cutaway / 8 x 5 m');
a.box(0,-.1,0,16.5,.2,11.5,colors.soil,'ground');a.box(0,.08,0,8.35,.16,5.35,colors.floor,'slab');
a.box(0,1.53,-2.55,8.3,2.75,.16,colors.plaster,'walls');a.box(-4.07,1.53,0,.16,2.75,5.2,colors.plaster,'walls');
a.box(0,.3,2.6,8.3,.3,.13,colors.plaster,'cutaway');a.box(4.05,.3,0,.13,.3,5.2,colors.plaster,'cutaway');
for(const x of [-2.65,1.85]){a.box(x,1.96,-2.45,1.65,.9,.07,colors.dark,'windows');a.box(x,1.97,-2.395,1.49,.75,.025,'#acc1bd','glass');a.box(x,1.96,-2.36,.045,.85,.055,colors.plaster,'frames');}
for(const z of [-1.8,0,1.8]){a.box(-4,2.94,z,.18,.14,.18,colors.wood,'rafters');a.box(0,2.96,z,8.4,.12,.075,colors.wood,'rafters');}
// Cutaway omits roof and two upper walls deliberately.
a.box(-.15,.17,.42,1.25,.013,3.6,'#94b6ad','aisle');
a.box(0,.02,4.6,16.5,.025,1.5,'#ab9473','road');
for(const x of [-6,-4,-2,0,2,4,6])a.box(x,.04,4.6,.7,.013,.045,'#e9dcc6','roadmarks');
a.add();
function bench(id:string,x:number,z:number,w=1.7,d=.72){const b=new Shape(id,'Locally fabricated workbench');b.box(0,.9,0,w,.09,d,colors.white,'top');for(const dx of [-w/2+.09,w/2-.09])for(const dz of [-d/2+.08,d/2-.08])b.box(dx,.47,dz,.06,.88,.06,colors.teal,'legs');b.box(0,.35,0,w-.2,.05,d-.08,colors.wood,'shelf');b.add([x,.16,z]);}
bench('prep-bench',-2.7,1.5,1.9,.8);bench('robot-bench',-.75,-1.75,2.15,.88);bench('assay-bench',2.05,-1.72,2,.85);
const sink=new Shape('wash','Wash station / limited clean water');sink.box(0,.65,0,1.35,1,.7,colors.teal,'cabinet');sink.box(0,1.16,0,1.46,.08,.8,colors.steel,'rim');sink.box(0,1.18,0,.75,.02,.48,colors.dark,'basin');sink.cyl(.45,1.4,-.23,.025,.4,colors.steel,'tap');sink.box(.3,1.58,-.23,.3,.04,.045,colors.steel,'tap');sink.add([-3.05,.16,-1.75]);
const rig=new Shape('pipette','Form fixture / camera-equipped pipetting station');
rig.box(0,.055,0,1.12,.11,.76,colors.white,'base');
for(const x of [-.5,.5])for(const z of [-.3,.3])rig.box(x,.38,z,.045,.65,.045,colors.steel,'frame');
for(const z of [-.3,.3])rig.box(0,.7,z,1.08,.045,.045,colors.steel,'frame');
for(const x of [-.5,.5])rig.box(x,.7,0,.045,.045,.65,colors.steel,'frame');
rig.box(0,.69,0,.075,.075,.63,colors.dark,'gantry');rig.box(0,.605,.03,.12,.15,.13,colors.orange,'head');rig.cyl(0,.442,.03,.025,.18,colors.white,'pipette');rig.cyl(0,.322,.03,.014,.06,colors.orange,'tip',[],.003);
rig.box(.08,.50,.085,.08,.055,.055,colors.dark,'camera');rig.cyl(.08,.462,.085,.017,.025,'#629caa','camera-lens');
rig.box(-.27,.135,.04,.27,.055,.42,colors.blue,'rack');rig.box(.29,.125,.04,.32,.032,.45,colors.teal,'plate');
for(let x=0;x<3;x++)for(let z=0;z<5;z++){rig.cyl(-.36+x*.09,.195,-.10+z*.07,.022,.095,colors.white,'sample-tubes');rig.torus(-.36+x*.09,.25,-.10+z*.07,.020,.004,colors.orange,'tube-rims');rig.cyl(.2+x*.085,.149,-.10+z*.07,.022,.016,colors.dark,'plate-wells');}
rig.box(-.44,.16,-.26,.14,.18,.13,colors.dark,'electronics');
const rigAsset=rig.add([-.78,1.105,-1.7],'form');
const assay=new Shape('instruments','Microscope, photometer and centrifuge');
assay.box(-.49,.035,0,.33,.07,.34,colors.dark,'scope');assay.box(-.57,.21,.09,.08,.38,.09,colors.white,'scope');assay.box(-.49,.3,-.03,.28,.045,.18,colors.dark,'scope-stage');assay.cyl(-.44,.44,.02,.048,.19,colors.white,'scope-tube',[.45,0,0]);assay.cyl(-.44,.525,.06,.028,.07,colors.dark,'eyepiece',[.45,0,0]);
assay.cyl(.1,.16,0,.225,.29,colors.white,'centrifuge');assay.cyl(.1,.314,0,.21,.025,colors.teal,'centrifuge-lid');assay.cyl(.1,.34,0,.025,.025,colors.orange,'lid-knob');
assay.box(.65,.13,0,.35,.26,.32,colors.white,'reader');assay.box(.65,.266,-.02,.24,.017,.1,colors.blue,'reader-screen');assay.add([2,1.105,-1.7]);
const prep=new Shape('sample-prep','Sample intake and recording');prep.box(-.3,.07,0,.6,.14,.3,colors.teal,'crate');for(const x of [-.5,-.3,-.1])for(const z of [-.07,.07]){prep.cyl(x,.22,z,.036,.22,colors.water,'bottles');prep.cyl(x,.335,z,.037,.026,colors.orange,'caps');}prep.box(.5,.02,0,.32,.03,.25,colors.dark,'laptop');prep.box(.5,.18,-.12,.32,.29,.02,colors.dark,'laptop');prep.box(.5,.19,-.105,.28,.23,.005,colors.blue,'screen');prep.add([-2.7,1.105,1.5]);
const storage=new Shape('stock','Dry consumables and cool storage');storage.box(0,.72,0,1.2,1.44,.58,colors.teal,'cabinet');for(const yy of [.32,.8,1.26]){storage.box(0,yy,.32,1.08,.07,.13,colors.wood,'shelves');for(const xx of [-.34,0,.34])storage.box(xx,yy+.14,.34,.26,.23,.28,yy>.9?colors.orange:colors.white,'boxes');}storage.add([3.28,.16,.15]);
const cold=new Shape('cooler','Insulated DC cold storage / assumed load');cold.box(0,.38,0,.76,.76,.68,colors.white,'body');cold.box(0,.79,0,.8,.07,.72,colors.teal,'lid');cold.box(0,.58,.36,.19,.06,.03,colors.dark,'handle');cold.add([1.62,.16,.6]);
const bins=new Shape('waste','Separated solid / liquid waste');for(const [i,c] of [colors.teal,colors.orange].entries()){bins.cyl(i*.48,.28,0,.18,.56,c,'bin'+i);bins.cyl(i*.48,.58,0,.2,.035,colors.dark,'lid'+i);}bins.add([2.65,.16,1.78]);
const water=new Shape('water','Clean water storage / gravity feed');water.box(0,.13,0,1.45,.26,1.25,colors.floor,'plinth');water.cyl(0,1.03,0,.52,1.5,colors.water,'tank');water.cyl(0,1.79,0,.49,.04,colors.teal,'top');for(const yy of [.46,.95,1.48])water.cyl(0,yy,0,.531,.04,colors.teal,'bands');water.cyl(0,.43,.65,.026,.36,colors.steel,'outlet',[Math.PI/2,0,0]);water.box(.42,.18,.52,.23,.34,.18,colors.orange,'jerrycan');water.add([-5.25,0,3.0]);
const solar=new Shape('solar','1.0 kWp conceptual solar array');
for(const x of [-.62,.62]){solar.box(x,.92,0,1.16,.07,1.7,colors.steel,'frame',[-.27,0,0]);solar.box(x,.96,0,1.07,.02,1.61,'#294965','cells',[-.27,0,0]);for(let k=-3;k<4;k++)solar.box(x,.97-k*.059,k*.21,1.03,.012,.012,'#91a7b7','grid');for(const z of [-.55,.55])solar.box(x,.45,z,.055,.9,.055,colors.steel,'legs');}solar.add([5.75,0,-2.1]);
const batt=new Shape('battery','Battery / charge controller');batt.box(0,.37,0,.82,.74,.65,colors.teal,'case');batt.box(0,.78,0,.9,.07,.73,colors.dark,'top');batt.box(.12,.57,.335,.3,.16,.02,colors.dark,'panel');batt.box(.12,.57,.35,.25,.10,.005,colors.blue,'display');batt.add([5.3,0,-.6]);
const repair=new Shape('repair','Local repair bench / hand tools');repair.box(0,.81,0,1.7,.08,.74,colors.wood,'top');for(const x of [-.7,.7])repair.box(x,.4,0,.075,.8,.59,colors.dark,'legs');repair.box(-.48,.93,0,.25,.2,.24,colors.blue,'vice');for(let i=0;i<4;i++)repair.box(.1+i*.17,.863,.06,.09,.025,.27,colors.steel,'tools');repair.box(.1,.89,-.2,.48,.07,.11,colors.orange,'toolbox');repair.add([5.7,0,1.25]);
const crate=new Shape('delivery-crates','Replenishment / tips, assay kits, water');for(const x of [0,.57]){crate.box(x,.22,0,.49,.44,.44,colors.wood,'wood');for(const z of [-.227,.227])for(const y of [.10,.32])crate.box(x,y,z,.51,.05,.025,colors.dark,'bands');}crate.add([-4.8,0,2]);
function person(id:string,pos:Vec3,shirt:string){const p=new Shape(id,'Field technician');p.cyl(0,.59,0,.07,.7,colors.dark,'trousers');p.cyl(.20,.59,0,.07,.7,colors.dark,'trousers');p.box(.1,.15,.045,.33,.1,.25,colors.black,'boots');p.box(.1,1.06,0,.40,.51,.26,shirt,'coat');p.cyl(-.15,.99,0,.061,.44,shirt,'arms');p.cyl(.35,.99,0,.061,.44,shirt,'arms');p.sphere(.1,1.48,0,.135,'#805b44','head');p.cyl(.1,1.61,0,.15,.045,colors.white,'cap');p.add(pos);}
person('technician-1',[-1.62,.16,-.68],colors.white);person('technician-2',[-2.73,.16,.63],colors.teal);
const cart=new Shape('sample-cart','Sample transfer trolley');cart.box(0,.61,0,.5,.05,.38,colors.steel,'tray');cart.box(0,.25,0,.5,.04,.38,colors.teal,'lower');for(const x of [-.21,.21])for(const z of [-.15,.15]){cart.box(x,.36,z,.025,.6,.025,colors.steel,'legs');cart.cyl(x,.055,z,.055,.027,colors.dark,'wheels',[0,0,Math.PI/2]);}cart.box(0,.7,0,.32,.14,.25,colors.orange,'sample-box');cart.add([-1.2,.16,1.2]);
const bike=new Shape('courier','District delivery / cargo motorbike');for(const x of [-.6,.6]){bike.cyl(x,.32,0,.31,.13,colors.black,'tires',[Math.PI/2,0,0]);bike.cyl(x,.32,.075,.22,.03,colors.steel,'hubs',[Math.PI/2,0,0]);}bike.box(0,.51,0,1.1,.14,.16,colors.teal,'frame');bike.box(.07,.78,0,.65,.13,.31,colors.dark,'seat');bike.box(-.35,.87,0,.55,.48,.58,colors.orange,'cargo');bike.box(.52,.74,0,.06,.74,.06,colors.steel,'fork',[0,0,-.27]);bike.box(.35,1.1,0,.07,.045,.6,colors.dark,'handle');bike.add([-7,0,4.3]);
// Dryland planting and rocks are site geometry, not a claimed geographic depiction.
const landscape=new Shape('landscape','Site planting and drainage');for(const [x,z] of [[-6.6,-4.3],[7.3,3],[6.7,-4.8],[-6,3]]){landscape.cyl(x,.55,z,.065,1.1,colors.wood,'trunks');landscape.sphere(x,1.2,z,.6,colors.leaf,'canopy');}landscape.add();
function track(instanceId:string,name:string,values:{t:number,p?:Vec3,r?:Vec3}[],partId?:string){const item=ws.items.find(x=>x.id===instanceId)!;ws.animation.tracks.push({id:instanceId+':'+(partId??'instance'),instanceId,...(partId?{partId}:{}),keys:values.map((v,i)=>({id:name+i,time:v.t,position:v.p??(partId?[0,0,0]:item.position),rotation:v.r??[0,0,0]}))});}
const headParts=['head','pipette','tip','camera','camera-lens'];
for(const name of ['gantry',...headParts]){const p=rigAsset.parts.find(p=>p.name===name)!;track('pipette',name,[0,3,5,7,9,11,13,15,17,19,21,24].map((t,i)=>({t,p:[[-.27,-.27,-.27,.29,.29,.29,-.27,-.27,.29,.29,-.27,-.27][i],headParts.includes(name)&&[2,4,7,9].includes(i)?-.09:0,0] as Vec3})),p.id);}
const ci=ws.items.find(i=>i.id==='sample-cart')!;const origin=ci.asset.originOffset;track('sample-cart','cart',[{t:0,p:[-1.15+origin[0],.16+origin[1],1.2+origin[2]]},{t:4,p:[-.3+origin[0],.16+origin[1],1.2+origin[2]]},{t:8,p:[-.3+origin[0],.16+origin[1],-.75+origin[2]]},{t:12,p:[-.3+origin[0],.16+origin[1],-.75+origin[2]]},{t:16,p:[.7+origin[0],.16+origin[1],-.75+origin[2]]},{t:20,p:[.7+origin[0],.16+origin[1],1.2+origin[2]]},{t:24,p:[-1.15+origin[0],.16+origin[1],1.2+origin[2]]}]);
track('courier','courier',[{t:0,p:[-7,0,4.3]},{t:7,p:[-4.4,0,4.3]},{t:12,p:[-4.4,0,4.3]},{t:21,p:[7,0,4.3]},{t:24,p:[7,0,4.3]}]);
const manifest=makeManifest(ws,true);const reopen=hydrateManifest(readManifest(manifest),[]);assert(reopen.items.every(i=>!i.missing));assert.equal(reopen.items.length,ws.items.length);assert.deepEqual(evaluateWorkspace(reopen.items,reopen.animation,11),evaluateWorkspace(ws.items,ws.animation,11));
writeFileSync(out+'/field-lab.oi.json',JSON.stringify(manifest));writeFileSync(out+'/scene-inventory.json',JSON.stringify(specs,null,2));
writeFileSync(out+'/scene-checks.json',JSON.stringify({items:ws.items.length,assets:manifest.bundledAssets?.length,triangles:ws.items.reduce((n,i)=>n+i.asset.parts.reduce((a,p)=>a+p.indices.length/3,0),0),tracks:ws.animation.tracks.length,portableRoundTrip:true,missingGeometry:0,formAdapter:'passed; scenario-authored fixture; not live generation',bounds:'8 x 5 m interior within 17 x 12 m site',animation:'Authored kinematics; no collision, liquid or assay solver'},null,2));
console.log('Built',ws.items.length,'instances;',ws.animation.tracks.length,'animation tracks; native portable round-trip passed.');
