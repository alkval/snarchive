"""Synthetic On this day library, with dates relative to a supplied UTC day. Requires Pillow and ffmpeg."""
import argparse
from datetime import date, datetime, timedelta, timezone
from io import BytesIO
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import zipfile
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--reference', type=date.fromisoformat, default=datetime.now(timezone.utc).date())
parser.add_argument('--output', type=Path)
args = parser.parse_args()
reference = args.reference
root = Path(__file__).resolve().parent.parent / 'work'
root.mkdir(exist_ok=True)
out = args.output or Path(tempfile.mkdtemp(prefix='on-this-day-', dir=root))
out.mkdir(parents=True, exist_ok=True)

def corresponding(year):
    try:
        return reference.replace(year=year)
    except ValueError:
        return None  # February 29 never shifts to a different date.

past = [day for year in range(reference.year - 1, max(0, reference.year - 33), -1) if (day := corresponding(year))]
if not past:
    raise SystemExit('Reference needs at least one earlier matching year.')
future = next(day for year in range(reference.year + 1, reference.year + 5) if (day := corresponding(year)))

def photo(label, overlay=False):
    image = Image.new('RGBA' if overlay else 'RGB', (600, 800), (0, 0, 0, 0) if overlay else '#284e63')
    draw = ImageDraw.Draw(image)
    for x, y, color in [(100, 100, '#f4c542'), (500, 100, '#ed756a'), (100, 700, '#64d3ac'), (500, 700, '#e0a8ef')]:
        if overlay:
            draw.rectangle((x-45, y-45, x+45, y+45), outline='white', width=5)
        else:
            draw.rectangle((x-30, y-30, x+30, y+30), fill=color)
    draw.text((140, 390), label, fill='white')
    data = BytesIO()
    image.save(data, 'PNG' if overlay else 'JPEG')
    return data.getvalue()

still = out / 'synthetic-video.jpg'
still.write_bytes(photo('SYNTHETIC VIDEO'))
video = out / 'synthetic-video.mp4'
subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-loop', '1', '-i', str(still),
                '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(video)], check=True)

archive = out / 'snarchive-on-this-day.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for i in range(65):
        day = past[i % min(8, len(past))]
        memory = f'd{i:02}'
        is_video = i in (2, 30)
        z.writestr(f'{day}_{memory}-main.{"mp4" if is_video else "jpg"}', video.read_bytes() if is_video else photo(f'{memory} {day}'))
        if i == 0:
            z.writestr(f'{day}_{memory}-overlay.png', photo('SYNTHETIC OVERLAY', True))
    extras = [('current', reference), ('future', future), ('other', past[0] + timedelta(days=1)), ('conflict', past[0])]
    for memory, day in extras:
        z.writestr(f'{day}_{memory}-main.jpg', photo(f'{memory} {day}'))
    z.writestr('2025-02-30_unknown-main.jpg', photo('UNKNOWN DATE'))
    z.writestr('memories_history.json', json.dumps({'Saved Media': [{
        'Date': f'{past[0] + timedelta(days=1)} 12:00:00 UTC', 'Media Type': 'Image',
        'Download Link': 'https://example.test/?mid=conflict',
    }]}))

print(archive)
print('SHA-256:', hashlib.sha256(archive.read_bytes()).hexdigest())
print('UTC reference:', reference, '| 70 memories; 65 On this day matches (63 photos, 2 videos); one matching overlay.')
