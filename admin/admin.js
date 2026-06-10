'use strict';
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function toast(msg, err){const t=document.createElement('div');t.className='toast';if(err)t.style.background='#b91c1c';t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),2600);}
async function api(url, opts={}){
  const r = await fetch(url, { credentials:'same-origin', headers:{'Content-Type':'application/json'}, ...opts });
  const d = await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(d.error || ('HTTP '+r.status));
  return d;
}
function timeAgo(iso){ if(!iso) return ''; let s=String(iso); if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) s=s.replace(' ','T')+'Z'; const diff=(Date.now()-new Date(s).getTime())/1000; if(isNaN(diff))return''; if(diff<60)return'just now'; if(diff<3600)return Math.floor(diff/60)+'m'; if(diff<86400)return Math.floor(diff/3600)+'h'; if(diff<604800)return Math.floor(diff/86400)+'d'; return new Date(s).toLocaleDateString(); }
function parseTs(s){ if(!s)return null; let str=String(s); if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(str)) str=str.replace(' ','T')+'Z'; const d=new Date(str); return isNaN(d.getTime())?null:d; }
function initials(name, wa){ if(name&&name.trim()){const p=name.trim().split(/\s+/);return ((p[0][0]||'')+(p[1]?p[1][0]:'')).toUpperCase();} return String(wa||'').slice(-2)||'#'; }
function fmtPhone(wa){ const d=String(wa||''); if(/^91\d{10}$/.test(d)) return '+91 '+d.slice(2,7)+' '+d.slice(7); return d?'+'+d:''; }

// ───────── Auth + boot ─────────
(async function init(){
  try{ const me = await api('/api/auth/me'); if(me.authenticated){ showApp(me); } else showLogin(); }
  catch{ showLogin(); }
})();
function showLogin(){ $('#view-login').classList.remove('hidden'); $('#view-app').classList.add('hidden'); }
function showApp(me){ $('#view-login').classList.add('hidden'); $('#view-app').classList.remove('hidden'); $('#me-name').textContent=me.username||'admin'; nav('dashboard'); startNotifier(); }

$('#login-form').addEventListener('submit', async e=>{
  e.preventDefault(); $('#login-error').classList.add('hidden');
  try{ const r=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:$('#login-username').value.trim(),password:$('#login-password').value})}); showApp(r); }
  catch(err){ $('#login-error').textContent=err.message; $('#login-error').classList.remove('hidden'); }
});
$('#logout-btn').addEventListener('click', async()=>{ await api('/api/auth/logout',{method:'POST'}); location.reload(); });

// ───────── Nav ─────────
function nav(name){
  $$('.pane').forEach(p=>p.classList.toggle('hidden', p.dataset.pane!==name));
  $$('.nav-item').forEach(b=>b.classList.toggle('bg-white/10', b.dataset.nav===name));
  if(name==='dashboard') loadDashboard();
  if(name==='whatsapp') loadWhatsApp();
  if(name==='leads') loadLeads();
  if(name==='settings') loadSettings();
}
$$('.nav-item').forEach(b=>b.addEventListener('click',()=>nav(b.dataset.nav)));

// ───────── Global notifier (badge) ─────────
let knownUnread=null;
async function notifierTick(){ try{ const d=await api('/api/admin/whatsapp/unread-count'); const n=d.totalUnread||0; const b=$('#wa-badge'); if(n>0){b.textContent=n>99?'99+':n;b.classList.remove('hidden');}else b.classList.add('hidden'); if(knownUnread!==null && n>knownUnread) beep(); knownUnread=n; }catch{} }
function startNotifier(){ notifierTick(); setInterval(notifierTick, 15000); }
let audioCtx=null;
document.addEventListener('click',()=>{ if(!audioCtx){try{audioCtx=new (window.AudioContext||window.webkitAudioContext)();}catch{}} },{once:true});
function beep(){ try{ if(!audioCtx)return; const o=audioCtx.createOscillator(),g=audioCtx.createGain(); o.type='sine';o.frequency.value=880; g.gain.setValueAtTime(0.0001,audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(0.25,audioCtx.currentTime+0.02); g.gain.exponentialRampToValueAtTime(0.0001,audioCtx.currentTime+0.4); o.connect(g);g.connect(audioCtx.destination);o.start();o.stop(audioCtx.currentTime+0.42);}catch{} }

// ───────── Dashboard ─────────
async function loadDashboard(){
  const box=$('#dash-stats'); box.innerHTML='';
  let unread=0, contacts=0, leads=0, st={};
  try{ unread=(await api('/api/admin/whatsapp/unread-count')).totalUnread||0; }catch{}
  try{ st=await api('/api/admin/whatsapp/status'); }catch{}
  // contacts/leads need unlock; best-effort
  const cards=[
    {label:'Unread WhatsApp',val:unread,icon:'💬'},
    {label:'WhatsApp',val:st.configured?'Connected':'Not set',icon:'🔗'},
    {label:'AI auto-reply',val:st.botEnabled?'On':'Off',icon:'🤖'},
    {label:'',val:'',icon:''}
  ];
  box.innerHTML=cards.filter(c=>c.label).map(c=>`<div class="bg-white border border-gray-200 rounded-xl p-4"><div class="text-2xl">${c.icon}</div><div class="text-xl font-extrabold mt-1">${esc(c.val)}</div><div class="text-xs text-gray-500">${esc(c.label)}</div></div>`).join('');
  $('#dash-conn').innerHTML = st.configured ? '<span class="text-emerald-600 font-semibold">● WhatsApp connected'+(st.botEnabled?' · AI on':'')+'</span>' : '<span class="text-amber-600">● WhatsApp not connected — add credentials in Settings.</span>';
}

// ═══════════ WHATSAPP ═══════════
const wa = { active:null, convos:[], lastMsgN:0, pollTimer:null, sub:'chats' };
async function loadWhatsApp(){
  // Section lock removed — go straight in (admin login is the only gate).
  $('#wa-gate').classList.add('hidden'); $('#wa-app').classList.remove('hidden');
  try{ const st=await api('/api/admin/whatsapp/status'); $('#wa-status-pill').innerHTML = st.configured?(st.botEnabled?'<span class="text-emerald-600 font-semibold">● Connected · AI on</span>':'<span class="text-amber-600 font-semibold">● Connected · AI off</span>'):'<span class="text-gray-400">● Not connected</span>'; }catch{}
  loadSpend(); waShowSub(wa.sub||'chats');
}
$('#wa-unlock-btn').addEventListener('click', async()=>{
  try{ await api('/api/admin/whatsapp/unlock',{method:'POST',body:JSON.stringify({password:$('#wa-pw').value})}); $('#wa-pw').value=''; loadWhatsApp(); }
  catch(e){ toast(e.message,true); }
});
$('#wa-pw').addEventListener('keydown',e=>{if(e.key==='Enter')$('#wa-unlock-btn').click();});
$('#wa-lock-btn').addEventListener('click', async()=>{ await api('/api/admin/whatsapp/lock',{method:'POST'}); stopPoll(); loadWhatsApp(); });
$('#wa-refresh').addEventListener('click', loadWhatsApp);

$$('[data-wa]').forEach(b=>b.addEventListener('click',()=>waShowSub(b.dataset.wa)));
function waShowSub(name){
  wa.sub=name;
  $$('[data-wa]').forEach(b=>b.classList.toggle('active', b.dataset.wa===name));
  $$('.wa-sub').forEach(p=>p.classList.toggle('hidden', p.dataset.wasub!==name));
  stopPoll();
  if(name==='chats'){ loadConvos(); wa.pollTimer=setInterval(()=>{loadConvos();if(wa.active)refreshThread();},7000); }
  if(name==='contacts'){ loadContacts(); loadFbStatus(); }
  if(name==='broadcast'){ loadBroadcasts(); }
  if(name==='templates'){ loadTemplates(); }
  if(name==='sequences'){ loadSequences(); }
  if(name==='analytics'){ loadAnalytics(); }
}
function stopPoll(){ if(wa.pollTimer){clearInterval(wa.pollTimer);wa.pollTimer=null;} }

async function loadSpend(){
  try{ const d=await api('/api/admin/whatsapp/spend'); const f=n=>'₹'+Number(n||0).toLocaleString('en-IN'); $('#wa-spend').innerHTML=`<div><div class="text-xs text-gray-400">SPEND THIS MONTH</div><div class="font-extrabold">${f(d.estMonth)}</div></div><div><div class="text-xs text-gray-400">TOTAL</div><div class="font-extrabold">${f(d.estTotal)}</div></div><div><div class="text-xs text-gray-400">MARKETING MSGS</div><div class="font-extrabold">${d.paidTotal||0}</div></div>`; $('#wa-spend').classList.remove('hidden'); }catch{}
}

// ── Chats ──
async function loadConvos(){
  try{
    const d=await api('/api/admin/whatsapp/conversations'); wa.convos=d.conversations||[];
    const b=$('#wa-badge'); if(d.totalUnread>0){b.textContent=d.totalUnread>99?'99+':d.totalUnread;b.classList.remove('hidden');}else b.classList.add('hidden'); knownUnread=d.totalUnread||0;
    renderConvos();
  }catch(e){ $('#wa-convos').innerHTML='<p class="p-4 text-xs text-red-500">'+esc(e.message)+'</p>'; }
}
function renderConvos(){
  const q=($('#wa-search').value||'').toLowerCase().trim();
  let list=wa.convos; if(q) list=list.filter(c=>(c.name||'').toLowerCase().includes(q)||(c.wa_id||'').includes(q)||(c.last_message||'').toLowerCase().includes(q));
  const box=$('#wa-convos');
  if(!list.length){box.innerHTML='<p class="p-6 text-center text-xs text-gray-400">No conversations'+(q?' match':' yet')+'.</p>';return;}
  box.innerHTML=list.map(c=>`<button class="wa-convo ${c.wa_id===wa.active?'active':''}" data-waid="${esc(c.wa_id)}">
    <span class="wa-av">${esc(initials(c.name,c.wa_id))}</span>
    <span class="flex-1 min-w-0"><span class="flex justify-between"><span class="font-semibold text-sm truncate">${esc(c.name||fmtPhone(c.wa_id))}</span><span class="text-[10px] text-gray-400">${esc(timeAgo(c.last_at))}</span></span>
    <span class="block text-xs text-gray-500 truncate">${c.last_direction==='out'?'You: ':''}${esc((c.last_message||'').slice(0,50))}</span>
    ${c.label?`<span class="inline-block mt-1 text-[10px] font-bold px-2 rounded-full" style="background:#e7f6ee;color:#1a7d45">${esc(c.label)}</span>`:''}</span>
    ${c.unread?`<span class="badge">${c.unread}</span>`:''}</button>`).join('');
  box.querySelectorAll('.wa-convo').forEach(btn=>btn.addEventListener('click',()=>openThread(btn.dataset.waid)));
}
$('#wa-search').addEventListener('input',renderConvos);
async function openThread(waId){
  wa.active=waId; renderConvos();
  $('#wa-thread-empty').classList.add('hidden'); $('#wa-thread').classList.remove('hidden'); $('#wa-thread').classList.add('flex');
  $('#wa-messages').innerHTML='<p class="text-center text-xs text-gray-400 py-6">Loading…</p>';
  try{
    const d=await api('/api/admin/whatsapp/conversations/'+encodeURIComponent(waId));
    $('#wa-thread-name').textContent=d.name||fmtPhone(waId); $('#wa-thread-phone').textContent=fmtPhone(waId); $('#wa-thread-av').textContent=initials(d.name,waId);
    $('#wa-ai-pause').checked=!!d.ai_paused; $('#wa-thread-label').value=d.label||'';
    wa.lastMsgN=(d.messages||[]).length; renderMessages(d.messages||[]); loadConvos();
  }catch(e){ $('#wa-messages').innerHTML='<p class="text-center text-xs text-red-500 py-6">'+esc(e.message)+'</p>'; }
}
async function refreshThread(){ if(!wa.active)return; try{ const d=await api('/api/admin/whatsapp/conversations/'+encodeURIComponent(wa.active)); if((d.messages||[]).length!==wa.lastMsgN){wa.lastMsgN=(d.messages||[]).length;renderMessages(d.messages||[]);} }catch{} }
function renderMessages(msgs){
  const box=$('#wa-messages');
  if(!msgs.length){box.innerHTML='<p class="text-center text-xs text-gray-400 py-6">No messages.</p>';$('#wa-window-banner').classList.add('hidden');return;}
  const tick=m=>{ if(m.direction!=='out')return''; const s=m.status||'sent'; if(s==='failed')return'<span style="color:#e53935">✗</span>'; if(s==='read')return'<span style="color:#34b7f1">✓✓</span>'; if(s==='delivered')return'<span style="color:#8696a0">✓✓</span>'; return'<span style="color:#8696a0">✓</span>'; };
  box.innerHTML=msgs.map(m=>{const out=m.direction==='out';let media='';if(m.media_url)media=m.media_type==='image'?`<img src="${esc(m.media_url)}" style="max-width:200px;border-radius:8px;margin-bottom:4px">`:`<a href="${esc(m.media_url)}" target="_blank" style="color:#1a7d45;text-decoration:underline">📎 file</a><br>`;return `<div class="wa-row ${out?'out':'in'}"><div class="wa-bubble">${media}${esc(m.body||'')}<span class="wa-meta">${esc(timeAgo(m.created_at))} ${out&&m.engine&&m.engine!=='admin'?esc(m.engine):''} ${tick(m)}</span></div></div>`;}).join('');
  box.scrollTop=box.scrollHeight;
  renderWindow(msgs);
}
function renderWindow(msgs){
  const el=$('#wa-window-banner'); let lastIn=null;
  for(let i=msgs.length-1;i>=0;i--){if(msgs[i].direction==='in'){lastIn=msgs[i].created_at;break;}}
  const OPEN='text-xs px-4 py-2 border-t font-medium bg-emerald-50 text-emerald-700';
  const SHUT='text-xs px-4 py-2 border-t font-medium bg-amber-50 text-amber-800';
  const ts=parseTs(lastIn);
  if(!ts){ el.className=SHUT; el.innerHTML='⚠️ No reply yet — outside the 24h window only an approved <b>template</b> can be sent.'; el.classList.remove('hidden'); return; }
  const left=24*3600*1000-(Date.now()-ts.getTime());
  if(left>0){ const h=Math.floor(left/3600000),m=Math.floor((left%3600000)/60000); el.className=OPEN; el.innerHTML=`✅ Free-reply window open — <b>${h}h ${m}m</b> left.`; }
  else { el.className=SHUT; el.innerHTML='⚠️ 24-hour window closed — free replies will fail. Send an approved <b>template</b>.'; }
  el.classList.remove('hidden');
}
function sendReply(){ const inp=$('#wa-reply-input'); const body=(inp.value||'').trim(); if(!body||!wa.active)return; inp.value='';inp.style.height='auto';
  api('/api/admin/whatsapp/conversations/'+encodeURIComponent(wa.active)+'/reply',{method:'POST',body:JSON.stringify({body})}).then(r=>{if(r.sendError)toast(r.sendError,!r.sent);openThread(wa.active);}).catch(e=>toast(e.message,true)); }
$('#wa-reply-send').addEventListener('click',sendReply);
$('#wa-reply-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendReply();}});
$('#wa-reply-input').addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(e.target.scrollHeight,96)+'px';});
$('#wa-ai-pause').addEventListener('change',e=>{ if(!wa.active)return; api('/api/admin/whatsapp/conversations/'+encodeURIComponent(wa.active)+'/ai-pause',{method:'POST',body:JSON.stringify({paused:e.target.checked})}).then(()=>toast(e.target.checked?'AI paused':'AI resumed')).catch(err=>toast(err.message,true)); });
$('#wa-thread-label').addEventListener('change',e=>{ if(!wa.active)return; api('/api/admin/whatsapp/conversations/'+encodeURIComponent(wa.active)+'/label',{method:'POST',body:JSON.stringify({label:e.target.value})}).then(()=>{toast('Label updated');loadConvos();}).catch(err=>toast(err.message,true)); });

// ── Contacts ──
async function loadFbStatus(){
  try{ const d=await api('/api/admin/fb/status'); const box=$('#fb-status');
    if(d.count){ box.innerHTML=`<span style="color:#1877F2;font-weight:700">📘 Meta Lead Ads</span><span class="text-emerald-600">Connected — ${d.count} page(s). Campaign leads auto-import, tagged by campaign.</span><a href="/api/admin/fb/connect" class="ml-auto text-xs border border-gray-300 rounded-lg px-3 py-1.5">Reconnect</a><button onclick="fbDisconnect()" class="text-xs border border-gray-300 rounded-lg px-3 py-1.5">Disconnect</button>`; }
    else if(d.configured){ box.innerHTML=`<span style="color:#1877F2;font-weight:700">📘 Meta Lead Ads</span><span class="text-gray-500">Not connected yet.</span><a href="/api/admin/fb/connect" class="ml-auto text-white text-xs rounded-lg px-3 py-1.5" style="background:#1877F2">Connect Facebook</a>`; }
    else box.innerHTML=`<span style="color:#1877F2;font-weight:700">📘 Meta Lead Ads</span><span class="text-gray-500">Add your Meta App ID &amp; Secret in Settings to connect.</span>`;
  }catch{ $('#fb-status').innerHTML=''; }
}
window.fbDisconnect=async()=>{ if(!confirm('Disconnect all Facebook pages?'))return; await api('/api/admin/fb/disconnect',{method:'POST'}); loadFbStatus(); };
let contactTag='';
async function loadContacts(){
  try{
    const q=($('#wac-search').value||'').trim();
    const d=await api('/api/admin/whatsapp/contacts?q='+encodeURIComponent(q)+'&tag='+encodeURIComponent(contactTag));
    $('#wac-tags').innerHTML=`<button onclick="setTag('')" class="px-2 py-1 rounded-full border ${contactTag?'':'bg-[#15291f] text-white'}">All (${d.total})</button>`+(d.tags||[]).map(t=>`<button onclick="setTag('${esc(t.name).replace(/'/g,"\\'")}')" class="px-2 py-1 rounded-full border ${contactTag===t.name?'bg-[#15291f] text-white':''}">${esc(t.name)} (${t.count})</button>`).join('');
    const rows=(d.contacts||[]).map(c=>`<tr class="border-t border-gray-100"><td class="px-3 py-2">${esc(c.name||'—')}</td><td class="px-3 py-2 font-mono text-xs">${esc(fmtPhone(c.wa_id))}</td><td class="px-3 py-2">${(c.tags||'').split(',').filter(Boolean).map(t=>`<span class="inline-block text-[10px] bg-gray-100 px-2 rounded-full mr-1">${esc(t.trim())}</span>`).join('')}</td><td class="px-3 py-2 text-xs text-gray-400">${esc(timeAgo(c.created_at))}</td><td class="px-3 py-2 text-right"><button onclick="delContact(${c.id})" class="text-red-400 hover:text-red-600 text-xs">Delete</button></td></tr>`).join('');
    $('#wac-list').innerHTML=`<table class="w-full text-sm"><thead><tr class="text-left text-xs text-gray-400"><th class="px-3 py-2">NAME</th><th class="px-3 py-2">NUMBER</th><th class="px-3 py-2">TAGS</th><th class="px-3 py-2">ADDED</th><th></th></tr></thead><tbody>${rows||'<tr><td class="px-3 py-6 text-center text-gray-400" colspan="5">No contacts.</td></tr>'}</tbody></table>`;
  }catch(e){ $('#wac-list').innerHTML='<p class="p-4 text-xs text-red-500">'+esc(e.message)+'</p>'; }
}
window.setTag=t=>{contactTag=t;loadContacts();};
window.delContact=async id=>{ if(!confirm('Delete this contact?'))return; await api('/api/admin/whatsapp/contacts/'+id,{method:'DELETE'}); loadContacts(); };
$('#wac-search').addEventListener('input',()=>{clearTimeout(window._wacT);window._wacT=setTimeout(loadContacts,300);});
$('#wac-add').addEventListener('click',async()=>{ try{ await api('/api/admin/whatsapp/contacts',{method:'POST',body:JSON.stringify({name:$('#wac-name').value,phone:$('#wac-phone').value,tags:$('#wac-newtags').value})}); $('#wac-name').value='';$('#wac-phone').value='';$('#wac-newtags').value=''; toast('Contact saved'); loadContacts(); }catch(e){toast(e.message,true);} });
$('#wac-import').addEventListener('click',async()=>{ try{ const r=await api('/api/admin/whatsapp/contacts/import',{method:'POST',body:JSON.stringify({numbers:$('#wac-import-nums').value,tags:$('#wac-import-tags').value})}); $('#wac-import-nums').value=''; toast(`Added ${r.added}, updated ${r.updated}`); loadContacts(); }catch(e){toast(e.message,true);} });
$('#wac-export').addEventListener('click',()=>window.open('/api/admin/whatsapp/contacts/export','_blank'));

// ── Broadcast ──
$('#bc-audience').addEventListener('change',e=>{ $('#bc-numbers').classList.toggle('hidden',e.target.value!=='paste'); $('#bc-tag').classList.toggle('hidden',e.target.value!=='tag'); });
$('#bc-send').addEventListener('click',async()=>{
  const body={ audience:$('#bc-audience').value, numbers:$('#bc-numbers').value, tag:$('#bc-tag').value, template:$('#bc-template').value.trim(), lang:$('#bc-lang').value.trim()||'en_US', params:$('#bc-params').value.split(',').map(s=>s.trim()).filter(Boolean), scheduledAt:$('#bc-schedule').value, preview:'Template: '+$('#bc-template').value.trim() };
  try{ const r=await api('/api/admin/whatsapp/broadcast',{method:'POST',body:JSON.stringify(body)}); $('#bc-result').innerHTML=r.scheduled?'<span class="text-emerald-600">✓ Scheduled.</span>':`<span class="text-emerald-600">✓ Sending to ${r.total} numbers…</span>`; loadBroadcasts(); }
  catch(e){ $('#bc-result').innerHTML='<span class="text-red-500">'+esc(e.message)+'</span>'; }
});
async function loadBroadcasts(){
  try{ const d=await api('/api/admin/whatsapp/broadcasts'); $('#bc-history').innerHTML=(d.broadcasts||[]).map(b=>`<div class="bg-white border border-gray-200 rounded-lg p-3 text-sm flex items-center gap-3"><div class="flex-1"><div class="font-semibold">${esc(b.template)} <span class="text-xs text-gray-400">${esc(b.status)}</span></div><div class="text-xs text-gray-500">${esc(b.preview||'')}</div></div><div class="text-xs text-right">${b.sent}/${b.total} sent${b.failed?` · ${b.failed} failed`:''}<div class="text-gray-400">${esc(timeAgo(b.created_at))}</div></div>${b.status==='scheduled'?`<button onclick="cancelBc(${b.id})" class="text-xs text-red-400">Cancel</button>`:''}</div>`).join('')||'<p class="text-xs text-gray-400">No broadcasts yet.</p>'; }catch{}
}
window.cancelBc=async id=>{ await api('/api/admin/whatsapp/broadcasts/'+id+'/cancel',{method:'POST'}); loadBroadcasts(); };

// ── Templates ──
async function loadTemplates(){
  $('#tpl-list').innerHTML='<p class="text-xs text-gray-400">Loading…</p>';
  try{ const d=await api('/api/admin/whatsapp/templates'); $('#tpl-list').innerHTML=(d.templates||[]).map(t=>`<div class="bg-white border border-gray-200 rounded-lg p-3 text-sm flex items-start gap-3"><div class="flex-1"><div class="font-semibold">${esc(t.name)} <span class="text-[10px] px-2 rounded-full ${t.status==='APPROVED'?'bg-emerald-100 text-emerald-700':'bg-amber-100 text-amber-700'}">${esc(t.status||'')}</span> <span class="text-xs text-gray-400">${esc(t.category||'')} · ${esc((t.language||''))}</span></div><div class="text-xs text-gray-600 mt-1">${esc(((t.components||[]).find(c=>c.type==='BODY')||{}).text||'')}</div></div><button onclick="delTpl('${esc(t.name)}')" class="text-red-400 text-xs">Delete</button></div>`).join('')||'<p class="text-xs text-gray-400">No templates. Create them in Meta Business Manager.</p>'; }
  catch(e){ $('#tpl-list').innerHTML='<p class="text-xs text-red-500">'+esc(e.message)+'</p>'; }
}
$('#tpl-refresh').addEventListener('click',loadTemplates);
window.delTpl=async name=>{ if(!confirm('Delete template '+name+'?'))return; try{await api('/api/admin/whatsapp/templates/'+encodeURIComponent(name),{method:'DELETE'});loadTemplates();}catch(e){toast(e.message,true);} };

// ── Sequences ──
let seqSteps=[{delay_hours:24,template:'',lang:'en_US',params:''}];
function renderSeqSteps(){ $('#seq-steps').innerHTML=seqSteps.map((s,i)=>`<div class="border border-gray-200 rounded-lg p-2 space-y-1"><div class="flex gap-1"><input value="${s.delay_hours}" onchange="seqSteps[${i}].delay_hours=this.value" class="w-16 border border-gray-300 rounded px-2 py-1 text-xs" placeholder="hrs"><span class="text-xs text-gray-400 self-center">hrs after prev</span></div><input value="${esc(s.template)}" onchange="seqSteps[${i}].template=this.value" placeholder="template name" class="w-full border border-gray-300 rounded px-2 py-1 text-xs"><input value="${esc(s.lang)}" onchange="seqSteps[${i}].lang=this.value" placeholder="en_US" class="w-full border border-gray-300 rounded px-2 py-1 text-xs"></div>`).join(''); }
$('#seq-addstep').addEventListener('click',()=>{seqSteps.push({delay_hours:24,template:'',lang:'en_US',params:''});renderSeqSteps();});
$('#seq-save').addEventListener('click',async()=>{ try{ await api('/api/admin/whatsapp/sequences',{method:'POST',body:JSON.stringify({name:$('#seq-name').value.trim(),trigger_tag:$('#seq-trigger').value.trim(),steps:seqSteps.map(s=>({delay_hours:Number(s.delay_hours)||0,template:s.template,lang:s.lang,params:[]}))})}); $('#seq-name').value='';$('#seq-trigger').value='';seqSteps=[{delay_hours:24,template:'',lang:'en_US',params:''}];renderSeqSteps(); toast('Sequence saved'); loadSequences(); }catch(e){toast(e.message,true);} });
async function loadSequences(){ renderSeqSteps();
  try{ const d=await api('/api/admin/whatsapp/sequences'); $('#seq-list').innerHTML=(d.sequences||[]).map(s=>`<div class="bg-white border border-gray-200 rounded-lg p-3 text-sm flex items-center gap-3"><div class="flex-1"><div class="font-semibold">${esc(s.name)} ${s.trigger_tag?`<span class="text-[10px] bg-gray-100 px-2 rounded-full">tag: ${esc(s.trigger_tag)}</span>`:''}</div><div class="text-xs text-gray-500">${s.steps.length} steps · ${s.enrolled} enrolled</div></div><button onclick="delSeq(${s.id})" class="text-red-400 text-xs">Delete</button></div>`).join('')||'<p class="text-xs text-gray-400">No sequences yet. Create one on the right.</p>'; }catch{}
}
window.delSeq=async id=>{ if(!confirm('Delete sequence?'))return; await api('/api/admin/whatsapp/sequences/'+id,{method:'DELETE'}); loadSequences(); };

// ── Analytics ──
async function loadAnalytics(){
  try{ const d=await api('/api/admin/whatsapp/analytics'); const o=d.overall||{};
    $('#an-cards').innerHTML=[['Sent',o.sent,''],['Delivered',o.delivered,o.deliveryRate+'% delivered'],['Read',o.read,o.readRate+'% read'],['Failed',o.failed,o.failRate+'% failed']].map(c=>`<div class="bg-white border border-gray-200 rounded-xl p-4"><div class="text-xs text-gray-400">${c[0].toUpperCase()}</div><div class="text-2xl font-extrabold mt-1">${c[1]||0}</div><div class="text-xs text-gray-500">${c[2]}</div></div>`).join('');
    $('#an-campaigns').innerHTML='<h3 class="font-semibold text-sm mb-2">Recent campaigns</h3>'+((d.campaigns||[]).map(c=>`<div class="flex items-center gap-3 text-sm py-2 border-t border-gray-100"><div class="flex-1"><div class="font-semibold">${esc(c.template)}</div><div class="text-xs text-gray-500">${esc(c.preview||'')}</div></div><div class="text-xs text-right">${c.sent}/${c.total} · read ${c.read}</div></div>`).join('')||'<p class="text-xs text-gray-400">No campaigns yet.</p>');
  }catch(e){ $('#an-cards').innerHTML='<p class="text-xs text-red-500">'+esc(e.message)+'</p>'; }
}

// ═══════════ LEADS ═══════════
async function loadLeads(){
  // Section lock removed — go straight in (admin login is the only gate).
  $('#leads-gate').classList.add('hidden'); $('#leads-app').classList.remove('hidden'); loadLeadsList();
}
$('#leads-unlock-btn').addEventListener('click',async()=>{ try{ await api('/api/admin/leads/unlock',{method:'POST',body:JSON.stringify({password:$('#leads-pw').value})}); $('#leads-pw').value=''; loadLeads(); }catch(e){toast(e.message,true);} });
$('#leads-pw').addEventListener('keydown',e=>{if(e.key==='Enter')$('#leads-unlock-btn').click();});
$('#leads-lock').addEventListener('click',async()=>{ await api('/api/admin/leads/lock',{method:'POST'}); loadLeads(); });
$('#leads-source').addEventListener('change',loadLeadsList);
$('#leads-markall').addEventListener('click',async()=>{ await api('/api/admin/leads/mark-all-read',{method:'POST'}); loadLeadsList(); });
$('#leads-export').addEventListener('click',()=>{ const s=$('#leads-source').value; window.open('/api/admin/leads/export'+(s?'?source='+s:''),'_blank'); });
async function loadLeadsList(){
  const s=$('#leads-source').value;
  try{ const d=await api('/api/admin/leads?limit=200'+(s?'&source='+s:''));
    const rows=(d.leads||[]).map(l=>`<tr class="border-t border-gray-100 ${l.is_read?'':'bg-amber-50/40'}"><td class="px-3 py-2"><div class="font-semibold">${esc(l.name||'—')}</div><div class="text-xs text-gray-500">${esc(l.phone||'')} ${l.email?'· '+esc(l.email):''}</div></td><td class="px-3 py-2 text-xs">${esc(l.message||l.interested_in||'')}</td><td class="px-3 py-2"><span class="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">${esc((l.source||'').replace('_',' '))}</span></td><td class="px-3 py-2 text-xs text-gray-400">${esc(timeAgo(l.created_at))}</td><td class="px-3 py-2 text-right text-xs"><button onclick="delLead(${l.id})" class="text-red-400">Delete</button></td></tr>`).join('');
    $('#leads-list').innerHTML=`<table class="w-full text-sm"><thead><tr class="text-left text-xs text-gray-400"><th class="px-3 py-2">LEAD</th><th class="px-3 py-2">MESSAGE</th><th class="px-3 py-2">SOURCE</th><th class="px-3 py-2">RECEIVED</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="5" class="px-3 py-8 text-center text-gray-400">No leads yet.</td></tr>'}</tbody></table>`;
  }catch(e){ $('#leads-list').innerHTML='<p class="p-4 text-xs text-red-500">'+esc(e.message)+'</p>'; }
}
window.delLead=async id=>{ if(!confirm('Delete this lead?'))return; await api('/api/admin/leads/'+id,{method:'DELETE'}); loadLeadsList(); };

// ═══════════ SETTINGS ═══════════
async function loadSettings(){
  $('#webhook-url').textContent=location.origin+'/api/whatsapp/webhook';
  try{
    const s=await api('/api/settings'); const f=$('#settings-form');
    for(const el of f.elements){ if(!el.name)continue;
      if(el.type==='checkbox'){ el.checked = s[el.name]!=='0'; } // default ON unless explicitly '0'
      else if(el.type==='password'){ el.value=''; }
      else if(s[el.name]!=null){ el.value=s[el.name]; } }
    $('#wa-tok-set').textContent=s.whatsapp_token_set?'✓ saved':''; $('#wa-sec-set').textContent=s.whatsapp_app_secret_set?'✓ saved':'';
    $('#k-gem').textContent=s.gemini_api_key_set?'✓ saved':''; $('#k-groq').textContent=s.groq_api_key_set?'✓ saved':''; $('#k-claude').textContent=s.anthropic_api_key_set?'✓ saved':'';
  }catch(e){ toast(e.message,true); }
}
$('#settings-form').addEventListener('submit',async e=>{
  e.preventDefault(); const f=e.target; const body={};
  for(const el of f.elements){ if(!el.name)continue; if(el.type==='checkbox') body[el.name]=el.checked?'1':'0'; else if(el.type==='password'){ if(el.value.trim()) body[el.name]=el.value; } else body[el.name]=el.value; }
  try{ await api('/api/settings',{method:'PUT',body:JSON.stringify(body)}); toast('Settings saved'); loadSettings(); }catch(err){toast(err.message,true);}
});
$('#pw-save').addEventListener('click',async()=>{
  const section=$('#pw-section').value;
  try{ await api('/api/admin/'+section+'/change-password',{method:'POST',body:JSON.stringify({current:$('#pw-current').value,next:$('#pw-next').value})}); $('#pw-current').value='';$('#pw-next').value=''; toast('Password changed'); }
  catch(e){ toast(e.message,true); }
});
