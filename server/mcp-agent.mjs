import Ajv from 'ajv';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const object = properties => ({type:'object', additionalProperties:false, properties, required:Object.keys(properties)});
const input = object({
  binding_id:{type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]*$'},
  run_id:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'},
});
export const agentTools = [
  {name:'astra.agent_inspect_robot', inputSchema:input,
    description:'Start or advance a configured simulated robot inspection. OpenCV evidence can trigger a survey command, one recapture, or needs_review. Repeat the same binding_id/run_id until completed or needs_review. Never replace an uncertain run with a new ID. Requires operator-configured camera/robot/target bindings. No physical control.'},
  {name:'astra.agent_read_inspection', inputSchema:input,
    description:'Read an authorized historical inspection trace, including image/observation references, the exact runtime command, job ID and verification outcome. This does not advance the workflow or assert current machine state.'},
];
const validate = new Ajv({strict:true}).compile(input);

/** Public failures contain stable codes, never subprocess output or secret configuration. */
export class AgentToolError extends Error {
  constructor(code) { super(code); this.name='AgentToolError'; this.code=code; }
}

/** Run one Python policy phase while the existing MCP/runtime services retain authority. */
export async function callAgentTool(root, name, args) {
  if (!validate(args)) throw new AgentToolError('INVALID_REQUEST');
  if (process.env.OI_AGENT_ENABLED !== 'true') throw new AgentToolError('DISABLED');
  const python=process.env.OI_AGENT_PYTHON || (process.platform==='win32'?'python':'python3');
  const config=resolve(root,process.env.OI_AGENT_CONFIG || '.astra/vision-agent/config.json');
  const database=resolve(root,process.env.OI_AGENT_DATABASE || '.astra/vision-agent/inspections.sqlite');
  const operation=name==='astra.agent_inspect_robot'?'advance':'read';
  return new Promise((accept,reject)=>{
    const processChild=spawn(python,['-m','oi_vision.agent_cli',operation,'--root',root,'--config',config,
      '--database',database,'--binding',args.binding_id,'--run-id',args.run_id],
      {cwd:root,env:process.env,stdio:['ignore','pipe','ignore']});
    const chunks=[]; let size=0, finished=false;
    const finish=(error,result)=>{
      if(finished)return;
      finished=true; clearTimeout(timer);
      if(error){processChild.kill('SIGKILL');reject(new AgentToolError(error));}else accept(result);
    };
    // A killed policy may have sent its durable command. Retrying the same run
    // reuses its prepared payload; no timeout is interpreted as cancellation.
    const timer=setTimeout(()=>finish('OUTCOME_UNKNOWN'),90000);
    processChild.on('error',()=>finish('UNAVAILABLE'));
    processChild.stdout.on('data',chunk=>{
      size+=chunk.length;
      if(size>256*1024)finish('INVALID_RESULT'); else chunks.push(chunk);
    });
    processChild.on('close',code=>{
      if(finished)return;
      try {
        if(code!==0)throw Error();
        const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(result.error){
          const code=result.error.code;
          return finish(typeof code==='string' && /^[A-Z_]{1,64}$/.test(code)?code:'UNAVAILABLE');
        }
        const record=result.inspection;
        if(!record || record.version!==1 || record.run_id!==args.run_id || record.binding_id!==args.binding_id
          || !['observing','ready','dispatching','running','verifying','completed','needs_review'].includes(record.stage))throw Error();
        finish(null,result);
      } catch {finish('OUTCOME_UNKNOWN');}
    });
  });
}
