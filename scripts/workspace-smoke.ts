import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createClient,type Session } from '@supabase/supabase-js';
import { chromium,expect,type Page } from '@playwright/test';
import { SceneRepository } from '../src/lib/scene-repository.ts';
import { CloudStorage } from '../src/lib/cloud-storage.ts';
import { createRequire } from 'node:module';
const {GifReader}=createRequire(import.meta.url)('omggif');
const url=process.env.SUPABASE_TEST_URL||'https://mrhxfmtofvrgfaikllfw.supabase.co';
const key=process.env.SUPABASE_TEST_PUBLIC_KEY!;const adminKey=process.env.SUPABASE_TEST_ADMIN_KEY!;
if(!key||!adminKey)throw new Error('Provide test-only public/admin Supabase keys.');
const admin=createClient(url,adminKey,{auth:{persistSession:false,autoRefreshToken:false}});
const users:{id:string;client:ReturnType<typeof createClient>;session:Session|null}[]=[];
const prefix=`astra-workspace-${randomUUID()}`;
const browser=await chromium.launch({channel:'chrome',headless:true});const errors:string[]=[];
async function newUser(){
  const email=`${prefix}-${users.length}@example.invalid`,password=`Mergence-${randomUUID()}!`;
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{user_name:'workspace-test'}});if(created.error)throw created.error;
  const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});const result={id:created.data.user!.id,client,session:null as Session|null};users.push(result);
  const signed=await client.auth.signInWithPassword({email,password});if(signed.error)throw signed.error;result.session=signed.data.session;return result;
}
async function newPage(session:Session){
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(({session,key})=>localStorage.setItem(key,JSON.stringify(session)),{session,key:`sb-${new URL(url).hostname.split('.')[0]}-auth-token`});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(process.env.ASTRA_BASE_URL||'http://127.0.0.1:8787');
  await expect(page.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'+ Import project'})).toBeEnabled();return{page,context};
}
async function downloaded(page:Page,action:()=>Promise<unknown>){const event=page.waitForEvent('download');await action();const file=await event;const stream=await file.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(chunk as Buffer);return Buffer.concat(chunks);}
async function waitSave(page:Page,text:string){const panel=page.getByRole('region',{name:'Scene persistence'});await expect.poll(async()=>{if(await panel.getByRole('alert').count())throw new Error(await panel.getByRole('alert').innerText());return panel.getByRole('status').innerText();},{timeout:120000}).toContain(text);}
try{
  const a=await newUser(),b=await newUser();const first=await newPage(a.session!);const page=first.page;
  const fixture={format:'form-project',version:1,project_id:prefix,agent:'codex',project_ir:{hardware_ir_version:'0.2',assembly_metadata:{revision:4},overview:{title:'Factory bench',description:'Fabrication demo fixture'},components:[{ref_des:'BENCH',name:'Bench top'}],bom:[{name:'Bench assembly',quantity:1}],validation:{warning:[{description:'Check clearance around the bench'}]},mechanical:{component_placements:[{ref_des:'BENCH',label:'Bench top',position:{x_mm:0,y_mm:0,z_mm:450},size:{x_mm:1800,y_mm:800,z_mm:900}}]}}};
  const file={name:'factory.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(fixture))};
  await page.locator('input[aria-label="Import files"]').setInputFiles(file);
  await expect(page.getByRole('heading',{name:'Factory bench'})).toBeVisible();
  await expect(page.locator('.inspector')).toContainText('Check clearance around the bench');
  await expect(page.locator('.inspector')).toContainText('codex');
  await page.getByLabel('Factory bench X position',{exact:true}).fill('2');
  const timeline=page.getByRole('region',{name:'Animation timeline'});
  await timeline.getByLabel('Keyframe time',{exact:true}).fill('0');
  await timeline.getByRole('button',{name:'Add / update keyframe'}).click();
  await timeline.getByLabel('Keyframe time',{exact:true}).fill('2');
  await timeline.getByLabel('Keyframe position X',{exact:true}).fill('4');
  await timeline.getByRole('button',{name:'Add / update keyframe'}).click();
  await timeline.getByLabel('Keyframe time',{exact:true}).fill('1');
  await expect(timeline.getByLabel('Keyframe position X',{exact:true})).toHaveValue('3');
  await timeline.getByRole('button',{name:'Reset to base layout'}).click();
  await expect(page.getByLabel('Factory bench X position',{exact:true})).toHaveValue('2');

  // A component track is distinct from the parent instance track.
  await timeline.getByLabel('Animation target',{exact:true}).selectOption('0');
  await timeline.getByLabel('Keyframe time',{exact:true}).fill('0');await timeline.getByRole('button',{name:'Add / update keyframe'}).click();
  await timeline.getByLabel('Keyframe time',{exact:true}).fill('2');await timeline.getByLabel('Keyframe position Y',{exact:true}).fill('.4');await timeline.getByRole('button',{name:'Add / update keyframe'}).click();
  await timeline.getByRole('button',{name:'Reset to base layout'}).click();
  await page.getByRole('button',{name:'GIF studio',exact:true}).click();
  const studio=page.getByRole('region',{name:'GIF studio',exact:true});
  await studio.getByLabel('GIF resolution').selectOption('320');await studio.getByLabel('Duration').selectOption('2');await studio.getByLabel('Preview motion').selectOption('animation');
  await studio.getByLabel('Animation export start').fill('0');await studio.getByLabel('Animation export end').fill('2');
  await studio.getByRole('button',{name:'Render GIF',exact:true}).click();
  await expect(studio.getByRole('status',{name:'GIF export status'})).toContainText('GIF ready',{timeout:90000});
  const metadata=JSON.parse((await downloaded(page,()=>studio.getByRole('link',{name:'Download review metadata'}).click())).toString());
  assert.equal(metadata.motion,'animation');assert.equal(metadata.frameCount,20);assert.equal(metadata.frames[10].time,1);assert.equal(metadata.frames[10].instances[0].position[0],3);
  const partPose=Object.values(metadata.frames[10].instances[0].parts)[0] as any;assert.equal(partPose.position[1],.2);
  const bytes=await downloaded(page,()=>studio.getByRole('link',{name:'Download GIF',exact:true}).click());const gif=new GifReader(bytes);assert.equal(gif.numFrames(),20);
  const pixelsA=Buffer.alloc(320*320*4),pixelsB=Buffer.alloc(320*320*4);gif.decodeAndBlitFrameRGBA(0,pixelsA);gif.decodeAndBlitFrameRGBA(10,pixelsB);assert(!pixelsA.equals(pixelsB));
  await page.getByRole('button',{name:'Close GIF studio'}).click();
  const exported=await downloaded(page,()=>page.getByRole('button',{name:'Export scene JSON'}).click());const manifest=JSON.parse(exported.toString());assert.equal(manifest.animation.tracks.length,2);assert.equal(manifest.instances[0].position[0],2);
  console.log('PASS authored instance/component animation, shared GIF frame coordinates, decoded moving GIF, and immutable base layout.');

  await page.getByLabel('Scene name',{exact:true}).fill(prefix);
  await page.getByRole('button',{name:'Save cloud scene',exact:true}).click();await waitSave(page,'Scene saved to Postgres');
  const repo=new SceneRepository(a.client,a.id,true);const scenes=await repo.list();assert.equal(scenes.length,1);const saved=scenes[0];assert.equal(saved.revision,1);
  await expect(page.getByRole('region',{name:'Scene persistence'})).toContainText('Cloud revision 1 · Saved');
  await expect(page.getByRole('status',{name:'Local draft status'})).toHaveText('Local draft saved');
  await page.reload();await expect(page.getByRole('region',{name:'Scene persistence'})).toContainText('Cloud revision 1 · Saved');
  const state=await first.context.storageState({indexedDB:true});
  for(const origin of state.origins)for(const item of origin.localStorage)if(item.name===`sb-${new URL(url).hostname.split('.')[0]}-auth-token`)item.value=JSON.stringify(b.session);
  const switchedContext=await browser.newContext({storageState:state});const switched=await switchedContext.newPage();await switched.goto(process.env.ASTRA_BASE_URL||'http://127.0.0.1:8787');await expect(switched.getByRole('button',{name:'+ Import project'})).toBeEnabled();await expect(switched.locator('.asset')).toHaveCount(0);await switchedContext.close();
  const versions=await new CloudStorage(a.client,a.id).list();assert.equal(versions.length,1);
  await assert.rejects(()=>new CloudStorage(a.client,a.id).remove(versions[0]),/referenced/);
  const second=await newPage(a.session!);
  await second.page.getByRole('button',{name:`Open scene ${prefix}`,exact:true}).click();await waitSave(second.page,'Cloud scene opened');
  await expect(second.page.getByLabel('Factory bench X position',{exact:true})).toHaveValue('2');
  const secondTimeline=second.page.getByRole('region',{name:'Animation timeline'});
  await second.page.locator('.asset').filter({hasText:'Factory bench'}).click();
  await secondTimeline.getByLabel('Keyframe time',{exact:true}).fill('1');await expect(secondTimeline.getByLabel('Keyframe position X',{exact:true})).toHaveValue('3');
  await mkdir('test-results',{recursive:true});await second.page.screenshot({path:'test-results/workspace-cloud-animation.png'});
  console.log('PASS real Postgres save, atomic asset references, and complete second-browser scene/animation restoration.');

  // Two clients editing the same revision must not overwrite each other.
  const loaded=await repo.open(saved.id,[],()=>{});const changed=structuredClone(loaded.workspace);changed.room[0]=9;
  const updated=await repo.save(changed,prefix,saved.id,1,true,()=>{});assert.equal(updated.scene.revision,2);
  await second.page.getByRole('button',{name:'Save cloud scene',exact:true}).click();
  await expect(second.page.getByRole('region',{name:'Scene persistence'}).getByRole('alert')).toContainText('changed on another device');
  assert.equal((await new SceneRepository(b.client,b.id,true).list()).length,0);
  await assert.rejects(()=>new SceneRepository(b.client,b.id,true).open(saved.id,[],()=>{}),/unavailable/);
  const forgedDocument={...manifest};delete forgedDocument.bundledAssets;
  const forged=await b.client.rpc('save_workspace_scene',{p_id:saved.id,p_name:'forged',p_document:forgedDocument,p_expected_revision:2,p_write_id:randomUUID()});assert(forged.error);assert.match(forged.error.message,/Scene not found/);
  console.log('PASS conflict detection and cross-user read/write isolation.');

  // Core metadata save/open does not require object storage.
  const metadataRepo=new SceneRepository(a.client,a.id,false);
  const metadataOnly=structuredClone(loaded.workspace);metadataOnly.items=metadataOnly.items.map(i=>({...i,cloudVersionId:undefined}));
  const metadataScene=await metadataRepo.save(metadataOnly,`${prefix} metadata`,randomUUID(),0,false,()=>{});
  const missing=await metadataRepo.open(metadataScene.scene.id,[],()=>{});assert(missing.workspace.items[0].missing);assert.equal(missing.workspace.items[0].position[0],2);
  assert((await metadataRepo.catalog()).some(asset=>asset.name==='Factory bench'));
  const third=await newPage(a.session!);
  await third.page.getByRole('button',{name:`Open scene ${prefix} metadata`,exact:true}).click();await waitSave(third.page,'missing geometry');
  await expect(third.page.locator('.asset')).toContainText('MISSING GEOMETRY');
  await expect(third.page.getByRole('button',{name:'Save cloud scene',exact:true})).toBeEnabled();
  await third.page.locator('input[aria-label="Import files"]').setInputFiles(file);
  await expect(third.page.locator('.asset')).not.toContainText('MISSING GEOMETRY');
  await expect(third.page.getByLabel('Factory bench X position',{exact:true})).toHaveValue('2');
  await third.context.close();
  await second.page.getByRole('button',{name:'New room',exact:true}).click();await second.page.getByRole('button',{name:'Refresh scenes'}).click();
  await expect(second.page.getByRole('button',{name:'Save cloud scene',exact:true})).toBeEnabled();
  // Local portable file keeps geometry and keyframes without a cloud dependency.
  await second.page.locator('input[aria-label="Import files"]').setInputFiles({name:'saved.astra.json',mimeType:'application/json',buffer:exported});
  await expect(second.page.getByLabel('Factory bench X position',{exact:true})).toHaveValue('2');
  await second.page.locator('.asset').filter({hasText:'Factory bench'}).click();await secondTimeline.getByLabel('Keyframe time',{exact:true}).fill('1');await expect(secondTimeline.getByLabel('Keyframe position X',{exact:true})).toHaveValue('3');
  await second.page.getByRole('button',{name:'Sign out',exact:true}).click();await expect(second.page.locator('.asset')).toHaveCount(0);
  await second.page.setViewportSize({width:390,height:844});await expect.poll(()=>second.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await second.page.screenshot({path:'test-results/workspace-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS metadata-only scenes with explicit missing assets, portable JSON round trip, sign-out clearing cloud state, and mobile layout.');
  await first.context.close();await second.context.close();
}finally{
  await browser.close();
  for(const user of users){if(user.session){const repo=new SceneRepository(user.client,user.id,true);for(const scene of await repo.list())await repo.remove(scene);const store=new CloudStorage(user.client,user.id);for(const v of await store.list())await store.remove(v);await user.client.from('assets').delete().eq('owner_id',user.id);}const deleted=await admin.auth.admin.deleteUser(user.id);if(deleted.error)throw deleted.error;}
  console.log('Workspace test users and cloud data cleaned up.');
}
