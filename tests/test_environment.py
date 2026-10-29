import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/bootstrap.py'
SPEC = importlib.util.spec_from_file_location('k12_bootstrap', SCRIPT)
BOOTSTRAP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BOOTSTRAP)
CHILD = '''import importlib.util,json,pathlib,sys,time
s=importlib.util.spec_from_file_location('setup',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with m.configuration_lock(pathlib.Path(sys.argv[2])):
 start=time.monotonic();print(json.dumps({'entered':start}),flush=True);time.sleep(float(sys.argv[3]));print(json.dumps({'start':start,'end':time.monotonic()}),flush=True)
'''


class EnvironmentTests(unittest.TestCase):
    def launch(self, home, delay):
        return subprocess.Popen([sys.executable, '-c', CHILD, str(SCRIPT), str(home), str(delay)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_two_processes_do_not_configure_simultaneously(self):
        with tempfile.TemporaryDirectory() as home:
            children = [self.launch(home, 0.15) for _ in range(2)]
            ranges = []
            try:
                for child in children:
                    out, err = child.communicate(timeout=5)
                    self.assertEqual(child.returncode, 0, err)
                    ranges.append(json.loads(out.strip().splitlines()[-1]))
                ranges.sort(key=lambda r:r['start'])
                self.assertLessEqual(ranges[0]['end'], ranges[1]['start'])
            finally:
                for child in children:
                    if child.poll() is None:
                        child.kill()
                        child.wait()

    def test_interrupted_process_does_not_leave_a_stale_lock(self):
        with tempfile.TemporaryDirectory() as home:
            first = self.launch(home, 30)
            try:
                self.assertIn('entered', first.stdout.readline())
                first.terminate()
                first.communicate(timeout=3)
                second = self.launch(home, 0)
                out, err = second.communicate(timeout=3)
                self.assertEqual(second.returncode, 0, err)
                self.assertIn('end', out)
            finally:
                if first.poll() is None:
                    first.kill()
                    first.wait()

    def test_corrupt_cache_is_rebuilt_without_trusting_partial_state(self):
        with tempfile.TemporaryDirectory() as home:
            target = Path(home) / 'environment.json'
            for invalid in ['{"ready":true} EXTRA', '[1,2]', '{broken']:
                target.write_text(invalid)
                self.assertEqual(BOOTSTRAP.load_previous_state(target), {})
            target.write_text('{"ready":false}')
            self.assertEqual(BOOTSTRAP.load_previous_state(target), {'ready':False})


if __name__ == '__main__':
    unittest.main()
