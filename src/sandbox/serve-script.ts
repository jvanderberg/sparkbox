/**
 * The static file server the Preview button runs inside the sandbox with
 * Edge.js. It is written to /workspace/.sparkbox/serve.mjs on demand and is
 * excluded from the file list and from saved versions.
 */
export const serveScript = `import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const port = Number(process.argv[2] || 8080);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".geojson": "application/geo+json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// Pages get a small bridge script injected into HTML responses. It reports
// runtime errors to the Sparkbox tab and answers requests from it (text
// outline, HTML, errors, screenshot) so the agent can look at the app.
const bridge =
  "<script>(function(){" +
  "var probe=location.hash.indexOf('sparkbox-probe')>=0;var errors=[];" +
  "function send(message){message=String(message).slice(0,2000);errors.push(message);if(errors.length>50)errors.shift();try{parent.postMessage({type:'sparkbox:page-error',message:message,href:location.pathname,probe:probe},'*')}catch(e){}}" +
  "window.addEventListener('error',function(e){var t=e.target;" +
  "if(t&&t!==window&&t.tagName){send('Failed to load '+t.tagName.toLowerCase()+' '+(t.src||t.href||''));return}" +
  "send((e.message||'Error')+(e.filename?' ('+e.filename.replace(location.origin,'')+':'+e.lineno+')':''))},true);" +
  "window.addEventListener('unhandledrejection',function(e){var r=e.reason;send('Unhandled promise rejection: '+(r&&r.message||r))});" +
  "var original=console.error;console.error=function(){send(Array.prototype.map.call(arguments,function(a){return a&&a.message||(typeof a==='object'?JSON.stringify(a):String(a))}).join(' '));original.apply(console,arguments)};" +
  "function visible(el){var r=el.getBoundingClientRect();if(!r.width&&!r.height)return false;var s=getComputedStyle(el);return s.visibility!=='hidden'&&s.display!=='none'}" +
  "function label(el){return (el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('title')||el.textContent||'').trim().replace(/\\\\s+/g,' ').slice(0,120)}" +
  "function outline(limit){var lines=[];var all=document.querySelectorAll('h1,h2,h3,h4,a[href],button,input,select,textarea,img,[role=button],[role=link],nav,main,header,footer,form,table');" +
  "for(var i=0;i<all.length&&lines.length<400;i++){var el=all[i];if(!visible(el))continue;var tag=el.tagName.toLowerCase();var text=label(el);" +
  "if(/^h[1-4]$/.test(tag))lines.push('#'.repeat(+tag[1])+' '+text);" +
  "else if(tag==='a')lines.push('[link] '+text+' -> '+el.getAttribute('href'));" +
  "else if(tag==='button'||el.getAttribute('role')==='button')lines.push('[button] '+text+(el.disabled?' (disabled)':''));" +
  "else if(tag==='input'||tag==='select'||tag==='textarea')lines.push('['+tag+(el.type?' '+el.type:'')+'] '+text+(el.value?' = '+String(el.value).slice(0,80):''));" +
  "else if(tag==='img')lines.push('[img] '+(el.alt||'(no alt)')+' '+el.naturalWidth+'x'+el.naturalHeight+(el.naturalWidth?'':' (not loaded)'));" +
  "else if(tag==='table')lines.push('[table] '+el.rows.length+' rows');" +
  "else lines.push('['+tag+(el.getAttribute('role')?' role='+el.getAttribute('role'):'')+']')}" +
  "var sheets=[];var links=document.querySelectorAll('link[rel=stylesheet]');for(var j=0;j<links.length;j++)sheets.push((links[j].sheet?'loaded ':'NOT LOADED ')+links[j].getAttribute('href'));" +
  "var body=(document.body&&document.body.innerText||'').replace(/\\\\n{3,}/g,'\\\\n\\\\n').trim();" +
  "return 'Title: '+document.title+'\\\\nViewport: '+innerWidth+'x'+innerHeight+', document '+document.documentElement.scrollWidth+'x'+document.documentElement.scrollHeight+(document.documentElement.scrollWidth>innerWidth+1?' (horizontal overflow!)':'')+'\\\\nStylesheets: '+(sheets.length?sheets.join('; '):'none linked')+'; body font: '+getComputedStyle(document.body).fontFamily.slice(0,60)+'\\\\n\\\\nElements:\\\\n'+lines.join('\\\\n')+'\\\\n\\\\nText:\\\\n'+body.slice(0,limit||6000)}" +
  "function pageBackground(){var c=[getComputedStyle(document.documentElement).backgroundColor,getComputedStyle(document.body).backgroundColor];for(var i=0;i<c.length;i++){var v=c[i]||'';var a=v.indexOf('('),b=v.lastIndexOf(')');if(a>0&&b>a){var p=v.slice(a+1,b).split(',');if(p.length<4||parseFloat(p[3])>0.01)return v}}return matchMedia('(prefers-color-scheme: dark)').matches?'#121212':'#ffffff'}" +
  "function inlineSheets(){var added=[];var links=document.querySelectorAll('link[rel=stylesheet]');for(var i=0;i<links.length;i++){var sheet=links[i].sheet;if(!sheet)continue;var text='';try{var rules=sheet.cssRules;for(var r=0;r<rules.length;r++)text+=rules[r].cssText+'\\\\n'}catch(e){continue}var style=document.createElement('style');style.setAttribute('data-sparkbox-inline','');style.textContent=text;links[i].parentNode.insertBefore(style,links[i].nextSibling);added.push(style)}return added}" +
  "async function screenshot(){var mod=await import('https://esm.sh/html2canvas@1.4.1');var fn=mod.default||mod;var added=inlineSheets();try{" +
  "var canvas=await fn(document.documentElement,{useCORS:true,allowTaint:false,logging:false,scale:1,width:innerWidth,height:innerHeight,windowWidth:innerWidth,windowHeight:innerHeight,x:0,y:0,scrollX:0,scrollY:0,backgroundColor:null});" +
  "var out=document.createElement('canvas');out.width=canvas.width;out.height=canvas.height;var ctx=out.getContext('2d');ctx.fillStyle=pageBackground();ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(canvas,0,0);" +
  "return {image:out.toDataURL('image/jpeg',0.82),width:out.width,height:out.height}}finally{for(var k=0;k<added.length;k++)added[k].remove()}}" +
  "window.addEventListener('message',async function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.type!=='sparkbox:request')return;" +
  "var reply=function(result,error){e.source.postMessage({type:'sparkbox:response',id:d.id,result:result,error:error},e.origin)};" +
  "try{if(d.format==='errors')reply({errors:errors.slice()});" +
  "else if(d.format==='html')reply({html:document.documentElement.outerHTML.slice(0,d.limit||60000)});" +
  "else if(d.format==='text')reply({text:outline(d.limit)});" +
  "else if(d.format==='screenshot')reply(await screenshot());" +
  "else reply(null,'unknown format '+d.format)}catch(err){reply(null,String(err&&err.message||err))}});" +
  "function ready(){try{parent.postMessage({type:'sparkbox:page-ready',href:location.pathname,probe:probe},'*')}catch(e){}}" +
  "if(document.readyState==='complete')ready();else window.addEventListener('load',ready);" +
  "})();</script>";

function withReporter(html) {
  const index = html.search(/<\\/body>/i);
  return index >= 0 ? html.slice(0, index) + bridge + html.slice(index) : html + bridge;
}

function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/\\0/g, "");
  const target = path.normalize(path.join(root, clean));
  if (!target.startsWith(root)) return null;
  return target;
}

http
  .createServer((request, response) => {
    let target = resolve(request.url || "/");
    if (!target) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory())
        target = path.join(target, "index.html");
      if (!fs.existsSync(target)) {
        const fallback = path.join(root, "index.html");
        if (!path.extname(target) && fs.existsSync(fallback)) target = fallback;
        else {
          response.writeHead(404, { "content-type": "text/plain" }).end("Not found: " + request.url);
          return;
        }
      }
      const extension = path.extname(target).toLowerCase();
      const data =
        extension === ".html"
          ? Buffer.from(withReporter(fs.readFileSync(target, "utf8")))
          : fs.readFileSync(target);
      response.writeHead(200, {
        "content-type": types[extension] || "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(data);
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    }
  })
  .listen(port, "0.0.0.0", () => console.log("Serving " + root + " on port " + port));
`;
