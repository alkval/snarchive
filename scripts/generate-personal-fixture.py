"""Small synthetic two-part phone test. Requires Pillow and ffmpeg; reads no personal files."""
import argparse
from io import BytesIO
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import zipfile
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', type=Path, help='New output directory')
out = parser.parse_args().output
out.mkdir(parents=True, exist_ok=False)

def picture(label, overlay=False):
    image = Image.new('RGBA' if overlay else 'RGB', (600, 800), (0, 0, 0, 0) if overlay else '#284e63')
    draw = ImageDraw.Draw(image)
    for x, y, color in [(100, 100, '#f4c542'), (500, 100, '#ed756a'), (100, 700, '#64d3ac'), (500, 700, '#e0a8ef')]:
        if overlay:
            draw.rectangle((x-42, y-42, x+42, y+42), outline='white', width=5)
        else:
            draw.rectangle((x-28, y-28, x+28, y+28), fill=color)
    draw.text((130, 370 if overlay else 410), label, fill='white')
    data = BytesIO()
    image.save(data, 'PNG' if overlay else 'JPEG')
    return data.getvalue()

with tempfile.TemporaryDirectory(prefix='snarchive-phone-fixture-') as temporary:
    root = Path(temporary)
    still = root / 'still.jpg'; still.write_bytes(picture('SYNTHETIC VIDEO - 4 seconds'))
    video = root / 'video.mp4'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', str(still),
                    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4', '-r', '24',
                    '-vf', "drawbox=x=180:y=450:w=180:h=25:color=white:t=fill:enable='lt(mod(t,2),1)'",
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-af', 'volume=0.1',
                    '-movflags', '+faststart', str(video)], check=True)
    parts = [
        {'2026-10-25_phone01-main.jpg': picture('PHOTO 1 - overlay in part 2'),
         '2026-10-24_phone02-main.jpg': picture('PHOTO 2 - no overlay'),
         '2026-10-23_phone03-main.mp4': video.read_bytes()},
        {'2026-10-25_phone01-overlay.png': picture('PHOTO OVERLAY ON', True),
         '2026-10-23_phone03-overlay.png': picture('VIDEO OVERLAY ON', True),
         '2026-10-22_phone04-main.jpg': picture('PHOTO 3 - from part 2')},
    ]
    files = []
    for number, entries in enumerate(parts, 1):
        path = out / f'Snarchive-test-part-{number}.zip'
        with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        with zipfile.ZipFile(path) as archive:
            assert archive.testzip() is None and len(archive.namelist()) == 3
        files.append({'file': path.name, 'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    report = {'synthetic': True, 'expectedMemories': 4, 'expectedOriginals': 6, 'photos': 3, 'videos': 1,
              'overlays': 2, 'videoSeconds': 4, 'videoAudio': 'quiet generated 440 Hz tone', 'files': files}
    (out / 'fixture-info.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
