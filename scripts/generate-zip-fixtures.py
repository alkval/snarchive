"""Synthetic adversarial archives. Output only to the supplied scratch directory."""
import io
import struct
import sys
import zipfile
from pathlib import Path

root = Path(sys.argv[1]); root.mkdir(parents=True, exist_ok=True)
def create(name, entries, compression=zipfile.ZIP_STORED):
    with zipfile.ZipFile(root / name, 'w', compression=compression) as archive:
        for path, content in entries:
            archive.writestr(path, content)
meta = b'{"Saved Media":[]}'
create('normal.zip', [('memories/2026-02-05_a-main.jpg', b'synthetic placeholder'), ('memories/2026-02-05_a-overlay.png', b'placeholder'), ('json/memories_history.json', meta)])
create('traversal.zip', [('../outside', b'x')])
create('absolute.zip', [('/outside', b'x')])
link = zipfile.ZipInfo('link'); link.create_system = 3; link.external_attr = 0o120777 << 16
create('symlink.zip', [(link, b'../outside')])
create('collision.zip', [('A.jpg', b'a'), ('a.jpg', b'b')])
create('parent.zip', [('a/b.jpg', b'b'), ('a', b'a')])
create('ratio.zip', [('memories_history.json', b'0' * 2_000_000)], zipfile.ZIP_DEFLATED)
create('oversized.zip', [('memories_history.json', b' ' * (8 * 1024 * 1024 + 1))])
create('invalid-utf8.zip', [('memories_history.json', b'\xff\xfe')])
normal = bytearray((root / 'normal.zip').read_bytes())
central = normal.index(b'PK\x01\x02')
modified = normal.copy(); struct.pack_into('<H', modified, central + 8, 1); (root/'encrypted.zip').write_bytes(modified)
modified = normal.copy(); modified[30] ^= 1; (root/'local-name.zip').write_bytes(modified)
modified = normal.copy(); modified[modified.index(meta)] ^= 1; (root/'corrupt-metadata.zip').write_bytes(modified)
(root/'truncated.zip').write_bytes(normal[:-10])
end = normal.rindex(b'PK\x05\x06')
modified = normal.copy(); struct.pack_into('<H', modified, end + 4, 1); (root/'split.zip').write_bytes(modified)
class Unseekable(io.BytesIO):
    def seekable(self): return False
    def seek(self, *args): raise io.UnsupportedOperation()
buffer = Unseekable()
with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('memories_history.json', meta)
(root/'descriptor.zip').write_bytes(buffer.getvalue())
for name, count in [('zip64-count.zip', 65_536), ('too-many.zip', 100_001)]:
    with zipfile.ZipFile(root/name, 'w') as archive:
        for number in range(count): archive.writestr(f'item-{number}', b'')
print('Generated synthetic ZIP fixtures.')
