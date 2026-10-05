import { record } from '../lib/form';
import type { SceneItem } from '../lib/workspace';

function FieldList({value}:{value:unknown}) {
  const fields=record(value);
  return Object.keys(fields).length?<dl className="project-meta">{Object.entries(fields).filter(([,v])=>typeof v==='string'||typeof v==='number'||typeof v==='boolean').map(([key,v])=><div key={key}><dt>{key.replace(/_/g,' ')}</dt><dd>{String(v)}</dd></div>)}</dl>:<p>No data supplied.</p>;
}
export function ProjectInspector({item,selectedPart,selectPart}:{item?:SceneItem;selectedPart:number;selectPart:(index:number)=>void}) {
  if(!item)return <><h2>A space for<br/>what’s next.</h2><p>Select an asset to inspect its components and source data.</p></>;
  const asset=item.asset;const project=asset.formProject;const ir=project?.ir??{};
  const definitions=Array.isArray(ir.part_definitions)?ir.part_definitions.map(record):[];
  const components=Array.isArray(ir.components)?ir.components.map(record):[];
  const validation=record(ir.validation);const bom=Array.isArray(ir.bom)?ir.bom.map(record):[];
  return <><h2>{item.name}</h2><span className="badge">{asset.source.kind.toUpperCase()}</span><h3>Layout instance</h3><p>{item.position.map(n=>n.toFixed(3)).join(' × ')} m<br/>Rotation {item.rotation.map(n=>n.toFixed(1)).join(' / ')}°</p><p className="notice">Mergence spatial edits do not alter or electrically revalidate the Form-authored design.</p><h3>Dimensions</h3><p>{asset.dimensions.map(n=>n.toFixed(3)).join(' × ')} m</p>{asset.warnings.map(w=><p className="notice" key={w}>{w}</p>)}
    {project&&<>
      <details open><summary>Form project</summary><FieldList value={{project_id:project.projectId??'Not supplied',revision:project.revision??'Not supplied',agent:project.agent??'Not supplied',hardware_ir_version:project.hardwareIrVersion,input:project.source}}/></details>
      <details open><summary>Overview</summary><FieldList value={ir.overview}/></details>
      <details open><summary>Validation</summary>{['critical','error','warning','info'].map(severity=><div key={severity}>{Array.isArray(validation[severity])&&(validation[severity] as unknown[]).map((v,i)=><div className={`validation-finding ${severity}`} key={i}><b>{severity.toUpperCase()}</b><p>{typeof v==='string'?v:String(record(v).description??record(v).message??'Finding supplied')}</p>{Boolean(record(v).troubleshooting)&&<p>{String(record(v).troubleshooting)}</p>}</div>)}</div>)}{!Object.values(validation).some(v=>Array.isArray(v)&&v.length)&&<p>No validation findings supplied.</p>}</details>
      <details><summary>Bill of materials ({bom.length})</summary>{bom.length?bom.map((row,i)=><div className="bom-row" key={i}><b>{String(row.name??row.part_number??row.part_definition_id??`Part ${i+1}`)}</b><FieldList value={row}/></div>):<p>No bill of materials supplied.</p>}</details>
      <details><summary>Mechanical data</summary><FieldList value={ir.mechanical}/>{Array.isArray(record(ir.mechanical).fabrication_details)&&<ul>{(record(ir.mechanical).fabrication_details as unknown[]).map((v,i)=><li key={i}>{String(v)}</li>)}</ul>}</details>
    </>}
    <details open><summary>Source</summary><FieldList value={asset.source}/><p>Instance ID: {item.id}</p>{item.cloudVersionId&&<p>Cloud file version: {item.cloudVersionId}</p>}</details>
    <h3>Components</h3>{asset.parts.map((part,i)=>{
      const component=components.find(c=>c.ref_des===part.metadata.ref);const definition=definitions.find(d=>d.part_definition_id===component?.part_definition_id);
      return <details key={part.id} open={selectedPart===i}><summary><button className="part-select" onClick={()=>selectPart(i)}>{part.name}</button></summary><FieldList value={part.metadata}/>{definition&&<FieldList value={definition}/>}<small>Scene part ID: {part.id}</small></details>;
    })}
    {components.filter(c=>!asset.parts.some(p=>p.metadata.ref===c.ref_des)).length>0&&<details><summary>Components without mapped geometry</summary>{components.filter(c=>!asset.parts.some(p=>p.metadata.ref===c.ref_des)).map((c,i)=><FieldList key={i} value={c}/>)}</details>}
    {project&&<details><summary>Retained source JSON</summary><pre>{JSON.stringify(project.ir,null,2)}</pre></details>}
  </>;
}
