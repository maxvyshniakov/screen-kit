import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureTerminalRecipe } from '../src/terminal.mjs';

const application = String.raw`import os,sys,tty
from pathlib import Path
tty.setraw(sys.stdin.fileno())
Path('child.pid').write_text(str(os.getpid()))
sys.stdout.write('\x1b[2J\x1b[Hselected: alpha');sys.stdout.flush()
while True:
 key=sys.stdin.read(1)
 if key=='j':
  sys.stdout.write('\x1b[Hselected: beta ');sys.stdout.flush()
`;

test('records real PTY input, checks rendered selection and cleans up the child', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'screen-kit-terminal-'));
 try {
  const result=await captureTerminalRecipe({name:'navigation',cwd,out:join(cwd,'out'),recipe:{
   source:'terminal',command:['python3','-c',application],columns:30,rows:6,duration:.8,
   format:'cast',steps:[{at:.2,input:'j',expect:'selected: beta'}],
  }});
  assert.ok(result.take.endsWith('.cast'));
  const lines=(await readFile(result.take,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(lines.some(row=>row[1]==='o'&&row[2].includes('selected: beta')));
  assert.equal(result.checkpoints[0].passed,true);
  const pid=Number(await readFile(join(cwd,'child.pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 } finally {await rm(cwd,{recursive:true,force:true})}
});

test('fails a missing screen expectation rather than returning a successful take', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'screen-kit-terminal-'));
 try {
  await assert.rejects(captureTerminalRecipe({name:'missing',cwd,out:join(cwd,'out'),recipe:{
   source:'terminal',command:['python3','-c',application],columns:30,rows:6,duration:.8,
   format:'cast',steps:[{at:.2,input:'j',expect:'selected: nonexistent'}],
  }}),/expectation.*selected: nonexistent/i);
  const pid=Number(await readFile(join(cwd,'child.pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 } finally {await rm(cwd,{recursive:true,force:true})}
});

test('checks screen assertions at their timestamp even when settle times reorder them', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'screen-kit-terminal-'));
 const app=application.replace("if key=='j':", "if key in ('j','k'):").replace("sys.stdout.write('\\x1b[Hselected: beta ')", "sys.stdout.write('\\x1b[Hselected: '+('beta ' if key=='j' else 'alpha'))");
 try {
  await assert.rejects(captureTerminalRecipe({name:'timeline',cwd,out:join(cwd,'out'),recipe:{
   command:['python3','-c',app],columns:30,rows:6,duration:.9,format:'cast',steps:[
    {at:.1,input:'j',expect:'selected: beta',settle:.5},
    {at:.2,input:'k',expect:'selected: beta',settle:.1},
    {at:.4,input:'j'},
   ],
  }}),/expectation.*selected: beta/i);
 } finally {await rm(cwd,{recursive:true,force:true})}
});

test('cleans a TERM-ignoring grandchild after its direct parent exits', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'screen-kit-terminal-'));
 let pid;
 const child="import signal,time,os;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path('grandchild.pid').write_text(str(os.getpid()));time.sleep(60)";
 const app=`import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',${JSON.stringify(child)}])\nprint('ready',flush=True)\ntime.sleep(60)`;
 try {
  await captureTerminalRecipe({name:'descendants',cwd,out:join(cwd,'out'),recipe:{
   command:['python3','-c',app],columns:30,rows:6,duration:.5,format:'cast',
  }});
  pid=Number(await readFile(join(cwd,'grandchild.pid'),'utf8'));
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 } finally {
  if(!pid)try{pid=Number(await readFile(join(cwd,'grandchild.pid'),'utf8'))}catch{}
  if(pid)try{process.kill(pid,'SIGKILL')}catch{}
  await rm(cwd,{recursive:true,force:true});
 }
});
