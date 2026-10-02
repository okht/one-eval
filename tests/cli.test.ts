import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
interface CliResult { code: number | null; stdout: string; stderr: string }

function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(root, 'src', 'cli.ts'), ...args], {
      cwd: root, env: { ...process.env, ...extraEnv }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`CLI timed out: ${args.join(' ')}\n${stderr}`)); }, 90000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function response(result: CliResult, code = 0): Record<string, any> {
  assert.equal(result.code, code, result.stderr || result.stdout);
  // Parsing the complete stream catches diagnostics mixed with the response.
  return JSON.parse(result.stdout) as Record<string, any>;
}

test('CLI help is structured and invalid options fail on stderr', async () => {
  const help = response(await cli(['--help']));
  assert.equal(help.name, 'one-eval');
  assert.match(help.commands.grade, /--calibration/);
  assert.match(help.commands.run, /--mode formal\|exploratory/);
  const schemas = response(await cli(['schema']));
  assert.equal(schemas.execution.type, 'object');
  assert.equal(schemas.grading.type, 'object');
  assert.equal(schemas.calibration.type, 'object');
  assert.equal(schemas.execution.properties.version.const, 1);
  const invalid = await cli(['run', 'missing.json']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, '');
  assert.match(JSON.parse(invalid.stderr).error.message, /--out/);
  const unknown = await cli(['report', 'somewhere', '--unsupported']);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stdout, '');
  assert.match(JSON.parse(unknown.stderr).error.message, /Unknown option/);
  const invalidMode = await cli(['run', 'missing.json', '--out', 'unused', '--mode', 'trusted']);
  assert.match(JSON.parse(invalidMode.stderr).error.message, /--mode must/);
});

test('CLI version identifies the running implementation and installed dependency versions',async()=> {
  const version=response(await cli(['version']));
  const metadata=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(version.oneEvalVersion,metadata.version);assert.equal(version.nodeVersion,process.version);
  assert.match(version.implementationHash,/^[a-f0-9]{64}$/);assert.equal(version.dependencies.promptfoo,'0.123.1');
});

test('CLI defaults to formal admission and supports a complete generated offline workflow',{timeout:180000},async()=> {
  const directory=await mkdtemp(path.join(tmpdir(),'one-eval-cli-formal-'));
  const starter=path.join(directory,'starter');
  const generated=response(await cli(['init',starter,'--template','offline']));assert.equal(generated.template,'offline');
  const config=path.join(starter,'eval.json'),judges=path.join(starter,'judges.json'),answers=path.join(starter,'calibration.json');
  const run=path.join(directory,'formal');
  const rejected=await cli(['run',config,'--out',run]);assert.equal(rejected.code,1);assert.equal(rejected.stdout,'');
  assert.match(rejected.stderr,/receipt/i);
  const probe=response(await cli(['probe',config,'--out',path.join(directory,'probe')]));assert.equal(probe.ok,true);assert.ok(probe.receiptPath);
  const execution=response(await cli(['run',config,'--out',run,'--preflight',probe.receiptPath]));assert.equal(execution.mode,'formal');
  const gradeRejected=await cli(['grade',run,'--config',judges]);assert.equal(gradeRejected.code,1);assert.match(gradeRejected.stderr,/receipt/i);
  const calibration=response(await cli(['calibrate',answers,'--config',judges,'--out',path.join(directory,'calibration')]));assert.equal(calibration.ok,true);
  const graded=response(await cli(['grade',run,'--config',judges,'--calibration',calibration.receiptPath]));assert.equal(graded.mode,'formal');
  const report=response(await cli(['report',run]));assert.deepEqual(report.admission,{execution:'formal',grading:'formal'});assert.equal(report.overall,1);
  assert.match(report.runtime.execution.implementationHash,/^[a-f0-9]{64}$/);
  const downgrade=await cli(['grade',run,'--config',judges,'--mode','exploratory']);assert.equal(downgrade.code,1);assert.match(downgrade.stderr,/admission mode/i);
});

test('CLI probe and calibration are independent and failed known answers return nonzero', {timeout:180000}, async()=> {
  const directory=await mkdtemp(path.join(tmpdir(),'one-eval-cli-preflight-'));
  const fixtures=path.join(directory,'fixtures');await cp(path.join(root,'examples','offline'),fixtures,{recursive:true});
  const probe=response(await cli(['probe',path.join(fixtures,'eval.json'),'--out',path.join(directory,'probe'),'--cases','1']));
  assert.equal(probe.ok,true);assert.equal(probe.summary.completed,1);assert.equal(probe.kind,'execution_probe');
  const script=path.join(directory,'always-pass.mjs');await writeFile(script,`console.log(JSON.stringify({status:'scored',score:1,reason:'Always passes'}));`);
  const judges=path.join(directory,'judges.json');await writeFile(judges,JSON.stringify({version:1,judges:[{id:'j',kind:'command',command:process.execPath,args:[script]}]}));
  const validation=response(await cli(['validate',judges,'--grading']));assert.equal(validation.callsPerAnswer,1);
  const answers=path.join(directory,'answers.json');await writeFile(answers,JSON.stringify({version:1,fixtures:[
    {id:'a',label:'positive',input:'2 + 2',reference:'4',output:'4',expected:{status:'scored',minScore:1,maxScore:1}},
    {id:'b',label:'negative',input:'2 + 2',reference:'4',output:'5',expected:{status:'scored',minScore:0,maxScore:0}},
  ]}));
  const calibration=response(await cli(['calibrate',answers,'--config',judges,'--out',path.join(directory,'calibration')]),1);
  assert.equal(calibration.ok,false);assert.equal(calibration.mismatched,1);assert.equal(calibration.errors,0);
});

test('CLI runs isolated offline conversations and judges only saved artifacts', { timeout: 180000 }, async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'one-eval-cli-'));
  context.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('one-eval-cli-'));
    await rm(directory, { recursive: true, force: true });
  });
  const fixtures = path.join(directory, 'fixtures');
  await cp(path.join(root, 'examples', 'offline'), fixtures, { recursive: true });
  const configPath = path.join(fixtures, 'eval.json');
  const callLog = path.join(directory, 'calls.jsonl');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.target.config = { callLog };
  await writeFile(configPath, JSON.stringify(config));
  const targetPath = path.join(fixtures, 'target.mjs');
  await writeFile(targetPath, (await readFile(targetPath, 'utf8')).replace('const sessions = new Map();',
    'console.log("fixture diagnostic"); process.stdout.write("direct fixture diagnostic\\n"); const sessions = new Map();'));
  const runDirectory = path.join(directory, 'run');

  const validation = response(await cli(['validate', configPath]));
  assert.equal(validation.valid, true);
  assert.equal(validation.planned, 6);
  const execution = await cli(['run', configPath, '--out', runDirectory, '--mode', 'exploratory']);
  const summary = response(execution);
  assert.equal(summary.completed, 6);
  assert.equal(summary.failed, 0);
  assert.match(execution.stderr, /fixture diagnostic/);
  const calls = (await readFile(callLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(calls.length, 12);
  assert.equal(new Set(calls.map((call) => call.sessionId)).size, 6);
  const artifacts = await Promise.all((await readdir(path.join(runDirectory, 'artifacts'))).filter((file) => file.endsWith('.json'))
    .map(async (file) => JSON.parse(await readFile(path.join(runDirectory, 'artifacts', file), 'utf8'))));
  assert.equal(artifacts.length, 6);
  assert.ok(artifacts.every((artifact) => artifact.status === 'completed' && artifact.messages.length === 4));
  assert.equal(artifacts.filter((artifact) => artifact.stopReason === 'simulator_stop').length, 3);
  assert.equal(artifacts.filter((artifact) => artifact.stopReason === 'script_complete').length, 3);

  const resumed = response(await cli(['resume', runDirectory]));
  assert.equal(resumed.completed, 6);
  const beforeJudging = await readFile(callLog, 'utf8');
  assert.equal(beforeJudging.trim().split('\n').length, 12);
  const ungraded = response(await cli(['report', runDirectory]), 1);
  assert.equal(ungraded.complete, false);
  assert.equal(ungraded.overall, null);

  const noTarget = { ONE_EVAL_EXAMPLE_TARGET_DISABLED: '1' };
  const judgesPath = path.join(fixtures, 'judges.json');
  const grading = response(await cli(['grade', runDirectory, '--config', judgesPath, '--mode', 'exploratory'], noTarget));
  assert.equal(grading.planned, 36);
  assert.equal(grading.scored, 36);
  assert.equal(grading.errors, 0);
  const sameGrading = response(await cli(['grade', runDirectory, '--config', judgesPath, '--mode', 'exploratory'], noTarget));
  assert.equal(sameGrading.gradingVersion, grading.gradingVersion);
  assert.equal((await readdir(path.join(runDirectory, 'grades', grading.gradingVersion, 'records'))).length, 36);
  const report = response(await cli(['report', runDirectory, '--grading-version', grading.gradingVersion], noTarget));
  assert.equal(report.complete, true);
  assert.equal(report.overall, 1);
  assert.equal(report.gradeCoverage.expected, 36);
  assert.equal(report.gradeCoverage.scored, 36);

  const mockGrading = response(await cli(['grade', runDirectory, '--config', path.join(fixtures, 'judges-llm-mock.json'), '--mode', 'exploratory'], noTarget));
  assert.equal(mockGrading.scored, 18);
  assert.notEqual(mockGrading.gradingVersion, grading.gradingVersion);
  const ambiguous = await cli(['report', runDirectory], noTarget);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /Multiple grading versions/);
  assert.equal(await readFile(callLog, 'utf8'), beforeJudging);
});
