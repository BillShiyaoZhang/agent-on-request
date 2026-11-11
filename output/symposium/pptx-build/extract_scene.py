"""Read the existing diagram source into vector primitives without rewriting PDFs."""
from pathlib import Path
from functools import wraps
import json
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT.parent / 'build_materials.py'
HEIGHT = 595.28


def color(value):
    return '#'+''.join(f'{round(getattr(value,k)*255):02X}' for k in ['red','green','blue'])


class DrawPath:
    def __init__(self): self.commands=[]
    def moveTo(self,x,y): self.commands.append(['M',x,HEIGHT-y])
    def lineTo(self,x,y): self.commands.append(['L',x,HEIGHT-y])
    def curveTo(self,x1,y1,x2,y2,x,y): self.commands.append(['C',x1,HEIGHT-y1,x2,HEIGHT-y2,x,HEIGHT-y])
    def close(self): self.commands.append(['Z'])


class Recorder:
    current=None
    def __init__(self,*args,**kwargs):
        Recorder.current=self
        self.slides=[]; self.items=[]; self.group=None
        self.fill='#FFFFFF'; self.stroke='#000000'; self.width=1; self.dash=[]
        self.font='R'; self.size=12
    def setTitle(self,*args): pass
    def setAuthor(self,*args): pass
    def getPageNumber(self): return len(self.slides)+1
    def setFillColor(self,v): self.fill=color(v)
    def setStrokeColor(self,v): self.stroke=color(v)
    def setLineWidth(self,v): self.width=v
    def setLineCap(self,*args): pass
    def setDash(self,v): self.dash=list(v)
    def setFont(self,font,size): self.font=font; self.size=size
    def emit(self,item):
        item.update(group=self.group,fill=self.fill,stroke=self.stroke,strokeWidth=self.width,dash=self.dash[:])
        self.items.append(item)
    def roundRect(self,x,y,w,h,r,stroke=1,fill=1):
        self.emit(dict(kind='rect',x=x,y=HEIGHT-y-h,w=w,h=h,r=r,hasStroke=bool(stroke),hasFill=bool(fill)))
    def circle(self,x,y,r,stroke=1,fill=1):
        self.emit(dict(kind='ellipse',x=x-r,y=HEIGHT-y-r,w=2*r,h=2*r,hasStroke=bool(stroke),hasFill=bool(fill)))
    def line(self,x1,y1,x2,y2):
        self.emit(dict(kind='path',commands=[['M',x1,HEIGHT-y1],['L',x2,HEIGHT-y2]],hasStroke=True,hasFill=False))
    def beginPath(self): return DrawPath()
    def drawPath(self,p,stroke=1,fill=0):
        self.emit(dict(kind='path',commands=p.commands,hasStroke=bool(stroke),hasFill=bool(fill)))
    def drawString(self,x,y,value):
        self.emit(dict(kind='text',x=x,y=HEIGHT-y-self.size,w=pdfmetrics.stringWidth(value,self.font,self.size),
                       size=self.size,bold=self.font=='B',value=value,hasFill=False,hasStroke=False))
    def showPage(self):
        self.slides.append(self.items); self.items=[]
    def save(self): pass


def main():
    original=canvas.Canvas
    canvas.Canvas=Recorder
    try:
        src=SOURCE.read_text()
        prefix,draw=src.split('# 1. Independent assistants, explicit exchange, three tasks.',1)
        draw=draw.split('\nreader=PdfReader(PATH)',1)[0]
        env={'__file__':str(SOURCE),'__name__':'vector_scene_capture'}
        exec(compile(prefix,str(SOURCE),'exec'),env)
        rec=Recorder.current
        counter=0
        def grouped(fn,name):
            @wraps(fn)
            def wrapped(*args,**kwargs):
                nonlocal counter
                owns=rec.group is None
                if owns:
                    counter+=1; rec.group=f'{counter:03d}_{name}'
                try: return fn(*args,**kwargs)
                finally:
                    if owns: rec.group=None
            return wrapped
        for name in ['person','bot','graph','evidence','skill','lock','envelope','receipt','calendar','talk','discussion',
                     'room','paper','pointer','button','checkbox','number','arrow','bidir','tick','cross','neq']:
            env[name]=grouped(env[name],name)
        exec(compile(draw,str(SOURCE),'exec'),env)
        assert len(rec.slides)==3
        data={'width':841.89,'height':HEIGHT,'slides':rec.slides}
        (ROOT/'scene.json').write_text(json.dumps(data))
        print({'slides':3,'objects_per_slide':[len(s) for s in rec.slides],
               'text_objects':sum(e['kind']=='text' for s in rec.slides for e in s),'icon_groups':counter})
    finally: canvas.Canvas=original


if __name__=='__main__': main()
