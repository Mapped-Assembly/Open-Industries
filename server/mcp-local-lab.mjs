import { readFileSync } from 'node:fs';

const empty = {type: 'object', properties: {}, additionalProperties: false};
export const localLabTools = [
  {name: 'astra.local_lab_read', description: 'Read the installed local FIELD-LAB instance shared with its viewer. Does not create a task.', inputSchema: empty},
  {name: 'astra.local_lab_history', description: 'Read retained local FIELD-LAB history with an opaque continuation cursor.', inputSchema: {type:'object', properties:{cursor:{type:['string','null']},limit:{type:'integer',minimum:1,maximum:64}}, required:['cursor','limit'],additionalProperties:false}},
  {name: 'astra.local_lab_command', description: 'Pause, resume, fail or cancel a simulated job on the installed local station. Reuse command_id after an uncertain response; read the current revision first.', inputSchema:{type:'object',properties:{command_id:{type:'string'},expected_revision:{type:'integer',minimum:0},action:{type:'string',enum:['pause','resume','fail','cancel']},payload:{type:'object',properties:{job_id:{type:'string'}},required:['job_id'],additionalProperties:false}},required:['command_id','expected_revision','action','payload'],additionalProperties:false}},
];
/** Client capability stays in a private file; this adapter never starts a worker. */
export async function callLocalLabTool(name, args = {}) {
  try {
    if (!process.env.OI_LOCAL_CLIENT_FILE) throw Error();
    const config = JSON.parse(readFileSync(process.env.OI_LOCAL_CLIENT_FILE, 'utf8'));
    const origin = new URL(config.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash || typeof config.token !== 'string') throw Error();
    const route = {'astra.local_lab_read':'read','astra.local_lab_history':'history','astra.local_lab_command':'command'}[name];
    if (!route) throw Error();
    const response = await fetch(new URL(`/lab-api/${route}`, origin), {
      method: route === 'read' ? 'GET' : 'POST', redirect:'error', signal:AbortSignal.timeout(10000),
      headers:{authorization:`Bearer ${config.token}`, 'content-type':'application/json'},
      ...(route === 'read' ? {} : {body:JSON.stringify(args)}),
    });
    if (!response.ok) throw Error();
    // History is bounded by the runtime. Cap the transport independently too.
    let length = 0; const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) throw Error();
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch { throw Error('LOCAL_LAB_UNAVAILABLE: check service health and private client configuration; command outcome may be unknown.'); }
}
