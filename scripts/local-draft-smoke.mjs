import {chromium,expect} from '@playwright/test';
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();
async function exportScene(){const event=page.waitForEvent('download');await page.getByRole('button',{name:'Export scene JSON'}).click();const download=await event;const stream=await download.createReadStream();const chunks=[];for await(const chunk of stream)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks));}
try{
  await page.goto('http://127.0.0.1:8787');await expect(page.getByRole('button',{name:'+ Import project'})).toBeEnabled();
  await page.locator('input[aria-label="Import files"]').setInputFiles({name:'draft.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({hardware_ir_version:'0.2',overview:{title:'Draft asset'},mechanical:{render_dimensions:{x_mm:100,y_mm:200,z_mm:300}}}))});
  await page.getByLabel('Draft asset X position',{exact:true}).fill('2');await page.getByRole('button',{name:'Duplicate',exact:true}).click();
  await page.getByRole('button',{name:'Add / update keyframe'}).click();
  await expect(page.getByRole('status',{name:'Local draft status'})).toHaveText('Local draft saved');const before=await exportScene();
  await page.reload();await expect(page.locator('.asset')).toHaveCount(2);await expect(page.getByLabel('Draft asset X position',{exact:true})).toHaveValue('2');const after=await exportScene();
  expect(after.instances).toEqual(before.instances);expect(after.animation).toEqual(before.animation);
  await expect(page.getByRole('status',{name:'Local draft status'})).toHaveText('Local draft saved');
  await page.evaluate(async asset=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('astra-scenes',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction(['scenes','assets'],'readwrite');tx.objectStore('scenes').delete('active:guest');tx.objectStore('assets').put(asset);tx.objectStore('scenes').put({schemaVersion:1,id:'active',source:{},room:{width:9,depth:6,height:3},instances:[{id:'legacy-a',assetId:asset.id,name:'Legacy A',position:[2,0,0],rotation:[0,30,0],visible:true},{id:'legacy-b',assetId:asset.id,name:'Legacy B',position:[-2,0,0],rotation:[0,0,0],visible:true}]});tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();
  },before.bundledAssets[0]);
  await page.reload();await expect(page.locator('.asset')).toHaveCount(2);await expect(page.getByLabel('Legacy A X position',{exact:true})).toHaveValue('2');await expect(page.getByLabel('Legacy B X position',{exact:true})).toHaveValue('-2');await expect(page.getByLabel('Width',{exact:true})).toHaveValue('9');
  console.log('PASS autosaved instance/keyframe reload and legacy scene migration retaining repeated geometry instances.');
}finally{await browser.close();}
