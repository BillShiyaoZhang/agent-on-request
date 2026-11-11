import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Presentation, PresentationFile, FileBlob } from '@oai/artifact-tool';

const buildDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(buildDir, '../../..');
const skillDir = '/Users/shiyaozhang/.codex/plugins/cache/openai-primary-runtime/presentations/26.1110.11258/skills/presentations';
const runtimePython = '/Users/shiyaozhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const reference = path.join(workspaceDir, 'output/pdf/symposium-interactive-materials-draft.pdf');
const finalPath = path.join(workspaceDir, 'output/pptx/agent-on-request-editable.pptx');
const scene = JSON.parse(await fs.readFile(path.join(buildDir, 'scene.json'), 'utf8'));
process.env.RUNTIME_NODE_MODULES = '/Users/shiyaozhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const K = 4 / 3;
const presentation = Presentation.create({ slideSize: { width: scene.width*K, height: scene.height*K } });
const stats = [];
const titles = ['Two assistants. One shared task.', 'Meaning. Disclosure. Action.', 'Try it'];

function customPath(item) {
  const pts = item.commands.flatMap(([op,...p]) => op==='Z' ? [] : Array.from({ length:p.length/2 }, (_,i) => [p[2*i],p[2*i+1]]));
  const left = Math.min(...pts.map(p=>p[0]));
  const top = Math.min(...pts.map(p=>p[1]));
  const width = Math.max(.1,Math.max(...pts.map(p=>p[0]))-left);
  const height = Math.max(.1,Math.max(...pts.map(p=>p[1]))-top);
  const commands = item.commands.map(([op,...p]) => {
    if (op==='M') return { moveTo: { x:(p[0]-left)*K, y:(p[1]-top)*K } };
    if (op==='L') return { lineTo: { x:(p[0]-left)*K, y:(p[1]-top)*K } };
    if (op==='C') return { cubicBezTo: { x1:(p[0]-left)*K,y1:(p[1]-top)*K,x2:(p[2]-left)*K,y2:(p[3]-top)*K,x:(p[4]-left)*K,y:(p[5]-top)*K } };
    return { close: {} };
  });
  return { position:{left:left*K,top:top*K,width:width*K,height:height*K},customPaths:[{ width:width*K,height:height*K,commands }] };
}

for (const [i,items] of scene.slides.entries()) {
  const slide = presentation.slides.add();
  slide.background.fill = '#FAFAF5';
  for (const [j,e] of items.entries()) {
    const name = `${e.group ? 'GROUP_'+e.group+'__' : ''}${e.kind}_${String(j).padStart(3,'0')}`;
    if (e.kind==='text') {
      const shape = slide.shapes.add({
        name: `${name} ${e.value}`,
        geometry:'textbox',
        position:{ left:e.x*K,top:e.y*K,width:(e.w+2)*K,height:e.size*1.3*K },
        fill:'none',line:{style:'solid',fill:'none',width:0},
      });
      shape.text = e.value;
      shape.text.style = { typeface:'Arial',fontSize:e.size*K,bold:e.bold,color:e.fill,
        alignment:'left',verticalAlignment:'top',autoFit:'none',wrap:'none',insets:0 };
      continue;
    }
    const config = {
      name,
      fill:e.hasFill ? e.fill : 'none',
      line:{ style:e.dash.length ? 'dashed' : 'solid', fill:e.hasStroke ? e.stroke : 'none', width:e.hasStroke ? e.strokeWidth*K : 0 },
    };
    if (e.kind==='path') {
      Object.assign(config,{geometry:'custom'},customPath(e));
    } else {
      config.geometry=e.kind==='ellipse' ? 'ellipse' : e.r ? 'roundRect' : 'rect';
      config.position={left:e.x*K,top:e.y*K,width:e.w*K,height:e.h*K};
      if (e.r) config.borderRadius=e.r*K;
    }
    slide.shapes.add(config);
  }
  stats.push({slide:i+1,title:titles[i],nativeShapes:items.length,textBoxes:items.filter(e=>e.kind==='text').length});
  await fs.writeFile(path.join(buildDir,`slide-${i+1}.png`),new Uint8Array(await (await presentation.export({slide,format:'png',scale:1.5})).arrayBuffer()));
}

const ungroupedPath = path.join(buildDir,'ungrouped-candidate.pptx');
await (await PresentationFile.exportPptx(presentation)).save(ungroupedPath);
// Native PowerPoint groups keep each icon/control easy to move as one object.
execFileSync('/Users/shiyaozhang/.local/bin/uv', ['run','--no-project','--python',runtimePython,'python',path.join(buildDir,'group_native_shapes.py')],
  {env:{...process.env,UV_CACHE_DIR:'/private/tmp/agent-symposium-uv'},stdio:'inherit'});

const { finalizePresentation } = await import(pathToFileURL(path.join(skillDir,'container_tools/artifact_tool_utils.mjs')).href);
const result = await finalizePresentation({
  workspaceDir,
  candidatePath:path.join(buildDir,'candidate.pptx'),finalPath,
  explicitTotalSlideCount:3,
  requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],
  pythonExecutable:path.join(buildDir,'python-via-uv'),
  integrityValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(skillDir,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu',`${Math.round(scene.width*12700)},${Math.round(scene.height*12700)}`,'--validate-bullet-geometry','--validate-heading-fit'],
  fontPolicy:{ basis:'reference',families:['Arial'],referencePath:reference,
    referenceSha256:createHash('sha256').update(await fs.readFile(reference)).digest('hex') },
  verifyArtifactToolImport:true,
  receiptPath:path.join(buildDir,'validation.json'),
});
await fs.writeFile(path.join(buildDir,'editable-objects.json'),JSON.stringify(stats,null,2));
const verified = await PresentationFile.importPptx(await FileBlob.load(finalPath));
for (const [i,slide] of verified.slides.items.entries()) {
  const rendered = await verified.export({slide,format:'png',scale:1.5});
  await fs.writeFile(path.join(buildDir,`final-slide-${i+1}.png`),new Uint8Array(await rendered.arrayBuffer()));
}
console.log(JSON.stringify({finalPath,slides:stats,validation:result},null,2));
