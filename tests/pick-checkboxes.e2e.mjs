// Standalone browser matrix. Install puppeteer-core separately; run against a fresh demo server
// with a deterministic fake provider. BASE, CHROME_PATH and SCREENSHOT_PATH are configurable.
// Uses actual network response bodies and UI interactions, never a real account.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',headless:'new',args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage(); await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
const errors=[], calls=[], result=[];
page.on('pageerror',e=>errors.push(String(e))); page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
page.on('request',r=>{if(r.url().includes('/api/'))calls.push({url:r.url(),body:r.postData()})});
const pause=()=>new Promise(r=>setTimeout(r,180));
async function button(text){await page.evaluate(t=>{const b=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===t||e.textContent.trim().startsWith(t)); if(!b)throw new Error('missing button '+t); if(b.disabled)throw new Error('disabled '+t); b.click()},text); await pause()}
async function box(group,name){await page.evaluate(({group,name})=>{const e=[...document.querySelectorAll('div[aria-label="all '+group+' in your checked library"] label')].find(e=>e.textContent.trim()===name); if(!e)throw new Error('missing box '+name);e.querySelector('input').click()},{group,name});await pause()}
async function pick(){const resp=page.waitForResponse(r=>r.url().endsWith('/api/pick')&&r.request().method()==='POST');await button('Give me 5 ideas');const r=await resp;assert.equal(r.status(),200); const j=await r.json();await pause();return j}
async function ask(){const resp=page.waitForResponse(r=>r.url().endsWith('/api/ask-ai'));await button('Ask about the note above');const r=await resp;const j=await r.json();assert.equal(r.status(),200,JSON.stringify(j));await pause();assert.ok(await page.$('.card .cardbody h3'));return j}
try{
await page.goto(process.env.BASE,{waitUntil:'networkidle2'});await page.waitForSelector('input[aria-label="dish filter"]');
await button('Browse dishes');await button('Browse ingredients');
let n=calls.length;await box('dishes','Ven Pongal');await pause();assert.equal(calls.length,n);let p=await pick();assert.ok(p.picks.length);await ask();result.push('dish-only checkbox -> Pick -> Ask PASS');
await button('Clear all dishes');await box('ingredients','rice');p=await pick();await ask();result.push('ingredient-only checkbox -> second Pick -> Ask PASS');
const moreResponse=page.waitForResponse(r=>r.url().endsWith('/api/pick')&&r.request().method()==='POST');await button('Load more');const moreReply=await moreResponse;const body=JSON.parse(moreReply.request().postData());assert.equal(body.note,'rice');result.push('ingredient Load-more request retains composed note PASS');
await box('dishes','Ven Pongal');p=await pick();assert.ok(p.picks.every(x=>/ven pongal/i.test(x.name)));assert.match(p.noteInfo,/already suggested in the last 30 days/);assert.doesNotMatch(p.noteInfo,/no checked recipe name matches/);result.push('dish+ingredient AND -> actual named 30-day history cause PASS');
// List text visible below the fold, checked rice and first unchecked ingredient.
await page.evaluate(()=>document.querySelector('div[aria-label="all ingredients in your checked library"]').scrollIntoView({block:'center'}));
await page.screenshot({path:process.env.SCREENSHOT_PATH||'/tmp/e2e-main-ingredients-390.png'});
// Changing filter makes picks stale; rerun resets accumulated cards.
await box('dishes','Paruppu Poli');assert.ok(await page.evaluate(()=>document.body.textContent.includes('Note or filters changed since these picks')));p=await pick();assert.ok(p.picks.every(x=>/ven pongal|paruppu poli/i.test(x.name)));result.push('OR dishes AND rice + stale hint + fresh pick reset PASS');
await button('Clear all dishes');await button('Clear all ingredients');p=await pick();
let more=await page.$$('button');let before=await page.$$eval('article.card h3',es=>es.map(e=>e.textContent));
const resp=page.waitForResponse(r=>r.url().endsWith('/api/pick')&&r.request().method()==='POST');await button('Load more');let mr=await resp;assert.equal(mr.status(),200);await pause();
let after=await page.$$eval('article.card h3',es=>es.map(e=>e.textContent));assert.deepEqual(after.slice(0,before.length),before);assert.equal(new Set(after).size,after.length);result.push('Load more retains earlier cards + no duplicate names PASS');
await box('dishes','Ven Pongal');p=await pick();let now=await page.$$eval('article.card h3',es=>es.map(e=>e.textContent));assert.ok(now.filter(x=>x!=='AI answer').every(x=>/ven pongal/i.test(x)));result.push('filter change -> new pick clears broad-page append state PASS');
// Keyboard Space toggles a focused checkbox, removing and restoring the selected dish.
const checked='div[aria-label="all dishes in your checked library"] input:checked';await page.focus(checked);await page.keyboard.press('Space');await pause();assert.equal(await page.$$eval('div[aria-label="selected dishes"] button',es=>es.length),0);await page.keyboard.press('Space');await pause();assert.equal(await page.$$eval('div[aria-label="selected dishes"] button',es=>es.length),1);result.push('keyboard focus+Space uncheck/recheck chip sync PASS');
assert.deepEqual(errors,[]);console.log(JSON.stringify({baseline:process.env.TEST_SHA||'working-tree',result,consoleErrors:errors,askCalls:calls.filter(x=>x.url.endsWith('/api/ask-ai')).length},null,2));
}catch(e){console.error(e);console.log(JSON.stringify({result,errors},null,2));await page.screenshot({path:'/tmp/e2e-main-matrix-failure.png'});process.exitCode=1}
finally{await browser.close()}
