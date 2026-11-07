import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('installer', Path(__file__).resolve().parents[1]/'installer/littlezen_install.py')
inst = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inst)

class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='littlezen-install-fixture-')
        root=Path(self.tmp.name)
        self.profile=root/'profile'; self.resources=root/'Zen.app/Contents/Resources'; self.hs=root/'hammerspoon'
        for p in (self.profile,self.resources,self.hs): p.mkdir(parents=True)
        (self.profile/'user.js').write_text('// existing settings\n')
        (self.hs/'init.lua').write_text('-- existing settings\n')
    def tearDown(self): self.tmp.cleanup()
    def plan(self): return inst.plan_install(self.profile, self.resources, self.hs)
    def state(self): return self.profile/'chrome'/inst.STATE_FILE
    def test_install_remove_preserves_unrelated_changes(self):
        plan=self.plan(); inst.apply_install(plan)
        self.assertEqual(json.loads(self.state().read_text())['phase'],'installed')
        with (self.hs/'init.lua').open('a') as f: f.write('-- later setting\n')
        with (self.profile/'user.js').open('a') as f: f.write('// later preference\n')
        actions=inst.plan_remove(self.state()); inst.apply_remove(self.state(), actions)
        self.assertEqual((self.hs/'init.lua').read_text(),'-- existing settings\n-- later setting\n')
        self.assertEqual((self.profile/'user.js').read_text(),'// existing settings\n// later preference\n')
        self.assertFalse((self.profile/'chrome/JS/littleZen.uc.js').exists())
        self.assertFalse((self.hs/'little-zen-bridge.lua').exists())
        self.assertTrue((self.resources/'config.js').exists()) # shared loader retained
    def test_conflicting_loader_does_not_write(self):
        (self.resources/'config.js').write_text('someone else')
        with self.assertRaises(inst.Conflict): self.plan()
        self.assertFalse(self.state().exists())
        self.assertEqual((self.resources/'config.js').read_text(),'someone else')
    def test_changed_between_plan_and_apply_refuses_all_writes(self):
        plan=self.plan(); (self.hs/'init.lua').write_text('changed')
        with self.assertRaises(inst.Conflict): inst.apply_install(plan)
        self.assertFalse(self.state().exists())
        self.assertFalse((self.resources/'config.js').exists())
    def test_modified_installed_script_refuses_remove(self):
        inst.apply_install(self.plan()); path=self.profile/'chrome/JS/littleZen.uc.js'; path.write_text('my edit')
        with self.assertRaises(inst.Conflict): inst.plan_remove(self.state())
        self.assertEqual(path.read_text(),'my edit')
        self.assertTrue(self.state().exists())
    def test_conflicting_preference_refuses_install(self):
        (self.profile/'user.js').write_text('user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", false);\n')
        with self.assertRaises(inst.Conflict): self.plan()
    def test_matching_preference_is_preserved(self):
        user=self.profile/'user.js'; text='user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);\n'
        user.write_text(text)
        inst.apply_install(self.plan())
        self.assertEqual(user.read_text().count('toolkit.legacyUserProfileCustomizations.stylesheets'), 1)
        inst.apply_remove(self.state(),inst.plan_remove(self.state()))
        self.assertEqual(user.read_text(),text)
    def test_existing_matching_loader_is_not_claimed(self):
        payload=(inst.VENDOR/'program/config.js').read_bytes()
        (self.resources/'config.js').write_bytes(payload)
        plan=self.plan(); change=next(c for c in plan['changes'] if c['path']==str(self.resources/'config.js'))
        self.assertFalse(change['owned'])
    def test_symlinked_target_directory_refused(self):
        elsewhere=Path(self.tmp.name)/'elsewhere'; elsewhere.mkdir()
        (self.profile/'chrome').symlink_to(elsewhere, target_is_directory=True)
        with self.assertRaises(inst.Conflict): self.plan()
    def test_interrupted_install_can_recover(self):
        plan=self.plan(); plan['phase']='installing'; inst.atomic_write(self.state(),json.dumps(plan).encode())
        for change in plan['changes'][:4]: inst.atomic_write(Path(change['path']),inst.decode(change['after']))
        actions=inst.plan_remove(self.state()); inst.apply_remove(self.state(), actions)
        self.assertFalse(self.state().exists())
        self.assertEqual((self.hs/'init.lua').read_text(),'-- existing settings\n')
    def test_stylesheet_import_precedes_existing_rules(self):
        css=self.profile/'chrome/userChrome.css'; css.parent.mkdir()
        css.write_text('body { color: red; }\n')
        inst.apply_install(self.plan())
        self.assertLess(css.read_text().index('@import'), css.read_text().index('body'))
        inst.apply_remove(self.state(),inst.plan_remove(self.state()))
        self.assertEqual(css.read_text(),'body { color: red; }\n')
    def test_permissions_and_missing_newline_preserved(self):
        init=self.hs/'init.lua'; init.write_text('-- no trailing newline'); init.chmod(0o640)
        inst.apply_install(self.plan()); self.assertEqual(init.stat().st_mode & 0o777,0o640)
        inst.apply_remove(self.state(),inst.plan_remove(self.state()))
        self.assertEqual(init.read_text(),'-- no trailing newline')
        self.assertEqual(init.stat().st_mode & 0o777,0o640)
    def test_interrupted_removal_can_resume(self):
        inst.apply_install(self.plan()); actions=inst.plan_remove(self.state())
        state=json.loads(self.state().read_text()); state['phase']='removing'; state['removal_actions']=actions
        inst.atomic_write(self.state(),json.dumps(state).encode())
        first=actions[0]; path=Path(first['path']); data=inst.decode(first['replacement'])
        if data is None: path.unlink()
        else: inst.atomic_write(path,data)
        inst.apply_remove(self.state(),inst.plan_remove(self.state()))
        self.assertFalse(self.state().exists())
        self.assertEqual((self.hs/'init.lua').read_text(),'-- existing settings\n')
    def test_update_then_remove_preserves_original(self):
        inst.apply_install(self.plan())
        package=Path(self.tmp.name)/'release'; (package/'candidate').mkdir(parents=True)
        for name in ('littleZen.uc.js','little-zen.css','little-zen-bridge.lua'):
            (package/'candidate'/name).write_text('new '+name)
        actions=inst.plan_update(self.state(),package)
        self.assertEqual(len(actions),3)
        inst.apply_update(self.state(),actions)
        self.assertEqual((self.hs/'little-zen-bridge.lua').read_text(),'new little-zen-bridge.lua')
        inst.apply_remove(self.state(),inst.plan_remove(self.state()))
        self.assertFalse((self.hs/'little-zen-bridge.lua').exists())
        self.assertEqual((self.hs/'init.lua').read_text(),'-- existing settings\n')
    def test_interrupted_update_can_resume(self):
        inst.apply_install(self.plan())
        package=Path(self.tmp.name)/'release'; (package/'candidate').mkdir(parents=True)
        for name in ('littleZen.uc.js','little-zen.css','little-zen-bridge.lua'):
            (package/'candidate'/name).write_text('new '+name)
        actions=inst.plan_update(self.state(),package)
        state=json.loads(self.state().read_text());state['phase']='updating';state['update_actions']=actions
        inst.atomic_write(self.state(),json.dumps(state).encode())
        inst.atomic_write(Path(actions[0]['path']),inst.decode(actions[0]['replacement']))
        inst.apply_update(self.state(),inst.plan_update(self.state(),package))
        self.assertEqual(json.loads(self.state().read_text())['phase'],'installed')
        inst.apply_remove(self.state(),inst.plan_remove(self.state()))
        self.assertFalse(self.state().exists())
    def test_zen_update_missing_loader_is_repairable(self):
        inst.apply_install(self.plan())
        loader=self.resources/'config.js'; expected=loader.read_bytes();loader.unlink()
        actions=inst.plan_update(self.state())
        self.assertTrue(any(a['path']==str(loader) and a['current'] is None for a in actions))
        inst.apply_update(self.state(),actions)
        self.assertEqual(loader.read_bytes(),expected)
    def test_changed_shared_loader_is_not_replaced(self):
        inst.apply_install(self.plan())
        loader=self.resources/'config.js';loader.write_text('different loader')
        with self.assertRaises(inst.Conflict): inst.plan_update(self.state())
        self.assertEqual(loader.read_text(),'different loader')

if __name__=='__main__': unittest.main()

class PreviewCommandTests(unittest.TestCase):
    def test_preview_only_discloses_paths_not_file_contents(self):
        import subprocess, sys
        with tempfile.TemporaryDirectory(prefix='littlezen-preview-fixture-') as t:
            root=Path(t); profile=root/'profile'; profile.mkdir()
            app=root/'Zen.app'; resources=app/'Contents/Resources'; resources.mkdir(parents=True)
            import plistlib
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'app.zen-browser.zen','CFBundleExecutable':'zen'}))
            (app/'Contents/MacOS').mkdir(); (app/'Contents/MacOS/zen').write_text('fixture')
            (profile/'user.js').write_text('// PRIVATE-MARKER\n')
            cli=Path(__file__).resolve().parents[1]/'installer/littlezen.py'
            result=subprocess.run([sys.executable,str(cli),'--profile',str(profile),'--zen-app',str(app)],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertNotIn('PRIVATE-MARKER',result.stdout)
            self.assertFalse((profile/'chrome').exists())
            self.assertFalse((resources/'config.js').exists())

class CommandLifecycleTests(unittest.TestCase):
    def test_fixture_install_update_remove(self):
        import subprocess, sys, plistlib
        with tempfile.TemporaryDirectory(prefix='littlezen-cli-fixture-') as t:
            root=Path(t); profile=root/'profile'; profile.mkdir()
            app=root/'Zen.app'; (app/'Contents/Resources').mkdir(parents=True)
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'app.zen-browser.zen','CFBundleExecutable':'zen','CFBundleShortVersionString':'fixture'}))
            (app/'Contents/MacOS').mkdir(); (app/'Contents/MacOS/zen').write_text('fixture')
            hs=root/'hammerspoon';hs.mkdir();(hs/'init.lua').write_text('-- keep\n')
            cli=Path(__file__).resolve().parents[1]/'installer/littlezen.py'
            base=[sys.executable,str(cli),'--profile',str(profile),'--zen-app',str(app)]
            # The sandbox blocks process inventory; keep the production guard intact and
            # mock only that OS check while exercising the actual CLI lifecycle.
            import contextlib, io
            from unittest import mock
            sys.path.insert(0,str(cli.parent))
            try:
                import littlezen as command
            finally:
                sys.path.pop(0)
            def run(*args):
                out,err=io.StringIO(),io.StringIO()
                with mock.patch.object(command,'ensure_stopped'), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    status=command.main(base[2:]+list(args))
                return type('Result',(),{'returncode':status,'stdout':out.getvalue(),'stderr':err.getvalue()})()
            refused=run('--apply','--hammerspoon',str(hs))
            self.assertEqual(refused.returncode,2); self.assertFalse((profile/'chrome').exists())
            preview=run('--hammerspoon',str(hs)); self.assertEqual(preview.returncode,0,preview.stderr)
            self.assertEqual(json.loads(preview.stdout)['mode'],'preview only; no changes made')
            installed=run('--apply','--ack-bundle-modification','--hammerspoon',str(hs))
            self.assertEqual(installed.returncode,0,installed.stderr)
            self.assertEqual(json.loads(installed.stdout)['mode'],'applied')
            updated=run('--action','update','--apply'); self.assertEqual(updated.returncode,0,updated.stderr)
            removed=run('--action','remove','--apply'); self.assertEqual(removed.returncode,0,removed.stderr)
            self.assertIn(str(app/'Contents/Resources/config.js'),json.loads(removed.stdout)['retained_shared_loader'])
            self.assertFalse((profile/'chrome/JS/littleZen.uc.js').exists())
            self.assertEqual((hs/'init.lua').read_text(),'-- keep\n')
            self.assertTrue((app/'Contents/Resources/config.js').exists())
    def test_reject_unrelated_application(self):
        import subprocess, sys, plistlib
        with tempfile.TemporaryDirectory(prefix='littlezen-not-zen-') as t:
            root=Path(t); profile=root/'profile';profile.mkdir()
            app=root/'Other.app';(app/'Contents/Resources').mkdir(parents=True)
            (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'other'}))
            cli=Path(__file__).resolve().parents[1]/'installer/littlezen.py'
            result=subprocess.run([sys.executable,str(cli),'--profile',str(profile),'--zen-app',str(app),'--apply'],capture_output=True,text=True)
            self.assertEqual(result.returncode,2);self.assertFalse((profile/'chrome').exists())
    def test_process_guard_identifies_selected_zen(self):
        import sys
        from unittest import mock
        cli_dir=Path(__file__).resolve().parents[1]/'installer';sys.path.insert(0,str(cli_dir))
        try: import littlezen as command
        finally: sys.path.pop(0)
        process=type('Process',(),{'stdout':'/Applications/Zen.app/Contents/MacOS/zen -contentproc\n'})()
        with mock.patch.object(command.subprocess,'run',return_value=process):
            with self.assertRaises(command.Conflict): command.ensure_stopped(Path('/Applications/Zen.app/Contents/MacOS/zen'))
            command.ensure_stopped(Path('/tmp/Test.app/Contents/MacOS/zen'))
