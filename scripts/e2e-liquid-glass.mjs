/** Browser verification of real shared UI + Inmob chat, compiled Tailwind.
 * In-memory fixtures only; never reads .env or connects DB/providers. */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const output = resolve(process.env.GLASS_EVIDENCE_DIR ?? join(root, '.tmp/glass-evidence'));
mkdirSync(output, {recursive:true});
let failures = 0;
let checks = 0;
const errors = [];
function ok(name, passed, detail = '') {
  checks++;
  if (!passed) failures++;
  console.log(`${passed ? 'OK' : 'FAIL'} ${name}${detail ? ': '+detail : ''}`);
}
const source = `
import React, {useState, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {usePathname} from 'next/navigation';
import {AppShell} from '@/components/app-shell';
import {Card,CardHeader,CardTitle,CardContent} from '@/components/ui/card';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {InmobChatClient} from '@/components/inmob/chat-client';
import {InboxClient} from '@/components/inbox/inbox-client';
import {DEFAULT_BRANDING,accentCssVariables} from '@/lib/branding';
const theme = new URLSearchParams(location.search).get('theme') || 'light';
const brand = {...DEFAULT_BRANDING, name:'isIA', accent:'#007A80'};
const style = document.createElement('style');
style.textContent = accentCssVariables(brand.accent);
 document.head.append(style);
 document.documentElement.dataset.theme = theme;
 document.documentElement.dataset.brand = 'isia';
function Page() {
 const path = usePathname();
 const [dialog,setDialog]=useState(false);
 if(path==='/inbox') return <InboxClient channels={['telegram']}/>;
 if(path.includes('/inmob/')) return <InmobChatClient key={path} agent={path.endsWith('secretaria')?'secretaria':'buscador'}/>;
 return <section className="h-full overflow-y-auto p-4 sm:p-6" aria-label="Muestra de material">
   <header className="mb-6"><p className="kicker">VOCERO · ESTUDIO DE MATERIAL</p><h1 className="mt-2 text-2xl font-bold">Tu espacio, con otra luz.</h1><p className="mt-2 text-sm text-text-2">Cristal suave. Todo lo que necesitas, a la vista.</p></header>
   <div className="grid gap-4 sm:grid-cols-2">
     <Card data-testid="material-card"><CardHeader><CardTitle>Un cristal más suave</CardTitle></CardHeader><CardContent><p className="text-sm text-text-2">El fondo se difumina; la información conserva su nitidez.</p><p className="mt-4 text-xs text-text-3">Tu color de marca sigue siendo el protagonista.</p><Button className="mt-5" onClick={()=>setDialog(true)}>Abrir diálogo</Button></CardContent></Card>
     <Card><CardHeader><CardTitle>Un espacio para trabajar</CardTitle></CardHeader><CardContent><label htmlFor="name" className="text-sm">Nombre de prueba</label><Input id="name" placeholder="Escribe aquí" className="mt-2"/><label htmlFor="notes" className="mt-4 block text-sm">Notas</label><Textarea id="notes" className="mt-2" placeholder="Todo sigue en su lugar"/><Button variant="outline" className="mt-4">Acción secundaria</Button></CardContent></Card>
   </div>
   {dialog && <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"><div role="dialog" aria-modal="true" aria-label="Diálogo de prueba" className="w-full max-w-sm rounded-lg border bg-popover p-5 shadow-pop"><h2 className="font-semibold">Todo sigue nítido</h2><p className="mt-3 text-sm text-text-2">Una superficie más opaca mantiene el diálogo legible.</p><Button className="mt-5" onClick={()=>setDialog(false)}>Cerrar diálogo</Button></div></div>}
 </section>;
}
createRoot(document.getElementById('root')).render(<AppShell branding={brand} userName="Usuario de prueba" role="owner" theme={theme} agenda inmob commit={{commit:'fixture',verified:false}}><Page/></AppShell>);
`;
const navigation = `import React,{useSyncExternalStore} from 'react';
export function usePathname(){return useSyncExternalStore(cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)},()=>location.pathname)}
export function useSearchParams(){return new URLSearchParams(location.search)}
export function useRouter(){return {push:(url)=>{history.pushState(null,'',url);window.dispatchEvent(new Event('popstate'))},refresh:()=>{}}}`;
const link = `import React from 'react'; export default function Link({href,children,...props}){return <a href={href} {...props} onClick={e=>{if(e.metaKey||e.ctrlKey)return;e.preventDefault();history.pushState(null,'',href);window.dispatchEvent(new Event('popstate'))}}>{children}</a>}`;
const bundle = await build({
  stdin:{contents:source,resolveDir:root,sourcefile:'glass-harness.tsx',loader:'tsx'},
  bundle:true,write:false,format:'iife',platform:'browser',target:'chrome120',jsx:'automatic',alias:{'@':join(root,'src')},
  banner:{js:"var process = {env:{NODE_ENV:'production'}};"},logLevel:'silent',
  plugins:[{name:'isolated-navigation',setup(api){
    api.onResolve({filter:/^(next\/(navigation|link)|@\/components\/use-events|@\/lib\/auth\/client)$/},args=>({path:args.path,namespace:'fixture'}));
    api.onLoad({filter:/.*/,namespace:'fixture'},args=>({loader:'tsx',resolveDir:root,contents:
      args.path==='next/navigation'?navigation:args.path==='next/link'?link:args.path.includes('use-events')?'export function useEvents(){}':'export async function signOut(){}'}));
  }}],
});
const fontCss = `
@font-face{font-family:'Albert Sans';src:url('/fonts/AlbertSans.ttf');font-weight:100 900;font-display:swap}
@font-face{font-family:'Archivo';src:url('/fonts/Archivo.ttf');font-weight:100 900;font-display:swap}
@font-face{font-family:'IBM Plex Mono';src:url('/fonts/IBMPlexMono-Regular.ttf');font-weight:400;font-display:swap}
:root{--font-sans:'Albert Sans';--font-display:'Archivo';--font-mono:'IBM Plex Mono'}
`;
const css = (await postcss([tailwind({config:join(root,'tailwind.config.ts'),content:[join(root,'src/**/*.{ts,tsx}'),{raw:source,extension:'tsx'}]}),autoprefixer()])
  .process(readFileSync(join(root,'src/app/globals.css'),'utf8'),{from:join(root,'src/app/globals.css')})).css + fontCss;
const fallbackTree = postcss.parse(css);
// Simulate a browser that ignores unsupported feature blocks/declarations.
// The base semantic tokens must provide opaque surfaces without either feature.
fallbackTree.walkAtRules('supports',rule=>{if(rule.params.includes('backdrop-filter'))rule.remove()});
fallbackTree.walkDecls(/^(?:-webkit-)?backdrop-filter$/,decl=>decl.remove());
const fallback = fallbackTree.toString();
let chatPosts = 0;
let inboxPosts = 0;
let marks = 0;
const conversations=[{id:'fixture_ana',contact:{id:'contact_ana',name:'Ana de prueba',phone:null},unreadCount:0},{id:'fixture_luis',contact:{id:'contact_luis',name:'Luis de prueba',phone:null},unreadCount:2}].map(c=>({...c,channel:'telegram',stageName:'Nuevo',aiEnabled:false,handoffAt:null,handoffReason:null,lastInboundAt:null,lastMessageAt:null,windowOpen:true,windowRemainingMs:86400000,preview:'Conversación sintética de prueba',anuncio:null}));
const server = createServer((req,res)=>{
 const url = new URL(req.url,'http://127.0.0.1');
 if(['/branding/isia/logo-light.svg','/branding/isia/logo-dark.svg','/branding/isia/icon.svg'].includes(url.pathname)){
  res.setHeader('content-type','image/svg+xml');res.end(readFileSync(join(root,'public',url.pathname)));return;
 }
 if(['/fonts/AlbertSans.ttf','/fonts/Archivo.ttf','/fonts/IBMPlexMono-Regular.ttf'].includes(url.pathname)){
  res.setHeader('content-type','font/ttf');res.end(readFileSync(join(root,'src/app',url.pathname)));return;
 }
 if(url.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);return}
 if(url.pathname==='/style.css'){res.setHeader('content-type','text/css');res.end(url.searchParams.has('fallback')?fallback:css);return}
 if(url.pathname==='/api/conversations'){res.setHeader('content-type','application/json');res.end(JSON.stringify({conversations}));return}
 if(url.pathname.startsWith('/api/conversations/')){res.setHeader('content-type','application/json');
  if(req.method==='POST'){inboxPosts++;res.statusCode=405;res.end('{}');return}
  if(req.method==='PATCH'){marks++;res.end('{}');return}
  res.end(JSON.stringify({messages:[]}));return;
 }
 if(url.pathname==='/api/templates'){res.setHeader('content-type','application/json');res.end('{"templates":[]}');return}
 if(url.pathname==='/api/pipeline/stages'){res.setHeader('content-type','application/json');res.end('{"stages":[]}');return}
 if(url.pathname.startsWith('/api/contacts/')){res.setHeader('content-type','application/json');res.end('{"contact":{"notes":"","ficha":{}},"lead":null,"stage":null,"anuncio":null}');return}
 if(url.pathname==='/api/agent/brain-status'){res.statusCode=404;res.end('{}');return}
 if(url.pathname.startsWith('/api/inmob/chats/')){res.setHeader('content-type','application/json');
   if(req.method==='POST'){chatPosts++;res.statusCode=405;res.end('{}');return}
   if(req.headers.referer?.includes('failure')){res.statusCode=503;res.end('{"error":"fixture"}');return}
   const agent=url.pathname.split('/').at(-1);
   const turns=req.headers.referer?.includes('history')?Array.from({length:30},(_,i)=>({requestId:'fixture_'+i,createdAt:new Date(1700000000000+i*1000).toISOString(),message:'Consulta de prueba '+i,reply:'Respuesta de prueba '+i,status:'completed',results:[]})):[];
   res.end(JSON.stringify({chatId:'fixture_'+agent,agent,turns}));return}
 res.setHeader('content-type','text/html');res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css${url.searchParams.has('fallback')?'?fallback':''}"><title>VOCERO Glass Fixture</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base = 'http://127.0.0.1:'+server.address().port;
let browser;
// Browser screenshots provide the composited surface pixel, including the
// real gradient/alpha layers. A full viewport avoids clipped screenshots
// changing how Chromium paints the backdrop-filter kernel.
function pixel(png, x, y) {
 let offset=8, width, type; const chunks=[];
 while(offset<png.length){
  const size=png.readUInt32BE(offset), kind=png.toString('ascii',offset+4,offset+8);
  if(kind==='IHDR'){width=png.readUInt32BE(offset+8);type=png[offset+17];}
  if(kind==='IDAT')chunks.push(png.subarray(offset+8,offset+8+size));
  offset+=size+12;
 }
 if(![2,6].includes(type))throw Error('Unsupported screenshot color type');
 const channels=type===6?4:3, stride=width*channels;
 const bytes=inflateSync(Buffer.concat(chunks)); let prev=Buffer.alloc(stride);
 for(let rowIndex=0;rowIndex<=y;rowIndex++){
  const at=rowIndex*(stride+1), filter=bytes[at];
  const row=Buffer.from(bytes.subarray(at+1,at+1+stride));
  for(let i=0;i<stride;i++){
   const a=i>=channels?row[i-channels]:0,b=prev[i],c=i>=channels?prev[i-channels]:0;
   let value=0;
   if(filter===1)value=a;
   else if(filter===2)value=b;
   else if(filter===3)value=Math.floor((a+b)/2);
   else if(filter===4){const q=a+b-c,da=Math.abs(q-a),db=Math.abs(q-b),dc=Math.abs(q-c);value=da<=db&&da<=dc?a:db<=dc?b:c;}
   row[i]=(row[i]+value)&255;
  }
  if(rowIndex===y)return [...row.subarray(x*channels,x*channels+3)];
  prev=row;
 }
}
function lum(rgb){const s=rgb.map(v=>{const n=v/255;return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4});return s[0]*.2126+s[1]*.7152+s[2]*.0722}
function contrast(a,b){const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
async function textRgb(page,selector){return page.locator(selector).first().evaluate(el=>{
 const c=document.createElement('canvas').getContext('2d');c.fillStyle=getComputedStyle(el).color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3);
})}
async function sample(page,selector){const box=await page.locator(selector).first().boundingBox();return pixel(await page.screenshot(),Math.floor(box.x+40),Math.floor(box.y+12))}
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 for(const theme of ['light','dark']){
  await page.goto(base+'/?theme='+theme);await page.getByRole('heading',{name:'Tu espacio, con otra luz.'}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  const logo=page.getByRole('img',{name:'isIA',exact:true});
  ok(theme+' official full logo visible',await logo.isVisible());
  const logoSize=await logo.boundingBox();ok(theme+' full logo minimum96px',logoSize.width>=96);
  const logoPath=await logo.getAttribute('src');ok(theme+' navy sidebar uses official dark variant',logoPath==='/branding/isia/logo-dark.svg');
  const palette=await page.evaluate(()=>({accent:getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),sky:getComputedStyle(document.documentElement).getPropertyValue('--isia-sky').trim()}));
  ok(theme+' official palette preserved',palette.sky==='#ecf9f9'&&(theme==='dark'||palette.accent==='#007a80'),JSON.stringify(palette));
  const card=page.getByTestId('material-card');
  const material=await card.evaluate(el=>{const c=getComputedStyle(el);return{blur:c.backdropFilter||c.webkitBackdropFilter,bg:c.backgroundColor,filter:c.filter,radius:c.borderRadius}});
  ok(theme+' panel has visible background blur',/blur\((?:2\d|3\d)px\)/.test(material.blur),JSON.stringify(material));
  ok(theme+' foreground stays sharp',material.filter==='none');
  ok(theme+' rounded glass material',parseFloat(material.radius)>=20);
  const bg=await sample(page,'[data-testid="material-card"]');
  for(const [name,selector] of [['primary','[data-testid="material-card"] h3'],['secondary','[data-testid="material-card"] .text-text-2'],['tertiary','[data-testid="material-card"] .text-text-3']]){
   const ratio=contrast(await textRgb(page,selector),bg);ok(theme+' '+name+' composited contrast AA',ratio>=4.5,ratio.toFixed(2));
  }
  const field=page.getByLabel('Nombre de prueba');
  const unfocused=await field.evaluate(el=>getComputedStyle(el).boxShadow);
  await page.getByRole('button',{name:'Abrir diálogo'}).focus();await page.keyboard.press('Tab');
  await page.waitForFunction(before=>{const el=document.getElementById('name');return document.activeElement===el&&el.matches(':focus-visible')&&getComputedStyle(el).boxShadow!==before},unfocused);
  const focus=await field.evaluate(el=>getComputedStyle(el).boxShadow);ok(theme+' field has visible keyboard focus',focus!=='none'&&focus!==unfocused);
  await field.fill('Texto nítido');
  ok(theme+' input remains editable',await field.inputValue()==='Texto nítido');
  await page.getByRole('button',{name:'Abrir diálogo'}).click();const dialog=page.getByRole('dialog');
  const raised=await dialog.evaluate(el=>{const c=getComputedStyle(el);return {blur:c.backdropFilter||c.webkitBackdropFilter,bg:c.backgroundColor}});
  ok(theme+' raised dialog glass',/blur/.test(raised.blur),JSON.stringify(raised));
  const ratio=contrast(await textRgb(page,'[role="dialog"] .text-text-2'),await sample(page,'[role="dialog"]'));
  ok(theme+' raised dialog contrast AA',ratio>=4.5,ratio.toFixed(2));
  await page.getByRole('button',{name:'Cerrar diálogo'}).click();
  await page.screenshot({path:join(output,'glass-'+theme+'-desktop.png')});
  await page.getByRole('link',{name:'Buscador',exact:true}).click();await page.getByLabel('Mensaje para Buscador').waitFor();
  await page.getByLabel('Mensaje para Buscador').fill('Borrador local sin envío');
  const compact = await page.locator('section[aria-labelledby="inmob-chat-title"]').evaluate(el=>({header:el.querySelector('header').getBoundingClientRect().height,composer:el.querySelector('footer').getBoundingClientRect().height}));
  ok(theme+' compact WhatsApp proportions',Math.abs(compact.header-64)<1&&Math.abs(compact.composer-64)<1,JSON.stringify(compact));
  ok(theme+' user can adjust view',await page.getByRole('button',{name:'Ajustar vista',exact:true}).count()===1);
  ok(theme+' navigation can collapse',await page.getByRole('button',{name:'Retraer menú',exact:true}).count()===1);
  ok(theme+' chat composer enabled',await page.getByRole('button',{name:'Enviar',exact:true}).isEnabled());
  const fieldMaterial=await page.getByLabel('Mensaje para Buscador').evaluate(el=>({filter:getComputedStyle(el).filter,bg:getComputedStyle(el).backgroundColor}));
  ok(theme+' transparent composer text stays sharp',fieldMaterial.filter==='none'&&fieldMaterial.bg==='rgba(0, 0, 0, 0)');
  const dimensions = () => page.locator('section[aria-labelledby="inmob-chat-title"]').evaluate(el=>({header:el.querySelector('header').getBoundingClientRect().height,composer:el.querySelector('footer').getBoundingClientRect().height,nav:document.querySelector('aside').getBoundingClientRect().width}));
  const headHandle=page.getByRole('separator',{name:'Ajustar altura de la cabecera',exact:true});
  const composerHandle=page.getByRole('separator',{name:'Ajustar altura para redactar',exact:true});
  const navHandle=page.getByRole('separator',{name:'Ajustar ancho del menú',exact:true});
  await headHandle.press('ArrowDown');await composerHandle.press('ArrowUp');await navHandle.press('ArrowRight');
  let size=await dimensions();ok(theme+' keyboard resizes all three regions',size.header===72&&size.composer===72&&size.nav===248,JSON.stringify(size));
  async function dragHandle(handle,dx,dy){const b=await handle.boundingBox();await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:5});await page.mouse.up();}
  await dragHandle(headHandle,0,24);await dragHandle(composerHandle,0,-32);await dragHandle(navHandle,40,0);
  size=await dimensions();ok(theme+' pointer drag resizes without sending',size.header===96&&size.composer===104&&size.nav===288,JSON.stringify(size));
  await page.getByRole('button',{name:'Retraer menú',exact:true}).click();
  ok(theme+' collapsed sidebar keeps labeled routes',Math.round((await dimensions()).nav)===72&&await page.getByRole('link',{name:'Secretaria',exact:true}).isVisible());
  await page.reload();await page.getByLabel('Mensaje para Buscador').waitFor();
  size=await dimensions();ok(theme+' sizes and collapse survive reload',size.header===96&&size.composer===104&&size.nav===72,JSON.stringify(size));
  ok(theme+' resizing preserves draft',await page.getByLabel('Mensaje para Buscador').inputValue()==='Borrador local sin envío');
  await page.getByRole('link',{name:'Secretaria',exact:true}).click();await page.getByLabel('Mensaje para Secretaria').waitFor();
  ok(theme+' two agents share chosen heights',(await dimensions()).header===96&&(await dimensions()).composer===104);
  await page.getByRole('link',{name:'Buscador',exact:true}).click();await page.getByLabel('Mensaje para Buscador').waitFor();
  await page.waitForFunction(()=>{const field=document.querySelector('[aria-label="Mensaje para Buscador"]');return field&&!field.disabled});
  ok(theme+' navigation keeps previous agent draft',await page.getByLabel('Mensaje para Buscador').inputValue()==='Borrador local sin envío');
  await page.getByRole('button',{name:'Expandir menú',exact:true}).click();
  ok(theme+' expanding restores chosen width',(await dimensions()).nav===288);
  await page.getByRole('button',{name:'Ajustar vista',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Ajustar vista',exact:true});await settings.waitFor();
  ok(theme+' settings opens modal with focus',await settings.evaluate(el=>el.matches(':modal')&&el.contains(document.activeElement)));
  await page.getByRole('slider',{name:'Altura de la cabecera'}).press('End');
  await page.getByRole('slider',{name:'Altura para redactar'}).press('End');
  await page.getByRole('slider',{name:'Ancho del menú'}).press('End');
  size=await dimensions();ok(theme+' accessible sliders reach safe limits',size.header===144&&size.composer===220&&size.nav===360,JSON.stringify(size));
  await page.getByRole('button',{name:'Cerrar ajustes de vista'}).click();
  ok(theme+' modal returns focus to trigger',await page.getByRole('button',{name:'Ajustar vista',exact:true}).evaluate(el=>document.activeElement===el));
  await page.setViewportSize({width:375,height:360});
  const short=await page.locator('section[aria-labelledby="inmob-chat-title"]').evaluate(el=>({available:el.clientHeight-el.querySelector('header').clientHeight-el.querySelector('footer').clientHeight,scroll:document.documentElement.scrollWidth,width:innerWidth}));
  ok(theme+' short mobile viewport preserves conversation',short.available>=120&&short.scroll<=short.width,JSON.stringify(short));
  await page.getByRole('button',{name:'Ajustar vista',exact:true}).click();await page.getByRole('button',{name:'Restablecer tamaños'}).click();
  await page.getByRole('button',{name:'Cerrar ajustes de vista'}).click();
  await page.setViewportSize({width:1440,height:900});
  size=await dimensions();ok(theme+' reset restores compact defaults',size.header===64&&size.composer===64&&size.nav===240,JSON.stringify(size));
  const floating=await page.locator('.inmob-composer-pill').evaluate(el=>({blur:getComputedStyle(el).backdropFilter,radius:getComputedStyle(el).borderRadius}));
  ok(theme+' composer uses a floating frosted pill',floating.blur.includes('32px')&&parseFloat(floating.radius)>=24,JSON.stringify(floating));
  const bars=await page.locator('.glass-chat-bar').evaluateAll(els=>els.every(el=>getComputedStyle(el).backdropFilter.includes('36px')));
  ok(theme+' chat header and footer visibly blur history',bars);
  await page.getByRole('button',{name:'Información de Buscador'}).click();await page.getByRole('dialog',{name:'Buscador',exact:true}).waitFor();
  ok(theme+' compact header retains description and help',await page.getByText('Encuentra opciones por zona, precio y características.',{exact:true}).isVisible()&&await page.getByText('Enter envía · Shift+Enter agrega una línea.',{exact:true}).isVisible());
  await page.getByRole('button',{name:'Cerrar información'}).click();
  for(const width of [375,768,1440]){
   await page.setViewportSize({width,height:900});
   const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
   ok(theme+' '+width+' no horizontal overflow',fits);
   ok(theme+' '+width+' composer visible',await page.getByRole('button',{name:'Enviar',exact:true}).isVisible());
   if(width<1024){
    await page.getByRole('button',{name:'Abrir el menú'}).click();
    await page.getByRole('link',{name:'Pipeline',exact:true}).waitFor({state:'visible'});
    ok(theme+' '+width+' mobile navigation visible',await page.getByRole('link',{name:'Pipeline',exact:true}).isVisible());
    await page.getByRole('link',{name:'Pipeline',exact:true}).click();
    await page.getByRole('heading',{name:'Tu espacio, con otra luz.'}).waitFor();
    await page.getByRole('link',{name:'Pipeline',exact:true}).waitFor({state:'hidden'});
    ok(theme+' '+width+' navigation closes after route',!await page.getByRole('link',{name:'Pipeline',exact:true}).isVisible());
    await page.getByRole('button',{name:'Abrir el menú'}).click();await page.getByRole('link',{name:'Buscador',exact:true}).click();
    await page.getByLabel('Mensaje para Buscador').waitFor();
   }
  }
  await page.setViewportSize({width:375,height:812});
  await page.waitForFunction(()=>{const el=document.querySelector('.view-nav');const c=getComputedStyle(el);return c.visibility==='hidden'&&new DOMMatrixReadOnly(c.transform).m41<=-el.getBoundingClientRect().width+1});
  await page.screenshot({path:join(output,'glass-'+theme+'-mobile.png')});
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('link',{name:/^Bandeja/}).click();await page.getByRole('button',{name:'Ana de prueba',exact:true}).waitFor();
  const list=page.getByRole('region',{name:'Lista de conversaciones'});
  ok(theme+' inbox defaults to expanded 360px',Math.round((await list.boundingBox()).width)===360);
  await page.getByRole('button',{name:'Ana de prueba',exact:true}).click();
  const reply=page.getByPlaceholder('Escribe una respuesta…');await reply.fill('Borrador de bandeja sin envío');
  const markedBefore=marks;
  await page.getByLabel('Buscar conversación').fill('Ana');
  const listHandle=page.getByRole('separator',{name:'Ajustar ancho de la lista de chats',exact:true});
  await listHandle.press('ArrowRight');await dragHandle(listHandle,40,0);
  ok(theme+' inbox width supports keyboard and pointer',Math.round((await list.boundingBox()).width)===408);
  await page.getByRole('button',{name:'Retraer lista de chats',exact:true}).click();
  ok(theme+' inbox collapses to labeled avatar rail',Math.round((await list.boundingBox()).width)===80&&await page.getByRole('button',{name:'Ana de prueba',exact:true}).isVisible());
  ok(theme+' inbox resize and collapse preserve composer draft',await reply.inputValue()==='Borrador de bandeja sin envío');
  await page.getByRole('button',{name:'Retraer menú',exact:true}).click();
  ok(theme+' main menu and chat list collapse independently',Math.round((await page.locator('.view-nav').boundingBox()).width)===72&&Math.round((await list.boundingBox()).width)===80);
  await page.getByRole('button',{name:'Expandir lista de chats',exact:true}).click();
  ok(theme+' expanded chat list restores size and filter',Math.round((await list.boundingBox()).width)===408&&await page.getByLabel('Buscar conversación').inputValue()==='Ana'&&await page.getByRole('button',{name:/Luis de prueba/}).count()===0);
  ok(theme+' layout actions do not mark other conversations',marks===markedBefore);
  await page.getByRole('button',{name:'Retraer lista de chats',exact:true}).click();await page.reload();await page.getByRole('button',{name:'Ana de prueba',exact:true}).waitFor();
  ok(theme+' both collapse preferences survive reload',Math.round((await list.boundingBox()).width)===80&&Math.round((await page.locator('.view-nav').boundingBox()).width)===72);
  await page.getByRole('button',{name:'Ajustar bandeja',exact:true}).click();
  await page.getByRole('slider',{name:'Ancho de la lista de chats'}).press('End');
  await page.getByRole('checkbox',{name:'Lista de chats retraída',exact:true}).uncheck();
  await page.getByRole('slider',{name:'Ancho del menú',exact:true}).press('End');
  await page.getByRole('checkbox',{name:'Menú retraído en escritorio',exact:true}).uncheck();
  await page.getByRole('button',{name:'Cerrar ajustes de vista'}).click();
  await page.getByRole('button',{name:'Ana de prueba',exact:true}).click();
  const threadWidth=await reply.evaluate(el=>el.closest('.inbox-layout').children[1].getBoundingClientRect().width);
  ok(theme+' maximum widths still reserve a usable thread',threadWidth>=319,threadWidth.toFixed(2));
  await page.getByRole('button',{name:'Ocultar panel',exact:true}).click();
  await page.setViewportSize({width:375,height:812});
  await page.getByRole('button',{name:'Volver a las conversaciones'}).click();
  ok(theme+' mobile inbox ignores desktop rail and fills viewport',Math.round((await list.boundingBox()).width)===375&&await page.getByLabel('Buscar conversación').isVisible());
  await page.getByRole('button',{name:'Ajustar bandeja',exact:true}).click();await page.getByRole('button',{name:'Restablecer tamaños'}).click();await page.getByRole('button',{name:'Cerrar ajustes de vista'}).click();
  await page.setViewportSize({width:1440,height:900});
  await page.screenshot({path:join(output,'inbox-'+theme+'-adjustable.png')});
 }
 await page.goto(base+'/inmob/buscador?history');await page.getByText('Respuesta de prueba 29',{exact:true}).waitFor();
 const last=page.getByText('Respuesta de prueba 29',{exact:true});await last.scrollIntoViewIfNeeded();
 const lastBox=await last.boundingBox(),footerBox=await page.locator('footer').boundingBox();
 ok('last message can be read above floating composer',lastBox.y+lastBox.height<=footerBox.y);
 await page.locator('.inmob-history').evaluate(el=>el.scrollTop=0);
 const firstBox=await page.getByText('Consulta de prueba 0',{exact:true}).boundingBox(),headerBox=await page.locator('.inmob-chat-header').boundingBox();
 ok('first message can be read below floating header',firstBox.y>=headerBox.y+headerBox.height);
 ok('layout actions never post a chat message',chatPosts===0,String(chatPosts));
 ok('inbox layout actions never send messages',inboxPosts===0,String(inboxPosts));
 const corruptContext=await browser.newContext({viewport:{width:1440,height:900}});
 await corruptContext.addInitScript(()=>localStorage.setItem('vocero:view-layout:v1','{broken'));
 const corruptPage=await corruptContext.newPage();await corruptPage.goto(base+'/inmob/buscador');await corruptPage.getByLabel('Mensaje para Buscador').waitFor();
 ok('corrupt preferences recover to usable defaults',await corruptPage.locator('.inmob-chat-header').evaluate(el=>el.getBoundingClientRect().height===64));
 await corruptContext.close();
 const blockedContext=await browser.newContext({viewport:{width:1440,height:900}});
 await blockedContext.addInitScript(()=>{Storage.prototype.getItem=()=>{throw new Error('fixture blocked')};Storage.prototype.setItem=()=>{throw new Error('fixture blocked')};});
 const blockedPage=await blockedContext.newPage();await blockedPage.goto(base+'/inmob/buscador');await blockedPage.getByLabel('Mensaje para Buscador').waitFor();
 await blockedPage.getByRole('separator',{name:'Ajustar altura de la cabecera'}).press('ArrowDown');
 ok('blocked storage keeps visible adjustment working',await blockedPage.locator('.inmob-chat-header').evaluate(el=>el.getBoundingClientRect().height===72));
 await blockedContext.close();
 await page.goto(base+'/?theme=light&fallback');await page.getByTestId('material-card').waitFor();
 for(const [name,selector] of [['panel','[data-testid="material-card"]'],['navigation','.glass-nav'],['workspace','.glass-workspace::before']]){
  const opaque=await page.evaluate(selector=>{const pseudo=selector.endsWith('::before');const el=document.querySelector(selector.replace('::before',''));const c=getComputedStyle(el,pseudo?'::before':null);return {bg:c.backgroundColor,blur:c.backdropFilter||c.webkitBackdropFilter||'none'}},selector);
  ok('unsupported browser '+name+' opaque fallback',!opaque.bg.includes('/')&&!opaque.bg.startsWith('rgba'),opaque.bg);
  ok('unsupported browser '+name+' has no blur',opaque.blur==='none',opaque.blur);
 }
 await page.goto(base+'/inmob/buscador?fallback');await page.getByLabel('Mensaje para Buscador').waitFor();
 const plainFloating=await page.locator('.inmob-composer-pill').evaluate(el=>({bg:getComputedStyle(el).backgroundColor,blur:getComputedStyle(el).backdropFilter}));
 ok('floating controls preserve opaque unsupported fallback',plainFloating.bg.startsWith('rgb(')&&plainFloating.blur==='none',JSON.stringify(plainFloating));
 await page.emulateMedia({reducedMotion:'reduce'});await page.goto(base+'/?theme=dark');await page.getByTestId('material-card').waitFor();
 const motion=await page.getByRole('button',{name:'Abrir diálogo'}).evaluate(el=>parseFloat(getComputedStyle(el).transitionDuration));
 ok('reduced motion respected',motion<.01,String(motion));
 await page.goto(base+'/inmob/buscador?failure');await page.getByRole('alert').waitFor();
 ok('load failure visibly recoverable',await page.getByRole('button',{name:'Volver a cargar'}).isVisible());
 await page.getByRole('link',{name:'Contactos',exact:true}).click();await page.getByTestId('material-card').waitFor();
 ok('load failure does not block navigation',await page.getByTestId('material-card').isVisible());
 ok('zero browser runtime errors',errors.length===0,errors.join('; '));
 console.log(JSON.stringify({checks,failures,errors}));
 writeFileSync(join(output,'result.json'),JSON.stringify({checks,failures,errors},null,2));
}finally{await browser?.close();await new Promise(done=>server.close(done))}
if(failures)process.exitCode=1;
