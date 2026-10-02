# Formal admission and exploratory evaluation

Execution readiness and grader calibration are independent gates. An execution probe requires no judge. Calibration grades imported known-answer fixtures and never invokes a target. Successful preflights create `admission.json` beside their saved evidence and return `receiptPath`.

Receipts expire after 24 hours. They bind the complete prepared configuration, its original execution plan hash or grading version, declared source hashes, the canonical evidence directory, the evidence file inventory, and the local one-eval runtime fingerprint. A different build, installed direct dependency version, Node version, operating system, or architecture requires another preflight. A copied evidence directory cannot reuse its original receipt. Transitive installed dependency versions are not fully fingerprinted.

Declared `${ENV:KEY}` references in target/provider/judge settings and command-grader `env` mappings are bound through one aggregate environment hash. Resolved values are never written into receipts or manifests. Changing a declared endpoint, model, credential, or command environment binding invalidates admission. Providers that implicitly read undeclared SDK environment variables remain outside this check; explicitly reference behavior-relevant variables in configuration. Dataset text is evaluated as data and is not scanned for environment placeholders.

Before admitting a formal run, resume, or grading operation, one-eval checks the current sources and runtime, verifies the retained evidence files, and reconstructs the relevant decision. Execution admission requires completed bounded probe cases, matching start reservations, successful isolation verification, and clean lifecycle state. Grading admission verifies the original positive and negative fixture anchors, imported answers and transcripts, every judge/repeat result, and all grading reservations. An edited `ok: true` field is insufficient.

Admission checks run at the operation boundary. A receipt expiring during an already admitted operation does not interrupt that operation; its next resume or grading invocation must pass admission again. Declared source files and environment bindings are checked before dispatching individual jobs, and each target trial still verifies isolation. Runtime fingerprint and receipt inventory checks are not continuous while an operation is active. Keep the implementation and dependency installation unchanged during a run.

## TypeScript API

```ts
const execution = await preparePlan('eval.json');
const probe = await probeExecution(execution, 'runs/readiness');
if (!probe.receiptPath) throw new Error('Execution probe failed');
await runFormalEvaluation(execution, 'runs/evaluation', probe.receiptPath);

const grading = await prepareGrading('judges.json');
const calibration = await calibrateGrading(grading, 'fixtures.json', 'runs/calibration');
if (!calibration.receiptPath) throw new Error('Grader calibration failed');
await gradeFormalEvaluation('runs/evaluation', grading, calibration.receiptPath);
```

The lower-level `runEvaluation` and `gradeEvaluation` APIs retain compatibility: a new operation with omitted `mode` is explicitly recorded as `exploratory`. Pass `{ mode: 'formal', receipt: receiptPath }` or use the formal wrappers to enforce admission. Admission is enforced inside these library entry points as well as through the CLI. Formal grading of exploratory execution remains two separate provenance claims; it does not promote the execution evidence.

Every actual target trial still runs adapter `verify`. A successful bounded probe cannot establish all-case, concurrent, remote-memory, or future-server isolation. Calibration results describe the supplied fixture set and graders. They do not establish general judge accuracy.

## Resume and renew

Formal execution resume and repeated grading revalidate the stored receipt automatically, including when a low-level caller omits options. An expired receipt blocks further evaluation and grading operations. Run a new probe or calibration in a new directory for the same prepared configuration, then pass its path explicitly:

```ts
await resumeEvaluation('runs/evaluation', { receipt: freshProbe.receiptPath });
await gradeEvaluation('runs/evaluation', grading, {
  mode: 'formal', receipt: freshCalibration.receiptPath,
});
```

Recovery may clean a blocked formal run after its receipt expires. It first verifies the original runtime, declared environment bindings and source files, so cleanup cannot silently target a different deployment. Recovery does not renew admission or authorize more evaluation calls. Subsequent formal resume still requires a valid receipt.

The previous admission record is appended to `admissionHistory`; previous evidence directories are retained. Completed work is reused. Renewal requires the original runtime fingerprint and declared environment bindings, as well as the same prepared configuration. A fresh receipt cannot mix a different runtime or deployment binding into an existing formal run or grading version; create a new run or grading version for changed behavior. An existing execution run or grading version cannot switch between exploratory and formal modes. Create a new run to obtain formal evidence after exploratory use. Historical manifests without an admission field remain readable and resumable and are labeled `legacy_unverified`.

Report admission fields describe the admission mode recorded when work was started. Reporting does not require current receipts to remain unexpired and does not revalidate admission against the current runtime, so completed historical evidence remains reportable after upgrades. These fields do not assert that a new operation would pass admission today.

Receipts provide integrity and misuse checks within a trusted local filesystem. They are unsigned and do not prove authenticity against an owner who deliberately rewrites all evidence. Remote service implementations, untracked transitive imports, and undeclared environment changes remain outside the fingerprint. Keep behavior-relevant files declared and preserve preflight evidence for the lifetime of formal runs.
