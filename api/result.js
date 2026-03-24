const HF_SPACE = "https://multimodalart-qwen-image-multiple-angles-3d-camera.hf.space";
const HF_TOKEN = process.env.HF_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { event_id, api_name } = req.body || {};
  if (!event_id) 
