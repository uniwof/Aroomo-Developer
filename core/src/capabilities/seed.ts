// 由 scripts/gen-capabilities-seed.py 生成，勿手改。种子数据不含任何 Key；验证失败项只标状态，不自动注册。
import type { CapabilitySeed } from './types.js';

export const CAPABILITY_SEED: CapabilitySeed = {
  "source": "aroomo-resource-list.md（2026-10-30 所有者导出，不含 Key）",
  "items": [
    {
      "id": "groq-gpt-oss-120b",
      "name": "gpt-oss-120b",
      "kind": "text",
      "provider": "Groq",
      "access": "free",
      "status": "missing",
      "quota": {
        "used": null,
        "limit": 1000,
        "unit": "次/天",
        "resets": "每天"
      },
      "note": "免费档：gpt-oss-120b / gpt-oss-20b / qwen3.8-27b 每模型每天 1,000 次、20 万 tokens、每分钟 30 次"
    },
    {
      "id": "groq-gpt-oss-20b",
      "name": "gpt-oss-20b",
      "kind": "text",
      "provider": "Groq",
      "access": "free",
      "status": "missing",
      "quota": {
        "used": null,
        "limit": 1000,
        "unit": "次/天",
        "resets": "每天"
      },
      "note": "免费档：gpt-oss-120b / gpt-oss-20b / qwen3.8-27b 每模型每天 1,000 次、20 万 tokens、每分钟 30 次"
    },
    {
      "id": "groq-qwen3-8-27b",
      "name": "qwen3.8-27b",
      "kind": "text",
      "provider": "Groq",
      "access": "free",
      "status": "missing",
      "quota": {
        "used": null,
        "limit": 1000,
        "unit": "次/天",
        "resets": "每天"
      },
      "note": "免费档：gpt-oss-120b / gpt-oss-20b / qwen3.8-27b 每模型每天 1,000 次、20 万 tokens、每分钟 30 次"
    },
    {
      "id": "nvidia-nim-kimi-k3",
      "name": "kimi-k3",
      "kind": "text",
      "provider": "NVIDIA NIM",
      "access": "free",
      "status": "failed",
      "quota": null,
      "note": "开发者免费调用（官方文档没写具体次数，以 build.nvidia.com 账户页为准）"
    },
    {
      "id": "nvidia-nim-deepseek-v4-1-flash",
      "name": "deepseek-v4.1-flash",
      "kind": "text",
      "provider": "NVIDIA NIM",
      "access": "free",
      "status": "failed",
      "quota": null,
      "note": "开发者免费调用（官方文档没写具体次数，以 build.nvidia.com 账户页为准）"
    },
    {
      "id": "google-gemini-gemini-2-5-flash",
      "name": "gemini-2.5-flash",
      "kind": "text",
      "provider": "Google Gemini",
      "access": "free",
      "status": "ready",
      "quota": null,
      "note": "有免费档（Free tier），具体每分钟/每天次数在 AI Studio 限额页查看；每天太平洋时间 0 点重置"
    },
    {
      "id": "agnes-ai-agnes-3-0-flash",
      "name": "agnes-3.0-flash",
      "kind": "text",
      "provider": "Agnes AI",
      "access": "trial",
      "status": "ready",
      "quota": null,
      "note": "生图模型官方写「目前免费」（限时，截止日未公布）；对话模型额度未核实"
    },
    {
      "id": "agnes-ai-agnes-2-5-pro",
      "name": "agnes-2.5-pro",
      "kind": "text",
      "provider": "Agnes AI",
      "access": "trial",
      "status": "ready",
      "quota": null,
      "note": "生图模型官方写「目前免费」（限时，截止日未公布）；对话模型额度未核实"
    },
    {
      "id": "agnes-ai-agnes-image-2-5",
      "name": "agnes-image-2.5",
      "kind": "image",
      "provider": "Agnes AI",
      "access": "trial",
      "status": "ready",
      "quota": null,
      "note": "生图模型官方写「目前免费」（限时，截止日未公布）；对话模型额度未核实"
    },
    {
      "id": "agnes-ai-agnes-image-2-1-flash",
      "name": "agnes-image-2.1-flash",
      "kind": "image",
      "provider": "Agnes AI",
      "access": "trial",
      "status": "ready",
      "quota": null,
      "note": "生图模型官方写「目前免费」（限时，截止日未公布）；对话模型额度未核实"
    },
    {
      "id": "pm-glm-4-5-flash",
      "name": "glm-4.5-flash",
      "kind": "text",
      "provider": "PM 公益站",
      "access": "trial",
      "status": "missing",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "happycoding-kimi-k3",
      "name": "kimi-k3",
      "kind": "text",
      "provider": "HappyCoding 公益站",
      "access": "trial",
      "status": "ready",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "happycoding-deepseek-v4-1-flash",
      "name": "deepseek-v4.1-flash",
      "kind": "text",
      "provider": "HappyCoding 公益站",
      "access": "trial",
      "status": "ready",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "happycoding-minimax-m3",
      "name": "minimax-m3",
      "kind": "text",
      "provider": "HappyCoding 公益站",
      "access": "trial",
      "status": "ready",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "happycoding-glm-5-3",
      "name": "glm-5.3",
      "kind": "text",
      "provider": "HappyCoding 公益站",
      "access": "trial",
      "status": "ready",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "happycoding-glm-5-3-flash",
      "name": "glm-5.3-flash",
      "kind": "text",
      "provider": "HappyCoding 公益站",
      "access": "trial",
      "status": "ready",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "vyce-ai-glm-5-3-flash",
      "name": "glm-5.3-flash",
      "kind": "text",
      "provider": "Vyce AI",
      "access": "trial",
      "status": "failed",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "vyce-ai-deepseek-v4-flash",
      "name": "deepseek-v4-flash",
      "kind": "text",
      "provider": "Vyce AI",
      "access": "trial",
      "status": "failed",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "vyce-ai-claude-sonnet-4-6",
      "name": "claude-sonnet-4-6",
      "kind": "text",
      "provider": "Vyce AI",
      "access": "trial",
      "status": "failed",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "vyce-ai-gpt-6-luna",
      "name": "gpt-6-luna",
      "kind": "text",
      "provider": "Vyce AI",
      "access": "trial",
      "status": "failed",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "x-x",
      "name": "清羽公益站",
      "kind": "text",
      "provider": "清羽公益站",
      "access": "trial",
      "status": "failed",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "huan-huan",
      "name": "Huan 公益站",
      "kind": "text",
      "provider": "Huan 公益站",
      "access": "trial",
      "status": "missing",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "42api-42api",
      "name": "42api",
      "kind": "text",
      "provider": "42api",
      "access": "trial",
      "status": "missing",
      "quota": null,
      "note": "公益站，额度靠签到/站长发放，以站点余额为准"
    },
    {
      "id": "pollinations-openai-fast",
      "name": "openai-fast",
      "kind": "text",
      "provider": "Pollinations",
      "access": "free",
      "status": "keyless",
      "quota": {
        "used": null,
        "limit": 2,
        "unit": "次/分钟",
        "resets": "按 IP"
      },
      "note": "匿名档免 Key：openai-fast（gpt-oss-20b），按 IP 每 30 秒 1 次；Cloudflare 共享出口常被占满，2026-10-23 实测从 Worker 调用两次都被限速，只作兜底"
    },
    {
      "id": "cloudflare-workers-ai-workers-ai",
      "name": "Workers AI 开源模型",
      "kind": "text",
      "provider": "Cloudflare Workers AI",
      "access": "free",
      "status": "keyless",
      "quota": {
        "used": null,
        "limit": 10000,
        "unit": "neurons/天",
        "resets": "每天 00:00 UTC"
      },
      "note": "每天 10,000 neurons（整个主账号共用），每天 00:00 UTC 重置"
    }
  ],
  "tools": [
    {
      "id": "poke",
      "name": "Poke",
      "group": "智能体",
      "access": "free",
      "status": "unverified",
      "quota": null,
      "note": "官方未公布 API 限额"
    },
    {
      "id": "modal",
      "name": "Modal",
      "group": "算力",
      "access": "free",
      "status": "missing",
      "quota": {
        "used": null,
        "limit": 30,
        "unit": "美元/月",
        "resets": "每月"
      },
      "note": "Starter 每月 $30 免费算力（GPU/CPU/内存）；Shared Endpoints 按 token 另计费，不在免费内"
    },
    {
      "id": "kaggle",
      "name": "Kaggle",
      "group": "算力",
      "access": "free",
      "status": "missing",
      "quota": {
        "used": null,
        "limit": 30,
        "unit": "小时/周",
        "resets": "每周"
      },
      "note": "GPU 每周约 30 小时（P100，按供需浮动），每周重置"
    },
    {
      "id": "lightning-ai",
      "name": "Lightning AI",
      "group": "算力",
      "access": "trial",
      "status": "missing",
      "quota": null,
      "note": "注册送 5 credits，绑卡再送 25（最多 30，约 80 小时可中断 GPU，12 个月过期）；1 个免费 CPU Studio（每 4 小时重启）；领 GPU 需手机号。官网目前因安全事件锁站"
    },
    {
      "id": "lambda-cloud",
      "name": "Lambda Cloud",
      "group": "算力",
      "access": "paid",
      "status": "missing",
      "quota": null,
      "note": "没有免费档，需绑卡按量付费（官方 API 文档未写免费额度）"
    },
    {
      "id": "beam",
      "name": "Beam",
      "group": "算力",
      "access": "paid",
      "status": "missing",
      "quota": null,
      "note": "没有免费档：Developer 每月 $20（含 $20 额度）"
    },
    {
      "id": "e2b",
      "name": "E2B",
      "group": "沙盒",
      "access": "trial",
      "status": "missing",
      "quota": {
        "used": null,
        "limit": 100,
        "unit": "美元(一次性)"
      },
      "note": "Hobby 免费：一次性 $100 额度，单次会话最长 1 小时，20 个并发沙盒，免绑卡"
    },
    {
      "id": "daytona",
      "name": "Daytona",
      "group": "沙盒",
      "access": "trial",
      "status": "missing",
      "quota": {
        "used": null,
        "limit": 200,
        "unit": "美元(一次性)"
      },
      "note": "免费试用含 $200 算力，免绑卡；有 GPU 价目（RTX 4090 起），免费额度能否用于 GPU 未核实；免费档网络有白名单"
    },
    {
      "id": "instabox",
      "name": "InstaBox",
      "group": "沙盒",
      "access": "free",
      "status": "missing",
      "quota": null,
      "note": "Free 档：1 台机器（4 vCPU / 8 GiB）、5 个快照；暂停只收存储费"
    },
    {
      "id": "phonebox",
      "name": "Phonebox 云手机",
      "group": "云手机",
      "access": "trial",
      "status": "unverified",
      "quota": {
        "used": null,
        "limit": 2,
        "unit": "美元(一次性)"
      },
      "note": "$2 新号额度（约 33 手机分钟），不过期"
    },
    {
      "id": "airtap",
      "name": "Airtap 云手机",
      "group": "云手机",
      "access": "trial",
      "status": "unverified",
      "quota": null,
      "note": "第一版免费，每日上限未公布"
    },
    {
      "id": "freestyle",
      "name": "Freestyle 云浏览器",
      "group": "浏览器",
      "access": "free",
      "status": "missing",
      "quota": {
        "used": null,
        "limit": 200,
        "unit": "vCPU 小时/月",
        "resets": "每月"
      },
      "note": "Free 永久：每月 200 vCPU 小时，硬上限不超额"
    },
    {
      "id": "saperly",
      "name": "Saperly 电话号码",
      "group": "电话",
      "access": "trial",
      "status": "unverified",
      "quota": {
        "used": null,
        "limit": 5,
        "unit": "美元(一次性)"
      },
      "note": "$5 注册额度，永不过期"
    },
    {
      "id": "bark-iphone",
      "name": "Bark 推送（iPhone）",
      "group": "推送",
      "access": "free",
      "status": "missing",
      "quota": null,
      "note": "Bark 是免费开源的 iPhone 推送 App"
    }
  ],
  "library": {
    "skills": {
      "total": 148,
      "groups": [
        {
          "name": "视频",
          "count": 42
        },
        {
          "name": "页面",
          "count": 29
        },
        {
          "name": "编程",
          "count": 25
        },
        {
          "name": "插画",
          "count": 16
        },
        {
          "name": "图文",
          "count": 9
        },
        {
          "name": "研究",
          "count": 8
        },
        {
          "name": "总纲",
          "count": 6
        },
        {
          "name": "其他",
          "count": 4
        },
        {
          "name": "基础设施",
          "count": 3
        },
        {
          "name": "规矩",
          "count": 2
        },
        {
          "name": "配音",
          "count": 2
        },
        {
          "name": "音频",
          "count": 1
        },
        {
          "name": "提示词",
          "count": 1
        }
      ]
    },
    "resources": {
      "total": 45,
      "groups": [
        {
          "name": "免费配音/TTS",
          "count": 5
        },
        {
          "name": "免费试用模型",
          "count": 9
        },
        {
          "name": "音效",
          "count": 4
        },
        {
          "name": "UI 组件",
          "count": 6
        },
        {
          "name": "UI 参考",
          "count": 9
        },
        {
          "name": "配色字体图标",
          "count": 5
        },
        {
          "name": "提示词与学习",
          "count": 6
        },
        {
          "name": "用户投递",
          "count": 1
        }
      ]
    }
  }
};
