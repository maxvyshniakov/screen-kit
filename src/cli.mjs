#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve, dirname, basename, extname } from 'node:path';
import { captureRun, loadConfiguration, statusRun, VERSION } from './run.mjs';
import { reviewRun } from './review.mjs';
import { renderVideo } from './video.mjs';

const help = `screen-kit ${VERSION}

screen-kit capture --config screen-kit.config.mjs [--only name,name] [--out dir]
screen-kit status --config screen-kit.config.mjs [--manifest out/run.json]
screen-kit review --manifest out/run.json [--out review.json]
screen-kit render --input take.cast --out demo.webp [--fps 1] [--at 3]
screen-kit render --input take.gif --out demo.mp4 [--fps 30]

Recipes live in the consumer repository. Browser and terminal capture use real input.
Capture writes run.json, original takes and exported files; review verifies their hashes,
dimensions, frame counts, duration and capture checkpoints. render exports silent MP4/WebM.
`;

const [command = 'help', ...args] = process.argv.slice(2);
const allowed = new Set(['config', 'cwd', 'only', 'out', 'manifest', 'input', 'fps', 'at']);
try {
  if (['help', '--help', '-h'].includes(command)) { console.log(help); }
  else if (['--version', '-V'].includes(command)) console.log(VERSION);
  else {
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      if (!args[i].startsWith('--') || !allowed.has(args[i].slice(2))) throw Error(`unknown option: ${args[i]}`);
      const name = args[i].slice(2);
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error(`--${name} requires a value`);
      if (Object.hasOwn(flags, name)) throw Error(`duplicate option: --${name}`);
      flags[name] = args[++i];
    }
    if (command === 'capture' || command === 'status') {
      const loaded = await loadConfiguration(flags.config ?? 'screen-kit.config.mjs');
      const options = { config: loaded.config, cwd: flags.cwd ? resolve(flags.cwd) : loaded.cwd,
        only: flags.only, ...(flags.out ? { out: flags.out } : {}), manifest: flags.manifest };
      console.log(JSON.stringify(await (command === 'capture' ? captureRun(options) : statusRun(options)), null, 2));
    } else if (command === 'review') {
      const result = await reviewRun({ manifest: flags.manifest });
      const text = JSON.stringify(result, null, 2) + '\n';
      if (flags.out) await writeFile(resolve(flags.out), text);
      console.log(text.trimEnd());
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'render') {
      if (!flags.input || !flags.out) throw Error('render requires --input and --out');
      let result;
      if(extname(flags.input)==='.cast') {
        const {renderTerminalTake}=await import('./terminal.mjs');
        const output=resolve(flags.out),extension=extname(output);
        result=await renderTerminalTake({cast:resolve(flags.input),out:dirname(output),name:basename(output,extension),
          recipe:{format:extension.slice(1),...(flags.fps?{fps:Number(flags.fps)}:{}),...(flags.at?{at:Number(flags.at)}:{})}});
      } else result=await renderVideo({ input: flags.input, output: flags.out,
        ...(flags.fps ? { fps: Number(flags.fps) } : {}) });
      console.log(JSON.stringify(result, null, 2));
    } else throw Error(`unknown command: ${command}`);
  }
} catch (error) {
  console.error(`screen-kit: ${error.message}`);
  process.exitCode = 1;
}
