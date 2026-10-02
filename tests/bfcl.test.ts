import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const prepared = path.join(root, 'data/expanded-20261002-bfcl');
const grader = path.join(root, 'examples/benchmarks/bfcl/grade.py');
const localPython = path.join(root, '.venv-benchmarks', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.ONE_EVAL_TEST_PYTHON ?? (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python.exe' : 'python3');
const probe = spawnSync(python, ['--version'], { encoding: 'utf8', windowsHide: true });
const pythonSkip = probe.status === 0 ? false : 'Python >=3.10 is required for BFCL adapter tests.';
const preparedSkip = pythonSkip || (!existsSync(path.join(prepared, 'bfcl.cases.jsonl')) && 'Run node examples/benchmarks/bfcl/prepare.mjs to fetch the pinned BFCL assets.');
function pythonCode(code: string, input?: unknown) {
  const result = spawnSync(python, ['-B', '-c', code, grader, prepared], {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}
const loadGrader = `import importlib.util,json,sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('bfcl_adapter',sys.argv[1])\nm=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(m)\n`;

test('BFCL strict JSON protocol rejects malformed and ambiguous outputs', { skip: pythonSkip }, () => {
  const outputs = ['[]', '[{"function":"math.f","parameters":{"x":2}}]', 'not JSON', '```json\n[]\n```', '{}', '[{}]',
    '[{"function":"f","parameters":{},"extra":1}]', '[{"function":"f","parameters":{"x":NaN}}]',
    '[{"function":"f","function":"g","parameters":{}}]'];
  const values = pythonCode(loadGrader + 'print(json.dumps([m.strict_protocol(x)[0] for x in json.load(sys.stdin)]))', outputs);
  assert.deepEqual(values, [true, true, false, false, false, false, false, false, false]);
});

test('BFCL preparation preserves fixed source rows, stratified sample, and provenance hashes', { skip: preparedSkip }, async () => {
  const provenance = JSON.parse(await readFile(path.join(prepared, 'provenance.json'), 'utf8'));
  const cases = (await readFile(path.join(prepared, 'bfcl.cases.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(cases.length, 40);
  const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  for (const asset of provenance.assets) assert.equal(digest(await readFile(path.join(prepared, asset.path))), asset.sha256, asset.path);
  for (const [category, count] of [['simple_python', 15], ['multiple', 15], ['irrelevance', 10]] as const) {
    const rows = (await readFile(path.join(prepared, `upstream/data/BFCL_v4_${category}.json`), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
    const selected = rows.map((row, index) => ({ row, index, rank: digest(`${provenance.seed}:${category}:${row.id}`) }))
      .sort((a, b) => a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0).slice(0, count).sort((a, b) => a.index - b.index);
    const subset = cases.filter(item => item.reference.category === category);
    assert.equal(subset.length, count);
    assert.deepEqual(subset.map(item => item.reference.source), selected.map(item => item.row));
    for (const item of subset) {
      assert.ok(item.input.includes(JSON.stringify(item.reference.source.function)));
      assert.ok(item.input.endsWith(item.reference.source.question[0].map((message: {content: string}) => message.content).join('\n\n')));
      assert.ok(!item.input.includes('ground_truth'));
      if (item.reference.answerJson) assert.equal(JSON.parse(item.reference.answerJson).id, item.reference.source.id);
    }
  }
});

test('BFCL original checker accepts selected official answers and rejects opposite calls', { skip: preparedSkip }, () => {
  const results = pythonCode(loadGrader + `
root=Path(sys.argv[2])
cases=[json.loads(line) for line in (root/'bfcl.cases.jsonl').read_text(encoding='utf-8').splitlines()]
results=[]
def concrete(value):
    if isinstance(value,dict):
        return {key:concrete(options[0]) for key,options in value.items() if options[0]!=''}
    if isinstance(value,list):
        return [concrete(item) for item in value]
    return value
for case in cases:
    reference=case['reference']
    if reference['category']=='irrelevance':
        positive='[]'
        negative=json.dumps([{'function':reference['source']['function'][0]['name'],'parameters':{}}])
    else:
        answers=json.loads(reference['answerJson'])['ground_truth']
        calls=[]
        for answer in answers:
            name,options=next(iter(answer.items()))
            calls.append({'function':name,'parameters':concrete(options)})
        positive=json.dumps(calls)
        negative='[]'
    good=m.grade({'case':case,'artifact':{'output':positive}},str(root/'upstream'))
    bad=m.grade({'case':case,'artifact':{'output':negative}},str(root/'upstream'))
    results.append({'id':case['id'],'good':good['score'],'bad':bad['score'],'reason':good['reason']})
print(json.dumps(results))
`);
  assert.equal(results.length, 40);
  for (const result of results) {
    assert.equal(result.good, 1, `${result.id}: ${result.reason}`);
    assert.equal(result.bad, 0, result.id);
  }
});

test('BFCL malformed JSON stays zero despite permissive official irrelevance logic', { skip: preparedSkip }, () => {
  const results = pythonCode(loadGrader + `
root=Path(sys.argv[2])
cases=[json.loads(line) for line in (root/'bfcl.cases.jsonl').read_text(encoding='utf-8').splitlines()]
case=next(case for case in cases if case['reference']['category']=='irrelevance')
print(json.dumps([m.grade({'case':case,'artifact':{'output':output}},str(root/'upstream')) for output in ['not JSON','{}','[{}]','[]']]))
`);
  assert.deepEqual(results.map((row: {score: number}) => row.score), [0, 0, 0, 1]);
  for (const row of results) assert.equal(JSON.parse(row.reason).official_valid, true);
});

test('BFCL original parameter checker enforces function, required fields, types and allowed optional values', { skip: preparedSkip }, () => {
  const results = pythonCode(loadGrader + `
root=Path(sys.argv[2])
source=json.loads((root/'upstream/data/BFCL_v4_simple_python.json').read_text(encoding='utf-8').splitlines()[0])
answer_line=(root/'upstream/data/possible_answer/BFCL_v4_simple_python.json').read_text(encoding='utf-8').splitlines()[0]
case={'reference':{'category':'simple_python','source':source,'answerJson':answer_line,'revision':m.REVISION}}
name=source['function'][0]['name']
calls=[
    {'function':name,'parameters':{'base':10,'height':5}},
    {'function':name,'parameters':{'base':10,'height':5,'unit':'units'}},
    {'function':'wrong_function','parameters':{'base':10,'height':5}},
    {'function':name,'parameters':{'base':10}},
    {'function':name,'parameters':{'base':'10','height':5}},
    {'function':name,'parameters':{'base':10,'height':5,'invented':1}},
    {'function':name,'parameters':{'base':10,'height':5,'unit':'miles'}},
]
print(json.dumps([m.grade({'case':case,'artifact':{'output':json.dumps([call])}},str(root/'upstream'))['score'] for call in calls]))
`);
  assert.deepEqual(results, [1, 1, 0, 0, 0, 0, 0]);
});

test('BFCL command protocol emits one GradeValue and keeps invalid references as grader errors', { skip: preparedSkip }, async () => {
  const cases = (await readFile(path.join(prepared, 'bfcl.cases.jsonl'), 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line));
  const sample = cases.find(item => item.reference.category === 'irrelevance');
  const invoke = (input: unknown) => spawnSync(python, ['-B', grader, path.join(prepared, 'upstream')], { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const result = invoke({ case: sample, artifact: { output: '[]' } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).score, 1);
  const broken = structuredClone(sample);
  broken.reference.revision = 'wrong-revision';
  const error = invoke({ case: broken, artifact: { output: '[]' } });
  assert.notEqual(error.status, 0);
  assert.equal(error.stdout, '');
  assert.match(error.stderr, /revision/);
});

test('BFCL command preserves UTF-8 function arguments and identifiers under a GBK locale', { skip: preparedSkip }, () => {
  const text = '中文测试😀：「双引号 \\"」与单引号\'和换行\n结束';
  const id = `simple_python_${text}`;
  // Keep the independently expected answer ASCII-escaped, so a shared bad
  // stdin decoder cannot corrupt both the expected and actual values equally.
  const answerJson = JSON.stringify({ id, ground_truth: [{ echo: { text: [text] } }] })
    .replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const reference = {
    revision: 'f7cf7359b7ac615a0b294831c5ba2bc95ee4a000', category: 'simple_python', answerJson,
    source: { id, question: [[{ role: 'user', content: text }]], function: [{ name: 'echo', description: 'Echo the exact text.',
      parameters: { type: 'dict', properties: { text: { type: 'string', description: 'Exact text.' } }, required: ['text'] } }] },
  };
  const output = JSON.stringify([{ function: 'echo', parameters: { text } }]);
  const result = spawnSync(python, ['-B', grader, path.join(prepared, 'upstream')], {
    input: JSON.stringify({ case: { reference }, artifact: { output } }), encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, PYTHONIOENCODING: 'gbk' },
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.status, 'scored');
  assert.equal(value.score, 1, value.reason);
  const reason = JSON.parse(value.reason);
  assert.equal(reason.source_id, id);
  assert.equal(reason.protocol_valid, true);
  assert.equal(reason.official_valid, true);
});
