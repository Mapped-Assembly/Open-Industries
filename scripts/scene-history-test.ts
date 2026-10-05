import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { sceneTestService } from './lib/scene-test-service.ts';
import { sceneLinkDB } from './lib/scene-link-db.ts';
import { importForm } from '../src/lib/form.ts';
import { CloudStorage } from '../src/lib/cloud-storage.ts';
import { SceneRepository } from '../src/lib/scene-repository.ts';
import { SceneConflictError, compareSceneRevisions } from '../src/lib/scene-history.ts';
import { appendAssets, emptyWorkspace, hydrateManifest, makeManifest, readManifest, sceneContent } from '../src/lib/workspace.ts';

// Apply the new migration over real existing snapshots, not just an empty schema.
const legacyOwner=randomUUID(),legacyId=randomUUID();let originals:any[]=[];
const upgraded=await sceneLinkDB(undefined,async db=>{
  await db.query('insert into auth.users values($1)',[legacyOwner]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[legacyOwner]);
  const doc={...makeManifest(emptyWorkspace()),authoring:{via:'mcp',agent:'legacy-agent',summary:'secret-canary'}};
  await db.query('select public.save_workspace_scene($1,$2,$3,0,$4)',[legacyId,'Original',doc,randomUUID()]);
  await db.query('select public.save_workspace_scene($1,$2,$3,1,$4)',[legacyId,'Renamed',{...doc,room:[8,5,3]},randomUUID()]);
  originals=(await db.query('select document,created_at from scene_revisions order by revision')).rows;
});
try{
  const rows=(await upgraded.db.query<any>('select * from scene_revisions order by revision')).rows;
  assert.deepEqual(rows.map(row=>({document:row.document,created_at:row.created_at})),originals);
  assert.deepEqual(rows.map(row=>row.parent_revision),[null,1]);assert.equal(rows[0].author_agent,'legacy-agent');
  assert(rows[1].change_summary.name_changed);assert(rows[1].change_summary.room_changed);
  assert(!JSON.stringify(rows.map(row=>row.change_summary)).includes('canary'));
}finally{await upgraded.db.close();}

const service=await sceneTestService();
const owner=randomUUID(),other=randomUUID(),id=randomUUID();
const session=await service.account(owner),otherSession=await service.account(other);
const clientFor=(access?:string)=>createClient(service.origin,'fixture-public-key',{auth:{persistSession:false,autoRefreshToken:false},global:{headers:access?{Authorization:`Bearer ${access}`}:{}}});
const client=clientFor(session.access_token),foreign=clientFor(otherSession.access_token),anonymous=clientFor();
const repo=new SceneRepository(client,owner,false,'http://127.0.0.1:5173');
const storage=new CloudStorage(client,owner);
const original=importForm({hardware_ir_version:'0.2',overview:{title:'Version fixture'},mechanical:{render_dimensions:{x_mm:400,y_mm:500,z_mm:600}}},'fixture.json','same-source-digest');
const changed=structuredClone(original);changed.parts.push({...structuredClone(changed.parts[0]),id:`${changed.parts[0].id}-v2`,name:'Version two extension'});
changed.parts[0].color=[.9,.1,.1];
const saveRPC=(document:unknown,base:number,name='History fixture',writeId=randomUUID())=>client.rpc('save_workspace_scene',{p_id:id,p_name:name,p_document:document,p_expected_revision:base,p_write_id:writeId});
const count=async()=>Number((await service.sql('select count(*) from scene_revisions where scene_id=$1',[id])).rows[0].count);
try{
  const v1=await storage.upload({id:original.id,asset:original,updatedAt:0},()=>{});
  const v2=await storage.upload({id:changed.id,asset:changed,updatedAt:0},()=>{});
  assert.notEqual(v1.id,v2.id);assert.equal(original.id,changed.id);assert.equal(original.source.digest,changed.source.digest);
  const ws1=appendAssets(emptyWorkspace(),[original],v1.id);
  const firstDoc={...makeManifest(ws1),authoring:{via:'mcp',agent:'fixture-agent',parent_revision:999,change_summary:'secret-canary'}};
  const first=await saveRPC(firstDoc,0);assert.ifError(first.error);
  const firstSnapshot=(await client.rpc('get_workspace_scene',{p_id:id,p_revision:1,p_share_token:null})).data;
  const loaded=await repo.open(id,[changed],()=>{});assert.equal(loaded.workspace.items[0].asset.parts.length,1);assert(!loaded.workspace.items[0].missing);
  // A flat local ID/digest hit and a legacy unbound bundle must not satisfy a pin.
  assert(hydrateManifest(readManifest(firstDoc),[changed]).items[0].missing);
  assert(hydrateManifest(readManifest({...firstDoc,bundledAssets:[changed]}),[]).items[0].missing);
  const missing=hydrateManifest(readManifest(firstDoc),[]);
  const reimport=appendAssets(missing,[changed]);assert(reimport.items[0].missing);assert.equal(reimport.items.length,2);
  assert(!appendAssets(missing,[original],v1.id).items[0].missing);
  // One scene can carry two immutable versions of the same source asset ID.
  const mixed=appendAssets(ws1,[changed],v2.id);
  const portable=makeManifest(mixed,true);assert.equal(portable.bundledVersions?.length,2);
  const reopened=hydrateManifest(readManifest(JSON.parse(JSON.stringify(portable))),[]);
  assert.deepEqual(reopened.items.map(item=>item.asset.parts.length),[1,2]);assert(reopened.items.every(item=>!item.missing));
  const ws2={...ws1,room:[8,5,3] as [number,number,number],items:ws1.items.map(item=>({...item,asset:changed,cloudVersionId:v2.id,position:[2,0,0] as [number,number,number]}))};
  ws2.animation={duration:3,loop:false,tracks:[{id:`${ws1.items[0].id}:instance`,instanceId:ws1.items[0].id,keys:[{id:'start',time:0,position:[0,0,0],rotation:[0,0,0]},{id:'end',time:3,position:[3,0,0],rotation:[0,90,0]}]}]};
  const second=await repo.save(ws2,'Edited fixture',id,1,false,()=>{});assert.equal(second.scene.revision,2);
  assert.equal((await repo.open(id,[original],()=>{})).workspace.items[0].asset.parts.length,2);
  const diff=await repo.compare(id,1,2);
  for(const field of ['Name','Width (m)','Position (m)','Cloud file version','Track'])assert(diff.changes.some(change=>change.field===field),field);
  assert(!JSON.stringify(diff).includes('canary'));
  const disguised={...second.scene,document:{...second.scene.document as any,provider:{secret:'provider-canary'}}};
  assert(!JSON.stringify(compareSceneRevisions(second.scene,disguised)).includes('provider-canary'));
  const history=await repo.history(id);assert.deepEqual(history.revisions.map(row=>row.parent_revision),[1,null]);
  assert.equal(history.revisions[1].author_agent,'fixture-agent');assert.equal(history.revisions[1].author_id,owner);
  assert.equal(history.revisions[0].author_source,'workbench');assert(history.revisions[0].change_summary.room_changed);
  assert(!JSON.stringify(history).includes('canary'));
  // Two requests based on the same observed head: exactly one wins.
  const results=await Promise.all([saveRPC({...makeManifest(ws2),room:[9,5,3]},2),saveRPC({...makeManifest(ws2),room:[10,5,3]},2)]);
  assert.equal(results.filter(result=>!result.error).length,1);
  const conflict=results.find(result=>result.error)!.error!;assert.equal(conflict.code,'40001');assert.equal(JSON.parse(conflict.details).current_revision,3);assert.equal(await count(),3);
  await assert.rejects(()=>repo.save(ws1,'Stale rename',id,1,false,()=>{}),(error:any)=>error instanceof SceneConflictError&&error.currentRevision===3);
  await assert.rejects(()=>repo.remove(first.data),(error:any)=>error instanceof SceneConflictError&&error.currentRevision===3);
  await assert.rejects(()=>repo.restore(id,1,2),(error:any)=>error instanceof SceneConflictError&&error.currentRevision===3);
  assert.equal(await count(),3);
  // A broken reference aborts both head and snapshot/reference changes.
  await service.sql("update asset_file_versions set state='pending' where id=$1",[v1.id]);
  await assert.rejects(()=>repo.restore(id,1,3),/ready/);assert.equal(await count(),3);
  assert.equal((await repo.history(id)).head_revision,3);
  await service.sql("update asset_file_versions set state='ready' where id=$1",[v1.id]);
  const write=randomUUID(),restored=await repo.restore(id,1,3,write);assert.equal(restored.revision,4);
  assert.equal((await repo.restore(id,1,3,write)).revision,4);assert.equal(await count(),4);
  assert.deepEqual(sceneContent(restored.document),sceneContent(firstSnapshot.scene.document));assert.equal(restored.name,'History fixture');
  const latest=(await repo.history(id)).revisions[0];assert.equal(latest.parent_revision,3);assert.equal(latest.restored_from_revision,1);assert.equal(latest.author_source,'restore');
  assert.deepEqual((await client.rpc('get_workspace_scene',{p_id:id,p_revision:1,p_share_token:null})).data,firstSnapshot);
  assert.equal((await repo.open(id,[changed],()=>{},4)).workspace.items[0].asset.parts.length,1);
  // Missing pinned bytes must stay missing, even when the local cache matches the source.
  const path=`${owner}/${v1.id}/asset.json`,bytes=service.objects.get(path)!;service.objects.delete(path);
  assert((await repo.open(id,[original,changed],()=>{},1)).workspace.items[0].missing);service.objects.set(path,bytes);
  const page1=await client.rpc('list_scene_revisions',{p_id:id,p_before_revision:null,p_limit:2});assert.ifError(page1.error);
  assert.deepEqual(page1.data.revisions.map((row:any)=>row.revision),[4,3]);assert.equal(page1.data.next_before,3);
  const page2=await client.rpc('list_scene_revisions',{p_id:id,p_before_revision:3,p_limit:2});assert.deepEqual(page2.data.revisions.map((row:any)=>row.revision),[2,1]);assert.equal(page2.data.next_before,null);
  for(const denied of [foreign,anonymous]){
    for(const [name,args] of [
      ['list_scene_revisions',{p_id:id,p_before_revision:null,p_limit:25}],
      ['get_workspace_scene',{p_id:id,p_revision:1,p_share_token:null}],
      ['restore_workspace_scene',{p_id:id,p_revision:1,p_expected_revision:4,p_write_id:randomUUID()}],
    ] as const)assert((await denied.rpc(name,args)).error,`${name} must deny another account/anonymous caller`);
  }
  assert.equal(await count(),4);
  assert((await saveRPC({...makeManifest(ws1),authoring:{via:'restore',restored_from_revision:999}},4)).error);assert.equal(await count(),4);
  const duplicate=await repo.duplicate(restored,'Independent copy');assert.equal(duplicate.revision,1);
  const copy=await repo.open(duplicate.id,[],()=>{});assert.notEqual(copy.workspace.items[0].id,ws1.items[0].id);assert.equal(copy.workspace.items[0].cloudVersionId,v1.id);
  assert.equal((await repo.history(duplicate.id)).revisions[0].parent_revision,null);
  await repo.remove(duplicate);assert.equal(await count(),4);
  const mixedSaved=await repo.save(mixed,'Mixed versions',randomUUID(),0,false,()=>{});
  assert.deepEqual((await repo.open(mixedSaved.scene.id,[changed],()=>{})).workspace.items.map(item=>item.asset.parts.length),[1,2]);

  if(process.argv.includes('--browser')){
    const {createServer}=await import('vite');const {chromium,expect}=await import('@playwright/test');
    process.env.VITE_SUPABASE_URL=service.origin;process.env.VITE_SUPABASE_PUBLISHABLE_KEY='fixture-public-key';process.env.VITE_CLOUD_STORAGE_ENABLED='true';
    const web=await createServer({server:{host:'127.0.0.1',port:4176,strictPort:true}});let browser;
    try{
      await web.listen();const origin=new URL(web.resolvedUrls!.local[0]).origin;
      browser=await chromium.launch({headless:true,...(process.env.ASTRA_CHROME_PATH?{executablePath:process.env.ASTRA_CHROME_PATH}:{})});
      const context=await browser.newContext();
      await context.addInitScript(({origin,key,session})=>{if(location.origin===origin&&!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(session));},{origin,key:`sb-${new URL(service.origin).hostname.split('.')[0]}-auth-token`,session});
      const page=await context.newPage();const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(origin);await expect(page.getByLabel('Width',{exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'Save cloud scene',exact:true})).toBeVisible();await expect(page.getByLabel('Local draft status')).toHaveText('Local draft saved');
      // Cache both file versions in one local draft and round-trip through IndexedDB.
      const cached=await page.evaluate(async({workspace,owner})=>{
        const {saveWorkspaceDraft,loadWorkspaceDraft}=await import('/src/lib/workspace-draft.ts');
        await saveWorkspaceDraft(workspace,owner,'version-regression');
        const result=await loadWorkspaceDraft(owner);return result!.workspace.items.map((item:any)=>({parts:item.asset.parts.length,version:item.cloudVersionId,missing:item.missing}));
      },{workspace:mixed,owner});
      assert.deepEqual(cached.map(item=>item.parts),[1,2]);assert(cached.every(item=>!item.missing));
      // Flat legacy cache entries are not silently promoted to verified versions.
      const legacy=await page.evaluate(async({workspace,owner})=>{
        const {saveScene,saveActiveRoom}=await import('/src/lib/scene-storage.ts');
        const {loadWorkspaceDraft}=await import('/src/lib/workspace-draft.ts');
        const {makeManifest}=await import('/src/lib/workspace.ts');
        await saveScene({schemaVersion:1,id:'active-scene',source:{},room:{width:6,depth:5,height:3},instances:workspace.items.map((item:any)=>({id:item.id,name:item.name,assetId:item.asset.id,position:item.position,rotation:item.rotation,visible:item.visible})),workspaceDocument:makeManifest(workspace)},workspace.items.map((item:any)=>item.asset),`${owner}:legacy-pin`);
        await saveActiveRoom(owner,'legacy-pin');return (await loadWorkspaceDraft(owner))!.workspace.items[0].missing;
      },{workspace:ws1,owner});assert(legacy);
      await page.goto(`${origin}/?sceneId=${id}&revision=4`);
      await expect(page.getByLabel('Scene link',{exact:true})).toContainText('revision 4');
      await expect(page.locator('.asset')).toContainText('1 components');
      await expect(page.getByRole('button',{name:'Create shared revision link',exact:true})).toBeEnabled(); // authorship metadata is not a dirty edit
      await page.getByText('Revision history',{exact:true}).click();
      await expect(page.getByLabel('Scene revisions')).toContainText('fixture-agent');
      await page.getByLabel('Compare from revision').selectOption('1');await page.getByLabel('Compare to revision').selectOption('2');await page.getByRole('button',{name:'Compare revisions',exact:true}).click();
      await expect(page.getByRole('region',{name:'Revision comparison'})).toContainText('Cloud file version');
      // External edit after history was read: restore must show a conflict, preserving the view.
      const external=await saveRPC(makeManifest(ws2),4,'External edit');assert.ifError(external.error);
      page.on('dialog',dialog=>dialog.accept());
      await page.getByRole('button',{name:'Restore revision 1',exact:true}).click();
      await expect(page.getByRole('alert')).toContainText('Current revision: 5');await expect(page.getByLabel('Width',{exact:true})).toHaveValue('6');
      assert.equal(await count(),5);
      await page.getByRole('button',{name:'Refresh history',exact:true}).click();
      await expect(page.getByText('Latest saved revision: 5',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Restore revision 1',exact:true}).click();
      await expect(page.getByLabel('Scene save status')).toContainText('Restored revision 1 as revision 6');
      await expect(page.getByLabel('Scene link',{exact:true})).toContainText('revision 6');assert.equal(new URL(page.url()).searchParams.get('revision'),'6');
      await expect(page.locator('.asset')).toContainText('1 components');
      await page.getByText('Revision history',{exact:true}).click();await expect(page.getByLabel('Scene revisions')).toContainText('Revision 6');
      assert.equal(await count(),6);
      // Same room/instance/source IDs, different immutable geometry: rebuild the viewport.
      const canvas=await page.getByLabel('Interactive 3D room').locator('canvas').elementHandle();
      const geometryOnly={...ws1,items:ws1.items.map(item=>({...item,asset:changed,cloudVersionId:v2.id}))};
      const seventh=await repo.save(geometryOnly,'History fixture',id,6,false,()=>{});assert.equal(seventh.scene.revision,7);
      await page.getByRole('button',{name:'Refresh scenes',exact:true}).click();
      await page.getByRole('button',{name:'Open scene History fixture',exact:true}).click();
      await expect(page.getByLabel('Scene link',{exact:true})).toContainText('revision 7');
      await expect(page.locator('.asset')).toContainText('2 components');
      assert.equal(await canvas!.evaluate(node=>node.isConnected),false);
      const currentCanvas=await page.getByLabel('Interactive 3D room').locator('canvas').elementHandle();
      await page.getByLabel('Version fixture X position',{exact:true}).fill('3');
      assert.equal(await currentCanvas!.evaluate(node=>node.isConnected),true); // transforms keep the renderer
      assert.deepEqual(errors,[]);
      console.log('PASS browser history/compare/restore, stale restore recovery, clean saved state, version-aware IndexedDB and legacy-cache refusal.');
    }finally{await browser?.close();await web.close();}
  }
  console.log('PASS migration backfill, revision provenance/summaries, same-ID file versions, portable bindings, history/compare/restore, races/stale rename/delete, rollback, pagination, owner checks, duplicate independence.');
}finally{await service.close();}
