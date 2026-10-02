import { buildReport } from './report.js';

export async function compareRuns(baselineDirectory:string,candidateDirectory:string,options:{baselineGradingVersion?:string;candidateGradingVersion?:string}={}) {
  // Read sequentially so comparing one run against itself does not contend for its lock.
  const baseline=await buildReport(baselineDirectory,options.baselineGradingVersion);
  const candidate=await buildReport(candidateDirectory,options.candidateGradingVersion);
  const oldCases=new Map(baseline.cases.map(item=>[item.caseId,item]));
  const newCases=new Map(candidate.cases.map(item=>[item.caseId,item]));
  const removed=[...oldCases.keys()].filter(id=>!newCases.has(id));
  const added=[...newCases.keys()].filter(id=>!oldCases.has(id));
  const changed=[...oldCases.values()].filter(item=>newCases.has(item.caseId)&&(item.inputHash!==newCases.get(item.caseId)!.inputHash||item.weight!==newCases.get(item.caseId)!.weight)).map(item=>item.caseId);
  const sameCases=!removed.length&&!added.length&&!changed.length;
  const sameGrading=baseline.gradingVersion!==null&&baseline.gradingVersion===candidate.gradingVersion;
  const comparable=baseline.complete&&candidate.complete&&sameCases&&sameGrading;
  const cases=[...newCases.values()].map(item=> {
    const previous=oldCases.get(item.caseId);
    const compatible=baseline.complete&&candidate.complete&&!!previous&&previous.inputHash===item.inputHash&&previous.weight===item.weight&&sameGrading;
    return {caseId:item.caseId,compatible,baseline:previous?.score??null,candidate:item.score,
      delta:compatible&&previous?.score!==null&&previous?.score!==undefined&&item.score!==null?item.score-previous.score:null};
  });
  return {version:1,kind:'run_comparison',complete:baseline.complete&&candidate.complete,comparable,
    baseline:{runId:baseline.runId,gradingVersion:baseline.gradingVersion,score:baseline.overall},
    candidate:{runId:candidate.runId,gradingVersion:candidate.gradingVersion,score:candidate.overall},
    checks:{sameCases,sameGrading,added,removed,changed},
    delta:comparable?candidate.overall!-baseline.overall!:null,
    improvements:cases.filter(item=>item.delta!==null&&item.delta>0).length,
    regressions:cases.filter(item=>item.delta!==null&&item.delta<0).length,cases,
    note:'Deltas require matching case inputs/references/metadata/weights and the same grading version. They are descriptive differences, not significance tests. Reads are sequential snapshots; compare finished runs.'};
}
