import { SimulationDatabase } from '../../server/simulation/sqlite-runtime.js';
const runtime=new SimulationDatabase(process.argv[2]!,{clock:()=>Number(process.argv[3])});
try{
  if(process.argv[4]==='tick')runtime.tick(process.argv[5]==='crash'?()=>{
    process.stdout.write('before-commit\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  }:undefined);
  else process.stdout.write(JSON.stringify(runtime.execute(process.argv[4]!,JSON.parse(process.argv[5]!))));
}catch(error){process.stdout.write(JSON.stringify({error:{code:error instanceof Error&&'code'in error?error.code:'UNAVAILABLE'}}));}
finally{runtime.close();}
