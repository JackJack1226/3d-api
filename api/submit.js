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
    const imgResp = await fetch(image_url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!imgResp.ok) return res.json({ success: false, error: "下载图片失败:" + imgResp.status });

    const imgBuffer = await imgResp.arrayBuffer();
    const rand = Math.random().toString(36).substring(2, 8);
    const filename = rand + ".png";

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
            "Authorization": `Bearer ${HF_TOKEN}`,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Origin": HF_SPACE,
            "Referer": HF_SPACE + "/",
            "Accept": "*/*",
          },
          body: fd
        });
        if (resp.ok) {
          const paths = await resp.json();
          if (paths && paths.length > 0) { uploadedPath = paths[0]; break; }
        } else {
          const t = await resp.text();
          console.log("upload err:", resp.status, t);
        }
      } catch (e) { console.log("upload exception:", e.message); }
    }

    if (!uploadedPath) return res.json({ success: false, error: "上传失败，请重试" });

    let apiName = "predict";
    try {
      const infoResp = await fetch(`${HF_SPACE}/info`, {
        headers: { "Authorization": `Bearer ${HF_TOKEN}`, "User-Agent": "Mozilla/5.0" }
      });
      if (infoResp.ok) {
        const info = await infoResp.json();
        const eps = Object.keys(info.named_endpoints || {});
        if (eps.length > 0) apiName = eps[0].replace(/^\//, "");
      }
    } catch (e) {}

    const callResp = await fetch(`${HF_SPACE}/call/${apiName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${HF_TOKEN}`,
        "User-Agent": "Mozilla/5.0",
        "Origin": HF_SPACE,
        "Referer": HF_SPACE + "/",
      },
      body: JSON.stringify({
        data: [{
          path: uploadedPath,
          orig_name: "image.png",
          size: imgBuffer.byteLength,
          mime_type: "image/png",
          meta: { _type: "gradio.FileData" }
        }]
      })
    });

    if (!callResp.ok) {
      const t = await callResp.text();
      return res.json({ success: false, error: "提交失败:" + callResp.status + " " + t.slice(0, 100) });
    }

    const callResult = await callResp.json();
    const eventId = callResult.event_id;
    if (!eventId) return res.json({ success: false, error: "未获取到event_id:" + JSON.stringify(callResult).slice(0, 200) });

    return res.json({ success: true, event_id: eventId, api_name: apiName });

  } catch (e) {
    return res.json({ success: false, error: "异常:" + e.message });
  }
}
