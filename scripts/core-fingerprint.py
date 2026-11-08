#!/usr/bin/env python3
"""Hash all executable inputs for the standalone installer core."""
import hashlib
from pathlib import Path
root=Path(__file__).resolve().parent.parent
paths=[root/'installer/littlezen.py',root/'installer/littlezen_install.py']
for directory in (root/'candidate',root/'vendor/fx-autoconfig'):
    paths.extend(p for p in directory.rglob('*') if p.is_file() or p.is_symlink())
h=hashlib.sha256()
for path in sorted(paths):
    if path.is_symlink(): raise SystemExit('Refusing symlink input: '+str(path))
    rel=path.relative_to(root).as_posix().encode()
    data=path.read_bytes()
    h.update(len(rel).to_bytes(8,'big'));h.update(rel)
    h.update(len(data).to_bytes(8,'big'));h.update(data)
print(h.hexdigest())
