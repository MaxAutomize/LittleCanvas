const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const esbuild = require('esbuild');
process.env.CANVAS_BASE_URL = 'https://canvas.example';

const source = esbuild.transformSync(readFileSync(path.join(__dirname, 'index.ts'), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code;
let registered;
const paths = [];
const lecture = 'Lecture content '.repeat(80);
const extracted = 'PDF slide content '.repeat(300);
let binary = Buffer.from('fake-pdf');
let writtenLength = 0;
let chunkCalls = 0;
let postCalls = 0;
let failureMode;
const child = {
  execFileSync(_bin, args, options) {
    if (['pdftotext', 'python3', 'textutil'].includes(_bin)) return extracted;
    assert.equal(options.env.WEB_RUN_RETRIES, '1', 'uncertain mutations are never retried by the shim');
    if (args.at(-1) === 'url') return 'https://canvas.example/?pi_canvas_api=1';
    const encoded = args.at(-1).match(/atob\("([^"]+)"\)/)?.[1];
    assert.ok(encoded, 'expected authenticated background web-run');
    const guarded = Buffer.from(encoded, 'base64').toString('utf8');
    assert.match(guarded, /Canvas target origin changed/);
    assert.throws(() => vm.runInNewContext(guarded, {location:{origin:'https://not-canvas.example'}}), /origin changed/, 'a redirected tab must fail before operation execution');
    const js = JSON.parse(guarded.match(/return \(0,eval\)\((.*)\); \}\)\(\)$/)[1]);
    if (js.includes('window.__canvasAPI.post(')) {
      postCalls++;
      if (failureMode === 'transport') throw new Error('Lost browser response after dispatch');
      if (failureMode === 'undefined') return JSON.stringify({__ok:false,err:"Cannot read properties of undefined"});
    }
    if (js.includes('window.__canvasAPI ?')) return 'loaded';
    if (js.includes('overrideMimeType')) return JSON.stringify({length:binary.length});
    if (js.includes('delete window[')) return 'cleared';
    if (js.includes('Download buffer lost')) {
      const start = Number(js.match(/var i=(\d+)/)[1]);
      const end = Number(js.match(/Math.min\(t.length, (\d+)\)/)[1]);
      assert.ok(end-start <= 1024*1024, 'binary must cross web transport in bounded chunks');
      chunkCalls++;
      return JSON.stringify({b64:binary.subarray(start,end).toString('base64')});
    }
    return vm.runInNewContext(js, {window: {__canvasAPI: {get(p) {
      paths.push(p);
      if (p.includes('/files/')) return {url:'https://canvas.example/file.pdf', display_name:'lecture.pdf', 'content-type':'application/pdf'};
      return {title:'CNN lecture', html_url:'https://canvas.example/page', body:`<p>${lecture}</p><p>Next paragraph</p><a title="Slides" href="/courses/586119/files/7/download">Slides</a><iframe title="Video" src="https://video.example/embed"></iframe><img alt="Kernel illustration" src="/image.png">`};
    }}}});
  },
  execSync() { return extracted; },
};
const fakeFs = {existsSync:()=>true, mkdirSync(){}, mkdtempSync:()=>"/tmp/mock-private-attachment", rmSync(){}, readFileSync:()=>'{"target":"tab:1"}', unlinkSync(){}, writeFileSync(_path,data){writtenLength=data.length;}};
const moduleObject = {exports:{}};
vm.runInNewContext(source, {
  module:moduleObject, exports:moduleObject.exports, Buffer, process, URL, __dirname,
  require(name) {
    if (name === '@earendil-works/pi-ai') return {StringEnum:values=>({enum:values})};
    if (name === 'typebox') return {Type:{Object:x=>x,Optional:x=>x,Number:x=>x,String:x=>x,Boolean:x=>x}};
    if (name === '@earendil-works/pi-tui') return {Text:class {}};
    if (name === 'node:child_process') return child;
    if (name === 'node:fs' || name === 'fs') return fakeFs;
    return require(name);
  },
});
moduleObject.exports.default({registerTool:tool=>{registered=tool;}, registerCommand(){}});
(async()=>{
  assert.ok(registered.parameters.action.enum.includes('get_page'));
  const slug = "9-slash-30-let's-learn";
  const result = await registered.execute('test', {action:'get_page',courseId:586119,pageUrl:slug});
  assert.equal(result.isError, undefined);
  assert.equal(paths.at(-1), `/api/v1/courses/586119/pages/${encodeURIComponent(slug)}`);
  const text = result.content[0].text;
  assert.ok(text.includes(lecture), 'lecture body must not use short assignment-preview truncation');
  assert.ok(text.includes('\nNext paragraph\n'));
  assert.ok(text.includes('Slides (/courses/586119/files/7/download)'));
  assert.ok(text.includes('[Video] (https://video.example/embed)'));
  assert.ok(text.includes('[Kernel illustration] (/image.png)'));
  const missing = await registered.execute('test', {action:'get_page',courseId:586119});
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /pageUrl required/);
  const preview = await registered.execute('test', {action:'get_attachment_text',courseId:586119,fileId:7});
  assert.ok(preview.content[0].text.includes('[Truncated:'));
  assert.ok(!preview.content[0].text.includes(extracted));
  const full = await registered.execute('test', {action:'get_attachment_text',courseId:586119,fileId:7,fullText:true});
  assert.ok(full.content[0].text.includes(extracted.trim()), 'fullText must expose actual slide text beyond 1500 characters');
  binary = Buffer.alloc(21*1024*1024+17, 80);
  chunkCalls = 0;
  const large = await registered.execute('test', {action:'get_attachment_text',courseId:586119,fileId:7,fullText:true});
  assert.equal(large.isError, undefined);
  assert.equal(writtenLength, binary.length, 'attachments larger than old 20 MiB stdout buffer download completely');
  assert.equal(chunkCalls, 22);
  failureMode = 'transport';
  const uncertain = await registered.execute('write-transport', {action:'post_discussion',courseId:42,topicId:7,text:'fixture only'});
  assert.equal(uncertain.isError, true);
  assert.match(uncertain.content[0].text, /No automatic replay/);
  assert.equal(postCalls, 1, 'lost response must not create another POST');
  failureMode = 'undefined';
  const jsError = await registered.execute('write-js', {action:'post_discussion',courseId:42,topicId:7,text:'another fixture'});
  assert.equal(jsError.isError, true);
  assert.equal(postCalls, 2, 'generic undefined-property error is not pre-dispatch proof');
  console.log('Canvas mocked regressions passed: page paths/text/resources, attachment chunking, configured origin guard, and no mutation replay after transport/JS errors');
})().catch(error=>{console.error(error);process.exitCode=1;});
