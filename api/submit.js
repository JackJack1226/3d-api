export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  const HF_SPACE = "https://linoyts-qwen-image-edit-angles.hf.space";
  const HF_TOKEN = process.env.HF_TOKEN;
  const image_url = (req.body || {}).image_url || "";

  if (!image_url) return res.json({ success: false, error: "缺少image_url" });

  try {
    // 用专门的 API 端点 /infer_edit_camera_angles
    const submitUrl = HF_SPACE + "/gradio_api/call/infer_edit_camera_angles";

    // 图片直接用 URL，不需要上传！
    const imageData = {
      url: image_url,
      orig_name: "image.png",
      mime_type: "image/png",
      meta: { _type: "gradio.FileData" }
    };

    const payload = {
      data: [
        imageData,  // image
        0,          // rotate_deg（正面）
        0,          // move_forward
        0,          // vertical_tilt
        false,      // wideangle
        0,          // seed
        true,       // randomize_seed
        1.0,        // true_guidance_scale
        4,          // num_inference_steps
        1024,       // height
        1024,       // width
        null        // prev_output
      ]
    };

    console.log("submitting to:", submitUrl);
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

    var callResult;
    try { callResult = JSON.parse(callText); } catch(e) {
      return res.json({ success: false, error: "解析失败:" + callText.slice(0, 200) });
    }

    var eventId = callResult.event_id;
    if (!eventId) {
      return res.json({ success: false, error: "未获取event_id:" + callText.slice(0, 200) });
    }

    console.log("got event_id:", eventId);

    // 等待结果
    var resultUrl = HF_SPACE + "/gradio_api/call/infer_edit_camera_angles/" + eventId;
    console.log("getting result from:", resultUrl);

    var resultResp = await fetch(resultUrl, {
      headers: {
        "Authorization": "Bearer " + HF_TOKEN,
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/event-stream",
        "Origin": HF_SPACE,
        "Referer": HF_SPACE + "/",
      }
    });

    var reader = resultResp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var currentEvent = "";
    var resultData = null;
    var timeout = Date.now() + 18000;

    while (Date.now() < timeout) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split("\n");
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (t.startsWith("event:")) {
          currentEvent = t.slice(6).trim();
        } else if (t.startsWith("data:")) {
          var d = t.slice(5).trim();
          console.log("event:", currentEvent, "data:", d.slice(0, 200));
          if (currentEvent === "complete" && d) {
            try { resultData = JSON.parse(d); } catch(e) {}
          } else if (currentEvent === "error") {
            return res.json({ success: false, error: "生成失败:" + d.slice(0, 200) });
          }
        }
      }
      if (resultData !== null) break;
    }

    if (!resultData) {
      return res.json({ success: false, pending: true, error: "生成中（1-3分钟），请稍后重新发图片" });
    }

    // 提取结果
    console.log("resultData:", JSON.stringify(resultData).slice(0, 500));

    var files = [];
    function findFiles(obj, depth) {
      if (depth > 8 || !obj) return;
      if (Array.isArray(obj)) { for (var j = 0; j < obj.length; j++) findFiles(obj[j], depth+1); }
      else if (typeof obj === "object") {
        var keys = ["path", "url", "video", "image"];
        for (var k = 0; k < keys.length; k++) {
          if (typeof obj[keys[k]] === "string" && obj[keys[k]].length > 3) files.push(obj[keys[k]]);
          else if (typeof obj[keys[k]] === "object") findFiles(obj[keys[k]], depth+1);
        }
        var vals = Object.values(obj);
        for (var v = 0; v < vals.length; v++) {
          if (typeof vals[v] === "object") findFiles(vals[v], depth+1);
        }
      }
    }
    findFiles(resultData, 0);

    var seen = {};
    var unique = [];
    for (var f = 0; f < files.length; f++) {
      if (!seen[files[f]]) { seen[files[f]] = true; unique.push(files[f]); }
    }

    if (unique.length === 0) {
      return res.json({ success: false, error: "未识别到文件：" + JSON.stringify(resultData).slice(0, 300) });
    }

    var images = [];
    for (var u = 0; u < unique.length; u++) {
      var url = unique[u].startsWith("/") ? HF_SPACE + "/file=" + unique[u] : unique[u];
      images.push(url);
    }

    var resultText = "🎉 3D视角生成完成！\n\n";
    resultText += "📷 生成结果\n" + images[0] + "\n\n";
    resultText += "✨ 还需要生成其他角度吗？直接发图片！";

    return res.json({ success: true, result: resultText, images: images });

  } catch(e) {
    return res.json({ success: false, error: "异常:" + e.message });
  }
}
