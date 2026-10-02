#!/usr/bin/env node
import { resolve } from 'node:path';

type Command = 'init' | 'validate' | 'probe' | 'calibrate' | 'run' | 'resume' | 'recover' | 'grade' | 'report' | 'compare';
type Parsed = { command: Command; path: string; options: Record<string, string | true> };

const help = {
  name: 'one-eval',
  description: 'Isolated execution and independent judging. Commands return JSON on stdout.',
  commands: {
    version: 'version',
    init: 'init <directory> --template offline|openai-compatible|http|managed [--endpoint URL] [--model NAME]',
    schema: 'schema',
    validate: 'validate <config> [--grading]',
    probe: 'probe <config> --out <directory> [--cases <count>]',
    calibrate: 'calibrate <fixtures.json> --config <judges.json> --out <directory>',
    run: 'run <config> --out <directory> [--mode formal|exploratory] [--preflight <receipt>]',
    resume: 'resume <directory> [--retry-errors] [--preflight <receipt>]',
    recover: 'recover <directory>',
    grade: 'grade <directory> --config <judges.json> [--retry-errors] [--mode formal|exploratory] [--calibration <receipt>]',
    report: 'report <directory> [--grading-version <hash>]',
    compare: 'compare <baseline-directory> --against <candidate-directory> [--baseline-grading-version <hash>] [--candidate-grading-version <hash>]',
  },
  examples: [
    'one-eval init evaluation --template offline',
    'one-eval schema',
    'one-eval validate examples/offline/eval.json',
    'one-eval probe examples/offline/eval.json --out runs/probe',
    'one-eval run examples/offline/eval.json --out runs/offline --preflight runs/probe/admission.json',
    'one-eval calibrate examples/offline/calibration.json --config examples/offline/judges.json --out runs/calibration',
    'one-eval grade runs/offline --config examples/offline/judges.json --calibration runs/calibration/admission.json',
    'one-eval report runs/offline',
  ],
};

const optionsByCommand: Record<Command, Record<string, 'value' | 'boolean'>> = {
  init: { '--template': 'value', '--endpoint': 'value', '--model': 'value' },
  validate: { '--grading': 'boolean' },
  probe: { '--out': 'value', '--cases': 'value' },
  calibrate: { '--config': 'value', '--out': 'value' },
  run: { '--out': 'value', '--mode': 'value', '--preflight': 'value' },
  resume: { '--retry-errors': 'boolean', '--preflight': 'value' },
  recover: {},
  grade: { '--config': 'value', '--retry-errors': 'boolean', '--mode': 'value', '--calibration': 'value' },
  report: { '--grading-version': 'value' },
  compare: { '--against': 'value', '--baseline-grading-version': 'value', '--candidate-grading-version': 'value' },
};

function parse(args: string[]): Parsed {
  const command = args[0];
  if (!command || !Object.hasOwn(optionsByCommand, command)) {
    throw new Error(`Unknown command: ${command ?? '(missing)'}. Run one-eval --help.`);
  }
  const allowed = optionsByCommand[command as Command];
  const options: Record<string, string | true> = {};
  let path: string | undefined;
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (argument.startsWith('-')) {
      const kind = allowed[argument];
      if (!kind) throw new Error(`Unknown option for ${command}: ${argument}`);
      if (Object.hasOwn(options, argument)) throw new Error(`Duplicate option: ${argument}`);
      if (kind === 'boolean') options[argument] = true;
      else {
        const value = args[++index];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
        options[argument] = value;
      }
    } else {
      if (path !== undefined) throw new Error(`Unexpected argument: ${argument}`);
      path = argument;
    }
  }
  if (!path) throw new Error(`Missing path. Usage: one-eval ${help.commands[command as Command]}`);
  const requiredOptions:Partial<Record<Command,string[]>>={init:['--template'],run:['--out'],probe:['--out'],grade:['--config'],calibrate:['--config','--out'],compare:['--against']};
  for (const required of requiredOptions[command as Command]??[]) {
    if (typeof options[required] !== 'string') throw new Error(`Missing required option: ${required}`);
  }
  if(options['--mode']!==undefined&&!['formal','exploratory'].includes(options['--mode'] as string))throw new Error('--mode must be formal or exploratory');
  if(options['--mode']==='exploratory'&&(options['--preflight']!==undefined||options['--calibration']!==undefined))throw new Error('Exploratory mode cannot also supply a formal admission receipt');
  return { command: command as Command, path: resolve(path), options };
}

function isIncomplete(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return result.ok === false || result.comparable === false || result.limitReached === true || result.blocked === true || result.overallIncomplete === true || result.complete === false ||
    ['failed', 'pending', 'errors', 'missing'].some((key) => typeof result[key] === 'number' && result[key] > 0);
}

async function main(args: string[]): Promise<{ value: unknown; exitCode: number }> {
  if (args.length === 0 || args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { value: help, exitCode: 0 };
  }
  if (args.length === 1 && ['version', '--version', '-v'].includes(args[0]!)) {
    const { getRuntimeProvenance } = await import('./provenance.js');
    return { value: { name: 'one-eval', ...await getRuntimeProvenance() }, exitCode: 0 };
  }
  if (args[0] === 'schema') {
    if (args.length === 2 && (args[1] === '--help' || args[1] === '-h')) {
      return { value: { command: 'schema', usage: 'schema' }, exitCode: 0 };
    }
    if (args.length !== 1) throw new Error('Usage: one-eval schema');
    const { getConfigSchemas } = await import('./config.js');
    const { getCalibrationFixturesSchema } = await import('./preflight.js');
    const { getAdmissionReceiptSchema } = await import('./admission.js');
    return { value: { ...getConfigSchemas(), calibration:getCalibrationFixturesSchema(), admission:getAdmissionReceiptSchema() }, exitCode: 0 };
  }
  if (args.length === 2 && (args[1] === '--help' || args[1] === '-h') && Object.hasOwn(optionsByCommand, args[0]!)) {
    return { value: { command: args[0], usage: help.commands[args[0] as Command] }, exitCode: 0 };
  }
  const { command, path, options } = parse(args);
  // Import after redirecting stdout, so dependency/provider diagnostics cannot mix with JSON.
  const api = await import('./index.js');
  let value: unknown;
  switch (command) {
    case 'init': {
      const template=options['--template'] as string;
      if(!['offline','openai-compatible','http','managed'].includes(template))throw new Error('Unknown starter template');
      value=await api.generateStarter({directory:path,template:template as 'offline'|'openai-compatible'|'http'|'managed',
        endpoint:options['--endpoint'] as string|undefined,model:options['--model'] as string|undefined});break;
    }
    case 'validate': {
      if(options['--grading']) {
        const prepared=await api.prepareGrading(path);
        value={valid:true,kind:'grading',gradingVersion:prepared.versionHash,judges:prepared.plan.judges.length,
          callsPerAnswer:prepared.plan.judges.reduce((sum,judge)=>sum+judge.repeats,0),files:prepared.files};
        break;
      }
      const prepared = await api.preparePlan(path);
      value = { valid: true, name: prepared.plan.name, planHash: prepared.planHash,
        cases: prepared.plan.cases.length, repeats: prepared.plan.execution.repeats,
        planned: prepared.plan.cases.length * prepared.plan.execution.repeats,
        files: prepared.files };
      break;
    }
    case 'probe': {
      const caseLimit=options['--cases']===undefined?undefined:Number(options['--cases']);
      if(caseLimit!==undefined&&(!Number.isInteger(caseLimit)||caseLimit<1||caseLimit>10))throw new Error('Probe --cases must be an integer from 1 to 10');
      value=await api.probeExecution(await api.preparePlan(path),resolve(options['--out'] as string),{caseLimit});break;
    }
    case 'calibrate': value=await api.calibrateGrading(await api.prepareGrading(resolve(options['--config'] as string)),path,resolve(options['--out'] as string));break;
    case 'run': value = await api.runEvaluation(await api.preparePlan(path), resolve(options['--out'] as string),
      {mode:(options['--mode']??'formal') as 'formal'|'exploratory',receipt:options['--preflight']===undefined?undefined:resolve(options['--preflight'] as string)}); break;
    case 'resume': value = await api.resumeEvaluation(path, { retryErrors: options['--retry-errors'] === true,
      receipt:options['--preflight']===undefined?undefined:resolve(options['--preflight'] as string) }); break;
    case 'recover': value = await api.recoverEvaluation(path); break;
    case 'grade': value = await api.gradeEvaluation(path, await api.prepareGrading(resolve(options['--config'] as string)),
      { retryErrors: options['--retry-errors'] === true, mode:(options['--mode']??'formal') as 'formal'|'exploratory',
        receipt:options['--calibration']===undefined?undefined:resolve(options['--calibration'] as string) }); break;
    case 'report': value = await api.buildReport(path, options['--grading-version'] as string | undefined); break;
    case 'compare': value=await api.compareRuns(path,resolve(options['--against'] as string),{
      baselineGradingVersion:options['--baseline-grading-version'] as string|undefined,candidateGradingVersion:options['--candidate-grading-version'] as string|undefined});break;
  }
  return { value, exitCode: isIncomplete(value) ? 1 : 0 };
}

// Reserve stdout for the single command response, even when an adapter logs to stdout.
const writeJson = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
try {
  const result = await main(process.argv.slice(2));
  writeJson(`${JSON.stringify(result.value)}\n`);
  process.exitCode = result.exitCode;
} catch (error) {
  const {classifyError}=await import('./diagnostics.js');
  const diagnostic=classifyError(error,'cli');
  const detail = { name:error instanceof Error?error.name:'Error', ...diagnostic };
  process.stderr.write(`${JSON.stringify({ error: detail })}\n`);
  process.exitCode = 1;
}
