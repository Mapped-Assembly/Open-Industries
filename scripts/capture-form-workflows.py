#!/usr/bin/env python3
"""Capture real SDK/portable-agent compile outputs without providers or cloud state.

The upstream checkout is pinned and read only. Generated projects and the real
MCP handler's SQLite state live in a temporary directory. See fixture README.
"""
from __future__ import annotations
import argparse
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LEGACY_UPSTREAM = "6125a56e16b71de21d38929bc1ec09e94119ec21"
UPSTREAM = "d594bd3317860eb1225030dcc38d8a2a26f5d291"
FIXED_TIME = "2026-09-29T00:00:00Z"
SANITIZED_FIELDS = {"llm_provider", "model_name", "requested_model", "requested_provider",
                    "runtime_model", "runtime_provider", "model_overridden", "provider_overridden"}


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def canonical(value):
    """Normalize timestamps and remove capture-only model/provider selection."""
    if isinstance(value, list):
        return [canonical(v) for v in value]
    if isinstance(value, dict):
        return {k: FIXED_TIME if k in {"created_at", "updated_at", "generated_at", "timestamp"} and isinstance(v, str)
                else canonical(v) for k, v in value.items() if k not in SANITIZED_FIELDS}
    return value


def seed(agent):
    # Author-owned input, not represented as compiler output. 0.1 quantity/pin
    # records exercise the upstream compiler's real normalization to 0.2.
    components = [{"ref_des": ref, "part_number": ref + "-FIXTURE", "name": name,
                   "category": "Mechanical", "quantity": 1, "unit_price": 5,
                   "rationale": "Deterministic spatial import fixture", "pins": []}
                  for ref, name in [("BASE", "Fixture base"), ("TOP", "Fixture top")]]
    return {"hardware_ir_version": "0.1", "overview": {"title": f"{agent.title()} workflow fixture",
            "description": "Authored test geometry; no physical design claims", "difficulty": "Beginner", "category": "Laboratory"},
            "components": components, "nets": [],
            "mechanical": {"enclosure_type": "Test fixture", "mounting_guidance": "Review only", "manufacturability_rating": "Unverified",
              "render_dimensions": {"x_mm": 100, "y_mm": 60, "z_mm": 40},
              "component_placements": [
                {"ref_des": "BASE", "label": "Fixture base", "position": {"x_mm": 0, "y_mm": 0, "z_mm": 10}, "size": {"x_mm": 100, "y_mm": 60, "z_mm": 20}},
                {"ref_des": "TOP", "label": "Fixture top", "position": {"x_mm": 0, "y_mm": 0, "z_mm": 30}, "size": {"x_mm": 60, "y_mm": 40, "z_mm": 20}}]},
            "assembly_metadata": {"project_id": "10000000-0000-4000-8000-00000000000" + ("1" if agent == "opencode" else "2")},
            "cad_model": "models/block.step" if agent == "opencode" else {"meshes": [{"name": "Fixture base CAD", "ref_des": "BASE",
                "vertices": [-50,-30,0,50,-30,0,0,30,20], "faces": [0,1,2]}]}}


def block_step():
    # A self-authored 100 x 60 x 40 mm faceted BREP. No downloaded third-party CAD.
    lines = ["ISO-10303-21;", "HEADER;", "FILE_DESCRIPTION(('Import test block'),'2;1');",
             "FILE_NAME('block.step','2026-09-29T00:00:00',('OpenIndustries'),('OpenIndustries'),'fixture','fixture','');",
             "FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));", "ENDSEC;", "DATA;"]
    entities = ["APPLICATION_CONTEXT('configuration controlled 3d designs of mechanical parts and assemblies')",
        "APPLICATION_PROTOCOL_DEFINITION('international standard','config_control_design',1994,#1)",
        "PRODUCT_CONTEXT('',#1,'mechanical')", "PRODUCT('Fixture block','Fixture block','',(#3))",
        "PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#4,.NOT_KNOWN.)", "PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design')",
        "PRODUCT_DEFINITION('design','',#5,#6)", "(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))",
        "(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))", "(NAMED_UNIT(*) SOLID_ANGLE_UNIT() SI_UNIT($,.STERADIAN.))",
        "UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-6),#8,'distance_accuracy_value','')",
        "(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#11)) GLOBAL_UNIT_ASSIGNED_CONTEXT((#8,#9,#10)) REPRESENTATION_CONTEXT('',''))"]
    def add(value):
        entities.append(value)
        return len(entities)
    points = [add(f"CARTESIAN_POINT('',({x}.,{y}.,{z}.))") for x,y,z in [(0,0,0),(100,0,0),(100,60,0),(0,60,0),(0,0,40),(100,0,40),(100,60,40),(0,60,40)]]
    faces = []
    for indices, normal, tangent in [((0,3,2,1),(0,0,-1),(1,0,0)),((4,5,6,7),(0,0,1),(1,0,0)),((0,1,5,4),(0,-1,0),(1,0,0)),((1,2,6,5),(1,0,0),(0,1,0)),((2,3,7,6),(0,1,0),(-1,0,0)),((3,0,4,7),(-1,0,0),(0,-1,0))]:
        loop = add("POLY_LOOP('',(" + ','.join(f'#{points[i]}' for i in indices) + "))")
        bound = add(f"FACE_OUTER_BOUND('',#{loop},.T.)")
        axis = add("DIRECTION('',(" + ','.join(str(n)+'.' for n in normal) + "))")
        ref = add("DIRECTION('',(" + ','.join(str(n)+'.' for n in tangent) + "))")
        placement = add(f"AXIS2_PLACEMENT_3D('',#{points[indices[0]]},#{axis},#{ref})")
        plane = add(f"PLANE('',#{placement})")
        faces.append(add(f"FACE_SURFACE('',(#{bound}),#{plane},.T.)"))
    shell = add("CLOSED_SHELL('',(" + ','.join(f'#{f}' for f in faces) + "))")
    brep = add(f"FACETED_BREP('Fixture block',#{shell})")
    shape = add(f"SHAPE_REPRESENTATION('',(#{brep}),#12)")
    definition = add("PRODUCT_DEFINITION_SHAPE('','',#7)")
    add(f"SHAPE_DEFINITION_REPRESENTATION(#{definition},#{shape})")
    lines += [f"#{i}={entity};" for i,entity in enumerate(entities,1)] + ["ENDSEC;", "END-ISO-10303-21;"]
    return ('\n'.join(lines)+'\n').encode()


def offline_network(event, args):
    if event == 'socket.connect' and isinstance(args[1], tuple) and args[1][0] not in {'127.0.0.1', '::1'}:
        raise RuntimeError(f"Fixture capture forbids external connections: {args[1][0]}")


def phase_sdk(output):
    from forma_core.generation import generate_project_with_workflow
    from forma_core.workspaces.projects.objects import build_project_object
    ir = generate_project_with_workflow('default', 'A small temperature sensor enclosure for a laboratory bench',
          provider_name='simulation', persist_project=False,
          generation_metadata={'project_id':'10000000-0000-4000-8000-000000000003','source_agent':'sdk','revision':3})
    write(output/'sdk/project-ir.json', canonical(ir.model_dump(mode='json')))
    write(output/'sdk/project-object.json', canonical(build_project_object(ir).model_dump(mode='json')))


def phase_legacy(output, upstream):
    sys.path.insert(0, str(upstream))
    from blueprint_core.generation import generate_project_with_workflow
    from blueprint_core.database import init_db
    init_db()
    ir = generate_project_with_workflow('default', 'A small temperature sensor enclosure for a laboratory bench',
          provider_name='simulation', generation_metadata={'project_id':'10000000-0000-4000-8000-000000000004','source_agent':'sdk','revision':1})
    assert ir.hardware_ir_version == '0.1'
    write(output/'sdk/project-ir-0.1.json', canonical(ir.model_dump(mode='json')))


def phase_agents(output, upstream):
    sys.path.insert(0, str(upstream))
    from apps.api.a2a import handle_mcp_json_rpc
    from forma_core.database import init_db
    from forma_core.workspaces.projects.objects import build_project_object
    init_db()
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append({**request, 'id':'capture-request'})
            response = asyncio.run(handle_mcp_json_rpc(request))
            data = json.dumps(response).encode()
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(data)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    skill = upstream/'.agents/skills/forma-hardware/scripts'
    try:
        for agent in ['opencode','codex']:
            destination = output/agent
            created = subprocess.check_output([sys.executable,str(skill/'create_project.py'),'--workspace',str(Path.cwd()/'projects')],text=True).strip()
            project = Path(created)
            original = seed(agent)
            write(destination/'authored-ir-0.1.json', original)
            manifest = {'format':'forma-project','version':1,'project_ir':original}
            if agent == 'opencode':
                (project/'models').mkdir(); cad = block_step(); (project/'models/block.step').write_bytes(cad)
                manifest['artifacts']=[{'path':'models/block.step','sha256':hashlib.sha256(cad).hexdigest(),'media_type':'model/step'}]
            write(project/'forma-project.json',manifest)
            subprocess.run([sys.executable,str(skill/'forma.py'),'compile',str(project/'forma-project.json'),
                '--authoring-agent',agent,'--url',f'http://127.0.0.1:{server.server_port}/mcp',
                '--output',str(project/'compiled-project.json'),'--update-project'],check=True)
            for path in project.rglob('*'):
                if not path.is_file(): continue
                target=destination/path.relative_to(project); target.parent.mkdir(parents=True,exist_ok=True)
                if path.suffix=='.json' and path.name!='validation.json': write(target,canonical(json.loads(path.read_text())))
                else: shutil.copyfile(path,target)
            compiled = json.loads((destination/'compiled-project.json').read_text())
            write(destination/'project-object.json',canonical(build_project_object(compiled['project_ir']).model_dump(mode='json')))
        write(output/'compile-requests.json', requests)
    finally:
        server.shutdown();server.server_close()


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--upstream',type=Path,required=True);parser.add_argument('--legacy-upstream',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--phase',choices=['sdk','agents','legacy'])
    args=parser.parse_args();args.upstream=args.upstream.resolve();args.output=args.output.resolve();args.legacy_upstream=args.legacy_upstream.resolve()
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=args.upstream,text=True).strip()!=UPSTREAM: raise SystemExit('Upstream checkout is not the recorded commit')
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=args.legacy_upstream,text=True).strip()!=LEGACY_UPSTREAM: raise SystemExit('Legacy checkout is not the recorded commit')
    if importlib.metadata.version('caid-forma-core')!='0.3.5': raise SystemExit('Install caid-forma-core==0.3.5')
    if args.phase:
        sys.addaudithook(offline_network)
        if args.phase=='sdk': phase_sdk(args.output)
        elif args.phase=='legacy': phase_legacy(args.output,args.legacy_upstream)
        else: phase_agents(args.output,args.upstream)
        return
    args.output.mkdir(parents=True,exist_ok=True)
    for phase in ['sdk','agents','legacy']:
        with tempfile.TemporaryDirectory(prefix='form-capture-') as directory:
            env={key:os.environ[key] for key in ['PATH','SYSTEMROOT'] if key in os.environ}
            env.update({'BLUEPRINT_DEV_MODE':'true','FORMA_DEVELOPMENT_MODE':'true','DATABASE_BACKEND':'sqlite','SQLITE_DATABASE_URL':f'sqlite:///{directory}/fixture.db',
                'FORMA_DEPLOYMENT_MODE':'local','FORMA_CAD_WORKSPACE':f'{directory}/cad','PYTHONUNBUFFERED':'1','FORMA_AUTH_MODE':'none'})
            subprocess.run([sys.executable,str(Path(__file__).resolve()),'--upstream',str(args.upstream),'--legacy-upstream',str(args.legacy_upstream),'--output',str(args.output),'--phase',phase],env=env,cwd=directory,check=True)
    # Only source/tool identity and file hashes, never environment dumps.
    write(args.output/'provenance.json',{'sdk_distribution':'caid-forma-core==0.3.5','upstream_repository':'https://github.com/caid-technologies/Form-OSS',
        'legacy_sdk_commit':LEGACY_UPSTREAM,'upstream_commit':UPSTREAM,'agent_client_sha256':hashlib.sha256((args.upstream/'.agents/skills/forma-hardware/scripts/forma.py').read_bytes()).hexdigest(),
        'sdk_mode':'deterministic simulation','agent_mode':'published portable agent compile client + real local MCP handler + isolated SQLite',
        'sanitized_fields':sorted(SANITIZED_FIELDS),'native_agent_apps_executed':False,'live_provider_calls':False,'normalized_fields':['created_at','updated_at','generated_at','timestamp'],
        'files':{str(p.relative_to(args.output)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(args.output.rglob('*')) if p.suffix in {'.json','.step','.svg','.mmd'} and p.name!='provenance.json'}})

if __name__=='__main__':main()
