import Ajv from 'ajv';

const uuid={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'};
const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
export const farmTools=[
  {name:'astra.farm_read',inputSchema:object({}),description:'Read the persistent sample farm, current robot pose, deposited crops, active job and next bounded action. Synthetic MuJoCo farm, no physical control. Does not start motion.'},
  {name:'astra.farm_capture',inputSchema:object({bed:{type:'integer',minimum:0,maximum:2}}),description:'Capture actual rendered sample-farm pixels and OpenCV color evidence at a fixed pickup ROI. Beds: 0 tomatoes, 1 lettuce, 2 carrots. Returns an observation UUID; read its image with farm_read_frame. Color detection is not semantic crop identification.'},
  {name:'astra.farm_read_frame',inputSchema:object({observation_id:uuid}),description:'Read a stored farm observation and its original PNG image.'},
  {name:'astra.farm_read_job',inputSchema:object({command_id:uuid}),description:'Read durable progress and before/after verification for an accepted farm command. Agent disconnection does not stop the robot.'},
  {name:'astra.farm_command',inputSchema:object({command_id:uuid,expected_revision:{type:'integer',minimum:0},action:{type:'string',enum:['move_to_next_bed','harvest','return_home','pause','resume']},observation_id:uuid},['command_id','expected_revision','action']),description:'Control the sample-farm robot through bounded kinematic segments. Follow farm_read.next_action: move to bed 2, harvest, bed 1, harvest, bed 0, harvest, return home. Harvest requires fresh farm_capture evidence from the current revision. No arbitrary poses or physical actuation. Repeat the identical command UUID/payload after uncertain responses; read the job until completed or needs_review. Pause/resume require a new UUID and current revision. A needs_review result requires operator inspection.'},
];
const validators=new Map(farmTools.map(t=>[t.name,new Ajv({strict:true}).compile(t.inputSchema)]));
const paths={'astra.farm_read':'/status','astra.farm_capture':'/capture','astra.farm_read_frame':'/frame','astra.farm_read_job':'/job','astra.farm_command':'/command'};
export class FarmToolError extends Error {constructor(code){super(code);this.name='FarmToolError';this.code=code;}}
export async function callFarmTool(name,args){
  if(!validators.get(name)?.(args))throw new FarmToolError('INVALID_REQUEST');
  if(!process.env.OI_FARM_URL||!process.env.OI_FARM_TOKEN)throw new FarmToolError('DISABLED');
  try{
    const base=new URL(process.env.OI_FARM_URL);
    if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.search||base.hash)throw Error();
    const response=await fetch(new URL(paths[name],base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json',authorization:`Bearer ${process.env.OI_FARM_TOKEN}`},body:JSON.stringify(args)});
    const text=await response.text();if(text.length>1024*1024)throw Error();const result=JSON.parse(text);
    if(!response.ok){const code=result.error?.code;throw new FarmToolError(typeof code==='string'&&/^[A-Z_]{1,64}$/.test(code)?code:'FARM_UNAVAILABLE');}
    return result;
  }catch(error){if(error instanceof FarmToolError)throw error;throw new FarmToolError('FARM_UNAVAILABLE');}
}
