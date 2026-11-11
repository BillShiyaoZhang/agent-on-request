import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {PresentationFile,FileBlob} from '@oai/artifact-tool';

const dir=path.dirname(fileURLToPath(import.meta.url));
const workspaceDir=path.resolve(dir,'../../../..');
const skill='/Users/shiyaozhang/.codex/plugins/cache/openai-primary-runtime/presentations/26.1110.11258/skills/presentations';
const runtimePython='/Users/shiyaozhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3';
const source=path.join(dir,'source.pptx');
const finalPath=path.join(workspaceDir,'output/pptx/agent-on-request-layout-optimized.pptx');
process.env.RUNTIME_NODE_MODULES='/Users/shiyaozhang/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules';
const p=await PresentationFile.importPptx(await FileBlob.load(source));
const original=JSON.parse((await fs.readFile(path.join(dir,'source-inspection.ndjson'),'utf8')).split('\n')[0]);
const elements=original.elements;
const K=4/3;
const find=(name,filter=()=>true)=>elements.filter(e=>e.name===name&&filter(e));
const group=(prefix,filter=()=>true)=>elements.filter(e=>e.name?.startsWith(prefix)&&filter(e));
const resolve=e=>p.resolve(e.id);
function box(e,x,y,w,h){resolve(e).position={left:x*K,top:y*K,width:w*K,height:h*K};}
function move(items,x,y,w=null,h=null){
  if(!items.length) throw new Error('No matching objects');
  const left=Math.min(...items.map(e=>e.position.left)),top=Math.min(...items.map(e=>e.position.top));
  const width=Math.max(...items.map(e=>e.position.left+e.position.width))-left;
  const height=Math.max(...items.map(e=>e.position.top+e.position.height))-top;
  const sx=w===null?1:w*K/width,sy=h===null?1:h*K/height;
  for(const e of items){const z=e.position;resolve(e).position={left:x*K+(z.left-left)*sx,top:y*K+(z.top-top)*sy,width:z.width*sx,height:z.height*sy};}
}
function center(items,x,y){
  const left=Math.min(...items.map(e=>e.position.left)),top=Math.min(...items.map(e=>e.position.top));
  const width=Math.max(...items.map(e=>e.position.left+e.position.width))-left;
  const height=Math.max(...items.map(e=>e.position.top+e.position.height))-top;
  move(items,x-width/(2*K),y-height/(2*K));
}
function label(e,x,y,w,h,size,alignment='center'){
  box(e,x,y,w,h);
  resolve(e).text.style={fontSize:size*K,alignment,verticalAlignment:'top',insets:0,autoFit:'none',wrap:'none'};
}

// Preserve the revised title wording, while giving it a deliberate two-line frame.
const title=elements.find(e=>e.text==='Ontology-based Cross-Domain LLM-Agents Collaboration');
if(!title) throw new Error('The saved title changed. Reinspect the current source.');
resolve(title).text='Ontology-based Cross-Domain\nLLM-Agents Collaboration';
label(title,32,28,778,76,26,'left');

// Preserve every user-edited label; align the local stores and skills symmetrically.
for(const [prefix,x] of [['GROUP_003_graph__',88],['GROUP_004_evidence__',164],['GROUP_005_skill__',240],
                         ['GROUP_009_graph__',602],['GROUP_010_evidence__',678],['GROUP_011_skill__',754]]){
  const members=group(prefix,e=>prefix.includes('003')?e.position.left<400:prefix.includes('009')?e.position.left>700:true);
  center(members,x,350);
}
for(const [name,x] of [['text_027 Concepts',88],['text_037 Evidence',164],['text_044 Skills',240],
                      ['text_073 Concepts',602],['text_083 Evidence',678],['text_090 Skills',754]]){
  const e=find(name)[0];label(e,x-40,382,80,19,11);
}
// Each lock stays inside its owner's container, with an aligned Rules label.
center(group('GROUP_006_lock__'),264,291);
center(group('GROUP_012_lock__'),578,291);
label(find('text_049 Rules')[0],232,319,64,18,10);
label(find('text_095 Rules')[0],546,319,64,18,10);

for(const prefix of ['GROUP_002_bot__','GROUP_008_bot__']){
  const members=group(prefix);
  for(const e of members){const z=e.position;resolve(e).position={...z,top:z.top-15*K};}
}

// Two centered communication rows, using the actual user's duplicated objects.
move(group('GROUP_013_bidir__',e=>e.position.top<400),304,232,234,8);
move(group('GROUP_013_bidir__',e=>e.position.top>400),304,346,234,8);
box(find('rect_100',e=>e.position.top<400)[0],344,210,154,54);
box(find('rect_100',e=>e.position.top>400)[0],344,324,154,54);
move(find('rect_101').concat(find('path_103')),357,218);
move(find('rect_102').concat(find('path_104')),445,218);
label(elements.find(e=>e.text==='Verbal collaboration'),301,263,240,22,12.5);
center(group('GROUP_003_graph__',e=>e.position.left>400),378,350);
center(group('GROUP_009_graph__',e=>e.position.left<700),465,350);
label(elements.find(e=>e.text==='Concepts (ontology) alignment'),301,382,240,22,12.5);

// The contact detail is unchanged; its frame now fits the complete address.
const email=elements.find(e=>e.text?.startsWith('shiyao.zhang14@student.xjtlu.edu.cn'));
box(email,32,574,430,18);
resolve(email).text.style={insets:0,wrap:'none',autoFit:'none'};

const s=p.slides.getItem(0);
await fs.writeFile(path.join(dir,'after-native.png'),new Uint8Array(await(await p.export({slide:s,format:'png',scale:1.25})).arrayBuffer()));
await(await PresentationFile.exportPptx(p)).save(path.join(dir,'edited-export.pptx'));
// Copy only the edited first slide into the original package, keeping all other
// slide XML, notes, relationships, masters and user metadata exactly as saved.
execFileSync('/Users/shiyaozhang/.local/bin/uv',['run','--no-project','--python',runtimePython,'python',path.join(dir,'preserve_package.py')],
  {env:{...process.env,UV_CACHE_DIR:'/private/tmp/agent-symposium-uv'},stdio:'inherit'});
const {finalizePresentation}=await import(pathToFileURL(path.join(skill,'container_tools/artifact_tool_utils.mjs')).href);
const result=await finalizePresentation({
  workspaceDir,candidatePath:path.join(dir,'candidate.pptx'),finalPath,explicitTotalSlideCount:3,
  requiredNativeTableOwnerSlides:[],requiredNativeChartOwnerSlides:[],
  pythonExecutable:path.join(dir,'../python-via-uv'),
  integrityValidatorPath:path.join(skill,'container_tools/inspect_presentation_package_integrity.py'),
  layoutValidatorPath:path.join(skill,'container_tools/inspect_presentation_layout_geometry.py'),
  layoutArgs:['--expected-slide-size-emu','10691813,7559675','--validate-bullet-geometry','--validate-heading-fit'],
  fontPolicy:{basis:'reference',families:['Arial'],referencePath:source,referenceSha256:createHash('sha256').update(await fs.readFile(source)).digest('hex')},
  verifyArtifactToolImport:true,receiptPath:path.join(dir,'validation.json'),
});
const final=await PresentationFile.importPptx(await FileBlob.load(finalPath));
for(let i=0;i<3;i++){
  const png=await final.export({slide:final.slides.getItem(i),format:'png',scale:1.25});
  await fs.writeFile(path.join(dir,`final-${i+1}.png`),new Uint8Array(await png.arrayBuffer()));
}
console.log(JSON.stringify({finalPath,validation:result.presentationLayout},null,2));
