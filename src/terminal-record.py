#!/usr/bin/env python3
"""Record a trusted command in an isolated PTY; JSON config arrives on stdin."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time


def record(config):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', config['rows'], config['columns'], 0, 0))
    environment = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor')
    environment.update(config.get('env', {}))
    process = None
    started = time.monotonic()
    events, actions, checks = [], [], []
    pending = b''
    pending_since = started
    steps = list(config.get('steps', []))
    index = 0
    duration = config['duration']
    byte_count = 0
    try:
        process = subprocess.Popen(config['command'], cwd=config['cwd'], env=environment,
                                   stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        slave = None
        while time.monotonic() - started < duration:
            elapsed = time.monotonic() - started
            while index < len(steps) and steps[index]['at'] <= elapsed:
                step = steps[index]
                if step.get('input'):
                    os.write(master, step['input'].encode())
                actions.append(dict(at=round(elapsed, 3), input=step.get('input', '')))
                if step.get('expect'):
                    checks.append(dict(at=step['at'] + step.get('settle', .3), expect=step['expect']))
                index += 1
            readable, _, _ = select.select([master], [], [], .02)
            if readable:
                try:
                    chunk = os.read(master, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b''
                if chunk:
                    if not pending:
                        pending_since = time.monotonic()
                    pending += chunk
                    byte_count += len(chunk)
                    if byte_count > config.get('maxBytes', 32 * 1024 * 1024):
                        raise RuntimeError('terminal output exceeded maxBytes')
                elif process.poll() is not None:
                    break
            if pending and (not readable or time.monotonic() - pending_since > .1):
                events.append([round(time.monotonic() - started, 3), 'o', pending.decode('utf-8', errors='replace')])
                pending = b''
            if process.poll() is not None:
                break
        if pending:
            events.append([round(time.monotonic() - started, 3), 'o', pending.decode('utf-8', errors='replace')])
        if process.poll() is not None and time.monotonic() - started < duration - .2:
            raise RuntimeError(f'terminal command exited before capture finished (exit {process.returncode})')
        if not events:
            raise RuntimeError('terminal command produced no output')
        header = dict(version=2, width=config['columns'], height=config['rows'], timestamp=0)
        if config.get('theme'):
            header['theme'] = config['theme']
        # An end marker preserves intentional reading pauses after the last output.
        events.append([duration, 'm', 'end'])
        Path(config['cast']).write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in [header] + events) + '\n')
        Path(config['actions']).write_text(json.dumps(dict(actions=actions, checks=checks), indent=2) + '\n')
    finally:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            # The group can outlive its leader: a descendant may ignore TERM even
            # when wait() above succeeds. This is our own newly-created session.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(.01)
        os.close(master)
        if slave is not None:
            os.close(slave)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    record(json.load(sys.stdin))
