import { connect } from 'puppeteer-real-browser';
import fs from 'fs';
const dir='/Users/chanwut/work/robot/tmp/cf-profile-hl';
if(!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
const t0=Date.now();
const { browser } = await connect({
  headless: true, turnstile: true,
  customConfig: { userDataDir: dir },
  connectOption: { defaultViewport: null },
  args: ['--no-sandbox','--disable-setuid-sandbox','--window-size=1280,900'],
});
const p = await browser.newPage();
async function safe(fn){try{return await fn();}catch(e){return '';}}
try { await p.goto('https://www.dark-manga.com/', { waitUntil:'domcontentloaded', timeout:30000 }); } catch(e){ console.log('goto:',e.name); }
function ch(t,h){return t.includes('moment')||t.includes('รอสักครู่')||h.includes('challenge-platform')||h.includes('Verifying you are human');}
let t=await safe(()=>p.title()),h=await safe(()=>p.content());
for(let i=0;i<40 && ch(t,h);i++){await new Promise(r=>setTimeout(r,1000));t=await safe(()=>p.title());h=await safe(()=>p.content());}
console.log('HEADLESS passed:', !ch(t,h), '| title:', t.slice(0,45), '| len:', h.length, '| took', ((Date.now()-t0)/1000).toFixed(1)+'s');
const cookies = await safe(()=>p.cookies())||[];
console.log('cf_clearance present:', Array.isArray(cookies) && cookies.some(c=>c.name==='cf_clearance'));
await browser.close();process.exit(0);
