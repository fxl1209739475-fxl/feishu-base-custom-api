/* Shared browser/Node image pipeline. No credentials or external dependencies. */
(function (root) {
  const MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  function endpoint(base, kind) {
    const u = new URL(base.trim());
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw Error('API 地址必须为无查询参数的 HTTP(S) 地址');
    u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|images\/(?:generations|edits))$/, '');
    if (!u.pathname || u.pathname === '/') u.pathname = '/v1';
    u.pathname += '/images/' + kind;
    return u.href;
  }
  function isImage(a) { return !!a && (/^image\//i.test(a.type || '') || /\.(png|jpe?g|webp)$/i.test(a.name || '')); }
  async function attachmentUrls(table, fid, rid, limit = 16) {
    const cell = await table.getCellValue(fid, rid);
    const images = (Array.isArray(cell) ? cell : []).filter(isImage);
    if (images.length > limit) throw Error('每行最多支持 ' + limit + ' 张参考图');
    if (!images.length) return [];
    if (images.some(a => !a.token)) throw Error('参考图缺少附件 token');
    // Official table method preserves field/record permission context.
    const urls = await table.getCellAttachmentUrls(images.map(a => a.token), fid, rid);
    if (!Array.isArray(urls) || urls.length !== images.length || urls.some(u => typeof u !== 'string' || !u)) throw Error('无法取得参考图临时下载地址，请刷新飞书权限后重试');
    return urls;
  }
  async function imageBlob(response) {
    if (!response.ok) throw Error('下载图片失败 HTTP ' + response.status);
    const blob = await response.blob();
    if (!MIME[blob.type] || !blob.size || blob.size >= 50 * 1024 * 1024) throw Error('图片须为非空 PNG/JPEG/WebP，且小于 50MB');
    const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const valid = blob.type === 'image/png' ? b[0]===137 && b[1]===80 && b[2]===78 && b[3]===71 : blob.type === 'image/jpeg' ? b[0]===255 && b[1]===216 && b[2]===255 : String.fromCharCode(...b.slice(0,4))==='RIFF' && String.fromCharCode(...b.slice(8,12))==='WEBP';
    if (!valid) throw Error('图片内容与 MIME 不符，可能下载到了错误页面');
    return blob;
  }
  async function generate({ base, key, model = 'gpt-image-2', size, text, imageUrls = [] }, signal, fetcher = fetch) {
    if (!text.trim()) throw Error('图片模式请填写场景提示词');
    if (imageUrls.length > 16) throw Error('最多支持16张参考图');
    const edit = imageUrls.length > 0;
    const headers = { Authorization: 'Bearer ' + key };
    let body;
    if (edit) {
      body = new FormData();
      for (const [i, url] of imageUrls.entries()) {
        const blob = await imageBlob(await fetcher(url, { signal }));
        body.append('image[]', blob, 'reference-' + i + '.' + MIME[blob.type]);
      }
      for (const [k,v] of Object.entries({model, prompt:text, size, n:'1', output_format:'png'})) body.append(k,v);
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify({model, prompt:text, size, n:1, output_format:'png'});
    }
    let response;
    try { response = await fetcher(endpoint(base, edit ? 'edits' : 'generations'), {method:'POST', headers, body, signal}); }
    catch (e) { if (e.name === 'AbortError') throw e; throw Error('图片请求未完成：检查网络/CORS；建议使用安全中转。为避免重复扣费，不自动重试'); }
    if (!response.ok) {
      let message = '';
      try { const data = await response.json(); message = data.error?.message || ''; } catch {}
      throw Error('生图API HTTP ' + response.status + ': ' + message.slice(0,300));
    }
    const data = await response.json(); const first = data.data?.[0];
    if (first?.b64_json) return { b64:first.b64_json, edit };
    if (first?.url && /^https:\/\//.test(first.url)) return {url:first.url, edit};
    throw Error('生图返回缺少有效 b64_json/url');
  }
  async function write({table, base, fid, rid, result, signal}, fetcher = fetch) {
    let response;
    if (result.b64) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(result.b64) || result.b64.length % 4) throw Error('返回的 Base64 图片无效');
      const bytes = Uint8Array.from(atob(result.b64), c => c.charCodeAt(0));
      response = new Response(bytes, {headers:{'Content-Type':'image/png'}});
    } else response = await fetcher(result.url, {signal});
    const blob = await imageBlob(response);
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    const file = new File([blob], 'ai_' + rid.slice(-6) + '_' + Date.now() + '.' + MIME[blob.type], {type:blob.type});
    const tokens = await base.batchUploadFile([file]);
    if (!Array.isArray(tokens) || typeof tokens[0] !== 'string' || !tokens[0]) throw Error('飞书上传未返回附件 token，未修改输出单元格');
    if (signal?.aborted) throw new DOMException('已停止', 'AbortError');
    await table.setCellValue(fid, rid, [{name:file.name, size:file.size, type:file.type, token:tokens[0], timeStamp:file.lastModified}]);
    return file.size;
  }
  const api = {endpoint, isImage, attachmentUrls, imageBlob, generate, write};
  if (typeof module !== 'undefined') module.exports = api; else root.ImageAPI = api;
})(globalThis);
