// 在 export default async function handler 里
// 第一行加这个解析逻辑：

let image_url = "";
const contentType = req.headers["content-type"] || "";

if (contentType.includes("application/json")) {
  image_url = req.body?.image_url || "";
} else if (contentType.includes("form")) {
  // form-data 或 application/x-www-form-urlencoded
  image_url = req.body?.image_url || "";
} else {
  // 尝试直接从 query 参数取
  image_url = req.query?.image_url || req.body?.image_url || "";
}
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
        }
      } catch (e) {}
    }

    if (!uploadedPath) return res.json({ success: false, error: "上传失败，请重试" });

    // 获取端点
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

    // 提交任务
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
    if (!eventId) return res.json({ success: false, error: "未获取到event_id" });

    // 等待结果（最多20秒，Vercel免费版限制）
    const resultResp = await fetch(`${HF_SPACE}/call/${apiName}/${eventId}`, {
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
            try { resultData = JSON.parse(dataStr); } catch (e) {}
          } else if (currentEvent === "error") {
            return res.json({ success: false, error: "生成失败:" + dataStr.slice(0, 100) });
          }
        }
      }
      if (resultData !== null) break;
    }

    // 超时但任务还在跑，返回event_id让用户稍后查询
    if (!resultData) {
      return res.json({
        success: false,
        pending: true,
        event_id: eventId,
        api_name: apiName,
        error: "生成中（3D需要1-3分钟），请1分钟后重新发送图片"
      });
    }

    // 提取文件
    const files = [];
    function findFiles(obj, depth) {
      if (depth > 8 || !obj) return;
      if (Array.isArray(obj)) { obj.forEach(i => findFiles(i, depth + 1)); }
      else if (typeof obj === "object") {
        for (const key of ["path", "url", "video", "image"]) {
          if (typeof obj[key] === "string" && obj[key].length > 3) files.push(obj[key]);
          else if (typeof obj[key] === "object") findFiles(obj[key], depth + 1);
        }
        Object.values(obj).forEach(v => typeof v === "object" && findFiles(v, depth + 1));
      }
    }
    findFiles(resultData, 0);

    const seen = new Set();
    const unique = files.filter(f => !seen.has(f) && seen.add(f));

    if (unique.length === 0) {
      return res.json({ success: false, error: "未识别到文件：" + JSON.stringify(resultData).slice(0, 300) });
    }

    const images = [], videos = [], models = [];
    for (const f of unique) {
      const url = f.startsWith("/") ? `${HF_SPACE}/file=${f}` : f;
      const low = f.toLowerCase();
      if ([".png",".jpg",".jpeg",".webp"].some(e => low.endsWith(e))) images.push(url);
      else if ([".mp4",".webm",".gif"].some(e => low.endsWith(e))) videos.push(url);
      else if ([".glb",".obj",".ply"].some(e => low.endsWith(e))) models.push(url);
      else images.push(url);
    }

    const angles = ["正面(0°)","右前方(45°)","右侧(90°)","背面(180°)","左侧(270°)","俯视(Top)"];
    let resultText = "🎉 多角度3D视图生成完成！\n\n";
    images.forEach((u, i) => { resultText += (angles[i] || "视图"+(i+1)) + "\n" + u + "\n\n"; });
    videos.forEach(u => { resultText += "🎬 旋转预览\n" + u + "\n\n"; });
    models.forEach(u => { resultText += "📦 3D模型\n" + u + "\n"; });
    resultText += "\n✨ 还需要生成其他物品吗？直接发图片！";

    return res.json({ success: true, result: resultText, images, videos, models });

  } catch (e) {
    return res.json({ success: false, error: "异常:" + e.message });
  }
}
