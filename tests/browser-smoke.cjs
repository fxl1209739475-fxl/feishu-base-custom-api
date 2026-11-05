// Requires Playwright and installed Chromium; no real Feishu or model requests.
const {chromium}=require('playwright'); const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=','base64');
 const server=http.createServer((req,res)=>{const name=req.url==='/image-api.js'?'image-api.js':'index.html';res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':'text/html');res.end(fs.readFileSync(path.join(__dirname,'..',name)));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));let requests=0;
  await page.addInitScript(()=>{
   window.writes=[];
   const table={id:'table',getName:async()=> '测试商品表',getFieldMetaList:async()=>[{id:'white',name:'白底图',type:17},{id:'main',name:'主图',type:17}],getCellValue:async(fid)=>fid==='white'?[{token:'source-token',name:'product.png',type:'image/png'}]:[],getCellAttachmentUrls:async()=>['https://attachment.test/product.png'],setCellValue:async(...args)=>window.writes.push(args),getRecordIdList:async()=>['row'],getActiveView:async()=>({getVisibleRecordIdList:async()=>['row']})};
   const mock={base:{getActiveTable:async()=>table,getSelection:async()=>({tableId:'table',recordId:'row'}),onSelectionChange:()=>{},batchUploadFile:async(files)=>{if(files[0].type!=='image/png'||!files[0].size)throw Error('invalid file');return ['generated-token'];}}};
   Object.defineProperty(window,'__BITABLE__',{configurable:true,get:()=>mock,set:()=>{}});
  });
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.hostname==='127.0.0.1')return route.continue();
   if(u.hostname==='attachment.test')return route.fulfill({contentType:'image/png',body:png});
   if(u.hostname==='mock-api.test') {requests++;assert.equal(u.pathname,'/v1/images/edits');assert.ok(route.request().headers()['content-type'].startsWith('multipart/form-data'));return route.fulfill({json:{data:[{b64_json:png.toString('base64')}]}});}
   throw Error('Unexpected network request: '+u.hostname);
  });
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.locator('.chip').first().waitFor();await page.selectOption('#taskType','image');await page.locator('.chip').filter({hasText:'白底图'}).click();await page.selectOption('#outputSel','main');await page.fill('#apiBase','https://mock-api.test/v1');await page.fill('#apiKey','fake-browser-token');await page.fill('#prompt','保持商品原样，放在明亮的电商摄影场景中');await page.click('#runBtn');
  await page.waitForFunction(()=>window.writes.length===1);
  assert.deepEqual(await page.evaluate(()=>window.writes[0].slice(0,2)),['main','row']);assert.equal(await page.evaluate(()=>window.writes[0][2][0].token),'generated-token');assert.equal(requests,1);assert.deepEqual(errors,[]);console.log('PASS browser: 白底图 → multipart edits → PNG upload → 主图 attachment (mocked, zero paid calls)');
 } finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
