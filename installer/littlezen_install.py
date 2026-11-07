#!/usr/bin/env python3
"""Transactional LittleZen installation primitives. Experimental; no system writes on import."""
from __future__ import annotations
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import tempfile
import stat

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'vendor/fx-autoconfig'
BEGIN = '# >>> LittleZen managed block >>>'
END = '# <<< LittleZen managed block <<<'
JS_BEGIN = '// >>> LittleZen managed block >>>'
JS_END = '// <<< LittleZen managed block <<<'
CSS_BEGIN = '/* >>> LittleZen managed block >>> */'
CSS_END = '/* <<< LittleZen managed block <<< */'
LUA_BEGIN = '-- >>> LittleZen managed block >>>'
LUA_END = '-- <<< LittleZen managed block <<<'
STATE_FILE = 'littlezen-install-state.json'

class Conflict(Exception):
    pass

def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def encode(data: bytes | None):
    return None if data is None else base64.b64encode(data).decode('ascii')

def decode(data):
    return None if data is None else base64.b64decode(data, validate=True)

def read(path: Path):
    if path.is_symlink():
        raise Conflict(f'Refusing symlink: {path}')
    return path.read_bytes() if path.exists() else None

def ensure_safe_parent(path: Path, root: Path):
    # Do not follow links inside selected roots, even for missing targets.
    path.relative_to(root)
    for p in [Path('.'), *reversed(path.relative_to(root).parents)]:
        check = root / p
        if check.is_symlink():
            raise Conflict(f'Refusing symlink directory: {check}')

def marked(original: bytes | None, begin: str, body: str, end: str, prepend=False) -> bytes:
    data = original or b''
    try: text = data.decode('utf-8')
    except UnicodeDecodeError as exc: raise Conflict('Configuration is not UTF-8') from exc
    if begin in text or end in text:
        raise Conflict(f'Managed marker already present: {begin}')
    if prepend:
        if text.startswith(('\ufeff', '@charset')):
            raise Conflict('Existing stylesheet starts with BOM or @charset; review manually')
        return (begin + '\n' + body + '\n' + end + '\n' + text).encode('utf-8')
    prefix = '' if not text or text.endswith('\n') else '\n'
    return (text + prefix + begin + '\n' + body + '\n' + end + '\n').encode('utf-8')

def plan_install(profile: Path, resources: Path, hammerspoon: Path | None = None):
    profile, resources = profile.absolute(), resources.absolute()
    if not profile.is_dir() or not resources.is_dir():
        raise Conflict('Profile and Zen Resources directories must already exist')
    state = profile / 'chrome' / STATE_FILE
    if state.exists(): raise Conflict('An installer state already exists; use update')
    changes = []
    def add_owned(src: Path, target: Path, root: Path, shared=False):
        ensure_safe_parent(target, root)
        payload = src.read_bytes()
        old = read(target)
        if old is not None and old != payload:
            raise Conflict(f'Existing file differs: {target}')
        changes.append(dict(path=str(target), root=str(root), before=encode(old), after=encode(payload), mode='file', owned=old is None, shared=shared))
    for rel in ['config.js', 'defaults/pref/config-prefs.js']:
        add_owned(VENDOR / 'program' / rel, resources / rel, resources, True)
    for src in sorted((VENDOR / 'profile/chrome/utils').iterdir()):
        if src.is_file(): add_owned(src, profile / 'chrome/utils' / src.name, profile, True)
    for name, rel in [('littleZen.uc.js', 'chrome/JS/littleZen.uc.js'), ('little-zen.css', 'chrome/CSS/little-zen.css')]:
        add_owned(ROOT / 'candidate' / name, profile / rel, profile)
    def add_block(target, root, begin, body, end, prepend=False):
        ensure_safe_parent(target, root)
        old = read(target)
        if old and body.encode() in old:
            raise Conflict(f'Existing configuration may already contain LittleZen: {target}')
        changes.append(dict(path=str(target), root=str(root), before=encode(old), after=encode(marked(old, begin, body, end, prepend)), mode='block', begin=begin, end=end, owned=True, shared=False))
    pref = profile / 'user.js'
    oldpref = read(pref)
    # Keep existing matching preferences untouched; don't add conflicting overrides.
    pref_text=(oldpref or b'').decode('utf-8')
    additions=[]
    for name, value in [('toolkit.legacyUserProfileCustomizations.stylesheets','true'), ('zen.widget.mac.mono-window-controls','false')]:
        pattern=r'(?m)^\s*user_pref\(\s*["\x27]'+re.escape(name)+r'["\x27]\s*,\s*(true|false)\s*\)\s*;'
        matches=re.findall(pattern, pref_text)
        # Any unparsed occurrence (e.g. complex or commented config) needs review.
        if pref_text.count(name) != len(matches) or any(v != value for v in matches):
            raise Conflict(f'Existing preference requires review: {name}')
        if not matches: additions.append(f'user_pref("{name}", {value});')
    if additions:
        add_block(pref, profile, JS_BEGIN, '\n'.join(additions), JS_END)
    add_block(profile/'chrome/userChrome.css', profile, CSS_BEGIN, '@import url("CSS/little-zen.css");', CSS_END, prepend=True)
    if hammerspoon is not None:
        hammerspoon = hammerspoon.absolute()
        if not hammerspoon.is_dir(): raise Conflict('Hammerspoon configuration directory must exist')
        add_owned(ROOT/'candidate/little-zen-bridge.lua', hammerspoon/'little-zen-bridge.lua', hammerspoon)
        add_block(hammerspoon/'init.lua', hammerspoon, LUA_BEGIN, '_G.littleZenBridge = dofile(hs.configdir .. "/little-zen-bridge.lua")\n_G.littleZenBridge.start()', LUA_END)
    return dict(version=1, profile=str(profile), resources=str(resources), state=str(state), changes=changes)

def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    fd, tmp = tempfile.mkstemp(prefix='.littlezen-', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def apply_install(plan):
    state = Path(plan['state'])
    # Preflight again to reject races and avoid overwriting newly changed files.
    for change in plan['changes']:
        p=Path(change['path']); ensure_safe_parent(p, Path(change['root']))
        if read(p) != decode(change['before']): raise Conflict(f'File changed after planning: {p}')
    if state.exists(): raise Conflict('An installer state already exists')
    state.parent.mkdir(parents=True, exist_ok=True)
    plan['phase'] = 'installing'
    atomic_write(state, json.dumps(plan, indent=2).encode())
    try:
        for change in plan['changes']:
            if change['before'] == change['after']:
                continue
            atomic_write(Path(change['path']), decode(change['after']))
        plan['phase'] = 'installed'
        atomic_write(state, json.dumps(plan, indent=2).encode())
    except Exception:
        # A durable journal remains for explicit recovery after process failure.
        raise

def plan_update(state_path: Path, payload_root: Path = ROOT):
    state_path=state_path.absolute()
    state=json.loads(state_path.read_text())
    if state.get('version') != 1 or state.get('state') != str(state_path):
        raise Conflict('Unrecognized installation state')
    if state.get('phase') == 'updating':
        return state['update_actions']
    if state.get('phase') != 'installed':
        raise Conflict('Complete recovery before updating')
    candidates={'littleZen.uc.js': payload_root/'candidate/littleZen.uc.js',
                'little-zen.css': payload_root/'candidate/little-zen.css',
                'little-zen-bridge.lua': payload_root/'candidate/little-zen-bridge.lua'}
    actions=[]
    for index, change in enumerate(state['changes']):
        p=Path(change['path']); ensure_safe_parent(p, Path(change['root']))
        current=read(p); installed=decode(change['after'])
        if change['mode'] == 'block':
            if current is None: raise Conflict(f'Configuration is missing: {p}')
            remove_block(current, change['begin'], change['end'], installed)
        elif change['shared'] and current is None:
            # Zen updates may replace bundle resources. Restore only a missing
            # pinned loader file; a differing file remains a conflict.
            actions.append(dict(index=index, path=str(p), root=change['root'], current=None, replacement=encode(installed)))
            continue
        elif current != installed:
            raise Conflict(f'Installed file was modified or removed: {p}')
        if change['mode'] != 'file' or change['shared'] or p.name not in candidates:
            continue
        new=candidates[p.name].read_bytes()
        if new == installed: continue
        if not change['owned']:
            raise Conflict(f'Cannot update a pre-existing file: {p}')
        actions.append(dict(index=index, path=str(p), root=change['root'], current=encode(current), replacement=encode(new)))
    return actions

def apply_update(state_path: Path, actions):
    state_path=state_path.absolute(); state=json.loads(state_path.read_text())
    if state.get('phase') not in ('installed','updating'):
        raise Conflict('Complete recovery before updating')
    if state.get('phase') == 'updating' and state.get('update_actions') != actions:
        raise Conflict('Update plan differs from recovery journal')
    for action in actions:
        p=Path(action['path']); ensure_safe_parent(p, Path(action['root']))
        if read(p) not in (decode(action['current']),decode(action['replacement'])):
            raise Conflict(f'File changed after planning: {p}')
    if state['phase'] == 'installed':
        state['phase']='updating'; state['update_actions']=actions
        atomic_write(state_path,json.dumps(state,indent=2).encode())
    for action in actions:
        p=Path(action['path']); replacement=decode(action['replacement'])
        if read(p) != replacement: atomic_write(p,replacement)
        state['changes'][action['index']]['after']=action['replacement']
    state['phase']='installed'; state.pop('update_actions',None)
    atomic_write(state_path,json.dumps(state,indent=2).encode())

def remove_block(data: bytes, begin: str, end: str, expected: bytes) -> bytes:
    text=data.decode('utf-8')
    before=expected.decode('utf-8')
    start=before.find(begin + '\n'); finish=before.find(end + '\n', start)
    if start < 0 or finish < 0: raise Conflict('Invalid installed block in journal')
    block=before[start:finish + len(end) + 1]
    if text.count(block) != 1: raise Conflict('Managed configuration block was edited or removed')
    return text.replace(block, '', 1).encode('utf-8')

def plan_remove(state_path: Path):
    state_path=state_path.absolute()
    state=json.loads(state_path.read_text())
    if state.get('version') != 1 or state.get('phase') not in ('installing', 'installed', 'removing'):
        raise Conflict('Unrecognized installation state')
    if state.get('state') != str(state_path): raise Conflict('Installation state path does not match')
    if state['phase'] == 'removing':
        return state['removal_actions']
    actions=[]
    for change in reversed(state['changes']):
        p=Path(change['path']); root=Path(change['root']); ensure_safe_parent(p, root)
        original=decode(change['before']); installed=decode(change['after']); current=read(p)
        if current == original:
            continue  # Not written yet, or already recovered.
        if change['mode'] == 'block':
            if current is None: raise Conflict(f'Configuration is missing: {p}')
            replacement=original if current == installed else remove_block(current, change['begin'], change['end'], installed)
            # Remove a file created by us only when no other content was added.
            if original is None and replacement == b'': replacement=None
        elif change['shared']:
            # A loader may now be used by another customization. Keep shared files.
            continue
        elif current == installed:
            replacement=original
        else:
            raise Conflict(f'Installed file was modified; not removing: {p}')
        actions.append(dict(path=str(p), root=str(root), current=encode(current), replacement=encode(replacement)))
    return actions

def apply_remove(state_path: Path, actions):
    state_path=state_path.absolute()
    for action in actions:
        p=Path(action['path']); ensure_safe_parent(p, Path(action['root']))
        current=read(p)
        if current != decode(action['current']) and current != decode(action['replacement']):
            raise Conflict(f'File changed after planning: {p}')
    state=json.loads(state_path.read_text())
    if state.get('phase') != 'removing':
        state['phase']='removing'; state['removal_actions']=actions
        atomic_write(state_path, json.dumps(state, indent=2).encode())
    elif state.get('removal_actions') != actions:
        raise Conflict('Removal plan differs from recovery journal')
    for action in actions:
        p=Path(action['path']); replacement=decode(action['replacement'])
        if read(p) == replacement: continue
        if replacement is None:
            if p.exists(): p.unlink()
        else: atomic_write(p, replacement)
    # Keep the journal if anything failed; state is removed only on success.
    state_path.unlink()

