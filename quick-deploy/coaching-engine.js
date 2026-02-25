// RISK SIGNAL + COACHING ENGINE + DEAL TABLE HELPERS
const secNames=["Metrics","Economic Buyer","Decision Process","Decision Criteria","Paper Process","Identify Pain","Champion","Competition"];
function getSec(o,name){const s=o.scores?.[name]||{};return{score:s.score||0,max:s.max||1,pct:s.pct||0}}

function getDaysSinceCall(o){
  const calls=o.calls||[];if(!calls.length)return 999;
  const last=calls.reduce((l,c)=>c.date>l?c.date:l,"");
  return Math.ceil((Date.now()-new Date(last))/864e5);
}

function getStakeholderCoverage(o){
  const s=o.stakeholders||[];if(!s.length)return{engaged:0,total:0,pct:0};
  const engaged=s.filter(x=>x.engagement==="high"||x.engagement==="medium").length;
  return{engaged,total:s.length,pct:s.length?Math.round(engaged/s.length*100):0};
}

function getScoreTrend(o){
  const h=o.history||[];if(h.length<2)return{delta:0,dir:"flat"};
  const prev=h[h.length-2].totalScore;const curr=h[h.length-1].totalScore;
  const d=curr-prev;
  return{delta:d,dir:d>0?"up":d<0?"down":"flat"};
}

function countNoAnswers(o){
  const m=o.meddpicc||{};let nos=0,partials=0;
  Object.values(m).forEach(sec=>{
    if(!sec||!sec.questions)return;
    sec.questions.forEach(q=>{
      const a=(q.answer||"").toLowerCase();
      if(a==="no")nos++;
      if(a==="partial")partials++;
    });
  });
  return{nos,partials};
}

function getDealRisks(o){
  const risks=[],dtc=Math.ceil((new Date(o.closeDate)-Date.now())/864e5);

  // === ANALYST-PROVIDED RISKS (from MEDDPICC incremental updates) ===
  if(o.dealRisks&&o.dealRisks.length){
    o.dealRisks.forEach(r=>{
      const sev=r.severity==="high"?"high":r.severity==="medium"?"med":"low";
      risks.push({sev,signal:r.risk,coaching:r.category?("Category: "+r.category):"",source:"analyst"});
    });
  }

  // === AUTO-GENERATED RISKS (from scores, dates, activity) ===
  const calls=o.calls||[],lastCall=calls.length?calls.reduce((l,c)=>c.date>l?c.date:l,""):null;
  const ds=lastCall?Math.ceil((Date.now()-new Date(lastCall))/864e5):999;
  const comp=o.competitive?.primary||o.competitor||"";
  const intent=(o.merchantIntent||"").toLowerCase();
  const pp=getSec(o,"Paper Process"),dp=getSec(o,"Decision Process"),eb=getSec(o,"Economic Buyer");
  const ch=getSec(o,"Champion"),ip=getSec(o,"Identify Pain"),mt=getSec(o,"Metrics"),co=getSec(o,"Competition");
  const dc=getSec(o,"Decision Criteria");
  const total=o.scores?._total||{pct:0};
  const {nos,partials}=countNoAnswers(o);

  // === HIGH SEVERITY ===

  // Close imminent + any section below 60%
  if(dtc<=14){
    if(pp.pct<70) risks.push({sev:"high",signal:"Close in "+dtc+"d but Paper Process at "+pp.score+"/"+pp.max+" ("+pp.pct+"%)",coaching:"Is the contract sent? Who signs? Map verbal yes → ink on paper this week."});
    if(dp.pct<70) risks.push({sev:"high",signal:"Close in "+dtc+"d but Decision Process at "+dp.score+"/"+dp.max+" ("+dp.pct+"%)",coaching:"If the buying committee hasn't aligned, this deal will slip past close date."});
    if(eb.pct<60) risks.push({sev:"high",signal:"Close in "+dtc+"d but Economic Buyer at "+eb.score+"/"+eb.max+" ("+eb.pct+"%)",coaching:"Who writes the check? Have we spoken to them directly? This is critical with "+dtc+" days left."});
    if(ch.pct<60) risks.push({sev:"high",signal:"Close in "+dtc+"d but Champion at "+ch.score+"/"+ch.max+" ("+ch.pct+"%)",coaching:"No strong internal advocate with days to close. Who is selling Shopify when we're not in the room?"});
    if(co.pct<60) risks.push({sev:"high",signal:"Close in "+dtc+"d but Competition at "+co.score+"/"+co.max+" ("+co.pct+"%)",coaching:"We may not know the full competitive picture. Status quo / do-nothing is often the real threat."});
  }

  // Merchant intent at risk
  if(intent.includes("at risk") || intent.includes("at-risk")){
    risks.push({sev:"high",signal:"Merchant Intent is '"+o.merchantIntent+"'",coaching:"Something is flagged as at-risk in Salesforce. Validate what changed and whether the blocker is addressable."});
  }

  // No calls in >21 days when close is <30 days
  if(ds>21 && dtc<=30){
    risks.push({sev:"high",signal:"No calls in "+ds+"d with close in "+dtc+"d — going cold at the worst time",coaching:"Silence kills deals in the final stretch. What is blocking the next conversation?"});
  } else if(ds>30){
    risks.push({sev:ds>60?"high":"med",signal:"No calls in "+(ds===999?"ever":ds+"d")+" — going cold",coaching:"Silence kills deals. What is blocking the next conversation?"});
  }

  // Any "No" answers in MEDDPICC
  if(nos>=3){
    risks.push({sev:"high",signal:nos+" questions scored 'No' in MEDDPICC — significant gaps remain",coaching:"Multiple unknowns create compound risk. Prioritize filling the top gaps before close."});
  } else if(nos>=1 && dtc<=14){
    risks.push({sev:"high",signal:nos+" 'No' answer(s) in MEDDPICC with "+dtc+"d to close",coaching:"Every 'No' at this stage is a potential deal-breaker. Address each one this week."});
  }

  // === MEDIUM SEVERITY ===

  // Champion strong but EB weak (coach vs champion gap)
  if(ch.pct>=60 && eb.pct<60) risks.push({sev:"med",signal:"Champion strong ("+ch.score+"/"+ch.max+") but Economic Buyer weak ("+eb.score+"/"+eb.max+")",coaching:"You may have a coach, not a champion. Can they get you in front of the budget holder?"});

  // Pain identified but metrics not quantified
  if(ip.pct>=70 && mt.pct<60) risks.push({sev:"med",signal:"Pain identified ("+ip.score+"/"+ip.max+") but Metrics weak ("+mt.score+"/"+mt.max+")",coaching:"Pain without numbers doesn't create urgency. Quantify the cost of inaction."});

  // Decision Criteria weak when close is near
  if(dc.pct<65 && dtc<=30) risks.push({sev:"med",signal:"Decision Criteria at "+dc.score+"/"+dc.max+" ("+dc.pct+"%) with close in "+dtc+"d",coaching:"Are we shaping the eval criteria or are they set by the competition? Reframe around Shopify strengths."});

  // Low stakeholder engagement
  const stk=getStakeholderCoverage(o);
  if(stk.total>=3 && stk.pct<40) risks.push({sev:"med",signal:"Only "+stk.engaged+" of "+stk.total+" stakeholders engaged — thin coverage",coaching:"Multi-threaded deals are safer. Engage more of the buying committee."});

  // Economic buyer identified but no direct access (check for "No" on EB Q3 or Q5)
  const ebQs=(o.meddpicc?.["Economic Buyer"]||o.meddpicc?.economicBuyer||{}).questions||[];
  const ebNoAccess=ebQs.some(q=>(q.answer||"").toLowerCase()==="no");
  if(ebNoAccess) risks.push({sev:"med",signal:"Economic Buyer identified but at least one critical gap (a 'No' in EB section)",coaching:"We know who the EB is but haven't validated access or alignment. Push for a direct touchpoint."});

  // Overall health below 70% with close in <30d
  if(total.pct<70 && dtc<=30) risks.push({sev:"med",signal:"Overall health at "+total.pct+"% with close in "+dtc+"d",coaching:"The deal health score suggests more work is needed. Review the weakest MEDDPICC sections."});

  // === LOW SEVERITY ===

  // Many partials suggest gaps
  if(partials>=8) risks.push({sev:"low",signal:partials+" questions scored 'Partial' — lots of gray areas",coaching:"Partials mean we have some info but not enough conviction. Push for clarity on the biggest ones."});

  // No competitor on record
  if((!comp||comp==="None"||comp==="null") && co.pct<70) risks.push({sev:"low",signal:"No clear competitor on record but Competition score "+co.score+"/"+co.max,coaching:"They might be hiding alternatives, or doing nothing is the real threat."});

  return risks;
}
function getRepCoaching(ow,deals){
  const secs={};secNames.forEach(s=>{secs[s]={score:0,max:0,deals:[]}});
  deals.forEach(o=>{Object.values(o.meddpicc||{}).forEach(sec=>{
    const l=sec.label;if(!secs[l])return;const qs=sec.questions||[];
    const sc=qs.reduce((s,q)=>s+(q.score||0),0);
    secs[l].score+=sc;secs[l].max+=qs.length;
    secs[l].deals.push({name:o.accountName,id:o.id,pct:qs.length?Math.round(sc/qs.length*100):0});
  })});
  const ranked=secNames.map(s=>{const d=secs[s];return{name:s,score:d.score,max:d.max,pct:d.max?Math.round(d.score/d.max*100):0,deals:d.deals.sort((a,b)=>a.pct-b.pct)}}).sort((a,b)=>a.pct-b.pct);
  return{ranked,weakest:ranked[0],strongest:ranked[ranked.length-1]};
}
function coachTip(owner,data){
  const w=data.weakest,fn=owner.split(" ")[0];
  const wd=w.deals.filter(d=>d.pct<50).map(d=>"<b>"+d.name+"</b> ("+d.pct+"%)").join(", ");
  const tips={
    "Paper Process":fn+" deals stall at paper process. <i>For each deal, walk me through verbal yes to signed contract.</i>",
    "Economic Buyer":fn+" finds pain but does not get to the budget holder. <i>Who writes the check? Have you met them?</i>",
    "Competition":fn+" is not mapping the competitive landscape. <i>What are the other options, including doing nothing?</i>",
    "Champion":fn+" needs stronger internal advocates. <i>Who sells Shopify when you are not in the room?</i>",
    "Decision Process":fn+" does not have visibility into the decision. <i>Walk me through now to signature.</i>",
    "Decision Criteria":fn+" may not be shaping eval criteria. <i>What criteria are they using? Did we help define them?</i>",
    "Metrics":fn+" finds problems but does not quantify impact. <i>What is this costing them? Put a dollar on the pain.</i>",
    "Identify Pain":fn+" needs deeper discovery. <i>Beyond the surface, what is the business impact?</i>",
  };
  return(tips[w.name]||"Focus on <b>"+w.name+"</b>")+(wd?" Weakest: "+wd:"");
}
