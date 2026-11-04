# Turns screencast frames (sorted by capture timestamp) into a constant 60 fps clip:
# each frame is held until the next one was captured, so a dropped frame shows as a repeat.
# Usage: python3 -I encode.py <recDir> <outBase>
import json, sys, subprocess, os
rec, base = sys.argv[1], sys.argv[2]
tl = json.load(open(f'{rec}/timeline.json'))
order = sorted(range(len(tl['frames'])), key=lambda i: tl['frames'][i])
ts = [tl['frames'][i] for i in order]
lst = f'{base}.concat.txt'
with open(lst, 'w') as f:
    f.write('ffconcat version 1.0\n')
    for k, i in enumerate(order):
        dur = (ts[k+1] - ts[k]) if k + 1 < len(order) else 1/60
        f.write(f"file '{os.path.abspath(rec)}/frames/f{i:05d}.jpg'\nduration {dur:.6f}\n")
    f.write(f"file '{os.path.abspath(rec)}/frames/f{order[-1]:05d}.jpg'\n")
src = ['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', 'fps=60,scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-an']
run = lambda args: subprocess.run(src + args, check=True)
run(['-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', f'{base}.mp4'])
run(['-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-pix_fmt', 'yuv420p', f'{base}.webm'])
run(['-c:v', 'libsvtav1', '-crf', '38', '-preset', '6', '-pix_fmt', 'yuv420p', f'{base}.av1.webm'])
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', f'{rec}/frames/f{order[0]:05d}.jpg', '-frames:v', '1', f'{base}.poster.png'], check=True)
