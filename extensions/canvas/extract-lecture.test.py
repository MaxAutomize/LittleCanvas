import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('extractor', pathlib.Path(__file__).with_name('extract-lecture.py'))
extractor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extractor)

class LectureExtractionTests(unittest.TestCase):
    def test_zip_notebook_is_data_and_paths_are_not_extracted(self):
        with tempfile.TemporaryDirectory() as temp:
            path = pathlib.Path(temp)/'slides.zip'
            marker = pathlib.Path(temp)/'executed'
            code = f"open({str(marker)!r}, 'w').write('bad')"
            nb = {'cells':[{'cell_type':'markdown','source':['# Convolution']},{'cell_type':'code','source':[code],'outputs':[{'data':{'text/plain':['torch.Size([1, 8, 28, 28])']}}]}]}
            with zipfile.ZipFile(path,'w') as z:
                z.writestr('../../danger.ipynb',json.dumps(nb))
                z.writestr('__MACOSX/._hidden.ipynb','not json')
                z.writestr('figure.png',b'not text')
            text = extractor.read_lecture(path)
            self.assertIn('# Convolution',text)
            self.assertIn(code,text)
            self.assertIn('torch.Size',text)
            self.assertNotIn('__MACOSX',text)
            self.assertFalse(marker.exists())
            self.assertEqual(sorted(p.name for p in pathlib.Path(temp).iterdir()),['slides.zip'])
    def test_html_never_executes_scripts(self):
        text = extractor.extract('slides.html',b'<h1>CNN</h1><script>danger()</script><p>Kernel</p><img alt="3x3 filter">')
        self.assertIn('CNN',text)
        self.assertIn('Kernel',text)
        self.assertIn('[Image: 3x3 filter]',text)
        self.assertNotIn('danger',text)

if __name__ == '__main__': unittest.main()
