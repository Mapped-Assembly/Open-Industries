/** Versioned camera and observation schemas shared by MCP discovery and validation. */
const id = {type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]*$'};
const hash = {type:'string',pattern:'^[a-f0-9]{64}$'};
const integer = (minimum,maximum=Number.MAX_SAFE_INTEGER)=>({type:'integer',minimum,maximum});
const object = (properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const array = (items,maxItems)=>({type:'array',items,maxItems});
const vector = (length,maximum)=>({...array({type:'number',minimum:0,maximum},length),minItems:length});
const maybeTime = {anyOf:[integer(0),{type:'null'}]};
const cameraFields = {camera_id:id,machine_id:id,adapter:{enum:['file','http_snapshot']},evidence_kind:{enum:['physical','simulation','fixture']}};
const camera = object(cameraFields);
const frame = object({version:{const:1},...cameraFields,frame_id:id,acquired_at_ms:integer(0),source_modified_at_ms:maybeTime,
  sha256:hash,byte_length:integer(1,4*1024*1024),media_type:{enum:['image/png','image/jpeg']},width:integer(1,4096),height:integer(1,4096)});
const profile = {oneOf:[
  object({profile_id:id,type:{const:'image_quality'}}),
  object({profile_id:id,type:{const:'color_regions'},label:id,lower_hsv:vector(3,255),upper_hsv:vector(3,255),min_area_px:integer(1,8000000)}),
]};
const observation = object({version:{const:1},observation_id:id,frame_id:id,camera_id:id,machine_id:id,
  evidence_kind:cameraFields.evidence_kind,frame_sha256:hash,acquired_at_ms:integer(0),analyzed_at_ms:integer(0),
  source_modified_at_ms:maybeTime,source_age_known:{type:'boolean'},profile,profile_sha256:hash,
  detector_version:{const:'oi-opencv-regions/1'},opencv_version:{type:'string',pattern:'^5\\.',maxLength:64},
  metrics:object({mean_luma:{type:'number',minimum:0,maximum:255},laplacian_variance:{type:'number',minimum:0},mask_fraction:{type:'number',minimum:0,maximum:1}},['mean_luma','laplacian_variance']),
  detections:array(object({label:id,bbox_px:vector(4,4096),centroid_px:vector(2,4096),area_px:{type:'number',minimum:0,maximum:8000000}}),64),
  detection_count:integer(0,8000000),truncated:{type:'boolean'},interpretation:{type:'string',maxLength:256},
});
const preview = object({mime_type:{const:'image/jpeg'},data:{type:'string',maxLength:524288,pattern:'^[A-Za-z0-9+/]*={0,2}$'},sha256:hash,width:integer(1,384),height:integer(1,384)});

export const visionTools = [
  {name:'astra.vision_describe',description:'Describe installed vision tools. This does not assert that a camera or service is available.',inputSchema:object({})},
  {name:'astra.vision_list_cameras',description:'List cameras authorized for this machine-agent principal and configured detector profiles. Source URLs and credentials are never exposed.',inputSchema:object({})},
  {name:'astra.vision_capture',description:'Capture and persist one image. Retry a lost response with the same request_id and arguments; use a new request_id for a new frame. Evidence kind is operator-declared.',inputSchema:object({camera_id:id,request_id:id})},
  {name:'astra.vision_read_frame',description:'Read authorized frame metadata and a resized JPEG evidence preview. The preview has its own hash; the frame hash identifies original source bytes.',inputSchema:object({frame_id:id})},
  {name:'astra.vision_analyze',description:'Run real OpenCV 5 against a saved frame with a configured profile. Enforce max_age_ms against acquisition and known source modification time. Unknown exposure time remains unknown. Historical receipt retries never reanalyze.',inputSchema:object({frame_id:id,profile_id:id,request_id:id,max_age_ms:integer(1,86400000)})},
  {name:'astra.vision_read_observation',description:'Read immutable historical pixel measurements and their evidence/profile hashes. This is not a fresh machine-state check or authorization to actuate.',inputSchema:object({observation_id:id})},
  {name:'astra.vision_list_observations',description:'List up to 100 recent authorized observations for one camera, newest first. No machine actuation.',inputSchema:object({camera_id:id,limit:integer(1,100)})},
];

export const visionRoutes = {
  'astra.vision_list_cameras':'/v1/cameras/list',
  'astra.vision_capture':'/v1/frames/capture',
  'astra.vision_read_frame':'/v1/frames/read',
  'astra.vision_analyze':'/v1/frames/analyze',
  'astra.vision_read_observation':'/v1/observations/read',
  'astra.vision_list_observations':'/v1/observations/list',
};
export const visionResultSchemas = {
  'astra.vision_list_cameras':object({cameras:array(camera,128),profiles:array(profile,128)}),
  'astra.vision_capture':object({frame}),
  'astra.vision_read_frame':object({frame,preview}),
  'astra.vision_analyze':object({observation}),
  'astra.vision_read_observation':object({observation}),
  'astra.vision_list_observations':object({observations:array(observation,100)}),
};
