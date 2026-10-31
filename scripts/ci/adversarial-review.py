#!/usr/bin/env python3
"""A 类 PR 反对式审查：diff + 审查清单 -> 外部模型（Gemini 优先，缺则 Groq）。
Key 只从环境变量读取，绝不打印。输出 review.md。"""
import json, os, sys, urllib.request

CHECKLIST = """A 类审查清单：①失败默认拒绝、无默认放行；②每次读写调用限定当前用户、有越权测试；③花钱/凭据/不可逆只有一个把关点（确认服务），无绕过；④Key/cookie/验证码不进响应、日志、审计、模型上下文；⑤外部输入（网址、主机、路径、重定向）校验、防 SSRF；⑥防点击劫持、CSRF，Cookie 属性正确；⑦计数与限额重启不清零；⑧测试有专门反例（越权、篡改、重放、超限）。"""
PROMPT = ("你是独立的反对式代码审查员。不附和作者，对下面清单逐条检查 diff 并尽力反驳（找出违反或遗漏之处，引用文件/行）。"
          "每条给结论：通过 / 有问题（说明）/ 无法判断。最后列出必须改的项。用中文，简洁。\n\n"
          + CHECKLIST + "\n\n=== DIFF ===\n")

def post(url, body, headers):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)

def main():
    diff = open("pr.diff", encoding="utf-8", errors="replace").read()[:60000]
    text = PROMPT + diff
    out, who = None, None
    gk, qk = os.environ.get("GEMINI_API_KEY"), os.environ.get("GROQ_API_KEY")
    try:
        if gk:
            r = post("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
                     {"contents": [{"parts": [{"text": text}]}]}, {"x-goog-api-key": gk})
            out, who = r["candidates"][0]["content"]["parts"][0]["text"], "Gemini"
    except Exception as e:
        print("Gemini 调用失败:", type(e).__name__)
    if out is None and qk:
        try:
            r = post("https://api.groq.com/openai/v1/chat/completions",
                     {"model": "llama-3.3-70b-versatile", "messages": [{"role": "user", "content": text[:30000]}]},
                     {"Authorization": "Bearer " + qk})
            out, who = r["choices"][0]["message"]["content"], "Groq"
        except Exception as e:
            print("Groq 调用失败:", type(e).__name__)
    if out is None:
        out = "兜底审查已跳过：未配置或调用失败（需要仓库 Secrets GEMINI_API_KEY / GROQ_API_KEY）。"
        who = "none"
    open("review.md", "w", encoding="utf-8").write(
        f"<!-- adversarial-review -->\n### 自动反对式审查（{who}，仅供负责人参考，不替代负责人审）\n\n{out}\n")

main()
