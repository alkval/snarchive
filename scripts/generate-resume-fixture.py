"""Synthetic, intentionally non-playable media for import interruption and identity checks."""
import hashlib
from pathlib import Path
import tempfile
import zipfile

root = Path(__file__).resolve().parent.parent / 'work'
root.mkdir(exist_ok=True)
out = Path(tempfile.mkdtemp(prefix='resume-fixture-', dir=root)) / 'snarchive-resume.zip'
payload = b'SNARCHIVE SYNTHETIC RESUME FIXTURE\n' * 2048
with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_STORED) as archive:
    for index in range(300):
        archive.writestr(f'2026-02-05_resume{index:04d}-main.jpg', payload)
print(out)
print('Expected: 300 file observations, 300 distinct memories, one shared object.')
print('Object SHA-256:', hashlib.sha256(payload).hexdigest())
print('These are placeholder bytes, not valid photographs. Do not use them for playback testing.')
