import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {PresentationFile,FileBlob} from '@oai/artifact-tool';
const dir=path.dirname(fileURLToPath(import.meta.url));
const source=path.resolve(dir,'../../../pptx/agent-on-request-editable.pptx');
const bytes=await fs.readFile(source);
await fs.writeFile(path.join(dir,'source.pptx'),bytes);
await fs.writeFile(path.join(dir,'source.sha256'),createHash('sha256').update(bytes).digest('hex'));
const p=await PresentationFile.importPptx(await FileBlob.load(path.join(dir,'source.pptx')));
const inspection=await p.inspect({select:'$.slides[*]',include:['id','index','layout','elements.id','elements.name','elements.kind','elements.text','elements.position','elements.style']});
await fs.writeFile(path.join(dir,'source-inspection.ndjson'),inspection.ndjson);
for(let i=0;i<3;i++){
  const image=await p.export({slide:p.slides.getItem(i),format:'png',scale:1.25});
  await fs.writeFile(path.join(dir,`before-${i+1}.png`),new Uint8Array(await image.arrayBuffer()));
}
console.log(JSON.stringify({sha256:createHash('sha256').update(bytes).digest('hex'),slides:p.slides.items.length,dir}));
