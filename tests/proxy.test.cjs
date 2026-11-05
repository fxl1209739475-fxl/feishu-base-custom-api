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
