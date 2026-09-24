// Plain data is the execution boundary: generated specifications are never evaluated as code.
const own = (o, k) => Object.hasOwn(o, k);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = message => { throw new Error(message); };
function keys(o, allowed) { if (!record(o) || Object.keys(o).some(k => !allowed.includes(k))) fail('Unexpected specification field. Only the documented JSON schema is accepted.'); }
function text(s, name) { if (typeof s !== 'string' || !s.trim()) fail(`${name} must be non-empty text.`); }
export function validateSpec(s) {
  keys(s, ['title','description','state','questions']); text(s.title,'Title'); text(s.description,'Description'); text(s.state,'State');
  if (!record(s.questions) || !Object.keys(s.questions).length) fail('At least one question is required.');
  for (const [id,q] of Object.entries(s.questions)) {
    if (!/^[a-z][a-z0-9_]*$/.test(id) || ['constructor','prototype','__proto__'].includes(id)) fail('Use simple lowercase question IDs.');
    keys(q,['type','instructions','criteria']); text(q.instructions,'Instructions');
    if (!['noul','choice','score'].includes(q.type)) fail('Question type must be noul, choice or score.');
    if(q.type === 'choice') {
      if(!record(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255) fail('Choice requires 2–255 named options in this workbench.');
      for(const [k,v] of Object.entries(q.criteria)) { text(k,'Option'); text(v,'Option description'); }
    }
    if(q.type === 'score') {
      if(!Array.isArray(q.criteria) || q.criteria.length<2 || q.criteria.length>10) fail('Score requires 2–10 ordered levels (Jev-compatible).');
      q.criteria.forEach(v=>text(v,'Score level'));
    }
    if(q.type === 'noul' && own(q,'criteria')) {
      keys(q.criteria,['true','false']); for(const v of Object.values(q.criteria)) text(v,'Noul criterion');
    }
  }
  return structuredClone(s);
}
export function requestFor(spec, model) { validateSpec(spec); text(model,'Model'); return {model,state:spec.state,questions:spec.questions}; }
export function validateAnswers(data, questions) {
  if(!record(data) || !record(data.answers)) fail('Provider did not return an answers object.');
  const unit = v => typeof v==='number' && Number.isFinite(v) && v>=0 && v<=1;
  for(const [id,q] of Object.entries(questions)) {
    const a=data.answers[id]; if(!record(a) || a.type!==q.type) fail(`Missing or wrong answer type: ${id}.`);
    if(q.type==='noul') { if(!unit(a.noul)) fail(`Invalid probability: ${id}.`); continue; }
    const names=q.type==='choice'?Object.keys(q.criteria):q.criteria.map((_,i)=>String(i));
    if(!record(a.probabilities) || Object.keys(a.probabilities).length!==names.length || names.some(k=>!own(a.probabilities,k)||!unit(a.probabilities[k]))) fail(`Invalid distribution: ${id}.`);
    // Provider rounds individual probabilities; tolerate at most half a hundredth per option.
    if(Math.abs(Object.values(a.probabilities).reduce((x,y)=>x+y,0)-1)>names.length*0.005+1e-8) fail(`Distribution does not sum to one: ${id}.`);
    if(!unit(a.confidence)) fail(`Invalid confidence: ${id}.`);
    if(q.type==='choice' && !names.includes(a.choice)) fail(`Out-of-set choice: ${id}.`);
    if(q.type==='score' && !(typeof a.score==='number' && Number.isFinite(a.score) && a.score>=0 && a.score<=names.length-1)) fail(`Invalid score: ${id}.`);
  }
  return data;
}
export function gate(answer, threshold) {
  if(!Number.isFinite(threshold)||threshold<0||threshold>1) fail('Threshold must be between zero and one.');
  return answer.type==='noul' ? (answer.noul>=threshold?'positive':answer.noul<=1-threshold?'negative':'review') : (answer.confidence>=threshold?'accept':'review');
}
export function loopbackEndpoint(value) {
  let u; try { u=new URL(value); } catch { fail('Enter a loopback URL, for example http://127.0.0.1:8009/v1/systemone.'); }
  if(!['http:','https:'].includes(u.protocol)||!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/v1/systemone') fail('Kev endpoint must be loopback, with path /v1/systemone and no credentials or query.');
  return u.href;
}
async function post(url, headers, body, signal) {
  let response;
  try { response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'}); }
  catch(e) { if(signal?.aborted) throw new Error('Request cancelled or timed out. No automatic retry.'); throw new Error('Connection failed or browser CORS refused. Jev rejected the Pages origin in our preflight check. Serve locally and select the optional relay for hosted APIs; for Kev check the server and local-network permission. No automatic retry.'); }
  if(!response.ok) throw new Error(`Provider returned HTTP ${response.status}. Check access, model name or rate limits. No automatic retry.`);
  return response.json();
}
function providerURL(provider, settings, direct) {
  if(settings.transport!=='relay') return direct;
  if(typeof location==='undefined'||!['127.0.0.1','localhost','[::1]'].includes(location.hostname)) fail('Relay is available only when serving this site locally.');
  return new URL('/api/'+provider,location.origin).href;
}
export async function decide(spec, settings, signal=AbortSignal.timeout(45000)) {
  const url=settings.provider==='jev'?providerURL('jev',settings,'https://api.typesafe.ai/v1/systemone'):loopbackEndpoint(settings.endpoint);
  if(settings.provider==='jev'&&!settings.key?.trim()) fail('Enter a Jev API key first.');
  const start=performance.now();
  const data=validateAnswers(await post(url,settings.provider==='jev'?{Authorization:`Bearer ${settings.key}`}:{},requestFor(spec,settings.model),signal),spec.questions);
  return {data,elapsed:performance.now()-start,source:settings.provider==='jev'?'Jev API':'Kev local server',requestedModel:settings.model};
}
export const GENERATOR_PROMPT = `You design small educational decision-model experiments. Return ONLY a JSON object with exactly title (string), description (string), state (string), questions (object keyed by lowercase IDs). Each question has type, instructions (string), and optionally criteria. Types: noul = probability of yes, criteria optional {true:string,false:string}; choice = select among criteria object mapping 2–255 labels to string descriptions; score = expected index across criteria array of 2–10 ordered string levels. At least one question. No other fields. These are System One decisions: text context and bounded choices, not prose generation or chain-of-thought. Keep questions independent: they see the same state, not each other's answers. Include an abstain option where useful. Code, not the model, must do arithmetic, enforce permissions and perform actions. Never request keys, fetch URLs or emit HTML/JavaScript. Produce a meaningful state and rubric for the user's idea. The renderer is fixed: input editor, distributions, confidence and threshold. You cannot invent extra UI or code.`;
export async function generate(idea, settings, signal=AbortSignal.timeout(45000)) {
  text(idea,'Idea'); text(settings.key,'Generator API key'); text(settings.model,'Generator model');
  const claude=settings.provider==='claude';
  const data=await post(providerURL(claude?'claude':'openai',settings,claude?'https://api.anthropic.com/v1/messages':'https://api.openai.com/v1/chat/completions'),claude?{'x-api-key':settings.key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'}:{Authorization:`Bearer ${settings.key}`},claude?{model:settings.model,max_tokens:4096,system:GENERATOR_PROMPT,messages:[{role:'user',content:idea}]}:{model:settings.model,messages:[{role:'system',content:GENERATOR_PROMPT},{role:'user',content:idea}],response_format:{type:'json_object'}},signal);
  const content=claude?data.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n'):data.choices?.[0]?.message?.content;
  if(typeof content!=='string') fail('Generator returned no textual specification.');
  let spec;try { spec=JSON.parse(content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')); } catch { fail('Generator did not return valid JSON. Nothing was executed.'); }
  return validateSpec(spec);
}
export function illustrative(spec, strength=.78) {
  validateSpec(spec);
  const answers=Object.fromEntries(Object.entries(spec.questions).map(([id,q])=>{
    if(q.type==='noul') return [id,{type:'noul',noul:strength}];
    const names=q.type==='choice'?Object.keys(q.criteria):q.criteria.map((_,i)=>String(i));
    const probabilities=Object.fromEntries(names.map((k,i)=>[k,i===0?strength:(1-strength)/(names.length-1)]));
    const confidence=(strength-1/names.length)/(1-1/names.length);
    return [id,q.type==='choice'?{type:'choice',choice:names[0],probabilities,confidence:Math.max(0,confidence)}:{type:'score',score:Object.values(probabilities).reduce((sum,p,i)=>sum+p*i,0),probabilities,confidence:Math.max(0,confidence)}];
  }));
  return {data:{model:'synthetic-distribution-not-a-model',answers},elapsed:0,source:'ILLUSTRATIVE — fixed distribution, no AI',requestedModel:'none'};
}
export function trialMetrics(answer, expected, threshold) {
  const p=answer.probabilities;
  if(answer.type!=='choice'||!own(p,expected)) fail('Expected label must be one of the Choice options.');
  return {correct:answer.choice===expected,expectedProbability:p[expected],brier:Object.entries(p).reduce((sum,[k,v])=>sum+(v-(k===expected?1:0))**2,0),gate:gate(answer,threshold)};
}
