import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareGrading } from '../../src/config.ts';
import { calibrateGrading } from '../../src/preflight.ts';

const data = path.resolve(process.argv[2]);
const directory = path.resolve(process.argv[3]);
const resultFile = path.resolve(process.argv[4]);
const result = await calibrateGrading(await prepareGrading(path.join(data, 'judges.json')), path.join(data, 'calibration.json'), directory);
await mkdir(path.dirname(resultFile), { recursive: true });
await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify(result));
process.exitCode = result.ok ? 0 : 1;
