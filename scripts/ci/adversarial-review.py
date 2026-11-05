#!/usr/bin/env python3
"""A 类 PR 反对式审查：diff + 审查清单 -> 外部模型（Gemini 优先，缺则 Groq），结果贴 PR 评论。
Key 只从环境变量读取，绝不打印。同一 diff 只审一次；每个 PR 最多 3 次（re-review 标签可再审）。"""
import hashlib, json, os, re, sys, urllib.error, urllib.request

CHECKLIST = """A 类审查清单：①失败默认拒绝、无默认放行；②每次读写调用限定当前用户、有越权测试；③花钱/凭据/不可逆只有一个把关点（确认服务），无绕过；④Key/cookie/验证码不进响应、日志、审计、模型上下文；⑤外部输入（网址、主机、路径、重定向）校验、防 SSRF；⑥防点击劫持、CSRF，Cookie 属性正确；⑦计数与限额重启不清零；⑧测试有专门反例（越权、篡改、重放、超限）。"""
PROMPT = ("你是独立的反对式代码审查员。不附和作者，对下面清单逐条检查 diff 并尽力反驳（找出违反或遗漏之处，引用文件/行）。"
          "每条给结论：通过 / 有问题（说明）/ 无法判断。最后列出必须改的项。用中文，简洁。\n\n"
          + CHECKLIST + "\n\n=== DIFF ===\n")
MARK = "<!-- adversarial-review"
MAX_REVIEWS = 3
API = "https://api.github.com/repos/" + os.environ.get("REPO", "")


def gh(path, body=None, accept="application/vnd.github+json"):
    req = urllib.request.Request(API + path, json.dumps(body).encode() if body is not None else None,
                                 {"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Accept": accept,
                                  "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if accept.endswith("diff") else json.loads(data or b"null")


MAX_DIFF = 60000
SKIP_RE = re.compile(r"(^|/)package-lock\.json$|\.md$|(^|/)tests?/|\.(test|spec)\.[jt]sx?$|(^|/)test_[^/]*\.py$")


def pr_diff(n):
    """整份 diff；太大时 GitHub 回 406，改按 /pulls/{n}/files 一页页拼补丁，拼够 MAX_DIFF 就停（最多 30 页）。
    兜底拼接时跳过 package-lock.json、*.md 和测试文件（只列文件名），把篇幅留给真正的代码。"""
    try:
        return gh(f"/pulls/{n}", accept="application/vnd.github.v3.diff").decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code != 406:
            raise
    print("diff 太大（406），改按文件列表读补丁")
    parts, size = [], 0
    for page in range(1, 31):
        batch = gh(f"/pulls/{n}/files?per_page=100&page={page}")
        for f in batch:
            if SKIP_RE.search(f["filename"]):
                parts.append(f"(跳过：{f['filename']})\n")
                continue
            part = f"diff --git a/{f['filename']} b/{f['filename']}\n({f['status']})\n{f.get('patch') or '(二进制或补丁太大，未附)'}\n"
            parts.append(part)
            size += len(part)
            if size >= MAX_DIFF:
                return "".join(parts)
        if len(batch) < 100:
            break
    return "".join(parts)


def post(url, body, headers):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.load(r)


def ask(text):
    gk, qk = os.environ.get("GEMINI_API_KEY"), os.environ.get("GROQ_API_KEY")
    if gk:
        for model in [m for m in [os.environ.get("GEMINI_MODEL"), "gemini-2.5-flash", "gemini-2.0-flash"] if m]:
            try:
                r = post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                         {"contents": [{"parts": [{"text": text}]}]}, {"x-goog-api-key": gk})
                return r["candidates"][0]["content"]["parts"][0]["text"], f"Gemini {model}"
            except Exception as e:  # 配额/模型下线：试下一个
                print(f"Gemini {model} 调用失败:", type(e).__name__, getattr(e, "code", ""))
    if qk:
        try:
            r = post("https://api.groq.com/openai/v1/chat/completions",
                     {"model": "llama-3.3-70b-versatile", "messages": [{"role": "user", "content": text[:30000]}]},
                     {"Authorization": "Bearer " + qk})
            return r["choices"][0]["message"]["content"], "Groq llama-3.3-70b"
        except Exception as e:
            print("Groq 调用失败:", type(e).__name__, getattr(e, "code", ""))
    return None, None


def main():
    n = os.environ["PR_NUMBER"]
    pr = gh(f"/pulls/{n}")
    labels = {l["name"] for l in pr["labels"]}
    if "needs-leader-review" not in labels:
        print("没有 needs-leader-review 标签，不审");
        return
    if pr["head"]["ref"].startswith("gemini/"):
        print("自动程序员 PR 不做 A 类审查");
        return
    diff = pr_diff(n)
    digest = hashlib.sha256(diff.encode()).hexdigest()[:16]
    comments = []
    page = 1
    while True:
        batch = gh(f"/issues/{n}/comments?per_page=100&page={page}")
        comments += batch
        if len(batch) < 100:
            break
        page += 1
    done = [c for c in comments if c["body"].startswith(MARK)]
    if any(f"sha={digest}" in c["body"][:120] for c in done):
        print("这份 diff 已审过，跳过（省额度）");
        return
    if len(done) >= MAX_REVIEWS and "re-review" not in labels:
        print(f"已审 {len(done)} 次，达到上限；需要再审请加 re-review 标签");
        return
    out, who = ask(PROMPT + diff[:MAX_DIFF])
    if out is None:
        out, who = "兜底审查已跳过：Gemini 与 Groq 都未配置或调用失败（可能是免费额度用完），稍后加 re-review 标签重试。", "none"
    body = f"{MARK} sha={digest} -->\n### 自动反对式审查（{who}，仅供负责人参考，不替代负责人审）\n\n{out}\n"
    gh(f"/issues/{n}/comments", {"body": body})
    print("已评论", who)


main()
