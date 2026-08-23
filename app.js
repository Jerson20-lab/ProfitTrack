/* ===================================================================
   ProfitTrack - Multi-business P&L tracker (local-only)
   -------------------------------------------------------------------
   Data model (v2):
   root = { businesses: [ business ], activeBusinessId }
   business = {
     id, name, currency, startingBalance,
     categories: [string],
     deals:      [ { id, name } ],          // "Deal" = project/venture (optional)
     partners:   [ { id, name, sharePct, scope:'business'|'deal', dealId? } ],
     payouts:    [ { id, partnerId, amount, date, note } ],
     transactions: [ { id, type, amount, category, date, description, createdAt, dealId? } ]
   }
   Partner earned share = netProfit(scope) * sharePct/100   (LOSS CARRIED FORWARD -> can be negative)
   Owed = earnedShare - sum(payouts)
   =================================================================== */

'use strict';

const STORAGE_KEY = 'profittrack.v2';
const DEFAULT_CATEGORIES = ['Sales','Inventory','Shipping','Supplies','Advertising','Payroll','Other'];
const CURRENCY_SYMBOLS = { USD:'$', DOP:'RD$', EUR:'€', GBP:'£', CAD:'$', AUD:'$' };
const DISPLAY_CURRENCIES = ['USD','DOP','EUR','GBP','CAD','AUD'];
// Sensible manual fallback rates (units per 1 USD). Editable in Settings.
const DEFAULT_MANUAL_RATES = { USD:1, DOP:60, EUR:0.92, GBP:0.79, CAD:1.36, AUD:1.52 };

/* ---------- State ---------- */
let root = loadState();

function defaultRoot() {
  return {
    businesses: [], activeBusinessId: null,
    displayCurrency: 'USD',
    fxCache: null,                                  // { base:'USD', rates:{...}, ts }
    manualRates: { ...DEFAULT_MANUAL_RATES }
  };
}

function newBusiness(name, currency, startingBalance) {
  return {
    id: uid(), name: name || 'My Business',
    currency: currency || 'USD',
    startingBalance: startingBalance || 0,
    categories: [...DEFAULT_CATEGORIES],
    deals: [], partners: [], payouts: [], transactions: []
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return migrateV1() || defaultRoot();
    const parsed = JSON.parse(raw);
    const merged = { ...defaultRoot(), ...parsed };
    merged.manualRates = { ...DEFAULT_MANUAL_RATES, ...(parsed.manualRates || {}) };
    return merged;
  } catch (e) { return defaultRoot(); }
}

// Best-effort migration from the old single-business v1 store
function migrateV1() {
  try {
    const raw = localStorage.getItem('profittrack.v1');
    if (!raw) return null;
    const old = JSON.parse(raw);
    const b = newBusiness(old.businessName, old.currency, old.startingBalance);
    b.categories = old.categories || [...DEFAULT_CATEGORIES];
    b.transactions = (old.transactions || []).map(t => ({ ...t }));
    return { businesses: [b], activeBusinessId: null };
  } catch (e) { return null; }
}

function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(root)); }

/* ---------- UI transient state ---------- */
let currentPeriod = 'month';
let homePeriod = 'month';
let currentFilter = 'all';
let searchTerm = '';
let editingTxId = null;
let sheetType = 'income';
let editingPartnerId = null;
let payoutPartnerId = null;

/* ---------- Utils ---------- */
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,8); }
function activeBiz() { return root.businesses.find(b => b.id === root.activeBusinessId) || null; }
function currencySymbol(b) { return CURRENCY_SYMBOLS[(b || activeBiz() || {}).currency] || '$'; }

function fmtMoney(value, { sign=false, biz=null } = {}) {
  const sym = currencySymbol(biz);
  const num = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 });
  let prefix = '';
  if (sign) prefix = value >= 0 ? '+' : '-';
  else if (value < 0) prefix = '-';
  return `${prefix}${sym}${num}`;
}
function todayISO() {
  const d = new Date(); const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off*60000).toISOString().slice(0,10);
}

/* ---------- FX / currency conversion ----------
   Rates are expressed as "units of currency per 1 USD" (USD base).
   Priority: live fxCache -> manualRates -> 1 (USD). */
let fxStatus = 'manual'; // 'live' | 'cached' | 'manual'

function getRate(cur) {
  if (cur === 'USD') return 1;
  if (root.fxCache && root.fxCache.rates && isFinite(root.fxCache.rates[cur]) && root.fxCache.rates[cur] > 0) {
    return root.fxCache.rates[cur];
  }
  const m = (root.manualRates || {})[cur];
  if (isFinite(m) && m > 0) return m;
  return null; // unknown
}

function convert(amount, fromCur, toCur) {
  if (!isFinite(amount)) return 0;
  if (fromCur === toCur) return amount;
  const rf = getRate(fromCur), rt = getRate(toCur);
  if (!rf || !rt) return amount; // can't convert safely -> pass through (flagged elsewhere)
  const usd = amount / rf;       // to USD
  return usd * rt;               // to target
}

function displayCur() { return root.displayCurrency || 'USD'; }

// Format a value already expressed in the display currency
function fmtDisplay(value, { sign=false } = {}) {
  const sym = CURRENCY_SYMBOLS[displayCur()] || '$';
  const safe = isFinite(value) ? value : 0;
  const num = Math.abs(safe).toLocaleString(undefined, { minimumFractionDigits:2, maximumFractionDigits:2 });
  let prefix = '';
  if (sign) prefix = safe >= 0 ? '+' : '-';
  else if (safe < 0) prefix = '-';
  return `${prefix}${sym}${num}`;
}

// Fetch live rates (USD base). Cannot be tested in this environment (network blocked).
function fetchRates() {
  if (typeof fetch !== 'function') return;
  fetch('https://open.er-api.com/v6/latest/USD')
    .then(r => r.json())
    .then(data => {
      if (data && data.result === 'success' && data.rates) {
        root.fxCache = { base: 'USD', rates: data.rates, ts: Date.now() };
        saveState();
        renderHome();
      }
    })
    .catch(() => { /* offline: keep using cache/manual, already rendered */ });
}


/* ---------- Date ranges ---------- */
function getRanges(period, ref = new Date()) {
  const y = ref.getFullYear(), m = ref.getMonth(), d = ref.getDate();
  let start,end,prevStart,prevEnd;
  if (period === 'week') {
    const diffToMon = (ref.getDay()+6)%7;
    start = new Date(y,m,d-diffToMon); end = new Date(start); end.setDate(start.getDate()+7);
    prevStart = new Date(start); prevStart.setDate(start.getDate()-7); prevEnd = new Date(start);
  } else if (period === 'month') {
    start = new Date(y,m,1); end = new Date(y,m+1,1); prevStart = new Date(y,m-1,1); prevEnd = new Date(y,m,1);
  } else if (period === 'year') {
    start = new Date(y,0,1); end = new Date(y+1,0,1); prevStart = new Date(y-1,0,1); prevEnd = new Date(y,0,1);
  } else { start = new Date(0); end = new Date(8640000000000000); prevStart = null; prevEnd = null; }
  return { start,end,prevStart,prevEnd };
}
function txDate(tx){ const [y,mo,da]=tx.date.split('-').map(Number); return new Date(y,mo-1,da); }
function txInRange(tx,start,end){ const t=txDate(tx).getTime(); return t>=start.getTime() && t<end.getTime(); }

/* ---------- Calculations ---------- */
function sumIncome(txs){ return txs.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0); }
function sumExpense(txs){ return txs.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0); }
function pnl(txs){ return sumIncome(txs)-sumExpense(txs); }
function profitMargin(txs){ const inc=sumIncome(txs); if(inc===0) return null; return (pnl(txs)/inc)*100; }
function bizBalance(b){ return b.startingBalance + sumIncome(b.transactions) - sumExpense(b.transactions); }
function growth(cur,prev){ if(prev==null) return null; if(prev===0) return cur===0?0:null; return ((cur-prev)/Math.abs(prev))*100; }

// Net profit for a partner's scope (all-time). Loss carried forward -> may be negative.
function scopeNetProfit(b, partner) {
  let txs = b.transactions;
  if (partner.scope === 'deal') txs = txs.filter(t => t.dealId === partner.dealId);
  return pnl(txs);
}

/* ---------- Capital-aware per-deal profit (B) ----------
   A "deal" is identified by its typed name (t.dealName). Money type on income:
     - moneyType 'capital'  = your investment (recovered first, NOT shared)
     - moneyType 'revenue'  = earnings (shared after capital + expenses)
   Deal profit = revenue - capital - expenses. Partner owed = max(0, sharePct% * profit). */
function dealTxs(b, dealName){ return b.transactions.filter(t => (t.dealName||'') === dealName); }
function dealBreakdown(b, dealName){
  const txs = dealTxs(b, dealName);
  const capital  = txs.filter(t => t.type==='income' && t.moneyType==='capital').reduce((s,t)=>s+t.amount,0);
  const revenue  = txs.filter(t => t.type==='income' && t.moneyType!=='capital').reduce((s,t)=>s+t.amount,0);
  const expenses = txs.filter(t => t.type==='expense').reduce((s,t)=>s+t.amount,0);
  return { capital, revenue, expenses, profit: revenue - capital - expenses };
}
// All deal names that have a partner assigned to them
function partnerDeals(b, partnerId){
  const dp = b.dealPartners || {};
  return Object.keys(dp).filter(name => dp[name] && dp[name].partnerId === partnerId);
}
function partnerEarned(b, partner){
  let earned = scopeNetProfit(b, partner) * (partner.sharePct/100); // legacy scope support (0 for deal-partners)
  const dp = b.dealPartners || {};
  partnerDeals(b, partner.id).forEach(name => {
    const pct = dp[name].sharePct;
    if (isFinite(pct)) {
      const profit = dealBreakdown(b, name).profit;
      earned += Math.max(0, profit * (pct/100)); // floored: partner never owes on a loss
    }
  });
  return earned;
}
function partnerPaid(b, partner){ return b.payouts.filter(p=>p.partnerId===partner.id).reduce((s,p)=>s+p.amount,0); }
function partnerOwed(b, partner){ return partnerEarned(b,partner) - partnerPaid(b,partner); }

/* ---------- DOM helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function formatDateShort(iso){ const [y,m,d]=iso.split('-').map(Number); const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return `${M[m-1]} ${d}, ${y}`; }

/* ===================================================================
   NAVIGATION
   =================================================================== */
function showView(id){
  $$('.view').forEach(v=>v.classList.remove('active'));
  $('#'+id).classList.add('active');
  $('#fab').classList.toggle('hidden', id !== 'view-business');
}
function goHome(){ root.activeBusinessId=null; saveState(); renderHome(); showView('view-home'); }

// Home tab bar: Transactions/Settings jump into a business (open the one if single, else prompt).
function homeJumpTo(target){
  if(root.businesses.length===0){ alert('Add a business first.'); return; }
  const b = root.businesses.length===1
    ? root.businesses[0]
    : root.businesses.find(x=>x.id===root.activeBusinessId) || root.businesses[0];
  openBusiness(b.id);
  if(target==='transactions') setBizTab('transactions');
  else if(target==='settings') openBusinessSettings();
}
function openBusiness(id){
  root.activeBusinessId=id; saveState();
  currentPeriod='month'; currentFilter='all'; searchTerm='';
  $('#tx-search').value='';
  setBizTab('dashboard');
  $$('#pane-dashboard .seg-btn').forEach(x=>x.classList.toggle('active',x.dataset.period==='month'));
  $$('#pane-transactions .seg-btn').forEach(x=>x.classList.toggle('active',x.dataset.filter==='all'));
  renderBusiness();
  showView('view-business');
}
function setBizTab(tab){
  $$('.biz-tab').forEach(t=>t.classList.toggle('active',t.dataset.btab===tab));
  $$('.pane').forEach(p=>p.classList.remove('active'));
  $('#pane-'+tab).classList.add('active');
}

/* ===================================================================
   HOME
   =================================================================== */
function renderHome(){
  const has = root.businesses.length>0;
  $('#home-empty').classList.toggle('hidden',has);
  $('#home-content').classList.toggle('hidden',!has);

  const cur = displayCur();
  $('#cur-code').textContent = cur;

  // Determine FX status for the badge/note
  const now = Date.now();
  const cacheFresh = root.fxCache && root.fxCache.rates && (now - root.fxCache.ts < 24*3600*1000);
  const cacheAny = root.fxCache && root.fxCache.rates;
  fxStatus = cacheAny ? (cacheFresh ? 'live' : 'cached') : 'manual';

  updateFxBadge(cur);

  if(!has){
    // keep the empty-state selector + subtext in sync
    $('#home-pnl-empty').textContent = fmtDisplay(0,{sign:true});
    $('#home-pnl-empty').className = 'pnl-value pos';
    $('#home-sub-empty').textContent = `0 businesses converted to ${cur}`;
    return;
  }

  const { start,end } = getRanges(homePeriod);
  let inc=0, exp=0, bal=0;
  root.businesses.forEach(b=>{
    const rng = homePeriod==='all' ? b.transactions : b.transactions.filter(t=>txInRange(t,start,end));
    inc += convert(sumIncome(rng), b.currency, cur);
    exp += convert(sumExpense(rng), b.currency, cur);
    bal += convert(bizBalance(b), b.currency, cur);
  });
  const net = inc - exp;
  const margin = inc === 0 ? null : (net / inc) * 100;

  const pnlEl=$('#home-pnl');
  pnlEl.textContent=fmtDisplay(net,{sign:true});
  pnlEl.className='pnl-value '+(net>=0?'pos':'neg');
  const n = root.businesses.length;
  $('#home-sub').textContent=`${n} business${n===1?'':'es'} converted to ${cur}`;
  $('#home-income').textContent=fmtDisplay(inc,{sign:true});
  $('#home-expenses').textContent=fmtDisplay(-exp,{sign:true});
  $('#home-margin').textContent = margin===null ? '—' : `${margin.toFixed(1)}%`;
  $('#home-balance').textContent=fmtDisplay(bal);

  const list=$('#biz-list'); list.innerHTML='';
  root.businesses.forEach(b=>{
    const rng = homePeriod==='all' ? b.transactions : b.transactions.filter(t=>txInRange(t,start,end));
    const netNative = pnl(rng);
    const netDisp = convert(netNative, b.currency, cur);
    const sameCur = b.currency === cur;
    const nativeHint = sameCur ? '' : ` · ${fmtMoney(netNative,{sign:true,biz:b})} ${b.currency}`;
    const li=document.createElement('li');
    li.className='biz-card';
    li.innerHTML=`
      <div>
        <div class="biz-c-name">${escapeHtml(b.name)}</div>
        <div class="biz-c-sub">${b.transactions.length} transaction${b.transactions.length===1?'':'s'}${b.partners.length?` · ${b.partners.length} partner${b.partners.length===1?'':'s'}`:''}${nativeHint}</div>
      </div>
      <div style="display:flex;align-items:center">
        <span class="biz-c-pnl ${netDisp>=0?'pos':'neg'}">${fmtDisplay(netDisp,{sign:true})}</span>
        <span class="chev"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg></span>
      </div>`;
    li.addEventListener('click',()=>openBusiness(b.id));
    list.appendChild(li);
  });

  // FX note line
  const note=$('#fx-note');
  if(fxStatus==='live') note.textContent = `Live rates · updated ${fxAge()}`;
  else if(fxStatus==='cached') note.textContent = `Offline — using cached rates from ${new Date(root.fxCache.ts).toLocaleDateString()}`;
  else note.textContent = `Using manual rates (set in a business's Settings). Live rates load when online.`;
}

function fxAge(){
  if(!root.fxCache) return '';
  const mins = Math.round((Date.now()-root.fxCache.ts)/60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins/60);
  return `${hrs}h ago`;
}

function updateFxBadge(cur){
  const badge=$('#live-badge'); if(!badge) return;
  badge.classList.remove('cached','manual');
  if(fxStatus==='live'){ badge.textContent=`LIVE · ${cur}`; }
  else if(fxStatus==='cached'){ badge.textContent=`CACHED · ${cur}`; badge.classList.add('cached'); }
  else { badge.textContent=`MANUAL · ${cur}`; badge.classList.add('manual'); }
}

function cycleCurrency(){
  const i = DISPLAY_CURRENCIES.indexOf(displayCur());
  root.displayCurrency = DISPLAY_CURRENCIES[(i+1) % DISPLAY_CURRENCIES.length];
  saveState();
  renderHome();
}

/* ===================================================================
   BUSINESS VIEW
   =================================================================== */
function renderBusiness(){
  const b=activeBiz(); if(!b){ goHome(); return; }
  $('#biz-nav-title').textContent=b.name;
  renderDashboard(b);
  renderTransactions(b);
  renderPartners(b);
}

function renderDashboard(b){
  const { start,end,prevStart,prevEnd }=getRanges(currentPeriod);
  const inRange=b.transactions.filter(t=>txInRange(t,start,end));
  const inc=sumIncome(inRange), exp=sumExpense(inRange), net=inc-exp, margin=profitMargin(inRange);

  const pnlEl=$('#pnl-value');
  pnlEl.textContent=fmtMoney(net,{sign:true,biz:b});
  pnlEl.className='pnl-value '+(net>=0?'pos':'neg');

  const changeEl=$('#pnl-change');
  if(prevStart){
    const prevNet=pnl(b.transactions.filter(t=>txInRange(t,prevStart,prevEnd)));
    const g=growth(net,prevNet);
    const word={week:'last week',month:'last month',year:'last year'}[currentPeriod];
    if(g===null){ changeEl.textContent=`— vs ${word}`; changeEl.className='pnl-change'; }
    else { const up=g>=0; changeEl.textContent=`${up?'↑':'↓'} ${Math.abs(g).toFixed(1)}% vs ${word}`; changeEl.className='pnl-change '+(up?'pos':'neg'); }
  } else { changeEl.textContent='All-time total'; changeEl.className='pnl-change'; }

  $('#stat-income').textContent=fmtMoney(inc,{sign:true,biz:b});
  $('#stat-expenses').textContent=fmtMoney(-exp,{sign:true,biz:b});
  $('#stat-margin').textContent=margin===null?'—':`${margin.toFixed(1)}%`;
  $('#stat-balance').textContent=fmtMoney(bizBalance(b),{biz:b});

  drawChart(inRange);
}

function drawChart(txs){
  const canvas=$('#pnl-chart'); const ctx=canvas.getContext('2d');
  const dpr=window.devicePixelRatio||1; const cssW=canvas.clientWidth||320; const cssH=220;
  canvas.width=cssW*dpr; canvas.height=cssH*dpr; ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,cssW,cssH);

  const sorted=[...txs].sort((a,b)=>txDate(a)-txDate(b)||a.createdAt-b.createdAt);
  const points=[{x:0,v:0}]; let cum=0;
  sorted.forEach((t,i)=>{ cum+=t.type==='income'?t.amount:-t.amount; points.push({x:i+1,v:cum}); });

  const pad={l:10,r:10,t:16,b:16}; const w=cssW-pad.l-pad.r; const h=cssH-pad.t-pad.b;
  const vals=points.map(p=>p.v); let min=Math.min(0,...vals), max=Math.max(0,...vals);
  if(min===max){ max+=1; min-=1; }
  const n=Math.max(points.length-1,1);
  const px=i=>pad.l+(i/n)*w; const py=v=>pad.t+(1-(v-min)/(max-min))*h;

  ctx.strokeStyle='rgba(138,148,166,.25)'; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(pad.l,py(0)); ctx.lineTo(cssW-pad.r,py(0)); ctx.stroke();

  if(points.length<2){ ctx.fillStyle='#8a94a6'; ctx.font='13px -apple-system,sans-serif'; ctx.textAlign='center'; ctx.fillText('Not enough data for this period',cssW/2,cssH/2); return; }

  const endVal=points[points.length-1].v; const color=endVal>=0?'#34d17f':'#ff5a4d';
  const grad=ctx.createLinearGradient(0,pad.t,0,pad.t+h);
  grad.addColorStop(0,endVal>=0?'rgba(52,209,127,.25)':'rgba(255,90,77,.25)'); grad.addColorStop(1,'rgba(0,0,0,0)');
  ctx.beginPath(); ctx.moveTo(px(0),py(points[0].v)); points.forEach((p,i)=>ctx.lineTo(px(i),py(p.v)));
  ctx.lineTo(px(points.length-1),py(0)); ctx.lineTo(px(0),py(0)); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();

  ctx.beginPath(); ctx.moveTo(px(0),py(points[0].v)); points.forEach((p,i)=>ctx.lineTo(px(i),py(p.v)));
  ctx.strokeStyle=color; ctx.lineWidth=2.5; ctx.lineJoin='round'; ctx.stroke();

  ctx.beginPath(); ctx.arc(px(points.length-1),py(endVal),4,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
}

/* ---------- Transactions ---------- */
function renderTransactions(b){
  const list=$('#tx-list'); const term=searchTerm.trim().toLowerCase();
  let txs=[...b.transactions].sort((a,c)=>txDate(c)-txDate(a)||c.createdAt-a.createdAt);
  if(currentFilter!=='all') txs=txs.filter(t=>t.type===currentFilter);
  if(term) txs=txs.filter(t=>(t.description||'').toLowerCase().includes(term)||(t.category||'').toLowerCase().includes(term));

  list.innerHTML=''; $('#tx-empty').classList.toggle('hidden',txs.length>0);
  txs.forEach(t=>{
    const dealTag=t.dealName ? `<span class="tx-tag">${escapeHtml(t.dealName)}${t.moneyType==='capital'?' · capital':''}</span>` : '';
    const li=document.createElement('li'); li.className='tx-item';
    const amt=fmtMoney(t.type==='income'?t.amount:-t.amount,{sign:true,biz:b});
    li.innerHTML=`
      <div class="tx-main">
        <div class="tx-cat">${escapeHtml(t.category)}${dealTag}</div>
        ${t.description?`<div class="tx-desc">${escapeHtml(t.description)}</div>`:''}
        <div class="tx-meta">${formatDateShort(t.date)}</div>
      </div>
      <div class="tx-amt ${t.type}">${amt}</div>`;
    li.addEventListener('click',()=>openTxSheet(t.id));
    list.appendChild(li);
  });
}

/* ---------- Partners ---------- */
function renderPartners(b){
  const list=$('#partner-list'); list.innerHTML='';
  if(b.partners.length===0){
    list.innerHTML=`<p class="hint" style="text-align:center">No partners yet. Add someone who shares in this business's profit.</p>`;
  }
  b.partners.forEach(p=>{
    const earned=partnerEarned(b,p), paid=partnerPaid(b,p), owed=partnerOwed(b,p);
    // deals this partner is attached to (capital-aware per-deal splits)
    const dp=b.dealPartners||{};
    const pDealNames=partnerDeals(b,p.id);
    let scopeText;
    if(pDealNames.length){
      scopeText = pDealNames.map(name=>{
        const bd=dealBreakdown(b,name); const pct=dp[name].sharePct;
        const share=Math.max(0, bd.profit*(pct/100));
        return `<div class="deal-line"><b>${escapeHtml(name)}</b> — ${pct}% of profit<br>`
          +`<span class="deal-calc">Rev ${fmtMoney(bd.revenue,{biz:b})} − Capital ${fmtMoney(bd.capital,{biz:b})} − Exp ${fmtMoney(bd.expenses,{biz:b})} = <b>${fmtMoney(bd.profit,{biz:b})}</b> profit → <b>${fmtMoney(share,{biz:b})}</b></span></div>`;
      }).join('');
    } else if(p.scope==='deal'){
      scopeText = `${p.sharePct}% of deal (legacy)`;
    } else {
      scopeText = p.sharePct ? `${p.sharePct}% of whole business` : 'No active split';
    }
    const li=document.createElement('li'); li.className='partner-card';
    li.innerHTML=`
      <div class="partner-top">
        <div>
          <div class="partner-name">${escapeHtml(p.name)}</div>
          <div class="partner-scope">${scopeText}</div>
        </div>
        <button class="link-btn" data-edit-partner="${p.id}">Edit</button>
      </div>
      <div class="partner-rows">
        <div class="pr-box"><div class="pr-label">EARNED</div><div class="pr-val">${fmtMoney(earned,{biz:b})}</div></div>
        <div class="pr-box"><div class="pr-label">PAID OUT</div><div class="pr-val">${fmtMoney(paid,{biz:b})}</div></div>
        <div class="pr-box"><div class="pr-label">OWED</div><div class="pr-val owed ${owed>=0?'pos':'neg'}">${fmtMoney(owed,{biz:b})}</div></div>
      </div>
      <div class="partner-actions">
        <button class="btn-primary" data-payout="${p.id}">Record Payout</button>
      </div>`;
    li.querySelector('[data-edit-partner]').addEventListener('click',()=>openPartnerSheet(p.id));
    li.querySelector('[data-payout]').addEventListener('click',()=>openPayoutSheet(p.id));
    list.appendChild(li);
  });
}

/* ===================================================================
   SETTINGS (per business)
   =================================================================== */
function openBusinessSettings(){
  const b=activeBiz(); if(!b) return;
  $('#set-biz-name').value=b.name;
  $('#set-currency').value=b.currency;
  $('#set-start-balance').value=b.startingBalance||'';
  renderCategories(b); renderDeals(b); renderManualRates();
  showView('view-bizsettings');
}
function renderManualRates(){
  const wrap=$('#manual-rates'); if(!wrap) return;
  wrap.innerHTML='';
  DISPLAY_CURRENCIES.filter(c=>c!=='USD').forEach(cur=>{
    const val=(root.manualRates||{})[cur]||'';
    const label=document.createElement('label'); label.className='field';
    label.innerHTML=`<span>1 USD = ? ${cur}</span>`;
    const input=document.createElement('input');
    input.type='number'; input.inputMode='decimal'; input.step='0.0001'; input.value=val;
    input.addEventListener('input',e=>{
      const v=parseFloat(e.target.value);
      if(!root.manualRates) root.manualRates={...DEFAULT_MANUAL_RATES};
      if(isFinite(v)&&v>0) root.manualRates[cur]=v;
      saveState();
    });
    label.appendChild(input);
    wrap.appendChild(label);
  });
}
function renderCategories(b){
  const list=$('#cat-list'); list.innerHTML='';
  b.categories.forEach(cat=>{
    const li=document.createElement('li'); li.className='cat-item';
    li.innerHTML=`<span>${escapeHtml(cat)}</span><button aria-label="Remove"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`;
    li.querySelector('button').addEventListener('click',()=>removeCategory(cat));
    list.appendChild(li);
  });
}
function renderDeals(b){
  const list=$('#venture-list'); list.innerHTML='';
  b.deals.forEach(d=>{
    const li=document.createElement('li'); li.className='cat-item';
    li.innerHTML=`<span>${escapeHtml(d.name)}</span><button aria-label="Remove"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>`;
    li.querySelector('button').addEventListener('click',()=>removeDeal(d.id));
    list.appendChild(li);
  });
}

/* ===================================================================
   SHEETS: transaction
   =================================================================== */
let txMoneyType = 'revenue'; // 'revenue' | 'capital' (income only)

function fillTxSelects(b){
  $('#tx-category').innerHTML=b.categories.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  // datalist of existing deal names for quick reuse (with 🤝 marker for partner deals)
  const dp=b.dealPartners||{};
  const names=[...new Set(b.transactions.map(t=>t.dealName).filter(Boolean))];
  $('#tx-deal-list').innerHTML=names.map(n=>`<option value="${escapeHtml(n)}">${dp[n]?'🤝 partner deal':''}</option>`).join('');
  // partner select (existing partners + new)
  const psel=$('#tx-partner-select');
  if(psel){
    psel.innerHTML=b.partners.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
      +`<option value="__new__">+ New partner…</option>`;
  }
}
// Money type toggle is only relevant for income ("money in").
function syncTxMoneyType(){
  const show = sheetType==='income';
  $('#tx-moneytype-field').classList.toggle('hidden', !show);
}
function setTxMoneyType(mt){
  txMoneyType = mt;
  $$('.mt-btn').forEach(x=>x.classList.toggle('active', x.dataset.mt===mt));
}
// Partner add-on shows whenever a deal name is present; preloads an existing deal's partner.
function syncTxDealUI(){
  const b=activeBiz(); if(!b) return;
  const name=$('#tx-dealname').value.trim();
  const hasName = !!name;
  $('#tx-partner-block').classList.toggle('hidden', !hasName);
  const toggle=$('#tx-partner-toggle');
  const dp=(b.dealPartners||{})[name];
  if(dp && dp.partnerId){
    toggle.checked=true; $('#tx-partner-fields').classList.remove('hidden');
    $('#tx-partner-select').value=dp.partnerId;
    $('#tx-partner-pct').value=dp.sharePct;
    syncTxPartnerNewName();
  } else if(!hasName){
    toggle.checked=false; $('#tx-partner-fields').classList.add('hidden');
  }
}
function syncTxPartnerFields(){
  $('#tx-partner-fields').classList.toggle('hidden', !$('#tx-partner-toggle').checked);
  syncTxPartnerNewName();
}
function syncTxPartnerNewName(){
  $('#tx-partner-newname-field').classList.toggle('hidden', $('#tx-partner-select').value!=='__new__');
}
function openTxSheet(id=null){
  const b=activeBiz(); if(!b) return;
  fillTxSelects(b);
  editingTxId=id;
  const del=$('#tx-delete-btn');
  if(id){
    const t=b.transactions.find(x=>x.id===id); if(!t) return;
    $('#sheet-title').textContent='Edit Transaction'; setSheetType(t.type);
    $('#tx-amount').value=t.amount; $('#tx-category').value=t.category;
    $('#tx-dealname').value=t.dealName||''; $('#tx-date').value=t.date;
    $('#tx-description').value=t.description||''; del.classList.remove('hidden');
    setTxMoneyType(t.moneyType==='capital'?'capital':'revenue');
  } else {
    $('#sheet-title').textContent='Add Transaction'; setSheetType('income');
    $('#tx-amount').value=''; $('#tx-category').value=b.categories[0]||'';
    $('#tx-dealname').value=''; $('#tx-date').value=todayISO();
    $('#tx-description').value=''; del.classList.add('hidden');
    setTxMoneyType('revenue');
  }
  // reset partner add-on then sync visibility to the current deal name
  $('#tx-partner-toggle').checked=false;
  $('#tx-partner-pct').value=''; $('#tx-partner-newname').value='';
  if($('#tx-partner-select').options.length) $('#tx-partner-select').selectedIndex=0;
  syncTxMoneyType();
  syncTxDealUI();
  $('#tx-sheet').classList.remove('hidden');
}
function closeTxSheet(){ $('#tx-sheet').classList.add('hidden'); editingTxId=null; }
function setSheetType(type){ sheetType=type; $$('.type-btn').forEach(x=>x.classList.toggle('active',x.dataset.type===type)); syncTxMoneyType(); }
function saveTransaction(){
  const b=activeBiz(); if(!b) return;
  const amount=parseFloat($('#tx-amount').value);
  if(!isFinite(amount)||amount<=0){ alert('Please enter a valid amount greater than 0.'); return; }

  const dealName=$('#tx-dealname').value.trim();
  if(!b.dealPartners) b.dealPartners={};

  // --- Resolve the partner add-on (only if a deal name is present and toggle on) ---
  if(dealName && $('#tx-partner-toggle').checked){
    const pct=parseFloat($('#tx-partner-pct').value);
    if(!isFinite(pct)||pct<0||pct>100){ alert('Enter the partner\u2019s share (0\u2013100%).'); return; }
    let partnerId=$('#tx-partner-select').value;
    if(partnerId==='__new__'){
      const pname=$('#tx-partner-newname').value.trim();
      if(!pname){ alert('Enter the new partner\u2019s name.'); return; }
      // sharePct 0 on the partner record so legacy scope math contributes nothing (real % lives on the deal)
      const np={ id:uid(), name:pname, sharePct:0, scope:'business', dealId:null };
      b.partners.push(np); partnerId=np.id;
    }
    b.dealPartners[dealName]={ partnerId, sharePct:Math.round(pct*100)/100 };
  } else if(dealName && !$('#tx-partner-toggle').checked){
    // toggle off -> remove any partner mapping for this deal name
    if(b.dealPartners[dealName]) delete b.dealPartners[dealName];
  }

  const isIncome = sheetType==='income';
  const data={ type:sheetType, amount:Math.round(amount*100)/100, category:$('#tx-category').value,
    dealName:dealName||null,
    moneyType: isIncome ? txMoneyType : null,
    date:$('#tx-date').value||todayISO(), description:$('#tx-description').value.trim() };
  if(editingTxId){ Object.assign(b.transactions.find(x=>x.id===editingTxId),data); }
  else { b.transactions.push({ id:uid(), createdAt:Date.now(), ...data }); }
  saveState(); closeTxSheet(); renderBusiness();
}
function deleteTransaction(){
  const b=activeBiz(); if(!b||!editingTxId) return;
  if(!confirm('Delete this transaction? This cannot be undone.')) return;
  b.transactions=b.transactions.filter(t=>t.id!==editingTxId);
  saveState(); closeTxSheet(); renderBusiness();
}

/* ===================================================================
   SHEETS: partner
   =================================================================== */
function openPartnerSheet(id=null){
  const b=activeBiz(); if(!b) return;
  editingPartnerId=id;
  const scopeSel=$('#partner-scope');
  scopeSel.innerHTML=`<option value="business">Whole business profit</option>`+
    b.deals.map(d=>`<option value="deal:${d.id}">Deal: ${escapeHtml(d.name)}</option>`).join('');
  const del=$('#partner-delete-btn');
  if(id){
    const p=b.partners.find(x=>x.id===id); if(!p) return;
    $('#partner-sheet-title').textContent='Edit Partner';
    $('#partner-name').value=p.name; $('#partner-pct').value=p.sharePct;
    scopeSel.value=p.scope==='deal'?`deal:${p.dealId}`:'business';
    del.classList.remove('hidden');
  } else {
    $('#partner-sheet-title').textContent='Add Partner';
    $('#partner-name').value=''; $('#partner-pct').value=''; scopeSel.value='business';
    del.classList.add('hidden');
  }
  $('#partner-sheet').classList.remove('hidden');
}
function closePartnerSheet(){ $('#partner-sheet').classList.add('hidden'); editingPartnerId=null; }
function savePartner(){
  const b=activeBiz(); if(!b) return;
  const name=$('#partner-name').value.trim();
  const pct=parseFloat($('#partner-pct').value);
  if(!name){ alert('Enter a partner name.'); return; }
  if(!isFinite(pct)||pct<0||pct>100){ alert('Enter a share percentage between 0 and 100.'); return; }
  const scopeVal=$('#partner-scope').value;
  let scope='business', dealId=null;
  if(scopeVal.startsWith('deal:')){ scope='deal'; dealId=scopeVal.slice(5); }
  if(editingPartnerId){ Object.assign(b.partners.find(x=>x.id===editingPartnerId),{name,sharePct:pct,scope,dealId}); }
  else { b.partners.push({ id:uid(), name, sharePct:pct, scope, dealId }); }
  saveState(); closePartnerSheet(); renderPartners(b); renderBusiness();
}
function deletePartner(){
  const b=activeBiz(); if(!b||!editingPartnerId) return;
  if(!confirm('Remove this partner? Their payout history will also be removed.')) return;
  b.partners=b.partners.filter(p=>p.id!==editingPartnerId);
  b.payouts=b.payouts.filter(p=>p.partnerId!==editingPartnerId);
  saveState(); closePartnerSheet(); renderPartners(b);
}

/* ===================================================================
   SHEETS: payout
   =================================================================== */
function openPayoutSheet(partnerId){
  const b=activeBiz(); if(!b) return;
  payoutPartnerId=partnerId;
  const p=b.partners.find(x=>x.id===partnerId); if(!p) return;
  const owed=partnerOwed(b,p);
  $('#payout-sheet-title').textContent=`Pay ${p.name}`;
  $('#payout-context').textContent=`Currently owed: ${fmtMoney(owed,{biz:b})}`;
  $('#payout-amount').value=''; $('#payout-date').value=todayISO(); $('#payout-note').value='';
  renderPayoutHistory(b,p);
  $('#payout-sheet').classList.remove('hidden');
}
function renderPayoutHistory(b,p){
  const wrap=$('#payout-history');
  const items=b.payouts.filter(x=>x.partnerId===p.id).sort((a,c)=>c.date.localeCompare(a.date));
  if(!items.length){ wrap.innerHTML=`<p class="hint" style="margin-top:14px">No payouts recorded yet.</p>`; return; }
  wrap.innerHTML=`<div class="settings-title" style="margin-top:16px">PAYOUT HISTORY</div>`+
    items.map(it=>`<div class="payout-hist-item">
      <span>${formatDateShort(it.date)}${it.note?` · ${escapeHtml(it.note)}`:''}</span>
      <span>${fmtMoney(it.amount,{biz:b})} <button class="ph-del" data-del-payout="${it.id}" aria-label="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></span>
    </div>`).join('');
  wrap.querySelectorAll('[data-del-payout]').forEach(btn=>btn.addEventListener('click',()=>deletePayout(btn.dataset.delPayout)));
}
function closePayoutSheet(){ $('#payout-sheet').classList.add('hidden'); payoutPartnerId=null; }
function savePayout(){
  const b=activeBiz(); if(!b||!payoutPartnerId) return;
  const amount=parseFloat($('#payout-amount').value);
  if(!isFinite(amount)||amount<=0){ alert('Enter a valid payout amount.'); return; }
  b.payouts.push({ id:uid(), partnerId:payoutPartnerId, amount:Math.round(amount*100)/100,
    date:$('#payout-date').value||todayISO(), note:$('#payout-note').value.trim() });
  saveState();
  const p=b.partners.find(x=>x.id===payoutPartnerId);
  $('#payout-context').textContent=`Currently owed: ${fmtMoney(partnerOwed(b,p),{biz:b})}`;
  $('#payout-amount').value='';
  renderPayoutHistory(b,p); renderPartners(b);
}
function deletePayout(id){
  const b=activeBiz(); if(!b) return;
  if(!confirm('Delete this payout record?')) return;
  b.payouts=b.payouts.filter(x=>x.id!==id);
  saveState();
  const p=b.partners.find(x=>x.id===payoutPartnerId);
  if(p){ $('#payout-context').textContent=`Currently owed: ${fmtMoney(partnerOwed(b,p),{biz:b})}`; renderPayoutHistory(b,p); }
  renderPartners(b);
}

/* ===================================================================
   BUSINESS create / delete
   =================================================================== */
function openBizSheet(){ $('#biz-name').value=''; $('#biz-currency').value='USD'; $('#biz-start-balance').value=''; $('#biz-sheet').classList.remove('hidden'); }
function closeBizSheet(){ $('#biz-sheet').classList.add('hidden'); }
function saveBusiness(){
  const name=$('#biz-name').value.trim(); if(!name){ alert('Enter a business name.'); return; }
  const b=newBusiness(name,$('#biz-currency').value,parseFloat($('#biz-start-balance').value)||0);
  root.businesses.push(b); saveState(); closeBizSheet(); openBusiness(b.id);
}
function deleteBusiness(){
  const b=activeBiz(); if(!b) return;
  if(!confirm(`Delete "${b.name}" and all its data? This cannot be undone.`)) return;
  root.businesses=root.businesses.filter(x=>x.id!==b.id);
  saveState(); goHome();
}

/* ---------- Categories & deals ---------- */
function addCategory(){
  const b=activeBiz(); if(!b) return;
  const input=$('#cat-new'); const val=input.value.trim(); if(!val) return;
  if(b.categories.some(c=>c.toLowerCase()===val.toLowerCase())){ alert('That category already exists.'); return; }
  b.categories.push(val); input.value=''; saveState(); renderCategories(b);
}
function removeCategory(cat){
  const b=activeBiz(); if(!b) return;
  if(!confirm(`Remove category "${cat}"? Existing transactions keep their category.`)) return;
  b.categories=b.categories.filter(c=>c!==cat); saveState(); renderCategories(b);
}
function addDeal(){
  const b=activeBiz(); if(!b) return;
  const input=$('#venture-new'); const val=input.value.trim(); if(!val) return;
  if(b.deals.some(d=>d.name.toLowerCase()===val.toLowerCase())){ alert('That deal already exists.'); return; }
  b.deals.push({ id:uid(), name:val }); input.value=''; saveState(); renderDeals(b);
}
function removeDeal(id){
  const b=activeBiz(); if(!b) return;
  const hasPartner=b.partners.some(p=>p.dealId===id);
  const msg=hasPartner?'A partner is linked to this deal and will be switched to whole-business scope. Continue?':'Remove this deal? Transactions keep their data but lose the deal tag.';
  if(!confirm(msg)) return;
  b.deals=b.deals.filter(d=>d.id!==id);
  b.transactions.forEach(t=>{ if(t.dealId===id) t.dealId=null; });
  b.partners.forEach(p=>{ if(p.dealId===id){ p.scope='business'; p.dealId=null; } });
  saveState(); renderDeals(b);
}

/* ---------- Export / import (active business) ---------- */
function exportCSV(){
  const b=activeBiz(); if(!b) return;
  const header=['id','type','amount','category','dealName','moneyType','date','description','createdAt'];
  const rows=b.transactions.map(t=>header.map(h=>csvCell(t[h])).join(','));
  const csv=[header.join(','),...rows].join('\n');
  const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=`${b.name.replace(/\s+/g,'-')}-${todayISO()}.csv`; a.click(); URL.revokeObjectURL(url);
}
function csvCell(v){ const s=v==null?'':String(v); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; }
function importCSV(file){
  const b=activeBiz(); if(!b) return;
  const reader=new FileReader();
  reader.onload=e=>{
    try{
      const rows=parseCSV(e.target.result); const header=rows.shift().map(h=>h.trim()); const idx=n=>header.indexOf(n);
      const imported=rows.filter(r=>r.length&&r[idx('type')]).map(r=>({
        id:r[idx('id')]||uid(), type:r[idx('type')]==='expense'?'expense':'income',
        amount:Math.abs(parseFloat(r[idx('amount')])||0), category:r[idx('category')]||'Other',
        dealName:(idx('dealName')>=0?r[idx('dealName')]:'')||null,
        moneyType:(idx('moneyType')>=0&&r[idx('moneyType')]==='capital')?'capital':(r[idx('type')]==='expense'?null:'revenue'),
        date:r[idx('date')]||todayISO(), description:r[idx('description')]||'',
        createdAt:Number(r[idx('createdAt')])||Date.now()
      }));
      if(!imported.length){ alert('No transactions found in file.'); return; }
      if(confirm(`Import ${imported.length} transaction(s) into "${b.name}"?`)){
        const existing=new Set(b.transactions.map(t=>t.id));
        imported.forEach(t=>{ if(!existing.has(t.id)) b.transactions.push(t); });
        imported.forEach(t=>{ if(t.category&&!b.categories.includes(t.category)) b.categories.push(t.category); });
        saveState(); renderBusiness(); alert('Import complete.');
      }
    }catch(err){ alert('Could not read CSV file.'); }
  };
  reader.readAsText(file);
}
function parseCSV(text){
  const rows=[]; let row=[],cell='',inQ=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(inQ){ if(c==='"'&&text[i+1]==='"'){ cell+='"'; i++; } else if(c==='"') inQ=false; else cell+=c; }
    else { if(c==='"') inQ=true; else if(c===',' ){ row.push(cell); cell=''; }
      else if(c==='\n'||c==='\r'){ if(c==='\r'&&text[i+1]==='\n') i++; row.push(cell); rows.push(row); row=[]; cell=''; }
      else cell+=c; }
  }
  if(cell.length||row.length){ row.push(cell); rows.push(row); }
  return rows.filter(r=>r.length>1||(r.length===1&&r[0]!==''));
}

/* ---------- Sample data ---------- */
function loadSampleData(){
  const b=activeBiz(); if(!b) return;
  const today=new Date();
  const iso=off=>{ const d=new Date(today); d.setDate(today.getDate()-off); const o=d.getTimezoneOffset(); return new Date(d.getTime()-o*60000).toISOString().slice(0,10); };
  const sample=[
    {type:'income',amount:1250,category:'Sales',description:'Online orders',date:iso(1)},
    {type:'expense',amount:300,category:'Inventory',description:'Restock',date:iso(2)},
    {type:'expense',amount:75,category:'Shipping',description:'USPS shipping',date:iso(3)},
    {type:'income',amount:850,category:'Sales',description:'Card sales',date:iso(4)},
    {type:'expense',amount:120,category:'Supplies',description:'Packaging',date:iso(5)}
  ].map(s=>({ id:uid(), createdAt:Date.now()+Math.random(), dealId:null, ...s }));
  b.transactions.push(...sample); saveState(); renderBusiness();
}

/* ===================================================================
   EVENT WIRING
   =================================================================== */
function init(){
  // Cosmetic icon splash on open (~1.3s, no data work)
  (function(){ const el=document.getElementById('pt-loading'); if(el){ el.classList.remove('hidden');
    setTimeout(()=>{ el.classList.add('fading'); setTimeout(()=>el.classList.add('hidden'),350); },1300); } })();

  // Business sub-tabs
  $$('.biz-tab').forEach(t=>t.addEventListener('click',()=>setBizTab(t.dataset.btab)));

  // Home period selector (both empty + content copies share data-hperiod)
  $$('[data-hperiod]').forEach(btn=>btn.addEventListener('click',()=>{
    homePeriod=btn.dataset.hperiod;
    $$('[data-hperiod]').forEach(x=>x.classList.toggle('active',x.dataset.hperiod===homePeriod));
    renderHome();
  }));

  // Period selector
  $$('#pane-dashboard .seg-btn').forEach(btn=>btn.addEventListener('click',()=>{
    currentPeriod=btn.dataset.period;
    $$('#pane-dashboard .seg-btn').forEach(x=>x.classList.toggle('active',x===btn));
    const b=activeBiz(); if(b) renderDashboard(b);
  }));
  // Filter
  $$('#pane-transactions .seg-btn').forEach(btn=>btn.addEventListener('click',()=>{
    currentFilter=btn.dataset.filter;
    $$('#pane-transactions .seg-btn').forEach(x=>x.classList.toggle('active',x===btn));
    const b=activeBiz(); if(b) renderTransactions(b);
  }));
  // Search
  $('#tx-search').addEventListener('input',e=>{ searchTerm=e.target.value; const b=activeBiz(); if(b) renderTransactions(b); });
  // Type toggle
  $$('.type-btn').forEach(b=>b.addEventListener('click',()=>setSheetType(b.dataset.type)));

  // Transaction deal + partner add-on wiring
  $('#tx-dealname').addEventListener('input',syncTxDealUI);
  $('#tx-partner-toggle').addEventListener('change',syncTxPartnerFields);
  $('#tx-partner-select').addEventListener('change',syncTxPartnerNewName);
  $$('.mt-btn').forEach(btn=>btn.addEventListener('click',()=>setTxMoneyType(btn.dataset.mt)));

  // Settings inputs
  $('#set-biz-name').addEventListener('input',e=>{ const b=activeBiz(); if(!b) return; b.name=e.target.value; saveState(); $('#biz-nav-title').textContent=e.target.value||'Business'; });
  $('#set-currency').addEventListener('change',e=>{ const b=activeBiz(); if(!b) return; b.currency=e.target.value; saveState(); });
  $('#set-start-balance').addEventListener('input',e=>{ const b=activeBiz(); if(!b) return; b.startingBalance=parseFloat(e.target.value)||0; saveState(); });
  $('#import-file').addEventListener('change',e=>{ if(e.target.files[0]) importCSV(e.target.files[0]); e.target.value=''; });

  // Delegated actions
  document.body.addEventListener('click',e=>{
    const btn=e.target.closest('[data-action]'); if(!btn) return;
    ({
      'add-business':openBizSheet, 'save-business':saveBusiness, 'close-biz-sheet':closeBizSheet,
      'cycle-currency':cycleCurrency,
      'home-transactions':()=>homeJumpTo('transactions'),
      'home-settings':()=>homeJumpTo('settings'),
      'go-home':goHome, 'business-settings':openBusinessSettings, 'back-to-business':()=>{ renderBusiness(); showView('view-business'); },
      'open-add':()=>openTxSheet(null), 'close-sheet':closeTxSheet, 'save-tx':saveTransaction, 'delete-tx':deleteTransaction,
      'add-category':addCategory, 'add-venture':addDeal,
      'export':exportCSV, 'load-sample':loadSampleData, 'delete-business':deleteBusiness,
      'add-partner':()=>openPartnerSheet(null), 'save-partner':savePartner, 'delete-partner':deletePartner, 'close-partner-sheet':closePartnerSheet,
      'save-payout':savePayout, 'close-payout-sheet':closePayoutSheet
    }[btn.dataset.action]||(()=>{}))();
  });

  // Tap backdrop to close sheets
  ['tx-sheet','partner-sheet','payout-sheet','biz-sheet'].forEach(id=>{
    $('#'+id).addEventListener('click',e=>{ if(e.target.id===id){
      if(id==='tx-sheet') closeTxSheet(); else if(id==='partner-sheet') closePartnerSheet();
      else if(id==='payout-sheet') closePayoutSheet(); else closeBizSheet();
    }});
  });

  // Start on Home
  renderHome(); showView('view-home');

  // Fetch live FX in the background (cache/manual already used for first paint).
  // Note: cannot be tested in this sandboxed environment (network blocked).
  fetchRates();
}
document.addEventListener('DOMContentLoaded',init);
