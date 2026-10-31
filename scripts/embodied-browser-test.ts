import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const source=process.env.SO101_SOURCE_ROOT;
if(!source)throw Error('Set SO101_SOURCE_ROOT to the verified upstream checkout.');
const directory=mkdtempSync(join(tmpdir(),'oi-embodied-browser-'));
const child=spawn(process.env.PYTHON??'python3',['scripts/embodied_runtime.py','--source',resolve(source),'--state-dir',directory,'--port','0'],{stdio:['ignore','pipe','pipe']});
let output='',errors='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>errors+=v);
let browser;
try {
  for(let i=0;i<200&&!output.includes('Embodied workbench:');i++) {
    if(child.exitCode!==null)throw Error(errors);
    await new Promise(done=>setTimeout(done,100));
  }
  const origin=/http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];if(!origin)throw Error('Startup timeout '+errors);
  assert.equal((await fetch(origin+'/api/embodied/run')).status,401);
  assert.equal((await fetch(origin+'/api/embodied/run',{headers:{Origin:'https://example.com'}})).status,403);
  assert.equal((await fetch(origin+'/api/embodied/request',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  browser=await chromium.launch({headless:true,...(process.env.ASTRA_CHROME_PATH?{executablePath:process.env.ASTRA_CHROME_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  mkdirSync('deliverables/embodied',{recursive:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},recordVideo:{dir:'deliverables/embodied',size:{width:1440,height:1000}}});
  const page=await context.newPage(),pageErrors:string[]=[];
  page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(origin+'/?run=so101');
  await expect(page.getByRole('button',{name:'Enter Run mode'})).toBeEnabled({timeout:20000});
  await page.getByRole('button',{name:'Enter Run mode'}).click();
  await page.getByLabel('Selected object').selectOption('red-block');
  await page.getByLabel('Task',{exact:true}).fill('approach selected');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('running',{timeout:10000});
  const before=await page.evaluate(async()=> (await fetch('/api/embodied/run')).json());
  const started=Date.now();
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('paused');
  const stopped=Date.now()-started;assert(stopped<1500,`UI Stop took ${stopped}ms`);
  await page.getByRole('button',{name:'Resume',exact:true}).click();
  await page.getByRole('button',{name:'Disconnect viewer'}).click();
  await page.waitForTimeout(6500);
  await page.getByRole('button',{name:'Reconnect',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('completed',{timeout:10000});
  await page.reload();
  await expect(page.getByRole('status')).toContainText('completed');
  const after=await page.evaluate(async()=> (await fetch('/api/embodied/run')).json());
  assert.equal(after.run_id,before.run_id);assert.equal(after.task.id,before.task.id);
  assert.deepEqual(after.objects,before.objects);assert.equal(after.task.result.contact_validated,false);
  assert(after.messages.some((m:any)=>m.text==='approach selected'));
  await page.screenshot({path:'deliverables/embodied/chat-live.png',fullPage:true});
  // Missing grounding and unsupported input must produce a recorded refusal, not a canned animation.
  await page.getByLabel('Selected object').selectOption('');
  await page.getByLabel('Task',{exact:true}).fill('approach selected');
  await page.getByRole('button',{name:'Send',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('needs_review');
  assert.deepEqual(pageErrors,[]);
  writeFileSync('deliverables/embodied/browser-checks.json',JSON.stringify({source:'actual browser → local Python authority → controller → workbench',policy_mode:after.policy_mode,stop_ui_ack_ms:stopped,task:after.task,run_id:after.run_id,observations:after.observations,conversation:after.messages,physical_validation:false,live_model_run:false},null,2));
  await context.close();
  console.log('PASS built workbench chat, authoritative SO-101 motion, Stop/resume, disconnected progress, same-run reconnect, evidence and origin refusal');
} finally {
  await browser?.close();
  if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended;}
  rmSync(directory,{recursive:true,force:true});
}
