// ============================================================
// PixelShot Backend — server.js
// ============================================================
import express from 'express';
import multer from 'multer';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fetch from 'node-fetch';
import FormData from 'form-data';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import cors from 'cors';
import 'dotenv/config';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL ?? 'https://ghkmaibdovixhqpnlrao.supabase.co',
  process.env.SUPABASE_SERVICE_KEY ?? 'sb_secret_EqyK7N7JbsNN_YJV01-C_A_qbXrHtSs'
);
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: { accessKeyId: process.env.AWS_ACCESS_KEY, secretAccessKey: process.env.AWS_SECRET_KEY }
});
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const PLANS = {
  starter: { price: 999,  currency: 'eur', name: '1 Style — 40 Headshots',  styles: 1, shots: 40 },
  value:   { price: 1298, currency: 'eur', name: '2 Styles — 80 Headshots',  styles: 2, shots: 80 },
  pro:     { price: 1596, currency: 'eur', name: '4 Styles — 160 Headshots', styles: 4, shots: 160 }
};

const STYLE_PROMPTS = {
  professional: "professional corporate headshot, wearing a dark suit and tie, neutral grey background, soft studio lighting, sharp focus, 4K",
  casual:       "smart casual headshot, wearing a clean shirt, modern office background, natural light, friendly expression, 4K",
  creative:     "creative professional headshot, artistic composition, dynamic urban background, confident pose, 4K",
  executive:    "executive C-suite headshot, power pose, authoritative look, premium suit, minimalist background, 4K"
};

// 1. CREATE STRIPE CHECKOUT SESSION
app.post('/api/checkout', async (req, res) => {
  try {
    const { plan, email, style } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Invalid plan' });
    const jobId = crypto.randomUUID();
    await supabase.from('jobs').insert({
      id: jobId, email, plan, style, status: 'pending_payment',
      created_at: new Date().toISOString()
    });
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: PLANS[plan].currency,
          product_data: { name: `PixelShot — ${PLANS[plan].name}`, description: `${PLANS[plan].shots} AI headshots` },
          unit_amount: PLANS[plan].price,
        },
        quantity: 1,
      }],
      mode: 'payment',
      customer_email: email,
      metadata: { jobId, plan, style },
      success_url: `${process.env.FRONTEND_URL}/upload.html?job=${jobId}`,
      cancel_url: `${process.env.FRONTEND_URL}/#pricing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// 2. STRIPE WEBHOOK
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const { jobId } = event.data.object.metadata;
    await supabase.from('jobs').update({ status: 'paid' }).eq('id', jobId);
    console.log(`Payment confirmed for job ${jobId}`);
  }
  res.json({ received: true });
});

// 3. UPLOAD PHOTOS
app.post('/api/upload/:jobId', upload.array('files', 20), async (req, res) => {
  const { jobId } = req.params;
  const { style } = req.body;
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  if (!job || job.status !== 'paid') return res.status(403).json({ error: 'Job not found or not paid' });
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });
  if (req.files.length < 10) return res.status(400).json({ error: 'Please upload at least 10 photos' });
  try {
    const uploadPromises = req.files.map(async (file, i) => {
      const key = `temp/${jobId}/photo-${i}.${file.mimetype.split('/')[1]}`;
      await s3.send(new PutObjectCommand({
        Bucket: process.env.S3_BUCKET, Key: key,
        Body: file.buffer, ContentType: file.mimetype,
      }));
      return `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
    });
    const photoUrls = await Promise.all(uploadPromises);
    await supabase.from('jobs').update({
      status: 'processing', style: style || job.style,
      photo_urls: photoUrls, uploaded_at: new Date().toISOString()
    }).eq('id', jobId);
    triggerAIGeneration(jobId, photoUrls, style || job.style, job.plan, job.email);
    res.json({ success: true, message: 'Photos uploaded! Generation started. Check your email in 20-30 minutes.' });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// 4. AI GENERATION
async function triggerAIGeneration(jobId, photoUrls, style, plan, email) {
  console.log(`Starting AI generation for job ${jobId}`);
  try {
    const tuneForm = new FormData();
    tuneForm.append('tune[title]', `pixelshot-${jobId}`);
    tuneForm.append('tune[name]', 'person');
    tuneForm.append('tune[base_tune_id]', '690204');
    tuneForm.append('tune[callback]', `${process.env.API_URL}/api/astria-callback/${jobId}`);
    photoUrls.forEach(url => tuneForm.append('tune[image_urls][]', url));
    const tuneRes = await fetch('https://api.astria.ai/tunes', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.ASTRIA_API_KEY}` },
      body: tuneForm,
    });
    const tuneData = await tuneRes.json();
    if (!tuneData.id) throw new Error(`Astria tune failed: ${JSON.stringify(tuneData)}`);
    await supabase.from('jobs').update({ astria_tune_id: tuneData.id }).eq('id', jobId);
    console.log(`Astria tune created: ${tuneData.id}`);
  } catch (err) {
    console.error('AI generation error:', err);
    await supabase.from('jobs').update({ status: 'failed', error: err.message }).eq('id', jobId);
  }
}

// 5. ASTRIA CALLBACK
app.post('/api/astria-callback/:jobId', async (req, res) => {
  const { jobId } = req.params;
  res.json({ received: true });
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  if (!job) return;
  const plan = PLANS[job.plan];
  const promptText = STYLE_PROMPTS[job.style] || STYLE_PROMPTS.professional;
  const shotsPerStyle = plan.shots / plan.styles;
  try {
    const promptForm = new FormData();
    promptForm.append('prompt[text]', `<lora:${job.astria_tune_id}:1> ${promptText}`);
    promptForm.append('prompt[num_images]', shotsPerStyle.toString());
    promptForm.append('prompt[super_resolution]', 'true');
    promptForm.append('prompt[face_swap]', 'true');
    promptForm.append('prompt[callback]', `${process.env.API_URL}/api/images-callback/${jobId}`);
    const promptRes = await fetch(`https://api.astria.ai/tunes/${job.astria_tune_id}/prompts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.ASTRIA_API_KEY}` },
      body: promptForm,
    });
    const promptData = await promptRes.json();
    console.log(`Generation started for job ${jobId}: prompt ${promptData.id}`);
    await supabase.from('jobs').update({ astria_prompt_id: promptData.id }).eq('id', jobId);
  } catch (err) {
    console.error('Prompt generation error:', err);
  }
});

// 6. IMAGES CALLBACK
app.post('/api/images-callback/:jobId', async (req, res) => {
  const { jobId } = req.params;
  res.json({ received: true });
  const imageUrls = req.body?.images || [];
  if (!imageUrls.length) return;
  const { data: job } = await supabase.from('jobs').select('*').eq('id', jobId).single();
  if (!job) return;
  try {
    await supabase.from('jobs').update({
      status: 'complete', result_urls: imageUrls,
      completed_at: new Date().toISOString()
    }).eq('id', jobId);
    await sendResultsEmail(job.email, jobId, imageUrls.slice(0, 3));
    const deletePromises = (job.photo_urls || []).map(url => {
      const key = url.split('.amazonaws.com/')[1];
      return s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    });
    await Promise.all(deletePromises);
    console.log(`Job ${jobId} complete! ${imageUrls.length} images delivered to ${job.email}`);
  } catch (err) {
    console.error('Completion error:', err);
  }
});

// 7. GET RESULTS
app.get('/api/results/:jobId', async (req, res) => {
  const { data: job } = await supabase
    .from('jobs').select('id,status,result_urls,completed_at,plan,style')
    .eq('id', req.params.jobId).single();
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// 8. EMAIL
async function sendResultsEmail(email, jobId, previewUrls) {
  const resultsUrl = `${process.env.FRONTEND_URL}/results.html?job=${jobId}`;
  const previewImgs = previewUrls.map(url =>
    `<img src="${url}" style="width:120px;height:160px;object-fit:cover;border-radius:8px;margin-right:8px">`
  ).join('');
  await mailer.sendMail({
    from: `"PixelShot" <noreply@pixelshot.ai>`,
    to: email,
    subject: '✦ Your AI headshots are ready!',
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px">
        <h1 style="font-size:1.8rem;color:#1A1A1A;margin-bottom:8px">Your headshots are ready ✦</h1>
        <p style="color:#7A7468;line-height:1.6">Your AI-generated professional headshots have been created and are ready to download.</p>
        <div style="margin:24px 0;display:flex;gap:8px">${previewImgs}</div>
        <a href="${resultsUrl}" style="display:inline-block;background:#C9A84C;color:#111;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600">
          View & Download My Headshots →
        </a>
        <p style="margin-top:24px;color:#aaa;font-size:0.8rem">You own full commercial rights to all images.</p>
      </div>
    `,
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 PixelShot API running on port ${PORT}`));
