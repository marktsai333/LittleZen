#!/usr/bin/env python3
"""Experimental CLI: preview by default; use only after reviewing the installation plan."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
from littlezen_install import (Conflict, STATE_FILE, decode, plan_install, apply_install,
                               plan_update, apply_update, plan_remove, apply_remove)

def app_details(app):
    if app.suffix != '.app': raise Conflict('Expected a .app application bundle')
    try:
        with (app/'Contents/Info.plist').open('rb') as f: info=plistlib.load(f)
    except (OSError, plistlib.InvalidFileException) as exc:
        raise Conflict('Cannot read Zen application metadata') from exc
    if info.get('CFBundleIdentifier') != 'app.zen-browser.zen':
        raise Conflict('Selected application is not the supported Zen bundle')
    executable=info.get('CFBundleExecutable')
    if not isinstance(executable,str) or not executable or Path(executable).name != executable:
        raise Conflict('Invalid application executable')
    if not (app/'Contents/MacOS'/executable).is_file():
        raise Conflict('Zen executable does not exist')
    return info, app/'Contents/MacOS'/executable

def ensure_stopped(executable):
    result=subprocess.run(['ps','-A','-o','command='],capture_output=True,text=True,check=True)
    prefix=str(executable)
    if any(line.strip()==prefix or line.strip().startswith(prefix+' ') for line in result.stdout.splitlines()):
        raise Conflict('Quit the selected Zen application before applying changes')

def writable_parent(path):
    parent=path.parent
    while not parent.exists() and parent != parent.parent: parent=parent.parent
    return os.access(parent,os.W_OK | os.X_OK)

def main(argv=None):
    parser=argparse.ArgumentParser(description='Preview LittleZen changes; writes require --apply.')
    parser.add_argument('--profile',required=True,type=Path,help='Zen profile directory')
    parser.add_argument('--zen-app',required=True,type=Path,help='Path to Zen.app')
    parser.add_argument('--hammerspoon',type=Path,help='Existing Hammerspoon config directory (optional)')
    parser.add_argument('--action',choices=('install','update','remove'),default='install')
    parser.add_argument('--apply',action='store_true',help='Apply the proposed action')
    parser.add_argument('--expected-plan',help='Fingerprint obtained from a successful preview')
    parser.add_argument('--ack-bundle-modification',action='store_true',help='Acknowledge that installation can invalidate the Zen bundle signature')
    parser.add_argument('--remove-owned-app-loader',action='store_true',help='Optionally remove app loader installed by LittleZen after auditing registered profiles')
    parser.add_argument('--profiles-ini',type=Path,help='Zen profiles.ini used to audit optional loader cleanup')
    parser.add_argument('--ack-unregistered-profiles',action='store_true',help='Acknowledge unregistered profiles cannot be automatically checked')
    parser.add_argument('--ack-untested-zen',action='store_true',help='Acknowledge the selected Zen version has not been tested')
    args=parser.parse_args(argv)
    app=args.zen_app.absolute(); profile=args.profile.absolute(); resources=app/'Contents/Resources'
    state_path=profile/'chrome'/STATE_FILE
    try:
        info,executable=app_details(app)
        if args.action=='install':
            plan=plan_install(profile,resources,args.hammerspoon)
            changes=plan['changes']
        else:
            saved=json.loads(state_path.read_text())
            if saved.get('profile') != str(profile) or saved.get('resources') != str(resources):
                raise Conflict('Selected profile or Zen app does not match the installation record')
            changes=plan_update(state_path) if args.action=='update' else plan_remove(state_path,args.remove_owned_app_loader,args.profiles_ini)
        items=[]
        for change in changes:
            old=decode(change.get('before',change.get('current')))
            new=decode(change.get('after',change.get('replacement')))
            action='already present' if old==new else 'create' if old is None else 'remove' if new is None else 'modify'
            items.append({'path':change['path'],'action':action,'shared':change.get('shared',False)})
        payload={'action':args.action,'profile':str(profile),'zen_app':str(app),
                 'zen_info_sha256':hashlib.sha256((app/'Contents/Info.plist').read_bytes()).hexdigest(),
                 'changes':changes}
        fingerprint=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
        summary={'mode':'preview only; no changes made' if not args.apply else 'apply',
                 'action':args.action,'profile':str(profile),'zen_app':str(app),
                 'zen_version':info.get('CFBundleShortVersionString','unknown'),
                 'bundle_signature_warning':'Changing the app bundle can invalidate its code signature.',
                 'global_shortcut':args.hammerspoon is not None if args.action=='install' else None,
                 'changes':items,'plan_fingerprint':fingerprint}
        zen_version=info.get('CFBundleShortVersionString','unknown')
        if zen_version != '1.24b':
            summary['zen_compatibility_warning']=f'Zen {zen_version} has not been verified; compatibility is unknown.'
        if args.action == 'remove':
            removed_paths={change['path'] for change in changes if change.get('loader_cleanup')}
            summary['retained_shared_loader']=[change['path'] for change in saved['changes'] if change.get('shared') and change['path'] not in removed_paths]
            if args.remove_owned_app_loader:
                summary['loader_cleanup_warning']='Unregistered profiles cannot be detected and may depend on the app loader.'
        if args.apply:
            if args.expected_plan != fingerprint:
                raise Conflict('Changes differ from the confirmed preview; preview again')
            if zen_version != '1.24b' and not args.ack_untested_zen:
                raise Conflict(f'Zen {zen_version} has not been tested; explicit acknowledgement is required')
            if args.remove_owned_app_loader and not args.ack_unregistered_profiles:
                raise Conflict('App loader cleanup requires acknowledgement of unregistered profiles')
            if os.geteuid()==0: raise Conflict('Do not run the installer as root; it would change profile ownership')
            modifies_bundle=any(Path(item['path']).is_relative_to(resources) and item['action'] != 'already present' for item in items)
            if modifies_bundle and not args.ack_bundle_modification:
                raise Conflict('Installation requires explicit acknowledgement of the app bundle signature impact')
            ensure_stopped(executable)
            targets=[Path(item['path']) for item in items if item['action'] != 'already present']+[state_path]
            unwritable=[str(p) for p in targets if not writable_parent(p)]
            if unwritable:
                raise Conflict('No write permission for target directories; no changes made: '+', '.join(unwritable))
            if args.action=='install': apply_install(plan)
            elif args.action=='update': apply_update(state_path,changes)
            else: apply_remove(state_path,changes)
            summary['mode']='applied'
        print(json.dumps(summary,indent=2,ensure_ascii=False));return 0
    except (Conflict, OSError, UnicodeError, ValueError, subprocess.SubprocessError) as exc:
        print(f'Cannot complete {args.action}: {exc}',file=sys.stderr);return 2

if __name__=='__main__': raise SystemExit(main())
