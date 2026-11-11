"""Keep all saved user parts unchanged except the edited first slide."""
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
from xml.etree import ElementTree as E
from collections import Counter
import re,json,hashlib

ROOT=Path(__file__).resolve().parent
P='http://schemas.openxmlformats.org/presentationml/2006/main'
A='http://schemas.openxmlformats.org/drawingml/2006/main'
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
REL='http://schemas.openxmlformats.org/package/2006/relationships'
N={'p':P,'a':A}
E.register_namespace('p',P);E.register_namespace('a',A);E.register_namespace('r',R)
def q(ns,name):return '{'+ns+'}'+name
slide='ppt/slides/slide1.xml'
rels='ppt/slides/_rels/slide1.xml.rels'
with ZipFile(ROOT/'source.pptx') as z,ZipFile(ROOT/'edited-export.pptx') as ze:
    original=z.read(slide)
    doc=E.fromstring(ze.read(slide))
    old_text=Counter(t.text or '' for t in E.fromstring(original).findall('.//a:t',N))
    new_text=Counter(t.text or '' for t in doc.findall('.//a:t',N))
    # Newlines split the title into two runs/paragraphs; compare lexical coverage.
    words=lambda root:Counter(' '.join((t.text or '') for t in root.findall('.//a:t',N)).split())
    assert words(E.fromstring(original))==words(doc),'A user label changed during the layout edit.'
    or_=E.fromstring(z.read(rels)); er=E.fromstring(ze.read(rels))
    originals={e.attrib['Id']:e.attrib for e in or_}
    exports={e.attrib['Id']:e.attrib for e in er}
    remap={}
    for element in doc.iter():
        for key,value in list(element.attrib.items()):
            if key.startswith('{'+R+'}'):
                rel=exports[value]
                matching=[i for i,v in originals.items() if (v.get('Type'),v.get('Target'),v.get('TargetMode'))==(rel.get('Type'),rel.get('Target'),rel.get('TargetMode'))]
                assert matching,('An unexpected first-slide relationship needs review',rel)
                element.set(key,matching[0])
    tree=doc.find('p:cSld/p:spTree',N)
    next_id=max(int(v.attrib['id']) for v in doc.findall('.//p:cNvPr',N))+1
    # Import flattens editable groups. Restore each contiguous icon independently,
    # including the user's duplicated graphs (which have repeated shape names).
    chunks=[]; current=[]; prefix=None
    for child in list(tree):
        nv=child.find('.//p:cNvPr',N)
        m=re.match(r'GROUP_(\d+_[a-z]+)__',nv.attrib.get('name','')) if nv is not None else None
        name=m.group(1) if m else None
        if name and name==prefix:current.append(child)
        else:
            if current:chunks.append((prefix,current))
            current=[child] if name else [];prefix=name
    if current:chunks.append((prefix,current))
    for name,children in chunks:
        if len(children)<2:continue
        bounds=[]
        for child in children:
            tr=child.find('.//a:xfrm',N);off=tr.find('a:off',N);ex=tr.find('a:ext',N)
            x,y=int(off.attrib['x']),int(off.attrib['y']);w,h=int(ex.attrib['cx']),int(ex.attrib['cy'])
            bounds.append((x,y,x+w,y+h))
        x=min(b[0] for b in bounds);y=min(b[1] for b in bounds);w=max(b[2] for b in bounds)-x;h=max(b[3] for b in bounds)-y
        g=E.Element(q(P,'grpSp'));nv=E.SubElement(g,q(P,'nvGrpSpPr'))
        E.SubElement(nv,q(P,'cNvPr'),{'id':str(next_id),'name':name.replace('_',' ')});next_id+=1
        E.SubElement(nv,q(P,'cNvGrpSpPr'));E.SubElement(nv,q(P,'nvPr'))
        tr=E.SubElement(E.SubElement(g,q(P,'grpSpPr')),q(A,'xfrm'))
        for tag,attrs in [('off',{'x':str(x),'y':str(y)}),('ext',{'cx':str(max(w,1)),'cy':str(max(h,1))}),('chOff',{'x':str(x),'y':str(y)}),('chExt',{'cx':str(max(w,1)),'cy':str(max(h,1))})]:E.SubElement(tr,q(A,tag),attrs)
        index=list(tree).index(children[0])
        for child in children:tree.remove(child);g.append(child)
        tree.insert(index,g)
    payload=E.tostring(doc,encoding='utf-8',xml_declaration=True)
    with ZipFile(ROOT/'candidate.pptx','w',ZIP_DEFLATED) as out:
        for info in z.infolist():out.writestr(info,payload if info.filename==slide else z.read(info.filename))
with ZipFile(ROOT/'source.pptx') as z,ZipFile(ROOT/'candidate.pptx') as out:
    changed=[name for name in z.namelist() if z.read(name)!=out.read(name)]
    assert changed==[slide],changed
    report={'changed_parts':changed,'slides_2_and_3_unchanged':True,'first_slide_labels_preserved':True}
    (ROOT/'preservation.json').write_text(json.dumps(report,indent=2))
    print(report)
