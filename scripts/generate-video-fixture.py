"""Generated calibration media only. Requires Pillow and ffmpeg on PATH."""
from pathlib import Path
import json
import subprocess
import tempfile
import zipfile
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'work'
root.mkdir(exist_ok=True)
out = Path(tempfile.mkdtemp(prefix='video-fixture-', dir=root))
base = Image.new('RGB', (480, 640), '#284e63')
draw = ImageDraw.Draw(base)
for x, y, color in [(80, 80, '#f4c542'), (400, 80, '#ed756a'), (80, 560, '#64d3ac'), (400, 560, '#e0a8ef')]:
    draw.rectangle((x-24, y-24, x+24, y+24), fill=color)
draw.text((120, 300), 'SYNTHETIC VIDEO', fill='white')
base.save(out / 'base.png')
overlay = Image.new('RGBA', (240, 320))
draw = ImageDraw.Draw(overlay)
for x, y in [(40, 40), (200, 40), (40, 280), (200, 280)]:
    draw.rectangle((x-16, y-16, x+16, y+16), outline='white', width=2)
draw.text((60, 180), 'OVERLAY ON', fill='white')
overlay.save(out / 'overlay.png')
overlay.transpose(Image.Transpose.ROTATE_90).save(out / 'rotated-overlay.png')
exif = Image.Exif(); exif[274] = 6
base.transpose(Image.Transpose.ROTATE_90).save(out / 'exif.jpg', exif=exif)
subprocess.run(['ffmpeg', '-v', 'error', '-loop', '1', '-i', str(out / 'base.png'), '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '12', '-vf', "drawbox=x=180:y=400:w=120:h=20:color=white:t=fill:enable='lt(mod(t,2),1)'", '-r', '24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', str(out / 'video.mp4')], check=True)
subprocess.run(['ffmpeg', '-v', 'error', '-display_rotation:v:0', '90', '-i', str(out / 'video.mp4'), '-c', 'copy', str(out / 'rotated.mp4')], check=True)
probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_side_data=rotation', '-of', 'json', str(out / 'rotated.mp4')]))
assert probe['streams'][0]['side_data_list'][0]['rotation'] == 90, 'Fixture must contain a real rotation matrix'
with zipfile.ZipFile(out / 'snarchive-video.zip', 'w', compression=zipfile.ZIP_STORED) as archive:
    for name, file in [('002-video-main.mp4', 'video.mp4'), ('002-video-overlay.png', 'overlay.png'), ('003-rotated-main.mp4', 'rotated.mp4'), ('003-rotated-overlay.png', 'rotated-overlay.png'), ('004-exif-main.jpg', 'exif.jpg'), ('004-exif-overlay.png', 'overlay.png')]:
        archive.write(out / file, f'2026-10-18_{name}')
    archive.writestr('2026-10-18_005-broken-main.mp4', b'SYNTHETIC INVALID VIDEO')
print(out / 'snarchive-video.zip')
