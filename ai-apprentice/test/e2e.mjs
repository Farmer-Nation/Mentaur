import pkg from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pkg;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
const mkpage = async (ctx, tag) => { const p = await ctx.newPage(); p.on('pageerror', e => errs.push(tag+':'+e.message)); p.on('console', m => { if (m.type()==='error' && !/403|Failed to load resource/.test(m.text())) errs.push(tag+'console:'+m.text()); }); return p; };

// --- Guide opens a room ---
const gctx = await b.newContext({ viewport:{width:1180,height:820} });
const guide = await mkpage(gctx, 'G');
await guide.goto('http://localhost:8787');
await guide.click('#startGuide');
await guide.waitForURL(/room\.html\?code=/);
await guide.waitForSelector('#queue');
const url = guide.url();
const code = new URL(url).searchParams.get('code');
console.log('Room code:', code);

// --- Student joins same room ---
const sctx = await b.newContext({ viewport:{width:1180,height:820} });
const student = await mkpage(sctx, 'S');
await student.goto('http://localhost:8787');
await student.fill('#joinCode', code);
await student.click('#joinStudent');
await student.waitForURL(/room\.html\?code=/);
await student.waitForSelector('#mirror', { timeout: 6000 });
await guide.waitForTimeout(600);
console.log('Guide presence text:', (await guide.locator('#presence').innerText()).replace(/\n/g,' '));

// --- Guide processes INV-4471: capex + approve ---
await guide.click('text=INV-4471');
await guide.selectOption('#ccSel', '0400');
// student should see the event appear live
await student.waitForSelector('.msg.event', { timeout: 6000 });
console.log('Student sees event:', (await student.locator('.msg.event').last().innerText()).slice(0,45));
// guide gets an AI question after the pause (via SSE watcher)
await guide.waitForSelector('.msg.agent .bubble', { timeout: 8000 });
console.log('Guide AI question:', (await guide.locator('.msg.agent .bubble').last().innerText()).slice(0,45));
// student sees suggested questions
await student.waitForTimeout(500);
console.log('Student suggestions:', await student.locator('.suggchip').count());

// --- Guide answers the AI ---
await guide.fill('#replyBox', 'Equipment over 5000 euros is always capex.');
await guide.click('#sendBtn');
await student.waitForTimeout(500);
// student should see the guide's answer in their transcript (real-time)
const sawGuideAnswer = await student.locator('.msg.guide .bubble').count();
console.log('Student saw guide answer bubbles:', sawGuideAnswer);

// --- Student asks a question (reverse direction) ---
await student.fill('#replyBox', 'Who approves capex over 10k?');
await student.click('#sendBtn');
await guide.waitForTimeout(500);
const guideSawStudent = await guide.locator('.msg.student .bubble').count();
console.log('Guide saw student question bubbles:', guideSawStudent);
// guide answers the student
await guide.fill('#replyBox', 'The controller signs off above 10k.');
await guide.click('#sendBtn');
await student.waitForTimeout(400);

await guide.screenshot({ path:'test/e2e-guide.png' });
await student.screenshot({ path:'test/e2e-student.png' });

// --- finish the task to reach curriculum ---
await guide.click('#approveBtn'); await guide.waitForTimeout(2600);
await guide.fill('#replyBox','No asset number, no capex booking.'); await guide.click('#sendBtn'); await guide.waitForTimeout(300);
await guide.click('text=Novák'); await guide.click('#escBtn'); await guide.waitForTimeout(2600);
await guide.fill('#replyBox','Czech subsidiary needs a second approval.'); await guide.click('#sendBtn'); await guide.waitForTimeout(300);
await guide.click('text=Weber'); await guide.click('#holdBtn'); await guide.waitForTimeout(2600);
await guide.fill('#replyBox','Weber double-bills in December, hold and reconcile.'); await guide.click('#sendBtn'); await guide.waitForTimeout(1200);
await guide.waitForSelector('#startDebrief', { timeout: 6000 }); await guide.click('#startDebrief'); await guide.waitForTimeout(700);
for (let i=0;i<10;i++){ if (await guide.locator('#confirmTB').count()) break; await guide.fill('#replyBox','Stop and ask the controller if the asset number is missing.'); await guide.click('#sendBtn'); await guide.waitForTimeout(650); }
console.log('Teach-back shown to guide:', await guide.locator('#confirmTB').count());
await guide.click('#confirmTB'); await guide.waitForTimeout(1000);

// both should now see curriculum
console.log('Guide lessons:', await guide.locator('.lesson').count());
await student.waitForSelector('.lesson', { timeout: 6000 });
console.log('Student lessons (live):', await student.locator('.lesson').count());
await student.screenshot({ path:'test/e2e-curriculum.png', fullPage:true });

// --- student practices: wrong then right ---
await student.click('#startPractice'); await student.waitForSelector('#tccSel');
await student.selectOption('#tccSel','4711'); await student.click('#tApprove'); await student.waitForTimeout(700);
console.log('Practice catch:', (await student.locator('.msg.agent .bubble').last().innerText()).slice(0,40));
await student.selectOption('#tccSel','0400'); await student.click('#tApprove'); await student.waitForTimeout(700);
console.log('Scorecard:', await student.locator('.scorecard').count());
await student.screenshot({ path:'test/e2e-practice.png' });

console.log('ERRORS:', errs.length ? errs.join(' | ') : 'none');
await b.close();
