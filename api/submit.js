export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const HF_SPACE = "https://linoyts-qwen-image-edit-angles.hf.space";
  const HF_TOKEN = process.env.HF_TOKEN;
  const image_url = (req.body || {}).image_url || "https://raw.githubusercontent.com/gradio-app/gradio/main/test/test_files/bus.png";

  try {
    const submitUrl = HF_SPACE + "/gradio_api/call/infer_edit_camera_angles";

    const imageData = {
      path: image_url,
      url: image_url,
      orig_name: "image.png",
      mime_type: "image/png",
      is_stream: false,
      meta: { _type: "gradio.FileData" }
    };

    const payload = {
      data: [
        imageData,
        0,
        0,
        0,
        false,
        0,
        true,
        1.0,
        4,
        1024,
        1024,
        null
      ]
    };

    console.log("submitting:", submitUrl);
    console.log("image_url:", image_url);

    const callResp = await fetch(submitUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + HF_TOKEN,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin": HF_SPACE,
        "Referer": HF_SPACE + "/",
      },
      body: JSON.stringify(payload)
    });

    const callText = await callResp.text();
    console.log("call status:", callResp.status, callText.slice(0, 300));

    if (!callResp.ok) {
      return res.json({ success: false, error: "提交失败:" + callResp.status + " " + callText.slice(0, 200) });
    }

    let callResult;
    try { callResult = JSON.parse(callText); } catch(e) {
      return res.json({ success: false, error: "解析失败:" + callText.slice(0, 200) });
    }

    const eventId = callResult.event_id;
    if (!eventId) {
      return res.json({ success: false, error: "未获取event_id:" + callText.slice(0, 200) });
    }

    console.log("got event_id:", eventId);

    const resultResp = await fetch(HF_SPACE + "/gradio_api/call/infer_edit_camera_angles/" + eventId, {
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
    let buffer = "";
    let currentEvent = "";
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
          console.log("event:", currentEvent, "data:", d.slice(0, 300));
          if (currentEvent === "complete" && d && d !== "null") {
            try { resultData = JSON.parse(d); break outer; } catch(e) {}
          } else if (currentEvent === "error") {
            return res.json({ success: false, error: "HF返回错误:" + d.slice(0, 200) });
          }
        }
      }
    }

    if (!resultData) {
      return res.json({ success: false, pending: true, error: "生成中（1-3分钟），请稍后重新发图片" });
    }

    console.log("resultData:", JSON.stringify(resultData).slice(0, 500));

    // 提取图片URL
    const files = [];
    function findFiles(obj, depth) {
      if (depth > 8 || !obj) return;
      if (Array.isArray(obj)) obj.forEach(i => findFiles(i, depth+1));
      else if (typeof obj === "object") {
        for (const key of ["path", "url"]) {
          if (typeof obj[key] === "string" && obj[key].length > 10 && (obj[key].startsWith("http") || obj[key].startsWith("/"))) {
            files.push(obj[key]);
          }
        }
        Object.values(obj).forEach(v => typeof v === "object" && findFiles(v, depth+1));
      }
    }
    findFiles(resultData, 0);

    const seen = new Set();
    const unique = files.filter(f => !seen.has(f) && seen.add(f));

    if (unique.length === 0) {
      return res.json({ success: false, error: "未找到图片：" + JSON.stringify(resultData).slice(0, 300) });
    }

    const images = unique.map(f => f.startsWith("/") ? HF_SPACE + "/file=" + f : f);

    let resultText = "🎉 视角生成完成！\n\n";
    images.forEach((u, i) => { resultText += "📷 图片" + (i+1) + "\n" + u + "\n\n"; });
    resultText += "✨ 还需要其他角度吗？直接发图片！";

    return res.json({ success: true, result: resultText, images });

  } catch(e) {
    return res.json({ success: false, error: "异常:" + e.message });
  }
}
