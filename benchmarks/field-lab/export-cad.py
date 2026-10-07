"""Export the same scenario pipette primitives to STEP in millimeters, Z-up."""
import json,sys,math
from pathlib import Path
import cadquery as cq
root=Path(sys.argv[1]);spec=json.loads((root/'pipette-geometry-spec.json').read_text());assembly=cq.Assembly(name='Field_Lab_Pipette_Fixture')
for i,s in enumerate(spec):
 p=[x*1000 for x in s['position']]
 if s['type']=='box':
  w,h,d=[x*1000 for x in s['size']]
  body=cq.Workplane('XY').box(w,d,h).val()
 elif s['type']=='cylinder':
  r,rt,h=s['radius']*1000,s['topRadius']*1000,s['height']*1000
  body=cq.Solid.makeCylinder(r,h).translate((0,0,-h/2)) if r==rt else cq.Solid.makeCone(r,rt,h).translate((0,0,-h/2))
 elif s['type']=='torus':
  body=cq.Solid.makeTorus(s['radius']*1000,s['tube']*1000)
 else:continue
 # None of this fixture's primitives are rotated; enforce that contract.
 assert not any(s.get('rotation',[]))
 body=body.translate((p[0],-p[2],p[1]))
 col=s['color'].lstrip('#');rgb=[int(col[k:k+2],16)/255 for k in (0,2,4)]
 assembly.add(body,name=f"{s['name'].replace('-','_')}_{i:03}",color=cq.Color(*rgb))
assembly.save(str(root/'field-lab-pipette.step'))
print('Exported',len(spec),'solids as Z-up millimeter STEP.')
