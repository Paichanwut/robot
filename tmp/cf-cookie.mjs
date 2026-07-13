import { connect } from 'puppeteer-real-browser';
import fs from 'fs';
const dir='/Users/chanwut/work/robot/tmp/cf-profile-ck';
if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
const { browser } = await connect({ headless:false, turnstile:true, customConfig:{userDataDir:dir}, connectOption:{defaultViewport:null}, args:['--window-size=1200,800'] });
const p = await browser.newPage();
async function safe(fn){try{return await fn();}catch(e){return '';}}
try{ await p.goto('https://www.dark-manga.com/',{waitUntil:'domcontentloaded',timeout:30000}); }catch(e){}
function ch(t,h){return t.includes('moment')||t.includes('รอสักครู่')||h.includes('challenge-platform')||h.includes('Verifying you are human');}
let t=await safe(()=>p.title()),h=await safe(()=>p.content());
for(let i=0;i<30 && ch(t,h);i++){await new Promise(r=>setTimeout(r,1000));t=await safe(()=>p.title());h=await safe(()=>p.content());}
console.log('browser solved:', !ch(t,h));
const ua = await p.evaluate(()=>navigator.userAgent);
const cookies = await p.cookies();
const cookieStr = cookies.map(c=>`${c.name}=${c.value}`).join('; ');
await browser.close();

// NOW: plain node fetch with cookie + UA (browser closed!)
console.log('--- plain fetch with cf_clearance (no browser) ---');
const r = await fetch('https://www.dark-manga.com/', { headers: { 'User-Agent': ua, 'Cookie': cookieStr, 'Accept':'text/html' } });
const body = await r.text();
console.log('status:', r.status, '| len:', body.length, '| challenged:', body.includes('challenge-platform')||body.includes('Just a moment')||body.includes('รอสักครู่'));
process.exit(0);
