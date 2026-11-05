import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {renderTerminalTake} from '../src/terminal.mjs';

test('terminal compact squares retain visible cell divisions in export',async()=>{
 const out=await mkdtemp(join(tmpdir(),'screen-kit-square-'));
 try{
  const cast=join(out,'bars.cast');
  await writeFile(cast,[{version:2,width:8,height:3},[0,'o','\x1b[38;2;95;175;255m■■■■'],[1,'m','end']].map(JSON.stringify).join('\n')+'\n');
  const result=await renderTerminalTake({cast,out,name:'bars',recipe:{format:'png',fontFamily:'Screen Kit Mono,JetBrains Mono,Noto Sans Symbols 2'}});
  const {data,info}=await sharp(result.file).removeAlpha().raw().toBuffer({resolveWithObject:true});
  let maximum=0;
  for(let y=0;y<info.height;y++){let runs=0,previous=false;for(let x=0;x<info.width;x++){
   const i=(y*info.width+x)*3,blue=data[i]<130&&data[i+1]>120&&data[i+2]>220;
   if(blue&&!previous)runs++;previous=blue;
  }maximum=Math.max(maximum,runs)}
  assert.equal(maximum,4,'four input cells must remain four visibly separated squares');
 }finally{await rm(out,{recursive:true,force:true})}
});
