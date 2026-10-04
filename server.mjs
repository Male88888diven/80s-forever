import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import OpenAI from 'openai';
import Stripe from 'stripe';

const app = express();
const port = process.env.PORT || 3000;
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const orders = new Map();
const uploadDir = path.resolve('uploads');
const generatedDir = path.resolve('generated');
fs.mkdirSync(uploadDir,{recursive:true});
fs.mkdirSync(generatedDir,{recursive:true});
const upload = multer({dest: uploadDir, limits:{fileSize:12*1024*1024}, fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|png|webp)$/.test(file.mimetype))});
const openai = new OpenAI({apiKey:process.env.OPENAI_API_KEY});
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const prompts={
 neon:'Transform this customer photo into a polished photorealistic 1980s neon portrait. Preserve the person\'s identity, face, age and recognizable features. Add magenta and cyan neon rim lighting, a dark retro nightclub atmosphere, subtle 1980s grid and glow. Do not distort the face.',
 arcade:'Transform this customer photo into a polished photorealistic 1980s arcade scene. Preserve the person\'s identity, face, age and recognizable features. Add colorful arcade-machine lighting, retro game-room atmosphere and tasteful pixel-inspired background elements. Do not distort the face.',
 magazine:'Transform this customer photo into a polished photorealistic 1980s fashion magazine cover portrait. Preserve the person\'s identity, face, age and recognizable features. Add studio lighting, authentic 1980s fashion styling, analog film grain and editorial composition. Do not distort the face.'
};

app.post('/api/stripe-webhook', express.raw({type:'application/json'}), async (req,res)=>{
  if(!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe nicht konfiguriert');
  let event;
  try { event=stripe.webhooks.constructEvent(req.body,req.headers['stripe-signature'],process.env.STRIPE_WEBHOOK_SECRET); }
  catch(e){ return res.status(400).send('Webhook ungültig'); }
  if(event.type==='checkout.session.completed'){
    const s=event.data.object; const id=s.metadata?.orderId; const order=orders.get(id);
    if(order){ order.status='processing'; await processOrder(order).catch(err=>{order.status='error';order.error=err.message;}); }
  }
  res.json({received:true});
});
app.use(express.json());
app.use(express.static('public'));
app.get('/api/health',(req,res)=>res.json({ok:true}));
app.get('/api/order/:id',(req,res)=>{const o=orders.get(req.params.id); if(!o)return res.status(404).json({error:'Nicht gefunden'}); res.json({status:o.status,images:o.images||[],error:o.error||null});});

app.post('/api/create-checkout', upload.single('photo'), async (req,res)=>{
  if(!stripe) return res.status(503).json({error:'Zahlung ist noch nicht eingerichtet.'});
  const email=String(req.body.email||'').trim(); const style=String(req.body.style||'neon');
  if(!req.file || !email || !prompts[style]) return res.status(400).json({error:'Bitte E-Mail, Stil und Foto angeben.'});
  const orderId=crypto.randomUUID();
  orders.set(orderId,{id:orderId,email,style,sourceFile:req.file.path,status:'waiting_payment',images:[]});
  try{
    const session=await stripe.checkout.sessions.create({mode:'payment',locale:'de',customer_email:email,
      line_items:[{price_data:{currency:'eur',unit_amount:990,product_data:{name:'80s Forever – 3 KI-Bilder'}},quantity:1}],
      metadata:{orderId},success_url:`${baseUrl}/success.html?order_id=${orderId}`,cancel_url:`${baseUrl}/?cancelled=1`});
    res.json({url:session.url});
  }catch(e){orders.delete(orderId); try{fs.unlinkSync(req.file.path)}catch{}; res.status(500).json({error:'Zahlung konnte nicht gestartet werden.'});}
});

async function processOrder(order){
  if(!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY fehlt');
  const result=[];
  for(let i=0;i<3;i++){
    const r=await openai.images.edit({model:'gpt-image-1',image:fs.createReadStream(order.sourceFile),prompt:`${prompts[order.style]} Create variation ${i+1}; customer-ready result.`,input_fidelity:'high',size:'1024x1024',quality:'auto',output_format:'jpeg'});
    const b64=r.data?.[0]?.b64_json; if(!b64) throw new Error('Kein Bild von OpenAI erhalten');
    const file=path.join(generatedDir,`${order.id}-${i+1}.jpg`); fs.writeFileSync(file,Buffer.from(b64,'base64'));
    result.push(`/generated/${path.basename(file)}`);
  }
  order.images=result; order.status='completed';
  try{fs.unlinkSync(order.sourceFile)}catch{}
}
app.use('/generated',express.static(generatedDir));
app.listen(port,'0.0.0.0',()=>console.log(`80s Forever läuft auf Port ${port}`));
