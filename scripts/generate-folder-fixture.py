"""Synthetic extracted export folders for folder preservation (section 21); requires Pillow, optional ffmpeg.
Never uses personal media. Writes two folders under work/folder-fixture-*/:
  snarchive-extracted/  12 dated photos, an overlay, two memories sharing identical bytes, a video, a copy of the
                        photo fixture's first memory (overlap with a ZIP import), metadata with locations and one
                        metadata-only memory, and an unrelated file.
  snarchive-many/       COUNT small distinct photos, slow enough to cancel or force-stop mid-run.
Usage: python3 scripts/generate-folder-fixture.py [COUNT]"""
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path
import json, random, shutil, subprocess, sys, tempfile, zipfile
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'work'
root.mkdir(exist_ok=True)
out = Path(tempfile.mkdtemp(prefix='folder-fixture-', dir=root))
count = int(sys.argv[1]) if len(sys.argv) > 1 else 600

def jpeg(label, color, size=(480, 640)):
    image = Image.new('RGB', size, color); draw = ImageDraw.Draw(image)
    draw.rectangle((40, 40, size[0] - 40, size[1] - 40), outline='white', width=6)
    draw.text((60, size[1] // 2), f'SYNTHETIC FOLDER {label}', fill='white')
    data = BytesIO(); image.save(data, 'JPEG', quality=85); return data.getvalue()

folder = out / 'snarchive-extracted'; memories = folder / 'memories'; memories.mkdir(parents=True)
for index in range(12):
    day = date(2026, 10, 1) + timedelta(days=index)
    (memories / f'{day}_f{index:02d}-main.jpg').write_bytes(jpeg(f'{index:02d} {day}', ((index * 41) % 200 + 30, (index * 67) % 200 + 30, 120)))
overlay = Image.new('RGBA', (240, 320)); draw = ImageDraw.Draw(overlay)
draw.rectangle((20, 20, 220, 300), outline='yellow', width=8); draw.text((50, 150), 'FOLDER OVERLAY', fill='yellow')
data = BytesIO(); overlay.save(data, 'PNG'); (memories / '2026-10-01_f00-overlay.png').write_bytes(data.getvalue())
# A distinct memory whose bytes equal f01's: one stored object, two memories.
shutil.copyfile(memories / '2026-10-02_f01-main.jpg', memories / '2026-10-13_fsame-main.jpg')
video = memories / '2026-10-14_fvideo-main.mp4'
if shutil.which('ffmpeg'):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-pix_fmt', 'yuv420p',
                    '-c:v', 'libx264', '-y', str(video)], check=True)
# Overlap with a ZIP import: the photo fixture's first memory, byte-identical, under the same name.
photos = sorted(root.glob('photo-fixture-*/snarchive-photos.zip'))
if photos:
    with zipfile.ZipFile(photos[-1]) as archive: (memories / '2026-10-18_000-photo-main.jpg').write_bytes(archive.read('2026-10-18_000-photo-main.jpg'))
(folder / 'json').mkdir()
rows = [{'Date': '2026-10-01 09:30:00 UTC', 'Media Type': 'Image', 'Location': 'Latitude, Longitude: 59.91, 10.75',
         'Download Link': 'https://synthetic.invalid/download?mid=f00'},
        {'Date': '2026-10-20 18:00:00 UTC', 'Media Type': 'Video', 'Location': 'Latitude, Longitude: 0.0, 0.0',
         'Download Link': 'https://synthetic.invalid/download?mid=fmetaonly'}]
(folder / 'json' / 'memories_history.json').write_text(json.dumps({'Saved Media': rows}), encoding='utf-8')
(folder / 'index.html').write_text('<p>synthetic</p>', encoding='utf-8')

many = out / 'snarchive-many' / 'memories'; many.mkdir(parents=True)
for index in range(count):
    day = date(2026, 9, 1) - timedelta(days=index % 300)
    noise = Image.frombytes('RGB', (48, 64), random.Random(index).randbytes(48 * 64 * 3)) # Distinct bytes per file.
    data = BytesIO(); noise.save(data, 'JPEG', quality=90); (many / f'{day}_m{index:04d}-main.jpg').write_bytes(data.getvalue())
print(out)
