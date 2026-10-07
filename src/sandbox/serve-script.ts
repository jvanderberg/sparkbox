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
  "var hash=location.hash||'';var probe=hash.indexOf('sparkbox-probe')>=0;var forced=/scheme=(light|dark)/.exec(hash);forced=forced?forced[1]:'';var errors=[];" +
  // Probe frames can force a color scheme: answer matchMedia queries, set the
  // root color-scheme (which drives light-dark() and form controls), and
  // rewrite prefers-color-scheme media rules once stylesheets are in.
  "if(forced){var realMatch=window.matchMedia.bind(window);window.matchMedia=function(q){var m=/prefers-color-scheme:\\\\s*(light|dark)/.exec(q);if(!m)return realMatch(q);var matches=m[1]===forced;return {matches:matches,media:q,onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return false}}};" +
  "document.addEventListener('DOMContentLoaded',function(){document.documentElement.style.colorScheme=forced});}" +
  "function applyScheme(){if(!forced)return;document.documentElement.style.colorScheme=forced;for(var i=0;i<document.styleSheets.length;i++){var rules;try{rules=document.styleSheets[i].cssRules}catch(e){continue}for(var r=0;r<rules.length;r++){var rule=rules[r];if(rule.media&&/prefers-color-scheme/.test(rule.media.mediaText)){var wantsDark=/prefers-color-scheme:\\\\s*dark/.test(rule.media.mediaText);rule.media.mediaText=(wantsDark?forced==='dark':forced==='light')?'all':'not all'}}}}" +
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
  "var scheme=forced?forced+' (forced)':(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')+' (system)';" +
  "return 'Title: '+document.title+'\\\\nViewport: '+innerWidth+'x'+innerHeight+', document '+document.documentElement.scrollWidth+'x'+document.documentElement.scrollHeight+(document.documentElement.scrollWidth>innerWidth+1?' (horizontal overflow!)':'')+'\\\\nColor scheme: '+scheme+'\\\\nStylesheets: '+(sheets.length?sheets.join('; '):'none linked')+'; body font: '+getComputedStyle(document.body).fontFamily.slice(0,60)+'\\\\n\\\\nElements:\\\\n'+lines.join('\\\\n')+'\\\\n\\\\nText:\\\\n'+body.slice(0,limit||6000)}" +
  "function pageBackground(){var c=[getComputedStyle(document.documentElement).backgroundColor,getComputedStyle(document.body).backgroundColor];for(var i=0;i<c.length;i++){var v=c[i]||'';var a=v.indexOf('('),b=v.lastIndexOf(')');if(a>0&&b>a){var p=v.slice(a+1,b).split(',');if(p.length<4||parseFloat(p[3])>0.01)return v}}return (forced||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'))==='dark'?'#121212':'#ffffff'}" +
  "function inlineSheets(){var added=[];var links=document.querySelectorAll('link[rel=stylesheet]');for(var i=0;i<links.length;i++){var sheet=links[i].sheet;if(!sheet)continue;var text='';try{var rules=sheet.cssRules;for(var r=0;r<rules.length;r++)text+=rules[r].cssText+'\\\\n'}catch(e){continue}var style=document.createElement('style');style.setAttribute('data-sparkbox-inline','');style.textContent=text;links[i].parentNode.insertBefore(style,links[i].nextSibling);added.push(style)}return added}" +
  "function composite(canvas){var out=document.createElement('canvas');out.width=canvas.width;out.height=canvas.height;var ctx=out.getContext('2d');ctx.fillStyle=pageBackground();ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(canvas,0,0);var stats=imageStats();return {image:out.toDataURL('image/jpeg',0.82),width:out.width,height:out.height,renderer:canvas.sparkboxRenderer||'html2canvas',images:stats}}" +
  // The browser paints the DOM through an SVG foreignObject, so transforms
  // (map panes, animations) land exactly. html2canvas is the fallback.
  // Maps and galleries add images after load; wait for them (bounded) and for
  // fade-in transitions before painting.
  "function imageStats(){var imgs=document.images;var loaded=0;for(var i=0;i<imgs.length;i++)if(imgs[i].complete&&imgs[i].naturalWidth>0)loaded++;return {total:imgs.length,loaded:loaded}}" +
  "function settle(){var deadline=Date.now()+10000;function step(){var pending=Array.prototype.filter.call(document.images,function(i){return !i.complete});if(!pending.length||Date.now()>deadline)return Promise.resolve();return Promise.race([Promise.all(pending.map(function(i){return new Promise(function(r){i.addEventListener('load',r,{once:true});i.addEventListener('error',r,{once:true})})})),new Promise(function(r){setTimeout(r,1500)})]).then(step)}" +
  "var fonts=document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve();return fonts.then(step).then(function(){return new Promise(function(r){setTimeout(r,700)})})}" +
  "async function screenshot(){applyScheme();await settle();var added=inlineSheets();try{" +
  "try{var ms=await import('https://esm.sh/modern-screenshot@4');var c1=await ms.domToCanvas(document.documentElement,{width:innerWidth,height:innerHeight,scale:1,backgroundColor:pageBackground(),fetch:{requestInit:{mode:'cors',cache:'force-cache'},bypassingCache:false},timeout:20000});c1.sparkboxRenderer='modern-screenshot';return composite(c1)}catch(e){console.warn('modern-screenshot failed, using html2canvas',e)}" +
  "var mod=await import('https://esm.sh/html2canvas@1.4.1');var fn=mod.default||mod;" +
  "var canvas=await fn(document.documentElement,{useCORS:true,allowTaint:false,logging:false,scale:1,width:innerWidth,height:innerHeight,windowWidth:innerWidth,windowHeight:innerHeight,x:0,y:0,scrollX:0,scrollY:0,backgroundColor:null});" +
  "return composite(canvas)}finally{for(var k=0;k<added.length;k++)added[k].remove()}}" +
  "window.addEventListener('message',async function(e){if(e.source!==window.parent)return;var d=e.data;if(!d||d.type!=='sparkbox:request')return;" +
  "var reply=function(result,error){e.source.postMessage({type:'sparkbox:response',id:d.id,result:result,error:error},e.origin)};" +
  "try{applyScheme();if(d.format==='errors')reply({errors:errors.slice()});" +
  "else if(d.format==='html')reply({html:document.documentElement.outerHTML.slice(0,d.limit||60000)});" +
  "else if(d.format==='text')reply({text:outline(d.limit)});" +
  "else if(d.format==='screenshot')reply(await screenshot());" +
  "else reply(null,'unknown format '+d.format)}catch(err){reply(null,String(err&&err.message||err))}});" +
  "function ready(){applyScheme();try{parent.postMessage({type:'sparkbox:page-ready',href:location.pathname,probe:probe},'*')}catch(e){}}" +
  "if(document.readyState==='complete')ready();else window.addEventListener('load',ready);" +
  "})();</script>";

function withReporter(html) {
  const head = html.search(/<head[^>]*>/i);
  if (head >= 0) {
    const after = head + html.slice(head).indexOf(">") + 1;
    return html.slice(0, after) + bridge + html.slice(after);
  }
  const index = html.search(/<\\/body>/i);
  return index >= 0 ? html.slice(0, index) + bridge + html.slice(index) : bridge + html;
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
