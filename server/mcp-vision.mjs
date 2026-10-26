import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import { visionTools, visionRoutes, visionResultSchemas } from './mcp-vision-contract.mjs';

/** Sanitized transport failure; no raw remote response or configuration is exposed. */
export class VisionToolError extends Error {
  constructor(code) { super(code); this.name='VisionToolError'; this.code=code; }
}
const ajv = new Ajv({strict:true});
const inputs = new Map(visionTools.map(tool=>[tool.name,ajv.compile(tool.inputSchema)]));
const outputs = new Map(Object.entries(visionResultSchemas).map(([name,schema])=>[name,ajv.compile(schema)]));
const errors = new Set(['AUTH_REQUIRED','NOT_FOUND','INVALID_REQUEST','REQUEST_ID_REUSED','STALE_FRAME',
  'CAMERA_UNAVAILABLE','SOURCE_CHANGED','IMAGE_TOO_LARGE','INVALID_IMAGE','STORAGE_LIMIT','STORE_UNAVAILABLE','PROCESSING_FAILED']);

/** Call the independently running Python service using the host's machine-scoped token. */
export async function callVisionTool(name, args) {
  if (!inputs.get(name)?.(args)) throw new VisionToolError('INVALID_REQUEST');
  if (name==='astra.vision_describe') return {contract_version:1,requires_service:true,opencv_major:5,
    adapters:['file','http_snapshot'],detectors:['image_quality','color_regions'],controls_hardware:false};
  if (process.env.OI_VISION_ENABLED!=='true') throw new VisionToolError('DISABLED');
  const token=process.env.OI_VISION_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new VisionToolError('AUTH_REQUIRED');
  let base;
  try {
    base=new URL(process.env.OI_VISION_SERVICE_URL || 'http://127.0.0.1:8792');
    const localHttp=base.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname);
    if ((!localHttp && base.protocol!=='https:') || base.username || base.password || base.pathname!=='/' || base.search || base.hash) throw Error();
  } catch { throw new VisionToolError('UNAVAILABLE'); }
  try {
    const response=await fetch(new URL(visionRoutes[name],base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),
      headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(args)});
    const reader=response.body?.getReader();
    if (!reader) throw new VisionToolError('OUTCOME_UNKNOWN');
    const chunks=[]; let size=0;
    while (true) {
      const {done,value}=await reader.read(); if (done) break;
      size+=value.length;
      if(size>2*1024*1024){await reader.cancel();throw new VisionToolError('INVALID_RESULT');}
      chunks.push(value);
    }
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(!response.ok)throw new VisionToolError(errors.has(result?.error?.code)?result.error.code:'UNAVAILABLE');
    if(!outputs.get(name)?.(result))throw new VisionToolError('INVALID_RESULT');
    if(result.preview && createHash('sha256').update(Buffer.from(result.preview.data,'base64')).digest('hex')!==result.preview.sha256)
      throw new VisionToolError('INVALID_RESULT');
    return result;
  } catch(error) {
    if(error instanceof VisionToolError)throw error;
    throw new VisionToolError('OUTCOME_UNKNOWN');
  }
}
