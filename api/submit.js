const HF_SPACE = "https://multimodalart-qwen-image-multiple-angles-3d-camera.hf.space";
const HF_TOKEN = process.env.HF_TOKEN;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const { image_url } = req.body || {};
  if (!image_url) return res.json({ success: false, error: "缺少image_url" });

  try {
    // 下载图片
    const imgResp = await fetch(image_url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!imgResp.ok) return res.json({ success: false, error: "下载图片失败:" + imgResp.status });

    const imgBuffer = await imgResp.arrayBuffer();
    const rand = Math.random().toString(36).substring(2, 8);
    const filename = rand + ".png";

    // 上传图片
    let uploadedPath = null;
    for (const uploadUrl of [
      `${HF_SPACE}/upload?upload_id=${rand + Date.now()}`,
      `${HF_SPACE}/upload`
    ]) {
      try {
        const fd = new FormData();
        fd.append("files", new Blob([imgBuffer], { type: "image/png" }), filename);
        const resp = await fetch(uploadUrl, {
          method: "POST",
          headers: {
            
