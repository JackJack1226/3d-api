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
    // 下载图片转base64
    const imgResp = await fetch(image_url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!imgResp.ok) return res.json({ success: false, error: "下载图片失败:" + imgResp.status });
    
    const imgBuffer = await imgResp.arrayBuffer();
    const imgBase64 = Buffer.from(imgBuffer).toString("base64");

    // 生成6个角度的图片
    const angles = [
      { rotate: 0, tilt: 0, forward: 0, name: "正面(0°)" },
      { rotate: 45, tilt: 0, forward: 0, name: "右前方(45°)" },
      { rotate: 90, tilt: 0, forward: 0, name: "右侧(90°)" },
      { rotate: 180, tilt: 0, forward: 0, name: "背面(180°)" },
      { rotate: -90, tilt: 0, forward: 0, name: "左侧(270°)" },
      { rotate: 0, tilt: 1, forward: 0, name: "俯视(Top)" }
    ];

    const results = [];

    for (const angle of angles) {
      try {
        // 正确的图片格式：PIL Image 内部格式
        const imageParam = {
          format: "png",
          format_description: "PNG",
          data: imgBase64
        };

        const payload = {
          data: [
            imageParam,          // image
            angle.rotate,        // rotate_deg
            angle.forward,       // move_forward
            angle.tilt,          // vertical_tilt
            false,               // wideangle
            0,                   // seed
            true,                // randomize_seed
            1.0,                 // true_guidance_scale
            4,                   // num_inference_steps
            null,                // height
            null,                // width
            null                 // prev_output
          ]
        };

        const submitUrl = HF_SPACE + "/gradio_api/call/infer_edit_camera_angles";
        console.log("submitting angle:", angle.name);

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
        console.log("call status:", callResp.status, callText.slice(0, 200));

        if (!callResp.ok) continue;

        const callResult = JSON.parse(callText);
        const eventId = callResult.event_id;
        if (!eventId) continue;

        // 获取结果
        const resultResp = await fetch(
          HF_SPACE + "/gradio_api/call/infer_edit_camera_angles/" + eventId,
          {
            headers: {
              "Authorization": "Bearer " + HF_TOKEN,
              "User-Agent": "Mozilla/5.0",
              "Accept": "text/event-stream",
              "Origin": HF_SPACE,
              "Referer": HF_SPACE + "/",
            }
          }
        );

        const reader = resultResp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "", currentEvent = "";
        let resultData = null;
        const deadline = Date.now() + 60000; // 每个角度最多等60秒

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
              console.log("event:", currentEvent, "data:", d.slice(0, 100));
              if (currentEvent === "complete" && d && d !== "null") {
                try {
                  resultData = JSON.parse(d);
                  break outer;
                } catch(e) {}
              } else if (currentEvent === "error") {
                console.log("error:", d);
                break outer;
              }
            }
          }
        }

        if (resultData) {
          // 提取图片URL
          // 返回格式：[{format: "png", format_description: "PNG", data: "base64..."}, seed, prompt]
          const firstResult = Array.isArray(resultData) ? resultData[0] : resultData;
          console.log("result type:", typeof firstResult, JSON.stringify(firstResult).slice(0, 100));
          
          if (firstResult && firstResult.data) {
            // 返回的是base64，直接用data URI
            const dataUrl = "data:image/png;base64," + firstResult.data;
            results.push({ name: angle.name, url: dataUrl });
          } else if (firstResult && firstResult.url) {
            results.push({ name: angle.name, url: firstResult.url });
          } else if (firstResult && firstResult.path) {
            const fileUrl = firstResult.path.startsWith("/") 
              ? HF_SPACE + "/file=" + firstResult.path 
              : firstResult.path;
            results.push({ name: angle.name, url: fileUrl });
          } else {
            console.log("unknown result format:", JSON.stringify(firstResult).slice(0, 300));
          }
        }

      } catch(e) {
        console.log("angle error:", angle.name, e.message);
        continue;
      }
    }

    if (results.length === 0) {
      return res.json({ success: false, error: "所有角度生成失败，请重试" });
    }

    let resultText = "🎉 多角度视图生成完成！\n\n";
    results.forEach(r => {
      resultText += "📷 **" + r.name + "**\n" + r.url + "\n\n";
    });
    resultText += "✨ 还需要生成其他物品吗？直接发图片！";

    return res.json({ success: true, result: resultText, images: results.map(r => r.url) });

  } catch(e) {
    return res.json({ success: false, error: "异常:" + e.message });
  }
}
