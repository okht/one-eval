import { appendFile, readFile, writeFile } from 'node:fs/promises';
export function createTarget(config) {
  const sessions=new Map();
  async function log(event,context) {
    await appendFile(config.log,JSON.stringify({event,...context,signal:undefined})+'\n');
  }
  return {
    async prepare(context) {await log('prepare',context);sessions.set(context.sessionId,0);return context.sessionId;},
    async verify(session,context) {await log('verify',context);return {ok:config.verify!==false && sessions.get(session)===0,evidence:'Fresh local state verified'};},
    async execute(messages,session,context) {
      await log('execute',context);
      const count=sessions.get(session)+1;sessions.set(session,count);
      if(config.delayMs) await new Promise(resolve=>setTimeout(resolve,config.delayMs));
      context.signal.throwIfAborted();
      if(config.errorCase===context.caseId && context.attempt===1) throw new Error('Deliberate target failure');
      if(config.failTurn===count) throw new Error('Deliberate turn failure');
      return {output:config.empty?'':`${context.caseId}:${count}`,metadata:{history:messages.length,count}};
    },
    async cleanup(session,context) {
      await log('cleanup',context);sessions.delete(session);
      if(config.cleanupControl && (await readFile(config.cleanupControl,'utf8'))==='fail') throw new Error('Deliberate cleanup failure');
    },
    async recover(context) {
      sessions.clear();
      if(config.cleanupControl) await writeFile(config.cleanupControl,'ok');
      return {ok:true,evidence:'Local fixture state reset and control file restored'};
    },
    async close(){if(config.closeControl && (await readFile(config.closeControl,'utf8'))==='fail')throw new Error('Deliberate close failure');}
  };
}
