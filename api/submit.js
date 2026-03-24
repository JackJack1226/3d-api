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
        
