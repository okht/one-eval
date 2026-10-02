import path from 'node:path';
import os from 'node:os';
import type { ApiProvider } from 'promptfoo';
import type { ProviderSpec, SourceFile } from './types.js';

export const ENGINE_VERSION='0.123.1';
let sdkPromise:Promise<typeof import('promptfoo')>|undefined;
const loadedSources=new Map<string,string>();
export function guardLoadedSources(files:SourceFile[]) {
  for(const file of files) {
    if(loadedSources.has(file.path) && loadedSources.get(file.path)!==file.sha256) {
      throw new Error(`A loaded source changed: ${file.path}. Start a fresh process to avoid cached module dependencies.`);
    }
  }
  for(const file of files) loadedSources.set(file.path,file.sha256);
}
async function sdk() {
  if (!sdkPromise) {
    process.env.PROMPTFOO_DISABLE_TELEMETRY='true';
    process.env.PROMPTFOO_CACHE_ENABLED='false';
    process.env.PROMPTFOO_DISABLE_UPDATE='true';
    process.env.PROMPTFOO_LOG_LEVEL='error';
    process.env.PROMPTFOO_LOG_TO_STDERR='true';
    process.env.PROMPTFOO_CONFIG_DIR ??= path.join(os.tmpdir(),'one-eval-promptfoo');
    sdkPromise=import('promptfoo');
  }
  return sdkPromise;
}
function resolveEnvironment(value:unknown):unknown {
  if (typeof value==='string') return value.replace(/\$\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,key:string)=> {
    const found=process.env[key];if(found===undefined) throw new Error(`Missing environment variable: ${key}`);return found;
  });
  if (Array.isArray(value)) return value.map(resolveEnvironment);
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolveEnvironment(item)]));
  return value;
}
export async function loadProvider(spec:ProviderSpec,baseDir:string):Promise<ApiProvider> {
  const {loadApiProvider}=await sdk();
  const descriptor=typeof spec==='string'?{id:spec}:spec;
  // Disable SDK retries where the selected provider supports this option.
  // Custom providers must themselves honor the adapter's retry contract.
  return loadApiProvider(descriptor.id,{basePath:baseDir,options:{id:descriptor.id,config:{...resolveEnvironment(descriptor.config??{}) as object,maxRetries:0}}});
}
export async function schedule<T>(items:T[],concurrency:number,perform:(item:T)=>Promise<void>):Promise<void> {
  if (!items.length) return;
  const {evaluate}=await sdk();
  let failure:unknown;
  const invoked=new Set<number>();
  const provider:ApiProvider={id:()=> 'one-eval-batch',config:{maxRetries:0},async callApi(_prompt,context) {
    const index=Number(context?.vars.index);
    if (failure) return {error:'Batch stopped after a storage or orchestration error'};
    if (!Number.isInteger(index) || !items[index] || invoked.has(index)) {
      failure=new Error('Unexpected or repeated scheduler invocation');return {error:'Invalid scheduler invocation'};
    }
    invoked.add(index);
    try {await perform(items[index]!);return {output:'recorded'};}
    catch(error) {failure=error;return {error:error instanceof Error?error.message:String(error)};}
  }};
  await evaluate({prompts:['{{index}}'],providers:[provider],tests:items.map((_,index)=>({vars:{index}})),writeLatestResults:false,sharing:false},
    {maxConcurrency:concurrency,cache:false,repeat:1,showProgressBar:false,silent:true});
  if (failure) throw failure;
  if (invoked.size!==items.length) throw new Error(`Scheduler only processed ${invoked.size}/${items.length} items`);
}
