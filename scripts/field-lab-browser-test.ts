import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const server=await createServer({server:{host:'127.0.0.1',port:4194,strictPort:true}});
await server.listen();
const stationDir=mkdtempSync(join(tmpdir(),'oi-lab-browser-'));
const station=spawn(process.execPath,['--import','tsx','scripts/field-lab-viewer.ts'],{env:{...process.env,FIELD_LAB_VIEWER_PORT:'4195',FIELD_LAB_VIEWER_STATE_DIR:stationDir},stdio:['ignore','pipe','pipe']});
const stationReady=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Station startup timeout')),60000);station.stdout.on('data',d=>{if(String(d).includes('live simulated scene')){clearTimeout(timer);resolve();}});station.on('exit',code=>{clearTimeout(timer);reject(Error('Station exited '+code));});});
const browser=await chromium.launch({headless:true,...(process.env.ASTRA_CHROME_PATH?{executablePath:process.env.ASTRA_CHROME_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];
  page.on('pageerror',e=>errors.push(String(e)));
  await page.goto('http://127.0.0.1:4194/benchmarks/field-lab/runtime.html');
  await page.waitForFunction(()=> (window as any).ready);
  await page.locator('#import').setInputFiles('deliverables/field-lab/runtime-recording.json');
  await page.waitForFunction(()=> (window as any).labState?.job?.state==='failed');
  assert.match(await page.locator('#finding').innerText(),/OpenCAD unchecked/);
  assert.match(await page.locator('#selection-state').innerText(),/modeled-instrument-fault/);
  const recording=JSON.parse(readFileSync('deliverables/field-lab/runtime-recording.json','utf8'));
  const pause=recording.frames.findIndex((f:any)=>f.snapshot.jobs[0].state==='paused');
  assert(pause>=0);
  await page.evaluate(i=>(window as any).showLabEvent(i),pause);
  const paused=await page.evaluate(()=>(window as any).labState);
  assert.equal(paused.job.state,'paused');
  const downloadPromise=page.waitForEvent('download');await page.locator('#export').click();const exported=await downloadPromise;
  const exportPath='deliverables/field-lab/browser-roundtrip.json';await exported.saveAs(exportPath);
  await page.locator('#import').setInputFiles(exportPath);
  await page.waitForFunction(()=> (window as any).labState?.job?.state==='paused');
  assert.deepEqual(await page.evaluate(()=>(window as any).labState.poses),paused.poses);
  await page.locator('#focus').click();
  const screenshot=page.waitForEvent('download', d=>d.suggestedFilename()==='field-lab-runtime.png');
  await page.locator('#screenshot').click();await (await screenshot).saveAs('deliverables/field-lab/runtime-captioned.png');
  await page.screenshot({path:'deliverables/field-lab/runtime-viewer.png',fullPage:true});
  // UI uses the same route for fresh reads/reconnect; this is a recorded transport fixture.
  await page.route('**/lab-recording',route=>route.fulfill({json:recording}));
  await page.locator('#connect').click();await page.waitForFunction(()=> (window as any).labState?.job?.state==='failed');
  await page.locator('#disconnect').click();assert.match(await page.locator('#status').innerText(),/Disconnected/);
  assert.equal(await page.locator('vite-error-overlay').count(),0);assert.deepEqual(errors,[]);
  await stationReady;
  const live=await browser.newPage();
  await live.goto('http://127.0.0.1:4195/benchmarks/field-lab/runtime.html');
  await live.locator('#connect').click();
  await live.waitForFunction(()=> (window as any).labState?.job?.state==='running');
  const before=await live.evaluate(()=>(window as any).labState.job.progress_ms);
  await live.locator('#disconnect').click();
  await expect.poll(async()=>{
    const response=await live.request.get('http://127.0.0.1:4195/lab-recording');
    const r=await response.json();return r.frames.at(-1).snapshot.jobs[0].progress_ms;
  },{timeout:30000}).toBeGreaterThan(before);
  await live.locator('#connect').click();
  await live.waitForFunction(n=>(window as any).labState.job.progress_ms>n,before);
  // Validate the live UI command route and origin guard, using a fresh known revision.
  await live.evaluate(async()=>{
    for(let i=0;i<3;i++){
      const r=await (await fetch('/lab-recording')).json();
      const s=r.frames.at(-1).snapshot;
      const response=await fetch('/lab-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({command_id:crypto.randomUUID(),expected_revision:s.revision,action:'pause',payload:{job_id:'sample-1'}})});
      if(response.ok)return;
      const failure=await response.json();if(failure.error!=='CONFLICT')throw Error(failure.error);
    }throw Error('Could not pause current job');
  });
  await live.waitForFunction(()=> (window as any).labState.job.state==='paused',null,{timeout:30000});
  const forbidden=await live.request.get('http://127.0.0.1:4195/lab-recording',{headers:{Origin:'https://untrusted.example'}});
  assert.equal(forbidden.status(),403);
  writeFileSync('deliverables/field-lab/runtime-browser-checks.json',JSON.stringify({status:'passed',errors,checks:['import','paused pose','selection reason','export/reimport','captioned screenshot','reconnect projection','live SQLite bridge','no-viewer progression','live pause','cross-origin refusal'],scope:'Recorded fixtures and a fresh real local station; no physical equipment.'},null,2));
  console.log('PASS browser event scene, portable cursor/pose, live reconnect, independent execution and pause');
} finally {
  await browser.close();await server.close();
  if(station.exitCode===null){station.kill('SIGTERM');await new Promise<void>(resolve=>station.once('exit',()=>resolve()));}
  rmSync(stationDir,{recursive:true,force:true});
}
