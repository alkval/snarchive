"""70 distinct synthetic JPEGs for chronological pages and thumbnail cache eviction."""
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path
import tempfile
import zipfile
from PIL import Image, ImageDraw
root = Path(__file__).resolve().parent.parent / 'work'
root.mkdir(exist_ok=True)
out = Path(tempfile.mkdtemp(prefix='library-fixture-', dir=root)) / 'snarchive-library.zip'
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as archive:
    for index in range(70):
        day = date(2026, 10, 17) - timedelta(days=index)
        image = Image.new('RGB', (480, 640), ((index * 37) % 200 + 30, (index * 53) % 200 + 30, (index * 71) % 200 + 30))
        draw = ImageDraw.Draw(image)
        draw.rectangle((40, 40, 440, 600), outline='white', width=8)
        draw.text((120, 300), f'SYNTHETIC {index:02d} / {day}', fill='white')
        content = BytesIO(); image.save(content, 'JPEG')
        archive.writestr(f'{day}_thumb{index:02d}-main.jpg', content.getvalue())
print(out)
