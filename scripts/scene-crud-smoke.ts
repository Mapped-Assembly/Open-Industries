import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { SceneRepository } from '../src/lib/scene-repository.ts';
import { emptyWorkspace,appendAssets,makeManifest } from '../src/lib/workspace.ts';

const url=process.env.SUPABASE_TEST_URL||'https://mrhxfmtofvrgfaikllfw.supabase.co';
const key=process.env.SUPABASE_TEST_PUBLIC_KEY!;const adminKey=process.env.SUPABASE_TEST_ADMIN_KEY!;
if(!key||!adminKey)throw new Error('Provide test-only Supabase keys.');
const admin=createClient(url,adminKey,{auth:{persistSession:false,autoRefreshToken:false}});const prefix=`astra-crud-${randomUUID()}`;const users=[];
async function user(){const email=`${prefix}-${users.length}@example.invalid`,password=`Mergence-${randomUUID()}!`;const created=await admin.auth.admin.createUser({email,password,email_confirm:true});if(created.error)throw created.error;const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});const signed=await client.auth.signInWithPassword({email,password});if(signed.error)throw signed.error;const result={id:created.data.user!.id,client,session:signed.data.session!};users.push(result);return result;}
try{
 const a=await user(),b=await user();const repo=new SceneRepository(a.client,a.id,false);let workspace=appendAssets(emptyWorkspace(),[]);const id=randomUUID();
 const saved=await repo.save(workspace,'Primary room',id,0,false,()=>{});assert.equal(saved.scene.revision,1);
 const duplicate=await repo.duplicate(saved.scene,'Duplicate room');assert.notEqual(duplicate.id,saved.scene.id);assert.equal(duplicate.name,'Duplicate room');assert.equal(duplicate.revision,1);
 const update=await repo.save({...workspace,room:[8,5,3]},'Primary renamed',saved.scene.id,1,false,()=>{});assert.equal(update.scene.revision,2);
 await assert.rejects(()=>repo.save(workspace,'Stale overwrite',saved.scene.id,1,false,()=>{}),/changed/);
 const forged=await b.client.from('scenes').insert({id:randomUUID(),owner_id:a.id,name:'forged',document:{}});assert(forged.error);assert.match(forged.error.message,/permission|denied|violates/i);
 const direct=await b.client.from('scenes').update({name:'forged'}).eq('id',saved.scene.id);assert(direct.error);assert.match(direct.error.message,/permission|denied|violates/i);
 const refs=await a.client.from('scene_asset_files').insert({scene_id:saved.scene.id,version_id:randomUUID(),owner_id:a.id});assert(refs.error);assert.match(refs.error.message,/permission|denied|violates|foreign/i);
 const cross=await b.client.from('scenes').select('*').eq('id',saved.scene.id);assert.equal(cross.error,null);assert.equal(cross.data?.length,0);
 assert.equal((await repo.list()).length,2);
 console.log('PASS owner CRUD via RPC, atomic duplicate, stable independent IDs, revision conflict, direct-write denial, forged-reference denial, and cross-user isolation.');
}finally{for(const u of users){await u.client.from('scenes').delete().eq('owner_id',u.id);await u.client.from('assets').delete().eq('owner_id',u.id);await admin.auth.admin.deleteUser(u.id);}}
