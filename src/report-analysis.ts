import { classifyError } from './diagnostics.js';
import type { GradeRecord, JsonObject, TrialArtifact } from './types.js';

interface CaseResult {
  caseId: string; weight: number; complete: boolean; score: number | null; metadata?: JsonObject;
  executions: { complete: boolean; score: number | null; judges: { judgeId: string; score: number | null }[] }[];
}

/** Scale weights before summing so finite weights cannot overflow a convex mean. */
export function weightedMean(values: { score: number; weight: number }[]): number | null {
  if (!values.length) return null;
  let scale = 0; let directNumerator = 0; let directDenominator = 0;
  for (const value of values) {
    if (!Number.isFinite(value.score) || value.score < 0 || value.score > 1 || !Number.isFinite(value.weight) || value.weight <= 0) throw new Error('Weighted scores require finite scores from 0 to 1 and finite positive weights');
    scale = Math.max(scale, value.weight);
    directNumerator += value.score * value.weight;
    directDenominator += value.weight;
  }
  // Keep historical floating-point results for the ordinary, non-overflow path.
  if (Number.isFinite(directNumerator) && Number.isFinite(directDenominator) && directDenominator >= 2 ** -1022) return directNumerator / directDenominator;
  let numerator = 0; let denominator = 0;
  for (const value of values) { const weight = value.weight / scale; numerator += value.score * weight; denominator += weight; }
  return Math.max(0, Math.min(1, numerator / denominator));
}

function usageSummary(values: ({cost?:unknown;tokenUsage?:unknown}|undefined)[]) {
  const costs=values.flatMap(value=>typeof value?.cost==='number'&&Number.isFinite(value.cost)&&value.cost>=0?[value.cost]:[]);
  const tokens:Record<string,{knownTotal:number|null;knownRecords:number;overflow?:boolean}>=Object.create(null);
  for(const value of values) if(value?.tokenUsage&&typeof value.tokenUsage==='object'&&!Array.isArray(value.tokenUsage)) {
    for(const [key,count] of Object.entries(value.tokenUsage)) if(typeof count==='number'&&Number.isFinite(count)&&count>=0) {
      const entry=tokens[key]??={knownTotal:0,knownRecords:0};
      if(entry.knownTotal!==null){const total=entry.knownTotal+count;if(Number.isFinite(total))entry.knownTotal=total;else{entry.knownTotal=null;entry.overflow=true;}}
      entry.knownRecords++;
    }
  }
  const costTotal=costs.reduce((sum,cost)=>sum+cost,0);
  return {records:values.length,cost:{knownTotal:costs.length&&Number.isFinite(costTotal)?costTotal:null,knownRecords:costs.length,unknownRecords:values.length-costs.length,...(!Number.isFinite(costTotal)?{overflow:true}:{})},tokens};
}

export function analyzeReport(cases:CaseResult[],artifacts:TrialArtifact[],grades:GradeRecord[],planned:number,blocked:boolean) {
  const groups=new Map<string,{kind:string;label:string;cases:CaseResult[]}>();
  for(const item of cases) {
    const labels:{kind:string;label:string}[]=[];
    if(typeof item.metadata?.category==='string')labels.push({kind:'category',label:item.metadata.category});
    if(Array.isArray(item.metadata?.tags))for(const tag of new Set(item.metadata.tags))if(typeof tag==='string')labels.push({kind:'tag',label:tag});
    if(!labels.length)labels.push({kind:'uncategorized',label:'uncategorized'});
    for(const label of labels){const key=JSON.stringify([label.kind,label.label]);const group=groups.get(key)??{...label,cases:[]};group.cases.push(item);groups.set(key,group);}
  }
  const grouped=[...groups.values()].map(group=> {
    const complete=!blocked&&group.cases.every(item=>item.complete);
    return {kind:group.kind,label:group.label,caseIds:group.cases.map(item=>item.caseId),cases:group.cases.length,complete,
      score:complete?weightedMean(group.cases.map(item=>({score:item.score!,weight:item.weight}))):null};
  });
  const disagreements=cases.flatMap(item=>item.executions.flatMap((execution,repeat)=> {
    const values=execution.judges.filter(judge=>judge.score!==null);
    if(values.length<2)return [];
    const range=Math.max(...values.map(judge=>judge.score!))-Math.min(...values.map(judge=>judge.score!));
    return range>0?[{caseId:item.caseId,repeat,complete:execution.complete,range,judges:values.map(judge=>({judgeId:judge.judgeId,score:judge.score}))}]:[];
  })).sort((a,b)=>b.range-a.range);
  const unstable=cases.flatMap(item=> {
    const values=item.executions.flatMap(execution=>execution.score===null?[]:[execution.score]);
    const range=values.length>1?Math.max(...values)-Math.min(...values):0;
    return range>0?[{caseId:item.caseId,complete:item.complete,range,scores:item.executions.map(execution=>execution.score)}]:[];
  }).sort((a,b)=>b.range-a.range);
  const executionErrors:Record<string,number>=Object.create(null);
  const gradingErrors:Record<string,number>=Object.create(null);
  for(const artifact of artifacts)if(artifact.status!=='completed') {
    const diagnostic=artifact.diagnostic??artifact.cleanupDiagnostic??classifyError(artifact.error??artifact.cleanupError??artifact.status,'execution');
    executionErrors[diagnostic.code]=(executionErrors[diagnostic.code]??0)+1;
  }
  for(const grade of grades)if(grade.status==='grading_error') {
    const code=grade.diagnostic?.code??classifyError(grade.reason,'grading').code;
    gradingErrors[code]=(gradingErrors[code]??0)+1;
  }
  const firstCompleted=artifacts.filter(item=>item.attempt===1&&item.status==='completed').length;
  let attemptsWithoutCallEvidence=0;
  const targetUsage=artifacts.flatMap(item=> {
    const target=item.metadata?.target;
    if(target&&typeof target==='object'&&!Array.isArray(target)&&Array.isArray(target.calls)&&target.calls.length) {
      return target.calls.map(call=>call&&typeof call==='object'&&!Array.isArray(call)?{cost:call.cost,tokenUsage:call.tokenUsage}:undefined);
    }
    attemptsWithoutCallEvidence++;
    return [undefined];
  });
  return {
    groups:grouped,
    stability:{unstableCases:unstable,judgeDisagreements:disagreements,note:'Ranges describe observed scores; disagreement does not identify the correct judge. Repeats are correlated.'},
    reliability:{attempts:artifacts.length,firstAttemptCompleted:firstCompleted,plannedTrials:planned,
      firstAttemptCompletionRate:planned?firstCompleted/planned:null,retryAttempts:artifacts.filter(item=>item.attempt>1).length,
      failedAttempts:artifacts.filter(item=>item.status!=='completed').length,executionErrors,gradingAttempts:grades.length,gradingErrors},
    usage:{target:{...usageSummary(targetUsage),attemptsWithoutCallEvidence},grading:usageSummary(grades.map(grade=>grade.usage)),
      note:'Target records are per-call observations plus one unknown placeholder for each attempt without call evidence; they are not a count of all billed requests. Known totals include retained attempts. Missing usage stays unknown. Cached input is a subset of input. Target usage excludes simulator usage and unreported external work.'},
  };
}
