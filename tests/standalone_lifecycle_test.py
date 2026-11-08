"""Opt-in process-level test for the packaged core; uses disposable files only."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

CORE=os.environ.get('LITTLEZEN_STANDALONE_CORE')

@unittest.skipUnless(CORE,'set LITTLEZEN_STANDALONE_CORE to test the packaged executable')
class StandaloneLifecycle(unittest.TestCase):
    def test_unverified_version_requires_acknowledgement(self):
        with tempfile.TemporaryDirectory(prefix='littlezen-standalone-version-') as t:
            root=Path(t);profile=root/'profile';profile.mkdir()
            app=root/'Zen.app';(app/'Contents/Resources').mkdir(parents=True);(app/'Contents/MacOS').mkdir()
            (app/'Contents/MacOS/zen').write_text('fixture')
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'app.zen-browser.zen','CFBundleExecutable':'zen','CFBundleShortVersionString':'99.0'}))
            base=[CORE,'--profile',str(profile),'--zen-app',str(app)]
            env=dict(os.environ,PATH='/usr/bin:/bin')
            for key in ('PYTHONHOME','PYTHONPATH','DYLD_FRAMEWORK_PATH'):env.pop(key,None)
            preview=subprocess.run(base,env=env,capture_output=True,text=True)
            self.assertEqual(preview.returncode,0,preview.stderr)
            info=json.loads(preview.stdout);self.assertIn('zen_compatibility_warning',info)
            denied=subprocess.run(base+['--apply','--expected-plan',info['plan_fingerprint'],'--ack-bundle-modification'],env=env,capture_output=True,text=True)
            self.assertEqual(denied.returncode,2);self.assertFalse((profile/'chrome').exists())
    def test_install_update_cleanup_without_external_python(self):
        with tempfile.TemporaryDirectory(prefix='littlezen-standalone-lifecycle-') as t:
            root=Path(t); profile=root/'profile';profile.mkdir()
            app=root/'Zen.app';(app/'Contents/Resources').mkdir(parents=True);(app/'Contents/MacOS').mkdir()
            (app/'Contents/MacOS/zen').write_text('fixture')
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'app.zen-browser.zen','CFBundleExecutable':'zen','CFBundleShortVersionString':'1.24b'}))
            hs=root/'hammerspoon';hs.mkdir();(hs/'init.lua').write_text('-- existing configuration\n')
            registry=root/'profiles.ini';registry.write_text('[Profile0]\nIsRelative=1\nPath=profile\n')
            base=[CORE,'--profile',str(profile),'--zen-app',str(app)]
            env=dict(os.environ,PATH='/usr/bin:/bin')
            env.pop('PYTHONHOME',None);env.pop('PYTHONPATH',None);env.pop('DYLD_FRAMEWORK_PATH',None)
            def run(*args):
                r=subprocess.run(base+list(args),env=env,capture_output=True,text=True)
                self.assertEqual(r.returncode,0,r.stderr)
                return json.loads(r.stdout)
            opts=['--hammerspoon',str(hs)]
            preview=run(*opts);self.assertFalse((profile/'chrome').exists())
            run(*opts,'--apply','--expected-plan',preview['plan_fingerprint'],'--ack-bundle-modification')
            self.assertTrue((profile/'chrome/JS/littleZen.uc.js').is_file())
            update=run('--action','update');run('--action','update','--apply','--expected-plan',update['plan_fingerprint'])
            opts=['--action','remove','--remove-owned-app-loader','--profiles-ini',str(registry)]
            removal=run(*opts);run(*opts,'--apply','--expected-plan',removal['plan_fingerprint'],'--ack-bundle-modification','--ack-unregistered-profiles')
            self.assertFalse((app/'Contents/Resources/config.js').exists())
            self.assertFalse((profile/'chrome/JS/littleZen.uc.js').exists())
            self.assertEqual((hs/'init.lua').read_text(),'-- existing configuration\n')
