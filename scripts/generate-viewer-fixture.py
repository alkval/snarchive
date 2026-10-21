"""Synthetic export for checking the fullscreen viewer (Section 25). Generated calibration media only.

40 memories, newest first m00 … m39, one per day, so the grid's 30-row page boundary falls between m29 and m30.
Every base photo has filled marker squares; a matching overlay draws outlines that surround them only when the two
layers are aligned (the overlay is half the base resolution, same aspect). Cases:
  m00 landscape + matching overlay      m01 portrait + matching overlay     m02 video + matching overlay
  m03 overlay with a different shape    m04 two overlays (ambiguous)        m05 two base files (competing)
  m29 landscape + overlay (last on page 1)   m30 video (first on page 2)   m31 portrait
The rest alternate portrait and landscape. Each picture shows its memory number. Requires Pillow and ffmpeg."""
from datetime import date, timedelta
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile
from PIL import Image, ImageDraw, ImageFont

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix='viewer-fixture-'))
out.mkdir(parents=True, exist_ok=True)
font = ImageFont.load_default(size=96)
small = ImageFont.load_default(size=40)
COLORS = ['#f4c542', '#ed756a', '#64d3ac', '#e0a8ef', '#ffffff']

def markers(width, height):
    """Marker centres as fractions of the picture: four corners and the centre."""
    return [(0.12, 0.12), (0.88, 0.12), (0.12, 0.88), (0.88, 0.88), (0.5, 0.5)]

def base(label, width, height, background):
    image = Image.new('RGB', (width, height), background)
    draw = ImageDraw.Draw(image)
    for x in range(0, width, width // 8): draw.line((x, 0, x, height), fill='#ffffff22', width=2)
    for y in range(0, height, height // 8): draw.line((0, y, width, y), fill='#ffffff22', width=2)
    side = min(width, height) * 0.06
    for (fx, fy), color in zip(markers(width, height), COLORS):
        x, y = fx * width, fy * height
        draw.rectangle((x - side, y - side, x + side, y + side), fill=color)
    draw.text((width * 0.5, height * 0.3), label, fill='white', font=font, anchor='mm')
    draw.text((width * 0.5, height * 0.7), f'{width}x{height}', fill='white', font=small, anchor='mm')
    return image

def overlay(width, height, text='OVERLAY'):
    image = Image.new('RGBA', (width, height))
    draw = ImageDraw.Draw(image)
    side = min(width, height) * 0.06
    for fx, fy in markers(width, height):
        x, y = fx * width, fy * height
        draw.rectangle((x - side * 1.6, y - side * 1.6, x + side * 1.6, y + side * 1.6), outline='white', width=max(2, width // 200))
    draw.text((width * 0.5, height * 0.4), text, fill='white', font=small, anchor='mm')
    return image

LAND, PORT = (1600, 1200), (1080, 1920)
first = date(2026, 9, 30)
files = {}
def day(i): return (first - timedelta(days=i)).isoformat()
def name(i, suffix): return f'{day(i)}_m{i:02d}-{suffix}'

for i in range(40):
    size = LAND if i % 2 == 0 else PORT
    if i in (1, 31): size = PORT
    if i in (0, 29): size = LAND
    background = '#284e63' if size == LAND else '#5a3d6b'
    if i in (2, 30): continue  # Videos, below.
    image = base(f'm{i:02d}', *size, background)
    files[name(i, 'main.jpg')] = ('jpg', image)
    if i in (0, 1, 29):
        files[name(i, 'overlay.png')] = ('png', overlay(size[0] // 2, size[1] // 2))
    if i == 3:
        files[name(i, 'overlay.png')] = ('png', overlay(size[1] // 2, size[0] // 2, 'WRONG SHAPE'))
    if i == 4:
        files[name(i, 'overlay.png')] = ('png', overlay(size[0] // 2, size[1] // 2, 'FIRST'))
        files['second/' + name(i, 'overlay.png')] = ('png', overlay(size[0] // 2, size[1] // 2, 'SECOND'))  # Same name, another folder.
    if i == 5:
        files[name(i, 'main.jpeg')] = ('jpg', base('m05 B', *size, '#6b3d3d'))

for i in (2, 30):
    still = out / f'still-{i}.png'
    base(f'm{i:02d}', 720, 1280, '#1f5c3a').save(still)
    video = out / f'video-{i}.mp4'
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-loop', '1', '-i', str(still), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '10',
                    '-vf', "drawbox=x=300:y=900:w=120:h=30:color=white:t=fill:enable='lt(mod(t,2),1)'", '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-movflags', '+faststart', str(video)], check=True)
    files[name(i, 'main.mp4')] = ('file', video)
    files[name(i, 'overlay.png')] = ('png', overlay(360, 640))

archive_path = out / 'snarchive-viewer.zip'
with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_STORED) as archive:
    for entry, (kind, value) in sorted(files.items()):
        if kind == 'file':
            archive.write(value, entry)
            continue
        path = out / entry
        path.parent.mkdir(parents=True, exist_ok=True)
        value.save(path, quality=88) if kind == 'jpg' else value.save(path)
        archive.write(path, entry)
print(archive_path)
