import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { callLocalLabTool } from '../../server/mcp-local-lab.mjs';
const execute = promisify(execFile);
const python = process.env.PYTHON ?? 'python3';

/** Reserve a test port briefly, rather than depending on the developer's station port. */
async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as {port: number}).port;
  await new Promise<void>(done => server.close(() => done())); return port;
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill(signal); await ended;
}
/** Exercise the shipped static service, not an in-process mock worker. */
test('installed station persists across disconnected clients, kill, compatible restart and complete isolated restore', {timeout:60000, skip:process.platform === 'win32'}, async () => {
  const root = await mkdtemp(join(tmpdir(),'oi-local-'));
  const state = join(root,'station'); const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = {...process.env, FIELD_LAB_INSTALLED:'true', FIELD_LAB_VIEWER_STATE_DIR:state, FIELD_LAB_VIEWER_PORT:String(port)};
  let child: ChildProcess | undefined;
  async function start(directory = state): Promise<void> {
    child = spawn(process.execPath,['--import','tsx','scripts/field-lab-viewer.ts'],{env:{...env,FIELD_LAB_VIEWER_STATE_DIR:directory},stdio:['ignore','pipe','pipe']});
    let errors = ''; child.stderr!.on('data',chunk=>errors+=chunk);
    for(let i=0;i<100;i++) {
      if(child.exitCode !== null) throw Error(errors);
      try { if((await fetch(origin+'/health')).ok) return; } catch {}
      await delay(100);
    }
    throw Error('Station never became ready: '+errors);
  }
  async function api(route:string, data?:unknown):Promise<any> {
    const client = JSON.parse(await readFile(join(state,'client.json'),'utf8'));
    const response = await fetch(origin+'/lab-api/'+route,{method:data?'POST':'GET',headers:{authorization:`Bearer ${client.token}`,'content-type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
    assert.equal(response.status,200,await response.clone().text()); return response.json();
  }
  try {
    await assert.rejects(execute(process.execPath,['--import','tsx','scripts/field-lab-viewer.ts'],{env}));
    await execute(process.execPath,['--import','tsx','scripts/field-lab-viewer.ts','--init-only'],{env});
    await start();
    assert.match(await (await fetch(origin+'/')).text(), /FIELD-LAB/);
    assert.equal((await fetch(origin+'/scripts/field-lab-viewer.ts')).status,404);
    assert.equal((await fetch(origin+'/lab-api/read')).status,401);
    assert.equal((await fetch(origin+'/lab-recording',{headers:{origin:'https://example.com'}})).status,403);
    assert.equal((await fetch(origin+'/lab-control',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,404);
    const before = (await api('read')).snapshot;
    // No connected viewer/MCP and stdin is closed. The independent worker advances.
    await delay(2200);
    const after = (await api('read')).snapshot;
    assert.equal(after.instance_id,before.instance_id);
    assert(after.jobs[0].progress_ms > before.jobs[0].progress_ms);
    const command = {command_id:'local-pause-1',expected_revision:after.revision,action:'pause',payload:{job_id:after.jobs[0].id}};
    const paused = await api('command',command);
    assert.deepEqual(await api('command',command),paused);
    await stop(child!,'SIGKILL');
    // Simulate an expired bridge session deadline without changing the domain clock.
    const savedSession = JSON.parse(await readFile(join(state,'session.json'),'utf8'));
    await writeFile(join(state,'session.json'),JSON.stringify({...savedSession,expires_at_ms:0}));
    await start();
    await Promise.all([api('read'),api('read')]);
    assert.notEqual(JSON.parse(await readFile(join(state,'session.json'),'utf8')).token,savedSession.token);
    assert.deepEqual(await api('command',command),paused);
    const recovered = (await api('read')).snapshot;
    assert.equal(recovered.instance_id,before.instance_id);
    assert.equal(recovered.jobs[0].progress_ms,paused.snapshot.jobs[0].progress_ms);
    process.env.OI_LOCAL_CLIENT_FILE=join(state,'client.json');
    const transport = spawn(process.execPath,['server/astra-mcp.mjs'],{env:process.env,stdio:['pipe','pipe','pipe']});
    let reply=''; transport.stdout.on('data',chunk=>reply+=chunk);
    const transportEnded=once(transport,'exit');
    transport.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'astra.local_lab_read',arguments:{}}})+'\n');
    await transportEnded;
    assert.equal(JSON.parse(reply).result.structuredContent.snapshot.instance_id,recovered.instance_id);
    const mcp = await callLocalLabTool('astra.local_lab_read',{});
    assert.equal(mcp.snapshot.instance_id,recovered.instance_id);
    assert.deepEqual(mcp.snapshot.jobs,recovered.jobs);
    assert.deepEqual(mcp.snapshot.resources,recovered.resources);
    const recording = await (await fetch(origin+'/lab-recording')).json();
    assert.equal(recording.frames.at(-1).snapshot.instance_id,recovered.instance_id);
    const history = await api('history',{cursor:null,limit:64});
    assert(history.events.length>0);
    if (process.env.ASTRA_CHROME_PATH || process.env.OI_TEST_BROWSER === 'true') {
      const browser = await chromium.launch({headless:true,...(process.env.ASTRA_CHROME_PATH?{executablePath:process.env.ASTRA_CHROME_PATH}:{}),args:['--no-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
      try {
        const page = await browser.newPage(); const errors:string[]=[];
        page.on('pageerror',e=>errors.push(e.message));
        await page.goto(origin); await page.waitForFunction(()=> (window as any).ready);
        await page.locator('#connect').click();
        await expect(page.locator('#status')).toContainText('Connected · authoritative');
        await page.locator('#disconnect').click();
        await page.reload(); await page.locator('#connect').click();
        await expect(page.locator('#status')).toContainText('Connected · authoritative');
        assert.deepEqual(errors,[]);
      } finally { await browser.close(); }
    }
    const backup = join(root,'backup');
    await execute(python,['scripts/local_runtime_backup.py',state,backup]);
    await assert.rejects(execute(python,['scripts/local_runtime_backup.py',state,backup]));
    const restored = join(root,'restored');
    await execute(python,['scripts/local_runtime_backup.py',backup,restored]);
    await stop(child!); await start(); // compatible release restart using identical data location
    assert.deepEqual(await api('command',command),paused);
    await stop(child!); await start(restored);
    assert.deepEqual(await api('command',command),paused);
    const copy = (await api('read')).snapshot;
    assert.equal(copy.instance_id,recovered.instance_id);
    assert.deepEqual(copy.jobs,recovered.jobs);
    assert.deepEqual(copy.resources,recovered.resources);
    // A storage/worker failure exits nonzero so systemd can recover the process.
    const failed = once(child!,'exit');
    const damaged = new DatabaseSync(join(restored,'lab.sqlite'));
    damaged.exec('DROP TABLE runtime'); damaged.close();
    const [code] = await failed; assert.equal(code,1);
    // Incomplete state never silently spawns another instance.
    await stop(child!); await rm(join(restored,'operator.json'));
    await assert.rejects(execute(process.execPath,['--import','tsx','scripts/field-lab-viewer.ts'],{env:{...env,FIELD_LAB_VIEWER_STATE_DIR:restored}}));
  } finally {
    delete process.env.OI_LOCAL_CLIENT_FILE;
    if(child) await stop(child);
    await rm(root,{recursive:true,force:true});
  }
});
