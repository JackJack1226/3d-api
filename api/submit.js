export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const HF_SPACE = "https://multimodalart-qwen-image-multiple-angles-3d-camera.hf.space";
  const HF_TOKEN = process.env.HF_TOKEN;
  const image_url = (req.body || {}).image_url || "";

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

    // 上传图片（带 HF Token）
    const formData = new FormData();
    formData.append("files", new Blob([imgBuffer], { type: "image/png" }), filename);

    const uploadResp = await fetch(HF_SPACE + "/upload", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + HF_TOKEN,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin": HF_SPACE,
        "Referer": HF_SPACE + "/",
        "Accept": "*/*",
      },
      body: formData
    });

    console.log("upload status:", uploadResp.status);
    const uploadText = await uploadResp.text();
    console.log("upload result:", uploadText.slice(0, 200));

    if (!uploadResp.ok) {
      return res.json({ success: false, error: "上传失败:" + uploadResp.status + " " + uploadText.slice(0, 100) });
    }

    let paths;
    try { paths = JSON.parse(uploadText); } catch(e) {
      return res.json({ success: false, error: "上传响应解析失败:" + uploadText.slice(0, 100) });
    }

    if (!paths || paths.length === 0) {
      return res.json({ success: false, error: "上传返回为空" });
    }

    const uploadedPath = paths[0];
    console.log("uploaded path:", uploadedPath);

    // 获取 API 端点名
    let apiName = "predict";
    try {
      const infoResp = await fetch(HF_SPACE + "/info", {
        headers: {
          "Authorization": "Bearer " + HF_TOKEN,
          "User-Agent": "Mozilla/5.0"
        }
      });
      if (infoResp.ok) {
        const info = await infoResp.json();
        const eps = Object.keys(info.named_endpoints || {});
        console.log("endpoints:", eps);
        if (eps.length > 0) apiName = eps[0].replace(/^\//, "");
      }
    } catch(e) { console.log("info error:", e.message); }

    // 提交任务
    const payload = {
      data: [{
        path: uploadedPath,
        orig_name: "image.png",
        size: imgBuffer.byteLength,
        mime_type: "image/png",
        meta: { _type: "gradio.FileData" }
      }]
    };

    const submitUrl = HF_SPACE + "/call/" + apiName;
    console.log("submitting to:", submitUrl);

    const callResp = await fetch(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + HF_TOKEN,
        "User-Agent": "Mozilla/5.0",
        "Origin": HF_SPACE,
        "Referer": HF_SPACE + "/",
      },
      body: JSON.stringify(payload)
    });

    const callText = await callResp.text();
    console.log("call status:", callResp.status, callText.slice(0, 200));

    if (!callResp.ok) {
      return res.json({ success: false, error: "提交失败:" + callResp.status + " " + callText.slice(0, 200) });
    }

    let callResult;
    try { callResult = JSON.parse(callText); } catch(e) {
      return res.json({ success: false, error: "提交响应解析失败:" + callText.slice(0, 100) });
    }

    const eventId = callResult.event_id;
    if (!eventId) {
      return res.json({ success: false, error: "未获取到event_id:" + callText.slice(0, 200) });
    }
    console.log("event_id:", eventId);

    // 等待结果
    const resultUrl = HF_SPACE + "/call/" + apiName + "/" + eventId;
    console.log("getting result from:", resultUrl);

    const resultResp = await fetch(resultUrl, {
      headers: {
        "Authorization": "Bearer " + HF_TOKEN,
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/event-stream",
        "Origin": HF_SPACE,
        "Referer": HF_SPACE + "/",
      }
    });

    const reader = resultResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", currentEvent = "";
    let resultData = null;
    const deadline = Date.now() + 18000;

    outer: while (Date.now() < deadline) {
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
          const d = t.slice(5).trim();
          console.log("SSE event:", currentEvent, "data:", d.slice(0, 150));
          if (currentEvent === "complete" && d && d !== "null") {
            try { resultData = JSON.parse(d); break outer; } catch(e) {}
          } else if (currentEvent === "error") {
            return res.json({ success: false, error: "生成失败:" + d.slice(0, 200) });
          }
        }
      }
    }

    if (!resultData) {
      return res.json({
        success: false,
        pending: true,
        event_id: eventId,
        error: "生成中（需要1-3分钟），请1分钟后重新发送图片"
      });
    }

    console.log("resultData:", JSON.stringify(resultData).slice(0, 500));

    // 提取文件
    const files = [];
    function findFiles(obj, depth) {
      if (depth > 8 || !obj) return;
      if (Array.isArray(obj)) obj.forEach(i => findFiles(i, depth + 1));
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
      return res.json({
        success: false,
        error: "未识别到文件：" + JSON.stringify(resultData).slice(0, 300)
      });
    }

    const images = [], videos = [], models = [];
    for (const f of unique) {
      const url = f.startsWith("/") ? HF_SPACE + "/file=" + f : f;
      const low = f.toLowerCase();
      if ([".png",".jpg",".jpeg",".webp"].some(e => low.endsWith(e))) images.push(url);
      else if ([".mp4",".webm",".gif"].some(e => low.endsWith(e))) videos.push(url);
      else if ([".glb",".obj",".ply"].some(e => low.endsWith(e))) models.push(url);
      else images.push(url);
    }

    const angles = ["正面(0°)","右前方(45°)","右侧(90°)","背面(180°)","左侧(270°)","俯视(Top)"];
    let resultText = "🎉 多角度3D视图生成完成！\n\n";
    images.forEach((u, i) => { resultText += "📷 **" + (angles[i] || "视图"+(i+1)) + "**\n" + u + "\n\n"; });
    videos.forEach(u => { resultText += "🎬 旋转预览\n" + u + "\n\n"; });
    models.forEach(u => { resultText += "📦 3D模型\n" + u + "\n"; });
    resultText += "\n✨ 还需要生成其他物品吗？直接发图片！";

    return res.json({ success: true, result: resultText, images, videos, models });

  } catch(e) {
    return res.json({ success: false, error: "异常:" + e.message });
  }
}
