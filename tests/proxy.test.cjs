const {test}=require('node:test'); const assert=require('node:assert/strict');
const {createProxy}=require('../server/image-proxy.cjs');
test('proxy restricts origin/auth/path/body, replaces token, and forwards only to OpenAI',async()=>{
 let calls=0;
 const server=createProxy({apiKey:'fake-upstream-key',token:'x'.repeat(32),origins:['https://shop.github.io'],maxBytes:4096,fetcher:async(url,init)=>{
  calls++; assert.equal(url,'https://api.openai.com/v1/images/generations');assert.equal(init.headers.Authorization,'Bearer fake-upstream-key');assert.equal(JSON.parse(init.body).n,1);return Response.json({data:[{b64_json:'mock-image'}]});
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 const headers={Origin:'https://shop.github.io',Authorization:'Bearer '+'x'.repeat(32),'Content-Type':'application/json'};
 const data={model:'gpt-image-2',prompt:'场景',size:'1024x1024',n:1,output_format:'png'};
 try {
  assert.equal((await fetch(url+'/v1/images/generations',{method:'OPTIONS',headers})).status,204);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:JSON.stringify(data)})).status,403);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST',headers:{...headers,Authorization:'Bearer bad'},body:JSON.stringify(data)})).status,401);
  assert.equal((await fetch(url+'/v1/anything',{method:'POST',headers,body:'{}'})).status,404);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST',headers,body:JSON.stringify({...data,images:['https://private.test']})})).status,400);
  assert.equal((await fetch(url+'/v1/images/edits',{method:'POST',headers,body:'{}'})).status,415);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST',headers,body:'x'.repeat(4097)})).status,413);
  assert.equal(calls,0);
  const r=await fetch(url+'/v1/images/generations',{method:'POST',headers,body:JSON.stringify(data)});assert.equal(r.status,200);assert.equal(r.headers.get('access-control-allow-origin'),'https://shop.github.io');assert.equal((await r.json()).data[0].b64_json,'mock-image');assert.equal(calls,1);
 } finally {await new Promise(r=>server.close(r));}
});
test('multipart edits pass files and upstream failures are sanitized without retry',async()=>{
 let calls=0;
 const server=createProxy({apiKey:'fake-key',token:'y'.repeat(32),origins:['https://shop.github.io'],fetcher:async(url,init)=>{
  calls++;assert.equal(url,'https://api.openai.com/v1/images/edits');assert.ok(init.body instanceof FormData);assert.equal(init.body.getAll('image[]').length,1);assert.equal(init.headers['Content-Type'],undefined);return Response.json({error:{message:'sensitive-upstream-error'}},{status:400});
 }});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const body=new FormData();for(const [k,v] of Object.entries({model:'gpt-image-2',prompt:'场景',size:'1024x1024',n:'1',output_format:'png'}))body.append(k,v);body.append('image[]',new Blob(['mock-file'],{type:'image/png'}),'reference.png');
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/images/edits',{method:'POST',headers:{Origin:'https://shop.github.io',Authorization:'Bearer '+'y'.repeat(32)},body});assert.equal(r.status,400);assert.ok(!(await r.text()).includes('sensitive'));assert.equal(calls,1);
 } finally {await new Promise(r=>server.close(r));}
});

test('health is exact, public, secret-free and never calls upstream', async()=>{
 const server=createProxy({apiKey:'fake-health-key',token:'h'.repeat(32),origins:['https://shop.github.io'],fetcher:()=>assert.fail('health must not call OpenAI')});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 try {
  for(const headers of [{},{Origin:'https://evil.test'}]) {
   const r=await fetch(url+'/health',{headers});assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:'ok'});assert.equal(r.headers.get('access-control-allow-origin'),null);
  }
  assert.equal((await fetch(url+'/health?secret=anything')).status,403);
  assert.equal((await fetch(url+'/health',{method:'POST'})).status,403);
  assert.equal((await fetch(url+'/v1/images/generations',{method:'POST'})).status,403);
 }finally{await new Promise(r=>server.close(r));}
});

test('Render listens on all interfaces and PORT; local default remains loopback',async()=>{
 const {listenOptions,startProxy,UPLOAD_TIMEOUT_MS,GENERATION_TIMEOUT_MS}=require('../server/image-proxy.cjs');
 assert.deepEqual(listenOptions({}),{port:8787,host:'127.0.0.1'});
 assert.deepEqual(listenOptions({RENDER:'true',PORT:'10000'}),{port:10000,host:'0.0.0.0'});
 assert.deepEqual(listenOptions({PORT:'9000'}),{port:9000,host:'127.0.0.1'});
 assert.throws(()=>listenOptions({PORT:'invalid'}),/PORT/);
 assert.throws(()=>listenOptions({PORT:'65536'}),/PORT/);
 for(const render of [undefined,'true']) {
  const server=startProxy({RENDER:render,PORT:'0',OPENAI_API_KEY:'fake-start-key',PROXY_TOKEN:'s'.repeat(32),ALLOWED_ORIGINS:'https://shop.github.io'});
  await new Promise(r=>server.once('listening',r));
  try {
   assert.equal(server.address().address,render?'0.0.0.0':'127.0.0.1');assert.ok(server.address().port>0);
   assert.equal(server.requestTimeout,UPLOAD_TIMEOUT_MS);assert.equal(server.requestTimeout,300000);assert.equal(GENERATION_TIMEOUT_MS,600000);assert.equal(server.headersTimeout,60000);assert.equal(server.timeout,0);
   assert.deepEqual(await (await fetch('http://127.0.0.1:'+server.address().port+'/health')).json(),{status:'ok'});
  }finally{await new Promise(r=>server.close(r));}
 }
});

test('generation deadline returns sanitized 504 without retry',async()=>{
 let calls=0;
 const server=createProxy({apiKey:'fake-timeout-key',token:'t'.repeat(32),origins:['https://shop.github.io'],generationTimeoutMs:30,fetcher:async(url,{signal})=>{calls++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('secret-error','AbortError')),{once:true}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/v1/images/generations',{method:'POST',headers:{Origin:'https://shop.github.io',Authorization:'Bearer '+'t'.repeat(32),'Content-Type':'application/json'},body:JSON.stringify({model:'gpt-image-2',prompt:'场景',size:'1024x1024',n:1,output_format:'png'})});
  assert.equal(r.status,504);assert.ok(!(await r.text()).includes('secret-error'));assert.equal(calls,1);
 }finally{await new Promise(r=>server.close(r));}
});

test('native HTTPS transport serializes multipart and preserves abort signal without real requests',async()=>{
 const {EventEmitter}=require('node:events');const {openAIRequest}=require('../server/image-proxy.cjs');
 const controller=new AbortController();const form=new FormData();form.append('prompt','电商场景');form.append('image[]',new Blob(['fake-image'],{type:'image/png'}),'reference.png');
 let sent;
 const r=await openAIRequest('https://api.openai.com/v1/images/edits',{headers:{Authorization:'Bearer fake-key'},body:form,signal:controller.signal},(url,options,callback)=>{
  assert.equal(url,'https://api.openai.com/v1/images/edits');assert.equal(options.signal,controller.signal);assert.match(options.headers['content-type'],/^multipart\/form-data; boundary=/);
  const req=new EventEmitter();req.end=bytes=>{sent=bytes.toString();const response=new EventEmitter();response.statusCode=200;callback(response);response.emit('data',Buffer.from('{"data":[{"b64_json":"mock"}]}'));response.emit('end');};return req;
 });
 assert.ok(sent.includes('name="image[]"'));assert.ok(sent.includes('fake-image'));assert.equal((await r.json()).data[0].b64_json,'mock');
 controller.abort();await assert.rejects(openAIRequest('https://api.openai.com/v1/images/generations',{headers:{},body:'{}',signal:controller.signal},()=>assert.fail('aborted request must not be sent')),{name:'AbortError'});
});

test('documented npm start command runs in server directory with Render environment', async()=>{
 const {spawn}=require('node:child_process');const path=require('node:path');
 const child=spawn('npm',['start'],{cwd:path.join(__dirname,'../server'),detached:true,env:{...process.env,RENDER:'true',PORT:'0',OPENAI_API_KEY:'fake-cli-key',PROXY_TOKEN:'c'.repeat(32),ALLOWED_ORIGINS:'https://shop.github.io'},stdio:['ignore','pipe','pipe']});
 try {
  const port=await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('npm start readiness timeout')),10000);let out='';
   child.stdout.on('data',chunk=>{out+=chunk.toString();const match=out.match(/listening on 0\.0\.0\.0:(\d+)/);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
   child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(Error('npm start exited '+code));});
  });
  const r=await fetch('http://127.0.0.1:'+port+'/health');assert.equal(r.status,200);assert.deepEqual(await r.json(),{status:'ok'});
 }finally{process.kill(-child.pid,'SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));}
});
