#!/usr/bin/env python3
"""Record a trusted command in an isolated PTY; JSON config arrives on stdin's first line.

The caller runs the recipe's steps: every recorded output event is also written to stdout as a JSON line {"t", "o"},
and stdin carries JSON-line commands: {"input", "label", "narration", "kind"} types now; {"check"} and {"start"} are
noted in the actions file ({"start": null} at the moment it arrives); {"end": true, "at": seconds | null} stops the
capture then (or at once). `duration` is the most a capture may last. A command may exit before the steps end: its
output is drained, stdout gets {"exit": status}, and the steps go on against its last screen, but an input step
after the exit, or an exit with a nonzero status, fails the capture.
"""
import codecs
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


def read_config():
    """The first stdin line as JSON, and whatever arrived after it (live commands)."""
    data = b''
    while b'\n' not in data:
        chunk = os.read(0, 65536)
        if not chunk:
            break
        data += chunk
    line, _, rest = data.partition(b'\n')
    return json.loads(line), rest


def record(config, leftover=b''):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', config['rows'], config['columns'], 0, 0))
    environment = dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor')
    environment.update(config.get('env', {}))
    process = None
    started = time.monotonic()
    events, actions, checks = [], [], []
    pending = b''
    pending_since = started
    # Decoded across reads, so a character split between two reads is never replaced
    decoder = codecs.getincrementaldecoder('utf-8')(errors='replace')
    limit = config['duration']
    end_at = None
    commands = leftover
    capture_start = None
    byte_count = 0
    # Open until the command and every process that inherited the terminal have gone and their output is read
    terminal_open = True
    exit_reported = False

    def flush():
        nonlocal pending
        text = decoder.decode(pending)
        pending = b''
        if not text:
            return
        event = [round(time.monotonic() - started, 3), 'o', text]
        events.append(event)
        sys.stdout.write(json.dumps(dict(t=event[0], o=text), ensure_ascii=False) + '\n')
        sys.stdout.flush()

    def act(step, elapsed):
        if step.get('input') and process.poll() is not None:
            raise RuntimeError(f'terminal command exited (exit {process.returncode}) before an input step')
        if step.get('input') and not terminal_open:
            raise RuntimeError('terminal command closed its terminal before an input step')
        if step.get('input'):
            os.write(master, step['input'].encode())
        action_entry = dict(at=round(elapsed, 3), input=step.get('input', ''))
        for key in ('label', 'narration', 'kind'):
            if key in step:
                action_entry[key] = step[key]
        actions.append(action_entry)

    def command(line, elapsed):
        nonlocal end_at, capture_start
        order = json.loads(line)
        if 'input' in order:
            act(order, elapsed)
        if 'check' in order:
            checks.append(order['check'])
        if 'start' in order:
            capture_start = round(elapsed, 3) if order['start'] is None else order['start']
        if order.get('end'):
            at = order.get('at')
            if at is not None and at < elapsed - .05:
                raise RuntimeError(f'terminal steps outlasted the duration ({elapsed:.2f}s > {at}s)')
            end_at = elapsed if at is None else at

    try:
        process = subprocess.Popen(config['command'], cwd=config['cwd'], env=environment,
                                   stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        slave = None
        while True:
            elapsed = time.monotonic() - started
            if end_at is not None and elapsed >= end_at:
                break
            if elapsed >= limit:
                raise RuntimeError(f'terminal capture reached its {limit}s limit before its steps ended')
            while b'\n' in commands:
                line, _, commands = commands.partition(b'\n')
                if line.strip():
                    command(line, elapsed)
            if end_at is not None and elapsed >= end_at:
                break
            readable, _, _ = select.select([master, 0] if terminal_open else [0], [], [], .02)
            if 0 in readable:
                data = os.read(0, 65536)
                if not data:
                    raise RuntimeError('terminal capture controller went away')
                commands += data
            if master in readable:
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
                else:
                    terminal_open = False
            if pending and (master not in readable or time.monotonic() - pending_since > .1):
                flush()
            if not terminal_open and not exit_reported and process.poll() is not None:
                # Its output is all out: the controller learns of the exit now, not at a waitFor's timeout
                if pending:
                    flush()
                sys.stdout.write(json.dumps(dict(exit=process.returncode)) + '\n')
                sys.stdout.flush()
                exit_reported = True
        if pending:
            flush()
        if process.poll() is not None and process.returncode != 0:
            raise RuntimeError(f'terminal command failed (exit {process.returncode})')
        duration = round(max(end_at, events[-1][0] if events else 0), 3)
        if not events:
            raise RuntimeError('terminal command produced no output')
        header = dict(version=2, width=config['columns'], height=config['rows'], timestamp=0)
        if config.get('theme'):
            header['theme'] = config['theme']
        # An end marker preserves intentional reading pauses after the last output.
        events.append([duration, 'm', 'end'])
        Path(config['cast']).write_text('\n'.join(json.dumps(row, ensure_ascii=False) for row in [header] + events) + '\n')
        summary = dict(actions=actions, checks=checks, duration=duration)
        if capture_start is not None:
            summary['start'] = capture_start
        Path(config['actions']).write_text(json.dumps(summary, indent=2) + '\n')
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
                except (ProcessLookupError, PermissionError):
                    pass
                process.wait()
            # The group can outlive its leader: a descendant may ignore TERM even
            # when wait() above succeeds. This is our own newly-created session.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline:
                try:
                    os.killpg(process.pid, 0)
                except (ProcessLookupError, PermissionError):
                    break
                time.sleep(.01)
        os.close(master)
        if slave is not None:
            os.close(slave)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    record(*read_config())
