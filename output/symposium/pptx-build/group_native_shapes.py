"""Add native OOXML groups without rasterizing or changing child coordinates."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.etree import ElementTree as ET
import re

ROOT=Path(__file__).resolve().parent
NS={'p':'http://schemas.openxmlformats.org/presentationml/2006/main',
    'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
for prefix,uri in NS.items(): ET.register_namespace(prefix,uri)
def q(prefix,name): return '{'+NS[prefix]+'}'+name

groups_total=0
with ZipFile(ROOT/'ungrouped-candidate.pptx') as zin, ZipFile(ROOT/'candidate.pptx','w',ZIP_DEFLATED) as zout:
    for entry in zin.infolist():
        payload=zin.read(entry.filename)
        if re.fullmatch(r'ppt/slides/slide\d+\.xml',entry.filename):
            doc=ET.fromstring(payload); tree=doc.find('p:cSld/p:spTree',NS)
            existing_ids=[int(e.attrib['id']) for e in doc.findall('.//p:cNvPr',NS)]
            next_id=max(existing_ids,default=0)+1
            groups={}
            for child in list(tree):
                nv=child.find('.//p:cNvPr',NS)
                match=re.match(r'GROUP_(\d+_[a-z]+)__',nv.attrib.get('name','')) if nv is not None else None
                if match: groups.setdefault(match.group(1),[]).append(child)
            for name,children in groups.items():
                if len(children)<2: continue
                bounds=[]
                for child in children:
                    tr=child.find('.//a:xfrm',NS)
                    off=tr.find('a:off',NS); ext=tr.find('a:ext',NS)
                    x,y=int(off.attrib['x']),int(off.attrib['y'])
                    w,h=int(ext.attrib['cx']),int(ext.attrib['cy'])
                    bounds.append((x,y,x+w,y+h))
                x=min(v[0] for v in bounds); y=min(v[1] for v in bounds)
                w=max(v[2] for v in bounds)-x; h=max(v[3] for v in bounds)-y
                group=ET.Element(q('p','grpSp'))
                nv=ET.SubElement(group,q('p','nvGrpSpPr'))
                ET.SubElement(nv,q('p','cNvPr'),{'id':str(next_id),'name':name.replace('_',' ')})
                next_id+=1
                ET.SubElement(nv,q('p','cNvGrpSpPr')); ET.SubElement(nv,q('p','nvPr'))
                tr=ET.SubElement(ET.SubElement(group,q('p','grpSpPr')),q('a','xfrm'))
                for tag,attrs in [('off',{'x':str(x),'y':str(y)}),('ext',{'cx':str(max(1,w)),'cy':str(max(1,h))}),
                                  ('chOff',{'x':str(x),'y':str(y)}),('chExt',{'cx':str(max(1,w)),'cy':str(max(1,h))})]:
                    ET.SubElement(tr,q('a',tag),attrs)
                index=list(tree).index(children[0])
                for child in children: tree.remove(child); group.append(child)
                tree.insert(index,group); groups_total+=1
            payload=ET.tostring(doc,encoding='utf-8',xml_declaration=True)
        zout.writestr(entry,payload)
print({'native_icon_groups':groups_total})
