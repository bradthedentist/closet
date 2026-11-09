// Shared scoring/policy for automatic clothing type. Copied unchanged in logic from closet-auto-classifier/classifier-core.mjs
// (policy closet-auto-type-policy-2026-11-08-provisional-1, MIN_MARGIN 0.020). Scores are rankings, not calibrated confidence.
// Shared, dependency-free scoring/policy for Closet Organizer automatic clothing type.
// Used identically by the Node evaluation and by the browser harness/app.
// Scores are cosine-similarity RANKINGS, not calibrated probabilities of correctness.
export const CATEGORIES = Object.freeze(['tops','bottoms','dresses','outerwear','shoes','bags','accessories']);
export const NON_CLOTHING = 'not_clothing';
export const PROMPTS = Object.freeze({
  tops: ['a t-shirt','a shirt','a blouse','a sweater','a tank top','a hoodie','a knit top','a polo shirt'],
  bottoms: ['a pair of jeans','a pair of trousers','a pair of pants','a pair of shorts','a skirt','a pair of leggings'],
  dresses: ['a dress','a gown','a sundress','a maxi dress','a sleeveless dress'],
  outerwear: ['a coat','a jacket','a puffer jacket','a raincoat','a blazer','a denim jacket','a leather jacket','a parka'],
  shoes: ['a pair of shoes','a pair of sneakers','a pair of boots','a pair of sandals','a pair of high heels','a pair of loafers'],
  bags: ['a handbag','a backpack','a tote bag','a purse','a clutch bag','a crossbody bag'],
  accessories: ['a hat','a cap','a scarf','a belt','a necktie','a pair of sunglasses','a pair of gloves','a necklace','a wristwatch'],
  not_clothing: ['a photo of a room','a landscape','a document with text','a street sign','an animal','food','furniture','a screenshot','a building','a car']
});
export const PROMPT_TEMPLATE = 'a photo of {}';
export const POLICY_VERSION = 'closet-auto-type-policy-2026-11-08-provisional-1';
// Provisional decision rule, chosen on a SMALL licensed public validation set (see validation report).
// It is NOT a calibrated confidence. A result is saved as an AI suggestion (reviewed:false) only when:
//  - top category is a clothing category (not not_clothing), and
//  - cosine margin between best and second-best category >= MIN_MARGIN.
// Everything else saves category:null with needsReview:true (original still saved).
export const MIN_MARGIN = 0.020;

export function l2(v){let s=0;for(const x of v)s+=x*x;s=Math.sqrt(s)||1;return Array.from(v,x=>x/s);}
export function dot(a,b){let s=0;for(let i=0;i<a.length;i++)s+=a[i]*b[i];return s;}

// textBank: {modelId, revision, dims, entries:[{category,prompt,embedding:[...]}]} (embeddings L2-normalized)
export function scoreImage(imageEmbedding, textBank){
  if(!textBank||!Array.isArray(textBank.entries)||!textBank.entries.length) throw new Error('Text bank missing.');
  const img=l2(imageEmbedding);
  if(img.length!==textBank.dims) throw new Error('Embedding dimension mismatch; model/text bank revision differ.');
  const best={};
  for(const e of textBank.entries){const s=dot(img,e.embedding);if(!(e.category in best)||s>best[e.category].score)best[e.category]={category:e.category,score:s,prompt:e.prompt};}
  const ranking=Object.values(best).sort((a,b)=>b.score-a.score).map(x=>({category:x.category,score:round(x.score),bestPrompt:x.prompt}));
  return ranking;
}
export function decide(ranking){
  const top=ranking[0],second=ranking[1];const margin=round(top.score-second.score);
  if(top.category===NON_CLOTHING) return {status:'needs_review',category:null,reason:'may_not_be_clothing',margin};
  if(margin<MIN_MARGIN) return {status:'needs_review',category:null,reason:'close_ranking',margin,topCandidates:[top.category,second.category]};
  return {status:'ai_suggested',category:top.category,reason:'top_rank_margin',margin};
}
function round(x){return Math.round(x*1e5)/1e5;}

// Compact text bank: float16 little-endian embeddings, base64. Decoded with no dependencies (browser, Node, Apps Script).
export function halfToFloat(h){const s=(h&0x8000)?-1:1,e=(h>>10)&0x1f,f=h&0x3ff;if(e===0)return s*Math.pow(2,-14)*(f/1024);if(e===31)return f?NaN:s*Infinity;return s*Math.pow(2,e-15)*(1+f/1024);}
export function expandCompactBank(c,b64decode){
  const bytes=b64decode(c.f16Base64);const n=c.prompts.length*c.dims;if(bytes.length!==n*2)throw new Error('Text bank size mismatch.');
  const entries=c.prompts.map((p,i)=>{const v=new Array(c.dims);for(let k=0;k<c.dims;k++){const o=(i*c.dims+k)*2;v[k]=halfToFloat((bytes[o]&255)|((bytes[o+1]&255)<<8));}return {category:p.category,prompt:p.prompt,embedding:v};});
  return {modelId:c.modelId,revision:c.revision,dims:c.dims,entries};
}
