import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const demoCwd = path.join(process.env.PUBLIC || os.tmpdir(), 'relaydeck-demo');
fs.mkdirSync(demoCwd, { recursive: true });
const threads = new Map([['thread-demo', { id: 'thread-demo', name: '为项目添加深色模式', cwd: demoCwd, preview: '为项目添加深色模式', modelProvider: 'custom', model: 'test-model', source: 'appServer', updatedAt: Math.floor(Date.now()/1000), status: { type: 'idle' }, turns: [{ id: 'turn-old', status: 'completed', items: [{ id: 'u-old', type: 'userMessage', content: [{ type: 'text', text: '请检查移动端页面的布局。' }] }, { id: 'a-old', type: 'agentMessage', text: '布局检查完成。\n\n- 页面已适配手机宽度\n- 输入框保持可见\n- 任务在本地执行\n\n```js\nconst status = "ready";\n```' }] }] }]]);
const write = msg => process.stdout.write(JSON.stringify(msg)+'\n');
const notify = (method,params) => write({method,params});
let seq=0; const timers=new Map(); const approvals=new Map(); const loaded=new Set(); const externalOwners=new Set();
const models=[
  {model:'test-model',displayName:'测试模型',description:'用于自动化验证',supportedReasoningEfforts:[{reasoningEffort:'low',description:'快速回答'},{reasoningEffort:'high',description:'深入推理'}],defaultReasoningEffort:'low',serviceTiers:[{id:'priority',name:'Fast',description:'更快'}]},
  {model:'test-reasoner',displayName:'深度模型',description:'用于推理选项验证',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'均衡'},{reasoningEffort:'xhigh',description:'复杂任务'}],defaultReasoningEffort:'medium',serviceTiers:[]}
];
let lastTurnParams=null;
function finish(thread, turn, text) {
  if (turn.status !== 'inProgress') return;
  const item={id:`a-${turn.id}`,type:'agentMessage',text:'',phase:'final'}; turn.items.push(item);
  notify('item/started',{threadId:thread.id,turnId:turn.id,item:{...item}});
  item.text=text; notify('item/agentMessage/delta',{threadId:thread.id,turnId:turn.id,itemId:item.id,delta:text});
  notify('item/completed',{threadId:thread.id,turnId:turn.id,item}); turn.status='completed';
  notify('turn/completed',{threadId:thread.id,turn});
}
createInterface({input:process.stdin}).on('line',line=>{
  const msg=JSON.parse(line); const p=msg.params||{};
  if(!msg.method){const a=approvals.get(msg.id);if(a){approvals.delete(msg.id);notify('serverRequest/resolved',{threadId:a.thread.id,requestId:msg.id});finish(a.thread,a.turn,msg.result?.decision==='accept'?'已允许本次操作。':'已拒绝操作。');}return;}
  let result;
  switch(msg.method){
    case 'initialize':result={userAgent:'Fake Codex test fixture'};break;
    case 'initialized':return;
    case 'config/read':result={config:{model:'test-model',model_provider:'custom',model_reasoning_effort:'high',service_tier:null,api_key:'SHOULD_NEVER_LEAVE_AGENT',model_providers:{custom:{experimental_bearer_token:'ALSO_SECRET'}}}};break;
    case 'model/list':result={data:models,nextCursor:null};break;
    case 'fixture/lastTurnParams':result=lastTurnParams;break;
    case 'thread/list':result={data:[...threads.values()].filter(t=>!p.searchTerm||t.name.includes(p.searchTerm)).map(t=>({...t,turns:[]})),nextCursor:null};break;
    case 'thread/read':{const t=threads.get(p.threadId);if(!t)return write({id:msg.id,error:{code:-32600,message:'Thread not found'}});if(!t.turns.length)return write({id:msg.id,error:{code:-32600,message:'rollout at test.jsonl is empty'}});result={thread:{...t,turns:p.includeTurns?t.turns:[]}};break;}
    case 'thread/turns/list':{const t=threads.get(p.threadId);if(t&&!t.turns.length)return write({id:msg.id,error:{code:-32600,message:'rollout at test.jsonl is empty'}});result={data:[...(t?.turns||[])].reverse(),nextCursor:null};break;}
    case 'thread/start':{const id=`thread-${++seq}`;const t={id,name:'新的远程任务',cwd:p.cwd,modelProvider:'custom',model:p.model||'test-model',reasoningEffort:p.config?.model_reasoning_effort||'high',serviceTier:p.serviceTier||null,updatedAt:Math.floor(Date.now()/1000),status:{type:'idle'},turns:[]};threads.set(id,t);loaded.add(id);result={thread:{...t}};notify('thread/started',{thread:{...t}});break;}
    case 'thread/resume':if(externalOwners.has(p.threadId))return write({id:msg.id,error:{code:-32600,message:`thread ${p.threadId} already has an active writer`}});loaded.add(p.threadId);result={thread:threads.get(p.threadId)};break;
    case 'thread/loaded/list':result={data:[...loaded]};break;
    case 'thread/unsubscribe':{
      const wasLoaded=loaded.has(p.threadId);result={status:wasLoaded?'unsubscribed':'notLoaded'};
      if(wasLoaded)setTimeout(()=>{loaded.delete(p.threadId);notify('thread/closed',{threadId:p.threadId});},10);
      break;
    }
    case 'fixture/claim':externalOwners.add(p.threadId);result={};break;
    case 'fixture/release':externalOwners.delete(p.threadId);result={};break;
    case 'turn/start':{
      if(!loaded.has(p.threadId))return write({id:msg.id,error:{code:-32600,message:'Thread is not loaded'}});
      lastTurnParams=p;const thread=threads.get(p.threadId);if(p.model)thread.model=p.model;if(p.effort)thread.reasoningEffort=p.effort;if(p.serviceTier)thread.serviceTier=p.serviceTier;
      const turn={id:`turn-${++seq}`,status:'inProgress',items:[]};thread.turns.push(turn);
      const text=p.input[0].text;result={turn:{...turn}};
      write({id:msg.id,result});notify('turn/started',{threadId:thread.id,turn:{...turn}});
      const item={id:`u-${turn.id}`,type:'userMessage',content:p.input};turn.items.push(item);notify('item/completed',{threadId:thread.id,turnId:turn.id,item});
      if(text==='APPROVE'){const id=`approval-${seq}`;approvals.set(id,{thread,turn});write({id,method:'item/commandExecution/requestApproval',params:{threadId:thread.id,turnId:turn.id,itemId:'cmd',command:'echo hello',reason:'测试审批流程',availableDecisions:['accept','cancel']}});}
      else timers.set(turn.id,setTimeout(()=>finish(thread,turn,text==='XSS'?'<img src=x onerror="window.hacked=true"><script>window.hacked=true</script>\n\n安全输出。':`收到：${text}\n\n任务已完成。`),text==='SLOW'?1500:80));
      return;
    }
    case 'turn/interrupt':{const t=threads.get(p.threadId);const turn=t.turns.find(t=>t.id===p.turnId);clearTimeout(timers.get(turn.id));turn.status='interrupted';notify('turn/completed',{threadId:t.id,turn});result={};break;}
    default:return write({id:msg.id,error:{code:-32601,message:'Unsupported method'}});
  }
  if(msg.id!==undefined)write({id:msg.id,result});
});
process.stdin.on('end',()=>{fs.rmSync(demoCwd,{recursive:true,force:true});process.exit(0);});
