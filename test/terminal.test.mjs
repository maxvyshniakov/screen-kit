import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { captureTerminalRecipe, keyInput, renderTerminalTake, stepInput, terminalTheme, terminalThemes } from '../src/terminal.mjs';
import { captureRun } from '../src/run.mjs';
import { reviewRun } from '../src/review.mjs';

const application = String.raw`import os,sys,tty
from pathlib import Path
tty.setraw(sys.stdin.fileno())
Path('child.pid').write_text(str(os.getpid()))
sys.stdout.write('\x1b[2J\x1b[Hselected: alpha');sys.stdout.flush()
while True:
 key=sys.stdin.read(1)
 if key=='j':
  sys.stdout.write('\x1b[Hselected: beta ');sys.stdout.flush()
 if key=='k':
  sys.stdout.write('\x1b[Hselected: alpha');sys.stdout.flush()
`;

// Starts slowly, then echoes every byte it receives as hex: what each declarative action really typed
const echo = String.raw`import os,sys,time,tty
from pathlib import Path
tty.setraw(sys.stdin.fileno())
with open('launches','a') as f: f.write('x')
time.sleep(0.6)
sys.stdout.write('\x1b[?25l\x1b[2J\x1b[H\x1b[38;2;255;0;0mready\x1b[0m');sys.stdout.flush()
seen=b''
while True:
 seen+=os.read(0,64)
 sys.stdout.write('\x1b[2;1H\x1b[2Kgot:'+seen.hex());sys.stdout.flush()
`;

async function inTemporary(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'screen-kit-terminal-'));
  try { return await run(cwd); } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('records real PTY input in order, checks each waitFor and cleans up the child', () => inTemporary(async cwd => {
  const result = await captureTerminalRecipe({ name: 'navigation', cwd, out: join(cwd, 'out'), recipe: {
    command: ['python3', '-c', application], columns: 30, rows: 6, format: 'cast',
    steps: [{ waitFor: 'selected: alpha' }, { key: 'j', label: 'down' }, { waitFor: 'selected: beta' }, { hold: 0.2 }],
  } });
  assert.ok(result.take.endsWith('.cast'));
  const lines = (await readFile(result.take, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(lines.some(row => row[1] === 'o' && row[2].includes('selected: beta')));
  assert.deepEqual(result.checkpoints.map(check => [check.expect, check.passed]), [[['selected: alpha'], true], [['selected: beta'], true]]);
  assert.deepEqual(result.events.map(event => [event.input, event.kind, event.label]), [['j', 'key', 'down']]);
  assert.ok(result.duration >= 0.2, 'the take lasts until the last hold ends');
  assert.equal(lines.at(-1)[1], 'm');
  const pid = Number(await readFile(join(cwd, 'child.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}));

test('a waitFor that never appears fails after its timeout, with the screen, and cleans up', () => inTemporary(async cwd => {
  const started = Date.now();
  await assert.rejects(captureTerminalRecipe({ name: 'missing', cwd, out: join(cwd, 'out'), recipe: {
    command: ['python3', '-c', application], columns: 30, rows: 6, format: 'cast',
    steps: [{ key: 'j' }, { waitFor: 'selected: nonexistent', timeout: 0.8 }],
  } }), /waitFor timed out after 0\.8s: selected: nonexistent[\s\S]*selected: /);
  assert.ok(Date.now() - started < 6000);
  const pid = Number(await readFile(join(cwd, 'child.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}));

test('replay re-checks each waitFor at the moment it was met, not at the end of the take', () => inTemporary(async cwd => {
  const result = await captureTerminalRecipe({ name: 'moment', cwd, out: join(cwd, 'out'), recipe: {
    command: ['python3', '-c', application], columns: 30, rows: 6, format: 'cast',
    steps: [{ waitFor: 'selected: alpha' }, { key: 'j' }, { waitFor: 'selected: beta' }, { key: 'k' }, { waitFor: 'selected: alpha' }, { hold: 0.1 }],
  } });
  assert.deepEqual(result.checkpoints.map(check => check.expect[0]), ['selected: alpha', 'selected: beta', 'selected: alpha']);
  assert.ok(result.checkpoints.every(check => check.passed));
  assert.match(result.checkpoints[1].screen, /selected: beta/, 'the beta screen was seen at its own moment');
}));

test('cleans a TERM-ignoring grandchild after its direct parent exits', () => inTemporary(async cwd => {
  let pid;
  const child = "import signal,time,os;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);Path('grandchild.pid').write_text(str(os.getpid()));time.sleep(60)";
  const app = `import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',${JSON.stringify(child)}])\nprint('ready',flush=True)\ntime.sleep(60)`;
  try {
    await captureTerminalRecipe({ name: 'descendants', cwd, out: join(cwd, 'out'), recipe: {
      command: ['python3', '-c', app], columns: 30, rows: 6, format: 'cast', steps: [{ waitFor: 'ready' }, { hold: 0.3 }],
    } });
    pid = Number(await readFile(join(cwd, 'grandchild.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    if (!pid) try { pid = Number(await readFile(join(cwd, 'grandchild.pid'), 'utf8')); } catch {}
    if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}));

test('startCapture starts the animation the moment its waitFor is met; declarative keys, wheel and click type SGR bytes', () => inTemporary(async cwd => {
  const result = await captureTerminalRecipe({ name: 'scenario', cwd, out: join(cwd, 'out'), recipe: {
    command: ['python3', '-c', echo], columns: 40, rows: 4, theme: 'seti', format: 'webp', fps: 4,
    steps: [
      { waitFor: 'ready', startCapture: true, timeout: 10 },
      { key: 'Down' }, { key: 'Shift+Tab' }, { key: ['Ctrl+C', 'Enter'] },
      { wheel: { col: 3, row: 2, down: 2 } }, { wheel: { col: 3, row: 2, up: 1 } },
      { click: { col: 4, row: 1, button: 'right' } },
      { hold: 0.5 },
    ],
  } });
  const cast = (await readFile(result.take, 'utf8')).trim().split('\n').map(JSON.parse);
  const ready = cast.find(row => row[1] === 'o' && row[2].includes('ready'));
  assert.equal(result.captureStart, ready[0], 'the capture starts at the very output event that showed "ready"');
  assert.ok(result.captureStart >= 0.5, 'the app took its time to start; nothing guessed it');
  const typed = '\x1b[B' + '\x1b[Z' + '\x03\r' + '\x1b[<65;3;2M'.repeat(2) + '\x1b[<64;3;2M' + '\x1b[<2;4;1M\x1b[<2;4;1m';
  assert.equal(result.events.map(event => event.input).join(''), typed);
  assert.deepEqual(result.events.map(event => event.kind), ['key', 'key', 'key', 'wheel', 'wheel', 'click']);
  assert.ok(cast.some(row => row[1] === 'o' && row[2].includes('got:' + Buffer.from(typed).toString('hex'))), 'the app received every byte');
  // The animation opens on the "ready" screen, never on the blank start-up before it
  const { data, info } = await sharp(result.file, { animated: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let red = 0;
  for (let i = 0; i < info.width * result.height * 3; i += 3) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) red++;
  assert.ok(red > 20, 'first frame shows "ready"');
  assert.deepEqual([data[0], data[1], data[2]], [0x11, 0x12, 0x13], 'the seti preset paints the background');
  assert.ok(Math.abs(result.duration - (result.takeDuration - result.captureStart)) <= 0.25, 'the animation runs from capture start to the end');
}));

test('one PTY take renders several outputs, recorded and reviewed in the manifest', () => inTemporary(async cwd => {
  const out = join(cwd, 'out');
  const config = { recipes: { overview: {
    source: 'terminal', command: ['python3', '-c', echo], columns: 40, rows: 4, theme: 'prolight', fps: 2,
    steps: [{ waitFor: 'ready', startCapture: true }, { hold: 1.1 }, { key: 'x' }, { waitFor: 'got:78' }, { hold: 0.6 }],
    outputs: [{ suffix: '-still', format: 'png', at: 0.2 }, { format: 'webp' }, { name: 'overview-clip', format: 'mp4', fps: 4 }],
  } } };
  const report = await captureRun({ config, cwd, out });
  assert.equal(await readFile(join(cwd, 'launches'), 'utf8'), 'x', 'the application ran once');
  const entry = report.recipes.overview;
  assert.equal(entry.file, 'overview-still.png');
  assert.deepEqual(entry.outputs.map(output => output.file), ['overview-still.png', 'overview.webp', 'overview-clip.mp4']);
  assert.deepEqual((await readdir(join(out, 'takes'))).filter(name => name.endsWith('.cast')), ['overview.cast']);
  const still = await sharp(join(out, 'overview-still.png')).removeAlpha().raw().toBuffer();
  assert.deepEqual([...still.subarray(0, 3)], [255, 255, 255], 'the prolight preset paints the background');
  assert.ok(entry.outputs[1].frames >= 2, 'the WebP shows the screen before and after the key');
  assert.equal(entry.outputs[2].frames, Math.round(entry.outputs[2].duration * 4));
  assert.equal((await reviewRun({ manifest: join(out, 'run.json') })).ok, true);
}));

test('theme presets resolve by name; unknown names and leftover timed steps are refused', async () => {
  assert.equal(terminalTheme('seti').bg, '#111213');
  assert.equal(terminalTheme('prolight').bg, '#ffffff');
  assert.equal(terminalTheme('ghostty'), terminalThemes.ghostty);
  assert.throws(() => terminalTheme('dracula'), /Unknown terminal theme "dracula"/);
  const recipe = { command: ['true'], columns: 20, rows: 4 };
  await assert.rejects(captureTerminalRecipe({ name: 'old', out: tmpdir(), recipe: { ...recipe, steps: [{ at: 1, input: 'j' }] } }), /unknown "at" \(steps run in order/);
  await assert.rejects(captureTerminalRecipe({ name: 'old', out: tmpdir(), recipe: { ...recipe, duration: 2 } }), /take no duration/);
  await assert.rejects(captureTerminalRecipe({ name: 'two', out: tmpdir(), recipe: { ...recipe, steps: [{ key: 'j', input: 'k' }] } }), /one of input, key, wheel, click/);
  await assert.rejects(captureTerminalRecipe({ name: 'off', out: tmpdir(), recipe: { ...recipe, steps: [{ wheel: { col: 21, row: 1, down: 1 } }] } }), /col \(1–20\)/);
  await assert.rejects(captureTerminalRecipe({ name: 'both', out: tmpdir(), recipe: { ...recipe, format: 'png', outputs: [{ format: 'webp' }] } }), /outputs and format/);
  await assert.rejects(captureTerminalRecipe({ name: 'same', out: tmpdir(), recipe: { ...recipe, outputs: [{ format: 'png', at: 0 }, { format: 'png', at: 1 }] } }), /Two terminal outputs write same\.png/);
});

test('keys follow the terminal: arrows in application cursor mode, control and alt chords', () => {
  assert.equal(keyInput('Up'), '\x1b[A');
  assert.equal(keyInput('Up', true), '\x1bOA');
  assert.equal(keyInput('Ctrl+C'), '\x03');
  assert.equal(keyInput('Alt+x'), '\x1bx');
  assert.equal(keyInput('PageDown'), '\x1b[6~');
  assert.equal(keyInput('Space'), ' ');
  assert.equal(keyInput('2'), '2');
  assert.throws(() => keyInput('Hyper'), /Unknown terminal key/);
  assert.equal(stepInput({ click: { col: 1, row: 1 } }), '\x1b[<0;1;1M\x1b[<0;1;1m');
  assert.equal(stepInput({ hold: 1 }), undefined);
});

test('a re-render of a take accepts a theme preset by name', () => inTemporary(async cwd => {
  const take = await captureTerminalRecipe({ name: 'plain', cwd, out: join(cwd, 'out'), recipe: {
    command: ['python3', '-c', application], columns: 30, rows: 6, format: 'cast', steps: [{ waitFor: 'selected: alpha' }, { hold: 0.1 }],
  } });
  const result = await renderTerminalTake({ cast: take.take, name: 'light', out: join(cwd, 'out'), recipe: { format: 'png', theme: 'prolight' } });
  const pixels = await sharp(result.file).removeAlpha().raw().toBuffer();
  assert.deepEqual([...pixels.subarray(0, 3)], [255, 255, 255]);
}));
