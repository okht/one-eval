import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hash, fileHash, readJson } from './storage.js';
import type { ExecutionPlan, GradingPlan, PreparedPlan, PreparedGrading, ProviderSpec, SourceFile } from './types.js';

const object = z.record(z.string(), z.json());
const provider = z.union([z.string().min(1), z.object({id:z.string().min(1),config:object.optional()}).strict()]);
const positive = z.number().int().positive();
const timeout = positive.max(3_600_000).default(60_000);
const count = positive.max(10_000).default(1);
const executionLimits = { maxAttempts: positive.max(1_000_000).optional(), minIntervalMs: z.number().int().min(0).max(60_000).optional() };
const conversation = z.discriminatedUnion('mode', [
  z.object({mode:z.literal('scripted'),turns:z.array(z.string()).min(1)}).strict(),
  z.object({mode:z.literal('simulated'),goal:z.string().min(1),facts:object.optional(),constraints:z.array(z.string()).optional(),provider,maxTurns:positive.max(100).default(10)}).strict(),
]);
const evalCase = z.object({id:z.string().min(1),input:z.string(),reference:z.json().optional(),metadata:object.optional(),weight:z.number().positive().default(1),conversation:conversation.optional()}).strict();
const target = z.object({kind:z.enum(['provider','module']),provider:provider.optional(),path:z.string().optional(),config:object.optional(),
  isolation:z.object({mode:z.enum(['stateless','managed']),scope:z.enum(['independent','shared']),evidence:z.string().trim().min(1)}).strict(),retrySafe:z.boolean().default(false),
}).strict().superRefine((target, ctx) => {
  if (target.kind === 'module' && (!target.path || target.provider)) ctx.addIssue({code:'custom', message:'Module targets require path and cannot set provider'});
  if (target.kind === 'provider' && (!target.provider || target.path || target.isolation.mode !== 'stateless')) ctx.addIssue({code:'custom',message:'Provider targets require provider and stateless isolation; use a module for managed state'});
});
const executionSchema = z.object({version:z.literal(1),name:z.string().min(1),cases:z.union([z.string().min(1),z.array(evalCase).min(1)]),target,
  execution:z.object({repeats:count,concurrency:positive.max(100).default(1),timeoutMs:timeout,...executionLimits}).strict().default({repeats:1,concurrency:1,timeoutMs:60000}),
  files:z.array(z.string()).default([]),
}).strict();
const judge = z.object({id:z.string().min(1),kind:z.enum(['llm','command']),repeats:count,weight:z.number().positive().default(1),
  provider:provider.optional(),prompt:z.string().optional(),command:z.string().optional(),args:z.array(z.string()).optional(),env:z.record(z.string(),z.string()).optional(),cwd:z.string().optional(),
}).strict().superRefine((judge, ctx) => {
  if (judge.kind === 'llm' && (!judge.provider || !judge.prompt || judge.command)) ctx.addIssue({code:'custom',message:'LLM judges require provider and prompt'});
  if (judge.kind === 'command' && (!judge.command || judge.provider)) ctx.addIssue({code:'custom',message:'Command judges require command and cannot set provider'});
});
const gradingSchema = z.object({version:z.literal(1),judges:z.array(judge).min(1),concurrency:positive.max(100).default(1),timeoutMs:timeout,...executionLimits,maxCost:z.number().finite().positive().optional(),files:z.array(z.string()).default([])}).strict();

export function getConfigSchemas() {
  return {
    execution:z.toJSONSchema(executionSchema,{io:'input'}),
    grading:z.toJSONSchema(gradingSchema,{io:'input'}),
    note:'Schemas describe input fields. validate also checks source files, unique IDs, shared-state concurrency and target/judge cross-field constraints.',
  };
}

function uniqueIds(items: {id:string}[], label: string) {
  if (new Set(items.map(item=>item.id)).size !== items.length) throw new Error(`Duplicate ${label} IDs`);
}
function sourceCollector(baseDir: string) {
  const paths = new Set<string>();
  const add = (file:string) => {const resolved=path.resolve(baseDir,file);paths.add(resolved);return resolved;};
  const trackProvider = (spec:ProviderSpec): ProviderSpec => {
    const id=typeof spec==='string'?spec:spec.id;
    if (id.startsWith('file://')) {
      const absolute=add(id.slice(7));
      return typeof spec==='string'?`file://${absolute}`:{...spec,id:`file://${absolute}`};
    }
    return spec;
  };
  const finish = async ():Promise<SourceFile[]> => Promise.all([...paths].sort().map(async file=>({path:file,sha256:await fileHash(file)})));
  return {add,trackProvider,finish};
}
export async function preparePlan(configPath:string):Promise<PreparedPlan> {
  const absolute=path.resolve(configPath), baseDir=path.dirname(absolute);
  const config=executionSchema.parse(await readJson<unknown>(absolute));
  const sources=sourceCollector(baseDir);sources.add(absolute);config.files.forEach(sources.add);
  let cases;
  if (typeof config.cases==='string') {
    const file=sources.add(config.cases);
    const data=await readFile(file,'utf8');
    cases=z.array(evalCase).min(1).parse(file.endsWith('.jsonl') ? data.replace(/^\uFEFF/,'').split(/\r?\n/).filter(line=>line.trim()).map(line=>JSON.parse(line)) : JSON.parse(data.replace(/^\uFEFF/,'')));
  } else cases=config.cases;
  uniqueIds(cases,'case');
  if (cases.length*config.execution.repeats>1_000_000) throw new Error('Execution plan exceeds 1,000,000 trials; split the dataset');
  if (config.target.kind==='module') config.target.path=sources.add(config.target.path!);
  if (config.target.provider) config.target.provider=sources.trackProvider(config.target.provider);
  for (const item of cases) if (item.conversation?.mode==='simulated') item.conversation.provider=sources.trackProvider(item.conversation.provider);
  if (config.target.isolation.scope==='shared' && config.execution.concurrency!==1) throw new Error('Shared environments require execution.concurrency=1');
  const plan:ExecutionPlan={version:1,name:config.name,cases,target:config.target,execution:config.execution};
  const files=await sources.finish();
  return {plan,files,baseDir,planHash:hash({plan,files})};
}
export async function prepareGrading(configPath:string):Promise<PreparedGrading> {
  const absolute=path.resolve(configPath),baseDir=path.dirname(absolute);
  const config=gradingSchema.parse(await readJson<unknown>(absolute));
  const sources=sourceCollector(baseDir);sources.add(absolute);config.files.forEach(sources.add);
  uniqueIds(config.judges,'judge');
  for (const item of config.judges) {
    if (item.provider) item.provider=sources.trackProvider(item.provider);
    if (item.cwd) item.cwd=path.resolve(baseDir,item.cwd);
    if (item.command?.includes('/') || item.command?.includes('\\')) item.command=sources.add(item.command);
    if (item.args) item.args=await Promise.all(item.args.map(async arg=> {
      const candidate=path.resolve(baseDir,arg);
      try {if ((await stat(candidate)).isFile()) return sources.add(arg);}catch(error){if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
      return arg;
    }));
  }
  const plan:GradingPlan={version:1,judges:config.judges,concurrency:config.concurrency,timeoutMs:config.timeoutMs,
    ...(config.maxAttempts===undefined?{}:{maxAttempts:config.maxAttempts}),
    ...(config.minIntervalMs===undefined?{}:{minIntervalMs:config.minIntervalMs}),
    ...(config.maxCost===undefined?{}:{maxCost:config.maxCost})};
  const files=await sources.finish();
  return {plan,files,baseDir,versionHash:hash({plan,files})};
}
