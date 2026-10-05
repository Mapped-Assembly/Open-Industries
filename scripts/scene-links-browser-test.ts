import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { chromium, expect, type BrowserContext } from '@playwright/test';
import { sceneLinkDB } from './lib/scene-link-db.ts';
import { importForm } from '../src/lib/form.ts';
import { appendAssets, emptyWorkspace, makeManifest, writeKeyframe } from '../src/lib/workspace.ts';
import { sceneAssetHandler } from '../supabase/functions/scene-asset/handler.mjs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';

// No live services are used. Start the test server in this process by default.
let base=process.env.ASTRA_BASE_URL;
let server:Awaited<ReturnType<typeof createServer>>|undefined;
if(!base){
  process.env.VITE_SUPABASE_URL='https://scene-links.example.invalid';
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY='scene-links-test';
  process.env.VITE_CLOUD_STORAGE_ENABLED='true';
  server=await createServer({server:{host:'127.0.0.1',port:4173}});
  await server.listen();base=server.resolvedUrls!.local[0];
}
base=base.replace(/\/$/,'');
const {db,asUser,rpc}=await sceneLinkDB();
const owner=randomUUID(),other=randomUUID(),id=randomUUID(),version=randomUUID(),assetRow=randomUUID();
const asset=importForm({hardware_ir_version:'0.2',overview:{title:'Animated fixture'},mechanical:{render_dimensions:{x_mm:400,y_mm:500,z_mm:600}}},'fixture.json','fixture-digest');
const bundle=JSON.stringify({schemaVersion:1,asset});
const file={name:'asset.json',size:Buffer.byteLength(bundle),sha256:createHash('sha256').update(bundle).digest('hex'),mime:'application/json'};
let ws=appendAssets(emptyWorkspace(),[asset],version);
ws.animation=writeKeyframe(ws.animation,ws.items[0].id,undefined,{id:'start',time:0,position:[0,0,0],rotation:[0,0,0]});
ws.animation=writeKeyframe(ws.animation,ws.items[0].id,undefined,{id:'finish',time:2,position:[2,0,0],rotation:[0,90,0]});
const browser=await chromium.launch({headless:true,...(process.env.ASTRA_CHROME_PATH?{executablePath:process.env.ASTRA_CHROME_PATH}:{})});
const errors:string[]=[];
let unavailable=false;
// Serialize the emulated request role, just as separate PostgREST transactions do.
let queue=Promise.resolve();
function serialized<T>(fn:()=>Promise<T>):Promise<T>{const next=queue.then(fn);queue=next.then(()=>{},()=>{});return next;}
const proxy=sceneAssetHandler({rpc:async(name:string,args:any)=>{try{return {data:await serialized(()=>asUser(null,()=>rpc(name,[args.p_id,args.p_revision,args.p_share_token]))),error:null};}catch(e){return {error:{message:(e as Error).message}};}}}, {from:()=>({download:async()=>unavailable?{error:{message:'missing'}}:{data:new Blob([bundle]),error:null}})});
async function context(userId:string|null=null):Promise<BrowserContext>{
  const context=await browser.newContext();
  if(userId){
    const user={id:userId,aud:'authenticated',role:'authenticated',email:'fixture@example.invalid',user_metadata:{},app_metadata:{},created_at:new Date().toISOString()};
    const jwt=[Buffer.from('{"alg":"HS256"}').toString('base64url'),Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'signature'].join('.');
    await context.addInitScript(({jwt,user,origin})=>{if(location.origin===origin)localStorage.setItem('sb-scene-links-auth-token',JSON.stringify({access_token:jwt,refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600,expires_in:3600,token_type:'bearer',user}));},{jwt,user,origin:new URL(base!).origin});
  }
  await context.route('https://scene-links.example.invalid/**',async route=>{
    const url=new URL(route.request().url());
    if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers:{'access-control-allow-origin':'*','access-control-allow-headers':'*'}});
    if(url.pathname.endsWith('/functions/v1/scene-asset')){
      const response=await proxy(new Request(url,{method:'POST',body:route.request().postData()}));
      return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
    }
    if(url.pathname.includes('/storage/v1/object/'))return route.fulfill({status:unavailable?404:200,body:unavailable?'missing':bundle,contentType:'application/json'});
    if(url.pathname.includes('/rest/v1/rpc/')){
      const name=url.pathname.split('/').at(-1)!;const args=route.request().postDataJSON();
      const values=name==='get_workspace_scene'?[args.p_id,args.p_revision,args.p_share_token]:name==='create_scene_share'?[args.p_id,args.p_revision]:[args.p_id];
      try{const data=await serialized(()=>asUser(userId,()=>rpc(name,values)));return route.fulfill({json:data});}
      catch(e){return route.fulfill({status:400,json:{message:(e as Error).message}});}
    }
    if(url.pathname==='/rest/v1/scenes')return route.fulfill({json:[]});
    return route.fulfill({json:{}});
  });
  context.on('page',page=>page.on('pageerror',e=>errors.push(e.message)));
  return context;
}
async function snapshot(page:any){return page.evaluate(async()=>{const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('astra-scenes',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});const rows=await new Promise((resolve,reject)=>{const tx=db.transaction(['scenes','assets'],'readonly');const scenes=tx.objectStore('scenes').getAll(),assets=tx.objectStore('assets').getAll();tx.oncomplete=()=>resolve({scenes:scenes.result,assets:assets.result});tx.onerror=()=>reject(tx.error);});db.close();return rows;});}
try{
  await db.query('insert into auth.users values($1),($2)',[owner,other]);
  await db.query("insert into public.assets(id,owner_id,asset_key,name,source_kind) values($1,$2,$3,'Fixture','form')",[assetRow,owner,asset.id]);
  await db.query("insert into public.asset_file_versions(id,owner_id,asset_id,fingerprint,state,files) values($1,$2,$3,'fixture','ready',$4)",[version,owner,assetRow,JSON.stringify([file])]);
  const saved=await asUser(owner,()=>rpc('save_workspace_scene',[id,'Linked animation',makeManifest(ws),0,randomUUID()]));
  const share=await asUser(owner,()=>rpc('create_scene_share',[id,1]));
  await asUser(owner,()=>rpc('save_workspace_scene',[id,'Latest animation',makeManifest({...ws,room:[9,6,3]}),1,randomUUID()]));
  const guest=await context();const page=await guest.newPage();
  await page.goto(base);await expect(page.getByLabel('Width',{exact:true})).toBeEnabled();
  await page.getByLabel('Width',{exact:true}).fill('11');await expect(page.getByLabel('Local draft status')).toHaveText('Local draft saved');
  let before=await snapshot(page);
  await page.goto(new URL(share.url,base).href);
  await expect(page.getByLabel('Scene link',{exact:true})).toContainText('Linked animation · revision 1');
  await expect(page.locator('.asset')).toContainText('Animated fixture');
  await expect(page.locator('.asset')).not.toContainText('MISSING');
  await page.locator('.asset').click();await page.getByLabel('Keyframe time',{exact:true}).fill('1');
  await expect(page.getByLabel('Keyframe position X',{exact:true})).toHaveValue('1');
  await page.getByLabel('Width',{exact:true}).fill('12');
  await page.getByRole('button',{name:'Play animation',exact:true}).click();await expect(page.getByRole('button',{name:'Pause animation',exact:true})).toBeVisible();
  assert.deepEqual(await snapshot(page),before);
  await page.getByRole('link',{name:'Return to saved workspace'}).click();await expect(page.getByLabel('Width',{exact:true})).toHaveValue('11');
  await expect(page.getByLabel('Local draft status')).toHaveText('Local draft saved');before=await snapshot(page);
  // A clean browser receives both the saved geometry and the same authored motion.
  const fresh=await context();const copied=await fresh.newPage();await copied.goto(new URL(share.url,base).href);
  await expect(copied.getByLabel('Scene link',{exact:true})).toContainText('revision 1');await copied.locator('.asset').click();await copied.getByLabel('Keyframe time',{exact:true}).fill('1');
  await expect(copied.getByLabel('Keyframe position X',{exact:true})).toHaveValue('1');
  await mkdir('test-results',{recursive:true});await copied.screenshot({path:'test-results/scene-link.png',fullPage:true});
  const signed=await context(owner);const privatePage=await signed.newPage();await privatePage.goto(new URL(saved.head_url,base).href);
  await expect(privatePage.getByLabel('Scene link',{exact:true})).toContainText('revision 2');await expect(privatePage.getByLabel('Width',{exact:true})).toHaveValue('9');
  await privatePage.goto(new URL(saved.revision_url,base).href);await expect(privatePage.getByLabel('Scene link',{exact:true})).toContainText('revision 1');await expect(privatePage.getByLabel('Width',{exact:true})).toHaveValue('6');
  await privatePage.getByRole('button',{name:'Create shared revision link',exact:true}).click();await expect(privatePage.getByLabel('Shared revision URL')).toHaveValue(/#share=/);
  await privatePage.getByRole('button',{name:'Revoke all shared links',exact:true}).click();await expect(privatePage.getByLabel('Scene save status')).toContainText('revoked');
  await copied.reload();await expect(copied.getByRole('alert')).toContainText('expired, or revoked');
  await page.goto(new URL(saved.revision_url,base).href);await expect(page.getByRole('alert')).toContainText('Sign in');assert.deepEqual(await snapshot(page),before);
  const wrong=await context(other);const denied=await wrong.newPage();await denied.goto(new URL(saved.revision_url,base).href);await expect(denied.getByRole('alert')).toContainText('not found or access denied');
  await privatePage.goto(`${base}/?sceneId=${randomUUID()}`);await expect(privatePage.getByRole('alert')).toContainText('not found or access denied');
  await privatePage.goto(`${base}/?sceneId=${id}&revision=999`);await expect(privatePage.getByRole('alert')).toContainText('revision not found');
  const latestShare=await serialized(()=>asUser(owner,()=>rpc('create_scene_share',[id,1])));
  unavailable=true;await copied.goto(new URL(latestShare.url,base).href);await expect(copied.getByRole('alert')).toContainText('Unavailable assets');await expect(copied.locator('.asset')).toContainText('MISSING GEOMETRY');
  // Private-link OAuth handoff preserves the route and leaves the local draft alone.
  await page.route('**/auth/v1/settings',route=>route.fulfill({json:{external:{github:true}}}));
  let redirectTo='';
  await page.route('**/auth/v1/authorize?**',route=>{
    redirectTo=new URL(route.request().url()).searchParams.get('redirect_to')!;
    return route.fulfill({status:302,headers:{location:`${redirectTo}&error=access_denied`}});
  });
  await page.getByRole('button',{name:'Sign in with GitHub',exact:true}).click();
  await expect(page.locator('.auth-error')).toContainText('GitHub sign-in was not completed');
  assert.equal(redirectTo,new URL(saved.revision_url,base).href);
  assert.deepEqual(await snapshot(page),before);
  await page.goto(`${base}/?sceneId=broken`);await expect(page.getByRole('alert')).toContainText('Invalid scene link');assert.deepEqual(await snapshot(page),before);
  assert.deepEqual(errors,[]);
  console.log('PASS browser fresh-context geometry and animation, private head/pinned links, owner/anonymous/wrong-owner access, share/revoke controls, missing/revoked/invalid diagnostics, unchanged local draft records and active-room pointer.');
}finally{await browser.close();await db.close();await server?.close();}
