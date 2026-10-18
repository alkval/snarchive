"""Valid synthetic calibration media; requires Pillow. Never uses personal images."""
from pathlib import Path
from io import BytesIO
import json
import tempfile
import zipfile
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / 'work'
root.mkdir(exist_ok=True)
out = Path(tempfile.mkdtemp(prefix='photo-fixture-', dir=root)) / 'snarchive-photos.zip'
base = Image.new('RGB', (600, 800), '#284e63')
draw = ImageDraw.Draw(base)
for x, y, color in [(100, 100, '#f4c542'), (500, 100, '#ed756a'), (100, 700, '#64d3ac'), (500, 700, '#e0a8ef')]:
    draw.rectangle((x-30, y-30, x+30, y+30), fill=color)
draw.text((170, 390), 'SYNTHETIC PHOTO - 600 x 800', fill='white')
overlay = Image.new('RGBA', (300, 400))
draw = ImageDraw.Draw(overlay)
for x, y in [(50, 50), (250, 50), (50, 350), (250, 350)]:
    draw.rectangle((x-20, y-20, x+20, y+20), outline='white', width=3)
draw.text((60, 215), 'OVERLAY ON', fill='white')
def encoded(image, format):
    output = BytesIO(); image.save(output, format); return output.getvalue()
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as archive:
    archive.writestr('2026-10-18_000-photo-main.jpg', encoded(base, 'JPEG'))
    archive.writestr('2026-10-18_000-photo-overlay.png', encoded(overlay, 'PNG'))
    archive.writestr('2026-10-18_001-mismatch-main.jpg', encoded(base, 'JPEG'))
    archive.writestr('2026-10-18_001-mismatch-overlay.png', encoded(Image.new('RGBA', (400, 300), '#ffffff80'), 'PNG'))
    archive.writestr('memories_history.json', json.dumps({'Saved Media': [{'Date': '2026-10-18 12:34:56 UTC', 'Media Type': 'Image', 'Download Link': 'https://example.test/?mid=000-photo'}]}))
print(out)
print('Two synthetic photos, one matching half-resolution overlay, one mismatched overlay.')
