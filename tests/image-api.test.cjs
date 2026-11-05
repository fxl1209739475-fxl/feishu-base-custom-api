const {test} = require('node:test');
const assert = require('node:assert/strict');
const api = require('../image-api.js');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64');
const image = ()=>new Response(png,{headers:{'Content-Type':'image/png'}});
const options = {base:'https://api.openai.com/v1',key:'fake-test-token',size:'1024x1024',text:'电商场景，保持产品不变'};
test('endpoint normalization: root, v1, full endpoints and proxy prefixes',()=>{
 for(const base of ['https://api.openai.com','https://api.openai.com/','https://api.openai.com/v1/','https://api.openai.com/v1/chat/completions','https://api.openai.com/v1/images/edits','https://api.openai.com/v1/images/generations']) assert.equal(api.endpoint(base,'edits'),'https://api.openai.com/v1/images/edits');
 assert.equal(api.endpoint('https://proxy.test/api/v1/images/edits','generations'),'https://proxy.test/api/v1/images/generations');
 assert.throws(()=>api.endpoint('https://user:secret@example.com','edits'));
});
test('reference images use multipart edits, never JSON images/image or response_format',async()=>{
 let calls=0;
 const result = await api.generate({...options,imageUrls:['https://attachment.test/a','https://attachment.test/b']},undefined,async(url,init)=>{
  calls++; if(calls<3){assert.equal(init.headers,undefined);return image();}
  assert.equal(url,'https://api.openai.com/v1/images/edits'); assert.equal(init.headers['Content-Type'],undefined);
  assert.ok(init.body instanceof FormData);assert.equal(init.body.getAll('image[]').length,2);
  assert.equal(init.body.get('model'),'gpt-image-2');assert.equal(init.body.get('output_format'),'png');assert.equal(init.body.has('response_format'),false);assert.equal(init.body.has('images'),false);
  assert.deepEqual(Buffer.from(await init.body.get('image[]').arrayBuffer()),png);
  return Response.json({data:[{b64_json:png.toString('base64')}]});
 }); assert.equal(result.edit,true);assert.equal(calls,3);
});
test('no references use generations JSON',async()=>{
 await api.generate(options,undefined,async(url,init)=>{assert.ok(url.endsWith('/generations'));assert.deepEqual(JSON.parse(init.body),{model:'gpt-image-2',prompt:options.text,size:options.size,n:1,output_format:'png'});return Response.json({data:[{url:'https://result.test/a.png'}]});});
});
test('attachment tokens preserve field/record context and errors never degrade to text-only generation',async()=>{
 const table={getCellValue:async()=>[{token:'a',name:'产品.png'}],getCellAttachmentUrls:async(...args)=>{assert.deepEqual(args,[['a'],'white','row']);return ['https://attachment.test/a'];}};
 assert.equal((await api.attachmentUrls(table,'white','row')).length,1);
 table.getCellAttachmentUrls=async()=>[];await assert.rejects(api.attachmentUrls(table,'white','row'),/临时下载/);
 table.getCellValue=async()=>{throw Error('permission denied')};await assert.rejects(api.attachmentUrls(table,'white','row'),/permission/);
});
test('HTTP errors do not retry; malformed/missing results and CORS failures surface',async()=>{
 let calls=0;await assert.rejects(api.generate(options,undefined,async()=>{calls++;return Response.json({error:{message:'bad parameter'}},{status:400})}),/400.*bad parameter/);assert.equal(calls,1);
 await assert.rejects(api.generate(options,undefined,async()=>Response.json({data:[]})),/缺少/);
 await assert.rejects(api.generate(options,undefined,async()=>{throw TypeError('Failed to fetch')}),/CORS/);
 await assert.rejects(api.generate({...options,text:''}),/提示词/);
});
test('invalid reference data and abort do not reach paid endpoint',async()=>{
 await assert.rejects(api.generate({...options,imageUrls:['https://attachment.test/a']},undefined,async()=>new Response('<html>denied</html>',{headers:{'Content-Type':'text/html'}})),/PNG/);
 const controller=new AbortController();controller.abort();await assert.rejects(api.generate(options,controller.signal,async()=>{throw new DOMException('stop','AbortError')}),{name:'AbortError'});
});
test('Base64 uploads actual PNG File then writes target attachment cell',async()=>{
 let uploaded=false, written=false;
 const size=await api.write({fid:'main',rid:'row',result:{b64:png.toString('base64')},base:{batchUploadFile:async([file])=>{assert.equal(file.type,'image/png');assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);uploaded=true;return ['uploaded-token'];}},table:{setCellValue:async(fid,rid,values)=>{assert.ok(uploaded);assert.equal(fid,'main');assert.equal(rid,'row');assert.equal(values[0].token,'uploaded-token');written=true;}}});
 assert.equal(size,png.length);assert.ok(written);
});
test('URL result download, upload failure, invalid base64/content and write failure propagate',async()=>{
 const args={fid:'main',rid:'row',result:{url:'https://result.test/a.png'},base:{batchUploadFile:async()=>[]},table:{setCellValue:async()=>assert.fail('must not overwrite')}};
 await assert.rejects(api.write(args,async()=>image()),/token/);
 await assert.rejects(api.write({...args,result:{b64:'garbage'}}),/Base64/);
 await assert.rejects(api.write({...args,result:{b64:Buffer.from('not a PNG').toString('base64')}}),/MIME/);
 await assert.rejects(api.write(args,async()=>new Response('',{status:403})),/403/);
 await assert.rejects(api.write({...args,result:{b64:png.toString('base64')},base:{batchUploadFile:async()=>['token']},table:{setCellValue:async()=>{throw Error('write denied')}}}),/write denied/);
});
