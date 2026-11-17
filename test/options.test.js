import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { testHub, until } from './helpers.js';
import { ConversationOptions } from '../src/conversation-options.js';

test('plain conversations need no project path and receive separate managed directories', async () => {
  const t=await testHub();
  try {
    const first=await t.request('/api/devices/test-local/create', {mode:'chat'});
    const second=await t.request('/api/devices/test-local/create', {});
    assert.equal(first.response.status,200); assert.equal(second.response.status,200);
    assert.equal(first.data.thread.mode,'chat'); assert.notEqual(first.data.thread.cwd,second.data.thread.cwd);
    assert.equal(path.dirname(first.data.thread.cwd),path.join(t.dataDir,'chats')); assert.equal(fs.statSync(first.data.thread.cwd).isDirectory(),true);
    const reloaded=new ConversationOptions(t.dataDir); assert.equal(reloaded.get(first.data.thread.id).mode,'chat');
    const invalid=await t.request('/api/devices/test-local/create',{mode:'project'}); assert.equal(invalid.response.status,400);
    const project=await t.request('/api/devices/test-local/create',{mode:'project',cwd:process.cwd()}); assert.equal(project.data.thread.mode,'project');
    const catalog=await t.request('/api/devices/test-local/models'); assert.equal(catalog.data.recentProjects.includes(process.cwd()),true);
  }finally{await t.close();}
});

test('model discovery exposes only safe configuration fields and reported capabilities',async()=>{
  const t=await testHub();
  try {
    const result=await t.request('/api/devices/test-local/models'); assert.equal(result.response.status,200);
    assert.equal(result.data.defaults.model,'test-model'); assert.equal(result.data.models.length,2);
    assert.deepEqual(result.data.models[1].efforts.map(e=>e.value),['medium','xhigh']);
    assert.equal(JSON.stringify(result.data).includes('SECRET'),false); assert.equal(JSON.stringify(result.data).includes('SHOULD_NEVER'),false);
    assert.equal((await t.request('/api/devices/test-local/models',undefined,{auth:false})).response.status,401);
  }finally{await t.close();}
});

test('new conversations remember the last explicitly selected web model per device',async()=>{
  const t=await testHub();
  try {
    const firstSettings={model:'test-reasoner',effort:'xhigh'};
    await t.request('/api/devices/test-local/create',{mode:'chat',settings:firstSettings});
    let catalog=await t.request('/api/devices/test-local/models');
    assert.deepEqual(catalog.data.lastSettings,firstSettings);
    const changed={model:'test-model',effort:'high',serviceTier:'priority'};
    await t.request('/api/devices/test-local/settings',{threadId:'thread-demo',settings:changed});
    catalog=await t.request('/api/devices/test-local/models');
    assert.deepEqual(catalog.data.lastSettings,changed);
    await t.request('/api/devices/test-local/settings',{threadId:'thread-demo',reset:true});
    catalog=await t.request('/api/devices/test-local/models');
    assert.deepEqual(catalog.data.lastSettings,changed,'resetting one conversation must keep the next-conversation default');
    const reloaded=new ConversationOptions(t.dataDir);
    assert.deepEqual(reloaded.data.lastSettings,changed);
  }finally{await t.close();}
});

test('version 1 preferences seed the new-conversation model from existing web conversations',()=>{
  const dataDir=fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(),'relaydeck-options-migration-'));
  try {
    fs.writeFileSync(path.join(dataDir,'conversation-options.json'),JSON.stringify({version:1,recentProjects:[],threads:{
      older:{settings:{model:'test-model',effort:'low'}},
      newer:{settings:{model:'test-reasoner',effort:'xhigh'}}
    }}));
    const migrated=new ConversationOptions(dataDir);
    assert.deepEqual(migrated.data.lastSettings,{model:'test-reasoner',effort:'xhigh'});
  }finally{fs.rmSync(dataDir,{recursive:true,force:true});}
});

test('model and effort settings survive release and are passed to the next Codex turn',async()=>{
  const t=await testHub();
  try {
    const created=await t.request('/api/devices/test-local/create',{mode:'chat',settings:{model:'test-reasoner',effort:'xhigh'}});
    const id=created.data.thread.id; assert.equal(created.data.thread.reasoningEffort,'xhigh');
    assert.equal((await t.request('/api/devices/test-local/send',{threadId:id,text:'first',clientId:randomUUID()})).response.status,200);
    await until(()=>!t.local.loaded.has(id));
    const next={model:'test-model',effort:'high',serviceTier:'priority'};
    const changed=await t.request('/api/devices/test-local/settings',{threadId:id,settings:next}); assert.equal(changed.response.status,200);
    assert.deepEqual(new ConversationOptions(t.dataDir).get(id).settings,next);
    assert.deepEqual((await t.local.client.request('thread/loaded/list')).data,[],'editing settings must not take the writer lock');
    await t.request('/api/devices/test-local/send',{threadId:id,text:'next',clientId:randomUUID()});
    const sent=await t.local.client.request('fixture/lastTurnParams'); assert.equal(sent.model,'test-model'); assert.equal(sent.effort,'high'); assert.equal(sent.serviceTier,'priority');
    await until(()=>!t.local.loaded.has(id));
    const read=await t.request(`/api/devices/test-local/thread?threadId=${id}`); assert.equal(read.data.thread.model,'test-model'); assert.equal(read.data.thread.reasoningEffort,'high');
    await t.request('/api/devices/test-local/settings',{threadId:id,reset:true});
    assert.deepEqual(new ConversationOptions(t.dataDir).get(id).settings,{});
    assert.equal(new ConversationOptions(t.dataDir).get(id).mode,'chat');
  }finally{await t.close();}
});

test('unsupported catalog settings fail before running; custom model IDs remain available',async()=>{
  const t=await testHub();
  try {
    const invalid=await t.request('/api/devices/test-local/settings',{threadId:'thread-demo',settings:{model:'test-model',effort:'xhigh'}});
    assert.equal(invalid.response.status,400); assert.match(invalid.data.error,/不支持/);
    const badSpeed=await t.request('/api/devices/test-local/settings',{threadId:'thread-demo',settings:{model:'test-reasoner',serviceTier:'priority'}}); assert.equal(badSpeed.response.status,400);
    const custom=await t.request('/api/devices/test-local/settings',{threadId:'thread-demo',settings:{model:'my-provider/private-model',effort:'high'}}); assert.equal(custom.response.status,200);
    const current=await t.request('/api/devices/test-local/thread?threadId=thread-demo'); assert.equal(current.data.turns.length,1);
    await t.request('/api/devices/test-local/send',{threadId:'thread-demo',text:'SLOW',clientId:randomUUID()});
    const busy=await t.request('/api/devices/test-local/settings',{threadId:'thread-demo',settings:{model:'test-model'}}); assert.equal(busy.response.status,400);
    await t.request('/api/devices/test-local/interrupt',{threadId:'thread-demo'});
  }finally{await t.close();}
});
