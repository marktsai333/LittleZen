#!/usr/bin/env python3
"""Read-only LittleZen installation preview. Mutation is deliberately not exposed yet."""
import argparse
import json
import sys
from pathlib import Path
from littlezen_install import Conflict, decode, plan_install

def main(argv=None):
    parser=argparse.ArgumentParser(description='Preview LittleZen installation without changing files.')
    parser.add_argument('--profile',required=True,type=Path,help='Zen profile directory')
    parser.add_argument('--zen-app',required=True,type=Path,help='Path to Zen.app')
    parser.add_argument('--hammerspoon',type=Path,help='Existing Hammerspoon config directory (optional)')
    args=parser.parse_args(argv)
    app=args.zen_app.absolute(); resources=app/'Contents/Resources'
    if app.suffix != '.app' or not (app/'Contents/Info.plist').is_file():
        parser.error('--zen-app must refer to an application bundle with Contents/Info.plist')
    try:
        plan=plan_install(args.profile,resources,args.hammerspoon)
    except (Conflict, OSError, UnicodeError) as exc:
        print(f'Cannot prepare installation: {exc}',file=sys.stderr); return 2
    items=[]
    for change in plan['changes']:
        old=decode(change['before']); new=decode(change['after'])
        if old==new: action='already present'
        elif old is None: action='create'
        else: action='modify'
        items.append({'path':change['path'],'action':action,'shared':change['shared']})
    summary={'mode':'preview only; no changes made','profile':plan['profile'],'zen_app':str(app),
             'bundle_signature_warning':'Changing the app bundle can invalidate its code signature.',
             'global_shortcut':args.hammerspoon is not None,'changes':items}
    print(json.dumps(summary,indent=2,ensure_ascii=False));return 0

if __name__=='__main__': raise SystemExit(main())
