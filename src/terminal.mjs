import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import headless from '@xterm/headless';
import sharp from 'sharp';
import { TerminalRaster, sameScreen, snapshotScreen, unicodeProvider } from './internal/terminal-raster.mjs';

const { Terminal } = headless;
const DRIVER = fileURLToPath(new URL('./terminal-record.py', import.meta.url));
const RENDERER = 'screen-kit-raster';
export const ghosttyTheme = {bg:'#282c34',fg:'#ffffff',palette:[
 '#1d1f21','#cc6666','#b5bd68','#f0c674','#81a2be','#b294bb','#8abeb7','#c5c8c6',
 '#666666','#d54e53','#b9ca4a','#e7c547','#7aa6da','#c397d8','#70c0b1','#eaeaea',
].join(':')};

/** Named terminal themes: Ghostty's default, and cmux's bundled Ghostty themes dark Seti and light Pro Light. */
export const terminalThemes = Object.freeze({
 ghostty: ghosttyTheme,
 seti: {bg:'#111213',fg:'#cacecd',palette:'#323232:#c22832:#8ec43d:#e0c64f:#43a5d5:#8b57b5:#8ec43d:#eeeeee:#3f3f3f:#c22832:#8ec43d:#e0c64f:#43a5d5:#8b57b5:#8ec43d:#ffffff'},
 prolight: {bg:'#ffffff',fg:'#191919',palette:'#000000:#e5492b:#50d148:#c6c440:#3b75ff:#ed66e8:#4ed2de:#c2c2c2:#9f9f9f:#ff6640:#48d53e:#bfbe23:#0082ff:#ff7eff:#3bd1d2:#f2f2f2'},
});

/** A recipe's theme: a preset's name or a {bg, fg, palette} object. */
export function terminalTheme(theme=ghosttyTheme) {
 if(typeof theme!=='string')return theme;
 if(!Object.hasOwn(terminalThemes,theme))throw Error(`Unknown terminal theme "${theme}": use ${Object.keys(terminalThemes).join(', ')} or {bg, fg, palette}`);
 return terminalThemes[theme];
}

const NAME=/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const LIMIT=300; // the longest a capture may run, seconds
const ACTIONS=['input','key','wheel','click'];
const STEP_KEYS=new Set(['waitFor','timeout','startCapture','hold',...ACTIONS,'label','narration']);

// --- input ---------------------------------------------------------------------------------------

const CURSOR={Up:'A',Down:'B',Right:'C',Left:'D',Home:'H',End:'F'};
const KEYS={Enter:'\r',Return:'\r',Escape:'\x1b',Esc:'\x1b',Tab:'\t','Shift+Tab':'\x1b[Z',Backspace:'\x7f',Space:' ',
 Delete:'\x1b[3~',Insert:'\x1b[2~',PageUp:'\x1b[5~',PageDown:'\x1b[6~',F1:'\x1bOP',F2:'\x1bOQ',F3:'\x1bOR',F4:'\x1bOS',
 F5:'\x1b[15~',F6:'\x1b[17~',F7:'\x1b[18~',F8:'\x1b[19~',F9:'\x1b[20~',F10:'\x1b[21~',F11:'\x1b[23~',F12:'\x1b[24~'};

/** A named key ('Enter', 'Shift+Tab', 'Up', 'Ctrl+C', 'Alt+x') or one character, as the bytes a terminal sends. */
export function keyInput(key, applicationCursor=false) {
 if(typeof key!=='string'||!key)throw Error('Terminal key must be a nonempty string');
 if([...key].length===1)return key;
 if(Object.hasOwn(CURSOR,key))return (applicationCursor?'\x1bO':'\x1b[')+CURSOR[key];
 if(Object.hasOwn(KEYS,key))return KEYS[key];
 const control=/^Ctrl\+([a-zA-Z@[\\\]^_])$/.exec(key);
 if(control)return String.fromCharCode(control[1].toUpperCase().charCodeAt(0)&0x1f);
 const alt=/^Alt\+(.+)$/.exec(key);
 if(alt)return '\x1b'+keyInput(alt[1],applicationCursor);
 throw Error(`Unknown terminal key "${key}"`);
}

function cell(position, columns, rows, what) {
 const {col,row}=position??{};
 if(!Number.isInteger(col)||col<1||col>columns||!Number.isInteger(row)||row<1||row>rows)
  throw Error(`Terminal ${what} needs 1-based integer col (1–${columns}) and row (1–${rows})`);
 return [col,row];
}

/** A step's action as the bytes it writes (SGR 1006 for the mouse), or undefined for a step without one. */
export function stepInput(step, {columns=1000, rows=1000, applicationCursor=false}={}) {
 if(step.input!==undefined){if(typeof step.input!=='string')throw Error('Terminal input must be a string');return step.input}
 if(step.key!==undefined)return (Array.isArray(step.key)?step.key:[step.key]).map(key=>keyInput(key,applicationCursor)).join('');
 if(step.wheel!==undefined) {
  const [col,row]=cell(step.wheel,columns,rows,'wheel');
  const {down=0,up=0}=step.wheel;
  if(!Number.isInteger(down)||!Number.isInteger(up)||down<0||up<0||down+up===0)throw Error('Terminal wheel needs a positive whole number of down or up notches');
  return `\x1b[<65;${col};${row}M`.repeat(down)+`\x1b[<64;${col};${row}M`.repeat(up);
 }
 if(step.click!==undefined) {
  const [col,row]=cell(step.click,columns,rows,'click');
  const button={left:0,middle:1,right:2}[step.click.button??'left'];
  if(button===undefined)throw Error('Terminal click button must be left, middle or right');
  return `\x1b[<${button};${col};${row}M\x1b[<${button};${col};${row}m`;
 }
}

// --- recipes -------------------------------------------------------------------------------------

/** The names a terminal recipe's renders take in the output directory (before their extension). */
export function terminalOutputNames(recipe, name) {
 return recipeOutputs(recipe,name).map(output=>output.name);
}

/** A recipe's renders: `outputs`, or the single one `format`, `at`, `start` and `fps` describe. */
function recipeOutputs(recipe, name) {
 const single=['format','at','start'].filter(key=>recipe[key]!==undefined);
 if(recipe.outputs!==undefined&&single.length)throw Error(`Terminal recipe gives outputs and ${single.join(', ')}: put them in its outputs`);
 const list=recipe.outputs??[{format:recipe.format??'png',at:recipe.at,start:recipe.start}];
 if(!Array.isArray(list)||!list.length)throw Error('Terminal outputs must be a nonempty array');
 const seen=new Set();
 return list.map(output=>{
  const format=output.format??'png';
  if(!['png','webp','mp4','webm','cast'].includes(format))throw Error('Terminal format must be png, webp, mp4, webm or cast');
  if(format==='cast'&&list.length>1)throw Error('A cast output is the take itself: give it alone');
  if(output.name!==undefined&&output.suffix!==undefined)throw Error('A terminal output takes name or suffix, not both');
  const file=output.name??`${name}${output.suffix??''}`;
  if(!NAME.test(file))throw Error(`Invalid terminal output name: ${file}`);
  if(seen.has(`${file}.${format}`))throw Error(`Two terminal outputs write ${file}.${format}: give them a name or suffix`);
  seen.add(`${file}.${format}`);
  for(const key of ['at','start'])if(output[key]!==undefined&&!(output[key]>=0))throw Error(`Terminal output ${key} must be a nonnegative number of seconds`);
  return {name:file,format,at:output.at,start:output.start,fps:output.fps??recipe.fps};
 });
}

function validate(recipe, name) {
 if(!NAME.test(name))throw Error('Invalid terminal recipe name');
 if(!Array.isArray(recipe.command)||!recipe.command.length||recipe.command.some(s=>typeof s!=='string'))throw Error('Terminal command must be a nonempty string array');
 for(const key of ['columns','rows'])if(!Number.isInteger(recipe[key])||recipe[key]<2||recipe[key]>1000)throw Error(`Invalid terminal ${key}`);
 if(recipe.duration!==undefined)throw Error('Terminal recipes take no duration: the steps decide it, and a last { hold: seconds } leaves a reading pause');
 if(!Array.isArray(recipe.steps??[]))throw Error('Terminal steps must be an array');
 let starts=0;
 for(const [index,step] of (recipe.steps??[]).entries()) {
  const where=`Terminal step ${index+1}`;
  if(!step||typeof step!=='object')throw Error(`${where} must be an object`);
  for(const key of Object.keys(step))if(!STEP_KEYS.has(key))
   throw Error(`${where}: unknown "${key}"${['at','expect','settle'].includes(key)?' (steps run in order: wait with waitFor, pause with hold)':''}`);
  const waitFor=step.waitFor===undefined?[]:Array.isArray(step.waitFor)?step.waitFor:[step.waitFor];
  if(step.waitFor!==undefined&&(!waitFor.length||waitFor.some(text=>typeof text!=='string'||!text)))throw Error(`${where}: waitFor must be a nonempty string or array of them`);
  if(step.timeout!==undefined&&(step.waitFor===undefined||!(step.timeout>0&&step.timeout<=LIMIT)))throw Error(`${where}: timeout belongs to a waitFor and is between 0 and ${LIMIT} seconds`);
  if(step.hold!==undefined&&!(step.hold>=0&&step.hold<=LIMIT))throw Error(`${where}: hold must be between 0 and ${LIMIT} seconds`);
  if(step.startCapture!==undefined&&typeof step.startCapture!=='boolean')throw Error(`${where}: startCapture must be true or false`);
  if(step.startCapture)starts++;
  if(ACTIONS.filter(key=>step[key]!==undefined).length>1)throw Error(`${where}: one of ${ACTIONS.join(', ')} per step`);
  stepInput(step,{columns:recipe.columns,rows:recipe.rows});
 }
 if(starts>1)throw Error('Only one terminal step may startCapture');
 if(recipe.fps!==undefined&&!(Number.isFinite(recipe.fps)&&recipe.fps>0&&recipe.fps<=120))throw Error('Terminal fps must be between 0 and 120');
 return recipeOutputs(recipe,name);
}

const sleep=(ms,signal)=>new Promise((done,fail)=>{
 const timer=setTimeout(done,ms);
 signal?.addEventListener('abort',()=>{clearTimeout(timer);fail(signal.reason)},{once:true});
});

/**
 * Run the application in the PTY driver and its steps in order against a live headless terminal fed the
 * very output events the take records: `waitFor` watches that screen, `hold` waits, actions type.
 */
async function record(config, steps, signal) {
 const child=spawn(config.python??'python3',[DRIVER],{stdio:['pipe','pipe','pipe'],signal});
 let errors='';
 child.stderr.on('data',chunk=>{errors=(errors+chunk).slice(-8192)});
 const exited=new Promise((success,failure)=>{
  child.on('error',failure);
  child.on('exit',code=>code===0?success():failure(Error(`Terminal capture failed (${code}): ${errors.trim()}`)));
 });
 exited.catch(()=>{});
 child.stdin.on('error',()=>{});
 const terminal=createTerminal(config.columns,config.rows);
 const watchers=new Set();
 let latest=0,writing=Promise.resolve();
 createInterface({input:child.stdout}).on('line',line=>{
  const {t,o}=JSON.parse(line);
  writing=writing.then(()=>new Promise(done=>terminal.write(o,done))).then(()=>{latest=t;for(const watch of watchers)watch()});
 });
 const screen=()=>Array.from({length:config.rows},(_,i)=>terminal.buffer.active.getLine(i)?.translateToString(true)??'').join('\n');
 const send=order=>child.stdin.write(JSON.stringify(order)+'\n');
 const failed=exited.then(()=>{throw Error('Terminal capture ended before its steps finished')});
 failed.catch(()=>{});
 const waitFor=(texts,timeout)=>new Promise((success,failure)=>{
  const finish=(result,error)=>{clearTimeout(timer);watchers.delete(watch);if(error)failure(error);else success(result)};
  const watch=()=>{if(texts.every(text=>screen().includes(text)))finish(latest)};
  const timer=setTimeout(()=>finish(null,Error(`Terminal waitFor timed out after ${timeout}s: ${texts.join(', ')}\n--- screen ---\n${screen()}`)),timeout*1000);
  watchers.add(watch);
  failed.catch(error=>finish(null,error));
  watch();
 });
 try {
  child.stdin.write(JSON.stringify({...config,steps:undefined})+'\n');
  for(const step of steps) {
   signal?.throwIfAborted();
   if(step.waitFor!==undefined) {
    const texts=Array.isArray(step.waitFor)?step.waitFor:[step.waitFor];
    await writing;
    const at=await waitFor(texts,step.timeout??15);
    send({check:{at,expect:texts}});
    if(step.startCapture)send({start:at});
   } else if(step.startCapture)send({start:null});
   const input=stepInput(step,{columns:config.columns,rows:config.rows,applicationCursor:terminal.modes.applicationCursorKeysMode});
   if(input!==undefined)send({input,kind:ACTIONS.find(key=>step[key]!==undefined),
    ...(step.label!==undefined?{label:step.label}:{}),...(step.narration!==undefined?{narration:step.narration}:{})});
   if(step.hold)await Promise.race([sleep(step.hold*1000,signal),failed]);
  }
  send({end:true});
  await exited;
 } catch(error) {
  child.kill('SIGTERM');
  await exited.catch(()=>{});
  throw error;
 } finally {terminal.dispose()}
}

/** Replays the take and checks every waitFor's screen again at the moment it was met. */
async function inspectTake(cast, actions, columns, rows) {
 const data=(await readFile(cast,'utf8')).trim().split('\n').map(JSON.parse).slice(1);
 const terminal=createTerminal(columns,rows);
 const checkpoints=[];
 let cursor=0;
 try {
  for (const check of [...actions.checks].sort((a,b)=>a.at-b.at)) {
   while(cursor<data.length&&data[cursor][0]<=check.at) {
    const event=data[cursor++];
    if(event[1]==='o') await new Promise(done=>terminal.write(event[2],done));
   }
   const screen=Array.from({length:rows},(_,i)=>terminal.buffer.active.getLine(i)?.translateToString(true)??'').join('\n');
   const passed=check.expect.every(text=>screen.includes(text));
   checkpoints.push({...check,passed,screen});
   if(!passed) throw Error(`Terminal expectation failed on replay: ${check.expect.join(', ')}`);
  }
 } finally {terminal.dispose()}
 return checkpoints;
}

/**
 * Capture real application input/output in a PTY, once, and render each of the recipe's outputs from
 * that one take. Rendering never calls application internals. An output's `at` and `start` count from
 * the step that set `startCapture`, else from the take's beginning.
 */
export async function captureTerminalRecipe({name,recipe,cwd=process.cwd(),out,signal}) {
 const normalized={columns:100,rows:32,...recipe,theme:terminalTheme(recipe.theme)};
 const outputs=validate(normalized,name);
 const takes=resolve(out,'takes');
 await mkdir(takes,{recursive:true});
 const cast=join(takes,`${name}.cast`),actionsFile=join(takes,`${name}.actions.json`);
 await record({command:normalized.command,env:normalized.env,python:normalized.python,columns:normalized.columns,rows:normalized.rows,
  theme:normalized.theme,maxBytes:normalized.maxBytes,duration:LIMIT,cwd:resolve(cwd),cast,actions:actionsFile},normalized.steps??[],signal);
 const actions=JSON.parse(await readFile(actionsFile,'utf8'));
 const checkpoints=await inspectTake(cast,actions,normalized.columns,normalized.rows);
 await writeFile(join(takes,`${name}.checkpoints.json`),JSON.stringify(checkpoints,null,2)+'\n');
 const origin=actions.start??0;
 const capture={events:actions.actions,checkpoints,takeDuration:actions.duration,...(actions.start!==undefined?{captureStart:actions.start}:{})};
 if(outputs[0].format==='cast')
  return {file:cast,take:cast,width:normalized.columns,height:normalized.rows,frames:0,duration:actions.duration,...capture};
 const rendered=[];
 for(const output of outputs) {
  const at=output.at===undefined?undefined:Math.min(actions.duration,origin+output.at);
  const start=output.start!==undefined?origin+output.start:actions.start;
  rendered.push(await renderTerminalTake({cast,name:output.name,cwd,out,signal,recipe:{...normalized,format:output.format,fps:output.fps,
   at,start,duration:actions.duration}}));
 }
 return {...rendered[0],...(rendered.length>1?{outputs:rendered}:{}),...capture};
}

/** A headless terminal that measures cells as a modern terminal does and tracks cursor visibility. */
function createTerminal(columns, rows) {
 const terminal=new Terminal({cols:columns,rows,allowProposedApi:true,scrollback:0});
 terminal.unicode.register(unicodeProvider);
 terminal.unicode.activeVersion=unicodeProvider.version;
 terminal.cursorVisible=true;
 for(const [final,visible] of [['h',true],['l',false]])
  terminal.parser.registerCsiHandler({prefix:'?',final},params=>{if(params.includes(25))terminal.cursorVisible=visible;return false});
 return terminal;
}

/** A take's output events replayed in order; `advance` writes every event before a time. */
class Replay {
 constructor(events,columns,rows){this.events=events.filter(event=>event[1]==='o');this.cursor=0;this.terminal=createTerminal(columns,rows)}
 async advance(time,inclusive=false) {
  let data='';
  while(this.cursor<this.events.length&&(inclusive?this.events[this.cursor][0]<=time:this.events[this.cursor][0]<time))data+=this.events[this.cursor++][2];
  if(data)await new Promise(done=>this.terminal.write(data,done));
 }
 screen(theme){return snapshotScreen(this.terminal,theme,{cursor:this.terminal.cursorVisible})}
 /** Writes events one at a time until the screen shows anything; the time of that event, or null. */
 async firstDrawn(theme) {
  while(this.cursor<this.events.length) {
   const [time,,data]=this.events[this.cursor++];
   await new Promise(done=>this.terminal.write(data,done));
   const screen=snapshotScreen(this.terminal,theme);
   if(screen.text.some(text=>text&&text!==' ')||screen.bg.some(colour=>colour!==theme.background))return time;
  }
  return null;
 }
 dispose(){this.terminal.dispose()}
}

/**
 * Re-render an existing take; this never launches its application or changes the source. Frames are
 * drawn straight from the replayed terminal's cells in 24-bit colour (no GIF, no palette).
 */
export async function renderTerminalTake({cast,name,recipe={},cwd=process.cwd(),out,signal}) {
 cast=resolve(cwd,cast);
 const format=recipe.format??'png';
 if(!['png','webp','mp4','webm'].includes(format))throw Error('Terminal render format must be png, webp, mp4 or webm');
 if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name??'')) throw Error('Invalid terminal recipe name');
 const fps=recipe.fps??4;
 if(!(Number.isFinite(fps)&&fps>0&&fps<=120))throw Error('Terminal fps must be between 0 and 120');
 const records=(await readFile(cast,'utf8')).trim().split('\n').map(JSON.parse);
 const [header,...events]=records;
 const columns=recipe.columns??header.width,rows=recipe.rows??header.height;
 for (const [key,value] of [['columns',columns],['rows',rows]]) if (!Number.isInteger(value)||value<2||value>1000) throw Error(`Invalid terminal ${key}`);
 const duration=recipe.duration??Math.max(1,...events.map(event=>event[0]));
 if(recipe.at!==undefined&&!(recipe.at>=0&&recipe.at<=duration))throw Error('Terminal snapshot time must be within the take');
 const theme=recipe.theme!==undefined?terminalTheme(recipe.theme):header.theme??ghosttyTheme;
 const raster=await TerminalRaster.create({columns,rows,theme,cwd,fontSize:recipe.fontSize??20,lineHeight:recipe.lineHeight??1.2,
  fontFamily:recipe.fontFamily,fontDir:recipe.fontDir});
 const {width,height}=raster;
 await mkdir(resolve(out),{recursive:true});
 const file=resolve(out,`${name}.${format}`);
 const font={family:raster.fonts.chain[0].family,size:raster.fontSize,lineHeight:raster.lineHeight,
  ...(raster.fonts.missing.length?{missing:raster.fonts.missing}:{})};
 const replay=new Replay(events,columns,rows);
 try {
  // A still: the screen at `at`, else at the end of the take
  if(format==='png'||(format==='webp'&&recipe.at!==undefined)) {
   await replay.advance(recipe.at??duration,true);
   const pixels=await raster.render(replay.screen(raster.theme));
   const image=sharp(pixels,{raw:{width,height,channels:3}});
   await (format==='png'?image.png({compressionLevel:9}):image.webp({lossless:true,effort:4})).toFile(file);
   return {file,take:cast,width,height,frames:1,duration:0,fps,renderer:RENDERER,font};
  }
  // An animation starts at `start`, else when the application first draws: a take's opening blank screen
  // (the moments before the program has written anything) is no part of the picture
  let start=recipe.start;
  if(start===undefined)start=await replay.firstDrawn(raster.theme)??0;
  else if(!(start>=0&&start<duration))throw Error('Terminal animation start must be within the take');
  // Frame k shows the screen at its presentation time, start + k / fps, every event up to then included, so
  // the first frame is the screen at `start` itself; the last one also takes the events after its time, so the
  // animation ends on the take's last screen. A frame is new only when its pixels differ (a changed attribute
  // on a blank cell draws nothing), which also keeps the WebP encoder from merging frames behind our back.
  const count=Math.max(1,Math.round((duration-start)*fps));
  async function* frames() {
   let previous,pixels;
   for(let k=0;k<count;k++) {
    signal?.throwIfAborted();
    await replay.advance(k>0&&k===count-1?duration:start+k/fps+1e-6,true);
    const screen=replay.screen(raster.theme);
    let changed=!sameScreen(screen,previous);
    if(changed) {
     const drawn=await raster.render(screen);
     changed=!pixels||!drawn.equals(pixels); // render returns a Buffer
     pixels=drawn;
    }
    previous=screen;
    yield {pixels,changed,k};
   }
  }
  if(['mp4','webm'].includes(format)) {
   const {encodeRawVideo}=await import('./video.mjs');
   const pixels=(async function*(){for await (const frame of frames()) yield frame.pixels})();
   const encoded=await encodeRawVideo({frames:pixels,width,height,output:file,fps,signal});
   return {...encoded,take:cast,videoInput:cast,renderer:RENDERER,font};
  }
  // Lossless animated WebP: a repeated screen extends the previous frame's delay instead of adding a frame
  const stills=[],delays=[];
  const end=k=>Math.round((k+1)*1000/fps)-Math.round(k*1000/fps);
  for await (const {pixels,changed,k} of frames()) {
   if(changed||!stills.length){stills.push(await sharp(pixels,{raw:{width,height,channels:3}}).png({compressionLevel:1}).toBuffer());delays.push(end(k))}
   else delays[delays.length-1]+=end(k);
  }
  const animation=stills.length>1?sharp(stills,{join:{animated:true}}):sharp(stills[0]);
  await animation.webp({lossless:true,effort:4,loop:0,...(stills.length>1?{delay:delays}:{})}).toFile(file);
  // What the encoder wrote, not what it was given: the manifest records the file review will read
  const written=await sharp(file,{animated:true}).metadata();
  const writtenDelays=written.delay??delays;
  return {file,take:cast,width,height,frames:written.pages??1,duration:writtenDelays.reduce((a,b)=>a+b,0)/1000,fps,renderer:RENDERER,font};
 } finally {replay.dispose()}
}
