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
import {DEFAULT_BRANDING,accentCssVariables} from '@/lib/branding';
const theme = new URLSearchParams(location.search).get('theme') || 'light';
const brand = {...DEFAULT_BRANDING, accent:'#286457'};
const style = document.createElement('style');
style.textContent = accentCssVariables(brand.accent);
 document.head.append(style);
 document.documentElement.dataset.theme = theme;
function Page() {
 const path = usePathname();
 const [dialog,setDialog]=useState(false);
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
const css = (await postcss([tailwind({config:join(root,'tailwind.config.ts'),content:[join(root,'src/**/*.{ts,tsx}'),{raw:source,extension:'tsx'}]}),autoprefixer()])
  .process(readFileSync(join(root,'src/app/globals.css'),'utf8'),{from:join(root,'src/app/globals.css')})).css;
const fallbackTree = postcss.parse(css);
fallbackTree.walkAtRules('supports',rule=>{if(rule.params.includes('backdrop-filter'))rule.remove()});
const fallback = fallbackTree.toString();
const server = createServer((req,res)=>{
 const url = new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);return}
 if(url.pathname==='/style.css'){res.setHeader('content-type','text/css');res.end(url.searchParams.has('fallback')?fallback:css);return}
 if(url.pathname==='/api/conversations'){res.setHeader('content-type','application/json');res.end('{"conversations":[]}');return}
 if(url.pathname.startsWith('/api/inmob/chats/')){res.setHeader('content-type','application/json');
   if(req.headers.referer?.includes('failure')){res.statusCode=503;res.end('{"error":"fixture"}');return}
   const agent=url.pathname.split('/').at(-1);res.end(JSON.stringify({chatId:'fixture_'+agent,agent,turns:[]}));return}
 res.setHeader('content-type','text/html');res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css${url.searchParams.has('fallback')?'?fallback':''}"><title>VOCERO Glass Fixture</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const base = 'http://127.0.0.1:'+server.address().port;
let browser;
// Browser screenshots provide the composited surface pixel, including the
// real gradient/alpha layers. This avoids pretending a CSS hex tests glass.
function pixel(png){
 let offset=8;const chunks=[];let type;
 while(offset<png.length){const n=png.readUInt32BE(offset),kind=png.toString('ascii',offset+4,offset+8);
 if(kind==='IHDR')type=png[offset+17];
 if(kind==='IDAT')chunks.push(png.subarray(offset+8,offset+8+n));offset+=n+12;}
 const data=inflateSync(Buffer.concat(chunks));
 if(![2,6].includes(type)||data[0]>4)throw Error('Unsupported one-pixel screenshot format');
 return [...data.subarray(1,4)];
}
function lum(rgb){const s=rgb.map(v=>{const n=v/255;return n<=0.04045?n/12.92:((n+0.055)/1.055)**2.4});return s[0]*.2126+s[1]*.7152+s[2]*.0722}
function contrast(a,b){const x=lum(a),y=lum(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
async function textRgb(page,selector){return page.locator(selector).first().evaluate(el=>{
 const c=document.createElement('canvas').getContext('2d');c.fillStyle=getComputedStyle(el).color;c.fillRect(0,0,1,1);return [...c.getImageData(0,0,1,1).data].slice(0,3);
})}
async function sample(page,selector){const box=await page.locator(selector).first().boundingBox();return pixel(await page.screenshot({clip:{x:Math.floor(box.x+8),y:Math.floor(box.y+8),width:1,height:1}}))}
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
 for(const theme of ['light','dark']){
  await page.goto(base+'/?theme='+theme);await page.getByRole('heading',{name:'Tu espacio, con otra luz.'}).waitFor();
  const card=page.getByTestId('material-card');
  const material=await card.evaluate(el=>{const c=getComputedStyle(el);return{blur:c.backdropFilter||c.webkitBackdropFilter,bg:c.backgroundColor,filter:c.filter,radius:c.borderRadius}});
  ok(theme+' panel has visible background blur',/blur\((?:2\d|3\d)px\)/.test(material.blur),JSON.stringify(material));
  ok(theme+' foreground stays sharp',material.filter==='none');
  ok(theme+' rounded glass material',parseFloat(material.radius)>=20);
  const bg=await sample(page,'[data-testid="material-card"]');
  for(const [name,selector] of [['primary','[data-testid="material-card"] h3'],['secondary','[data-testid="material-card"] .text-text-2'],['tertiary','[data-testid="material-card"] .text-text-3']]){
   const ratio=contrast(await textRgb(page,selector),bg);ok(theme+' '+name+' composited contrast AA',ratio>=4.5,ratio.toFixed(2));
  }
  const field=page.getByLabel('Nombre de prueba');await field.fill('Texto nítido');await field.focus();
  const focus=await field.evaluate(el=>getComputedStyle(el).boxShadow);ok(theme+' field has keyboard focus',focus!=='none');
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
  ok(theme+' chat composer enabled',await page.getByRole('button',{name:'Enviar',exact:true}).isEnabled());
  const fieldMaterial=await page.getByLabel('Mensaje para Buscador').evaluate(el=>({filter:getComputedStyle(el).filter,bg:getComputedStyle(el).backgroundColor}));
  ok(theme+' transparent composer text stays sharp',fieldMaterial.filter==='none'&&fieldMaterial.bg==='rgba(0, 0, 0, 0)');
  for(const width of [375,768,1440]){
   await page.setViewportSize({width,height:900});
   const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
   ok(theme+' '+width+' no horizontal overflow',fits);
   ok(theme+' '+width+' composer visible',await page.getByRole('button',{name:'Enviar',exact:true}).isVisible());
   if(width<1024){
    await page.getByRole('button',{name:'Abrir el menú'}).click();
    ok(theme+' '+width+' mobile navigation visible',await page.getByRole('link',{name:'Pipeline',exact:true}).isVisible());
    await page.getByRole('link',{name:'Pipeline',exact:true}).click();
    await page.getByRole('heading',{name:'Tu espacio, con otra luz.'}).waitFor();
    ok(theme+' '+width+' navigation closes after route',!await page.getByRole('link',{name:'Pipeline',exact:true}).isVisible());
    await page.getByRole('button',{name:'Abrir el menú'}).click();await page.getByRole('link',{name:'Buscador',exact:true}).click();
    await page.getByLabel('Mensaje para Buscador').waitFor();
   }
  }
  await page.setViewportSize({width:375,height:812});await page.screenshot({path:join(output,'glass-'+theme+'-mobile.png')});
  await page.setViewportSize({width:1440,height:900});
 }
 await page.goto(base+'/?theme=light&fallback');await page.getByTestId('material-card').waitFor();
 const opaque=await page.getByTestId('material-card').evaluate(el=>getComputedStyle(el).backgroundColor);
 ok('unsupported browser opaque fallback',!opaque.includes('/')&&!opaque.startsWith('rgba'),opaque);
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
