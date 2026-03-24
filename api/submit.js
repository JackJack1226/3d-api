export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const HF_SPACE = "https://bils-qwen-image-multiple-angles-3d-camera.hf.space";
  const HF_TOKEN = process.env.HF_TOKEN;
  const image_url = (req.body || {}).image_url || "";

  if (!image_url) return res.json({ success: false, error: "缺少image_url" });

  try {
    // 下载图片转base64
    const imgResp = await fetch(image_url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!imgResp.ok) return res.json({ success: false, error: "下载图片失败:" + imgResp.status });
    const imgBuffer = await imgResp.arrayBuffer();
    const imgBase64 = Buffer.from(imgBuffer).toString("base64");
    const imgDataUrl = `data:image/png;base64,${imgBase64}`;

    // 试所有可能的端点
    const tryEndpoints = [
      { submit: `${HF_SPACE}/gradio_api/call/predict`, result: `${HF_SPACE}/gradio_api/call/predict` },
      { submit: `${HF_SPACE}/call/predict`, result: `${HF_SPACE}/call/predict` },
      { submit: `${HF_SPACE}/run/predict`, result: null },
      { submit: `${HF_SPACE}/api/predict`, result: null },
    ];

    let eventId = null;
    let resultBase = null;

    for (const ep of tryEndpoints) {
      try {
        console.log("trying:", ep.submit);
        const r = await fetch(ep.submit, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${HF_TOKEN}`,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Origin": HF_SPACE,
            "Referer": HF_SPACE + "/",
          },
          body: JSON.stringify({ data: [imgDataUrl] })
        });
        const t = await r.text();
        console.log("result:", ep.submit, r.status, t.slice(0, 300));

        if (r.ok) {
          try {
            const parsed = JSON.parse(t);
            if (parsed.event_id) {
              eventId = parsed.event_id;
              resultBase = ep.submit;
              break;
            }
            // 同步返回（/run/predict 或 /api/predict）
            if (parsed.data) {
              return processResult(parsed, HF_SPACE, res);
            }
          } catch(e) {}
        }
      } catch(e) {
        console.log("ep error:", ep.submit, e.message);
      }
    }

    if (!eventId) {
      return res.json({ success: false, error: "所有端点都失败，请查看 Vercel Logs" });
    }

    // 等待异步结果
    const resultResp = await fetch(`${resultBase}/${eventId}`, {
      headers: {
        "Authorization": `Bearer ${HF_TOKEN}`,
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/event-stream",
        "Origin": HF_SPACE,
        "Referer": HF_SPACE + "/",
      }
    });

    const reader = resultResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "";
    let resultData = null;
    const timeout = Date.now() + 18000;

    while (Date.now() < timeout) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("event:")) {
          currentEvent = t.slice(6).trim();
        } else if (t.startsWith("data:")) {
          const dataStr = t.slice(5).trim();
          if (currentEvent === "complete" && dataStr) {
            try { resultData = JSON.parse(dataStr); } catch(e) {}
          } else if (currentEvent === "error") {
            return res.json({ success: false, error: "生成失败:" + dataStr.slice(0,100) });
          }
        }
      }
      if (resultData !== null) break;
    }

    if (!resultData) {
      return res.json({ success: false, pending: true, event_id: eventId, error: "生成中，请1分钟后重新发图片" });
    }

    return processResult(resultData, HF_SPACE, res);

  } catch(e) {
    return res.json({ success: false, error: "异常:" + e.message });
  }
}

function processResult(resultData, HF_SPACE, res) {
  const files = [];
  function findFiles(obj, depth) {
    if (depth > 8 || !obj) return;
    if (Array.isArray(obj)) obj.forEach(i => findFiles(i, depth+1));
    else if (typeof obj === "object") {
      for (const key of ["path","url","video","image"]) {
        if (typeof obj[key] === "string" && obj[key].length > 3) files.push(obj[key]);
        else if (typeof obj[key] === "object") findFiles(obj[key], depth+1);
      }
      Object.values(obj).forEach(v => typeof v === "object" && findFiles(v, depth+1));
    }
  }
  findFiles(resultData, 0);

  const seen = new Set();
  const unique = files.filter(f => !seen.has(f) && seen.add(f));

  if (unique.length === 0) {
    return res.json({ success: false, error: "未识别到文件：" + JSON.stringify(resultData).slice(0,300) });
  }

  const images=[], videos=[], models=[];
  for (const f of unique) {
    const url = f.startsWith("/") ? `${HF_SPACE}/file=${f}` : f;
    const low = f.toLowerCase();
    if ([".png",".jpg",".jpeg",".webp"].some(e=>low.endsWith(e))) images.push(url);
    else if ([".mp4",".webm",".gif"].some(e=>low.endsWith(e))) videos.push(url);
    else if ([".glb",".obj",".ply"].some(e=>low.endsWith(e))) models.push(url);
    else images.push(url);
  }

  const angles = ["正面(0°)","右前方(45°)","右侧(90°)","背面(180°)","左侧(270°)","俯视(Top)"];
  let resultText = "🎉 多角度3D视图生成完成！\n\n";
  images.forEach((u,i) => { resultText += (angles[i]||"视图"+(i+1)) + "\n" + u + "\n\n"; });
  videos.forEach(u => { resultText += "🎬 旋转预览\n" + u + "\n\n"; });
  models.forEach(u => { resultText += "📦 3D模型\n" + u + "\n"; });
  resultText += "\n✨ 还需要生成其他物品吗？直接发图片！";

  return res.json({ success: true, result: resultText, images, videos, models });
}
