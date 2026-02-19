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
function getDealRisks(o){
  const risks=[],dtc=Math.ceil((new Date(o.closeDate)-Date.now())/864e5);
  const calls=o.calls||[],lastCall=calls.length?calls.reduce((l,c)=>c.date>l?c.date:l,""):null;
  const ds=lastCall?Math.ceil((Date.now()-new Date(lastCall))/864e5):999;
  const comp=o.competitor||"";
  const pp=getSec(o,"Paper Process"),dp=getSec(o,"Decision Process"),eb=getSec(o,"Economic Buyer");
  const ch=getSec(o,"Champion"),ip=getSec(o,"Identify Pain"),mt=getSec(o,"Metrics"),co=getSec(o,"Competition");
  if(dtc<=14&&pp.score<3) risks.push({sev:"high",signal:"Close in "+dtc+"d but Paper Process at "+pp.score+"/"+pp.max,coaching:"Get the contract sent this week or the close date needs to move."});
  if(dtc<=14&&dp.score<4) risks.push({sev:"high",signal:"Close in "+dtc+"d but Decision Process at "+dp.score+"/"+dp.max,coaching:"If the buying committee has not aligned, this deal will slip."});
  if(dtc<=14&&eb.score<3) risks.push({sev:"high",signal:"Close in "+dtc+"d but Economic Buyer at "+eb.score+"/"+eb.max,coaching:"Who writes the check, and have we spoken to them?"});
  if(ch.score>=4&&eb.score<3) risks.push({sev:"med",signal:"Champion strong ("+ch.score+") but EB weak ("+eb.score+")",coaching:"You have a coach, not a champion. Get in front of the budget holder."});
  if(ip.score>=6&&mt.score<4) risks.push({sev:"med",signal:"Pain identified ("+ip.score+") but Metrics weak ("+mt.score+")",coaching:"Pain without numbers does not create urgency. Quantify the cost."});
  if(ds>30) risks.push({sev:ds>60?"high":"med",signal:"No calls in "+(ds===999?"ever":ds+"d")+" \u2014 going cold",coaching:"Silence kills deals. What is blocking the next conversation?"});
  if((!comp||comp==="None")&&co.score<3) risks.push({sev:"low",signal:"No competitor on record but Competition score "+co.score+"/"+co.max,coaching:"They might be hiding alternatives or doing nothing is the real threat."});
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
