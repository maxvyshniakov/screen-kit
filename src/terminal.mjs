import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import headless from '@xterm/headless';
import sharp from 'sharp';

const exec = promisify(execFile);
const { Terminal } = headless;
const DRIVER = fileURLToPath(new URL('./terminal-record.py', import.meta.url));
const FONTS = fileURLToPath(new URL('../fonts/', import.meta.url));
export const ghosttyTheme = {bg:'#282c34',fg:'#ffffff',palette:[
 '#1d1f21','#cc6666','#b5bd68','#f0c674','#81a2be','#b294bb','#8abeb7','#c5c8c6',
 '#666666','#d54e53','#b9ca4a','#e7c547','#7aa6da','#c397d8','#70c0b1','#eaeaea',
].join(':')};

function validate(recipe, name) {
 if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw Error('Invalid terminal recipe name');
 if (!Array.isArray(recipe.command) || !recipe.command.length || recipe.command.some(s=>typeof s!=='string')) throw Error('Terminal command must be a nonempty string array');
 for (const key of ['columns','rows']) if (!Number.isInteger(recipe[key]) || recipe[key]<2 || recipe[key]>1000) throw Error(`Invalid terminal ${key}`);
 if (!(recipe.duration>0&&recipe.duration<=300)) throw Error('Terminal duration must be between 0 and 300 seconds');
 const steps=recipe.steps??[];
 let previous=-1;
 for (const step of steps) {
  if (!(step.at>=0&&step.at<recipe.duration&&step.at>=previous)) throw Error('Terminal steps must be ordered within duration');
  if(step.expect&&step.at+(step.settle??.3)>=recipe.duration) throw Error('Terminal expectation must settle before capture ends');
  previous=step.at;
 }
 if (!['png','webp','cast'].includes(recipe.format??'png')) throw Error('Terminal format must be png, webp or cast');
}

async function record(config, signal) {
 await new Promise((success,failure)=>{
  const child=spawn(config.python??'python3',[DRIVER],{stdio:['pipe','ignore','pipe'],signal});
  let errors='';
  child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-8192)});
  const timeout=setTimeout(()=>child.kill('SIGTERM'),(config.duration+10)*1000);
  child.on('error',error=>{clearTimeout(timeout);failure(error)});
  child.on('exit',code=>{clearTimeout(timeout);code===0?success():failure(Error(`Terminal capture failed (${code}): ${errors}`))});
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify(config));
 });
}

async function inspectTake(cast, actions, columns, rows) {
 const data=(await readFile(cast,'utf8')).trim().split('\n').map(JSON.parse).slice(1);
 const terminal=new Terminal({cols:columns,rows,allowProposedApi:true,scrollback:0});
 const checkpoints=[];
 let cursor=0;
 try {
  for (const check of [...actions.checks].sort((a,b)=>a.at-b.at)) {
   while(cursor<data.length&&data[cursor][0]<=check.at) {
    const event=data[cursor++];
    if(event[1]==='o') await new Promise(done=>terminal.write(event[2],done));
   }
   const screen=Array.from({length:rows},(_,i)=>terminal.buffer.active.getLine(i)?.translateToString(true)??'').join('\n');
   const expected=Array.isArray(check.expect)?check.expect:[check.expect];
   const passed=expected.every(text=>screen.includes(text));
   checkpoints.push({...check,passed,screen});
   if(!passed) throw Error(`Terminal expectation failed: ${expected.join(', ')}`);
  }
 } finally {terminal.dispose()}
 return checkpoints;
}

/** Capture real application input/output in a PTY; rendering never calls application internals. */
export async function captureTerminalRecipe({name,recipe,cwd=process.cwd(),out,signal}) {
 const normalized={columns:100,rows:32,duration:1,fps:1,theme:ghosttyTheme,...recipe};
 validate(normalized,name);
 const takes=resolve(out,'takes');
 await mkdir(takes,{recursive:true});
 const cast=join(takes,`${name}.cast`),actionsFile=join(takes,`${name}.actions.json`);
 await record({...normalized,cwd:resolve(cwd),cast,actions:actionsFile},signal);
 const actions=JSON.parse(await readFile(actionsFile,'utf8'));
 const checkpoints=await inspectTake(cast,actions,normalized.columns,normalized.rows);
 await writeFile(join(takes,`${name}.checkpoints.json`),JSON.stringify(checkpoints,null,2)+'\n');
 const format=normalized.format??'png';
 if(format==='cast') return {file:cast,take:cast,width:normalized.columns,height:normalized.rows,frames:0,duration:normalized.duration,events:actions.actions,checkpoints};
 const rendered=await renderTerminalTake({cast,name,recipe:normalized,cwd,out,signal});
 return {...rendered,events:actions.actions,checkpoints};
}

/** Re-render an existing take; this never launches its application or changes the source. */
export async function renderTerminalTake({cast,name,recipe={},cwd=process.cwd(),out,signal}) {
 cast=resolve(cwd,cast);
 const format=recipe.format??'png';
 if(!['png','webp','mp4','webm'].includes(format))throw Error('Terminal render format must be png, webp, mp4 or webm');
 if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name??'')) throw Error('Invalid terminal recipe name');
 const fps=recipe.fps??1;
 if(!(Number.isFinite(fps)&&fps>0&&fps<=120))throw Error('Terminal fps must be between 0 and 120');
 const records=(await readFile(cast,'utf8')).trim().split('\n').map(JSON.parse);
 const header=records[0];
 const duration=recipe.duration??Math.max(1,...records.slice(1).map(event=>event[0]));
 const takes=resolve(out,'takes');
 await mkdir(takes,{recursive:true});
 let input=cast;
 // Render compact squares through their font outline; swash deliberately synthesizes
 // terminal block elements, which must fill fractional-width cells without seams.
 const compact=records.slice(1).some(event=>event[1]==='o'&&event[2].includes('■'));
 if(recipe.theme||compact) {
  const copy=recipe.theme?{...header,theme:recipe.theme}:header;
  input=join(takes,`${name}.render.cast`);
  if(input===cast)throw Error('Rendered take copy would overwrite its source');
  const output=records.slice(1).map(event=>compact&&event[1]==='o'?[event[0],event[1],event[2].replaceAll('■','\ue000')]:event);
  await writeFile(input,[copy,...output].map(record=>JSON.stringify(record)).join('\n')+'\n');
 }
 const gif=join(takes,`${name}.gif`);
 const fontSize=String(recipe.fontSize??20);
 const family=recipe.fontFamily??'Screen Kit Mono,JetBrains Mono,Noto Sans Symbols 2';
 const fonts=family.includes('Screen Kit Mono')?family:family+',Screen Kit Mono';
 const options=['--quiet','--renderer','swash','--font-size',fontSize,
  '--font-family',fonts,'--line-height',String(recipe.lineHeight??1.2),
  '--fps-cap',String(fps),'--last-frame-duration','0','--idle-time-limit',String(duration)];
 options.push('--font-dir',FONTS);
 if(recipe.fontDir)options.push('--font-dir',resolve(cwd,recipe.fontDir));
 if(recipe.at!==undefined) {
  if(!(recipe.at>=0&&recipe.at<=duration))throw Error('Terminal snapshot time must be within the take');
  options.push('--select',String(recipe.at));
 }
 await exec('agg',[...options,input,gif],{signal,timeout:120000,maxBuffer:8192});
 const file=resolve(out,`${name}.${format}`);
 if(['mp4','webm'].includes(format)) {
  const {renderVideo}=await import('./video.mjs');
  return {...await renderVideo({input:gif,output:file,fps}),take:cast,videoInput:gif};
 }
 if(format==='webp') await exec('gif2webp',['-quiet','-m','6',gif,'-o',file],{signal,timeout:120000,maxBuffer:8192});
 else await sharp(gif).png().toFile(file);
 const metadata=await sharp(file,{animated:format==='webp'}).metadata();
 return {file,take:cast,videoInput:gif,width:metadata.width,height:metadata.pageHeight??metadata.height,
  frames:metadata.pages??1,duration:format==='png'?0:(metadata.delay??[]).reduce((a,b)=>a+b,0)/1000,
  fps};
}
