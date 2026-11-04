#!/usr/bin/env python3
"""从 PR、标签、工单（Issues）生成进度摘要（PROGRESS/HANDOFF 周报 + D213 商用就绪清单进度表）。不调用任何模型。

用法：
  python3 scripts/progress/gen-progress.py [--out FILE] [--update-issue] [--days 7]
环境变量：GITHUB_REPOSITORY（默认 uniwof/Aroomo-Developer）、GH_TOKEN（Actions 里用；Hark 沙盒里由连接器在线路上注入，可不设）。
--update-issue：把结果写进带 progress-report 标签的置顶 Issue（没有就新建），手机上直接看。
D213 每项的状态：优先 docs/progress/d213.json 里的手工状态，其次统计带 d213-<n> 标签的工单完成比例。
"""
import argparse, datetime as dt, json, os, sys, urllib.request

REPO = os.environ.get("GITHUB_REPOSITORY", "uniwof/Aroomo-Developer")
API = "https://api.github.com"
TZ = dt.timezone(dt.timedelta(hours=8))
LINES = {"line:backend": "后台线", "line:console": "控制台线", "line:executor": "执行员线", "line:iso": "隔离线"}
PREFIX = [("core/", "后台线"), ("p1/", "后台线"), ("console/", "控制台线"), ("executor/", "执行员线"), ("ci/", "执行员线"),
          ("iso/", "隔离线"), ("gemini/", "Gemini"), ("docs/", "文档"), ("fix/", "修复")]
D213 = ["RLS 全部模块（隔离线）", "自动越权测试 D208（执行员线）", "两个账号验收（隔离线）", "环境分离 + 打标签发版（控制台线）",
        "质量门禁 D210（执行员线）", "错误追踪 D212", "恢复演练（含保险箱）", "甲骨文生产机 + 防回收", "新用户引导 D214（控制台线）",
        "用户数据导出与删除", "服务条款、隐私政策", "计费预留 D215", "「加固前必须」各项"]
STATUS_FRAC = {"done": 1.0, "partial": 0.5, "todo": 0.0}
ICON = {"done": "✅", "partial": "🟡", "todo": "⏳"}


def get(path):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "aroomo-progress"}
    if os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    req = urllib.request.Request(API + path, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def send(method, path, body):
    headers = {"Accept": "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "aroomo-progress"}
    if os.environ.get("GH_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GH_TOKEN"]
    req = urllib.request.Request(API + path, json.dumps(body).encode(), headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def paged(path):
    out, page = [], 1
    sep = "&" if "?" in path else "?"
    while True:
        batch = get(f"{path}{sep}per_page=100&page={page}")
        items = batch["items"] if isinstance(batch, dict) else batch
        out += items
        if len(items) < 100 or page >= 10:
            return out
        page += 1


def line_of_branch(ref):
    for p, name in PREFIX:
        if ref.startswith(p):
            return name
    return "其他"


def labels_of(x):
    return {l["name"] for l in x.get("labels", [])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--update-issue", action="store_true")
    ap.add_argument("--days", type=int, default=7)
    a = ap.parse_args()

    now = dt.datetime.now(TZ)
    since = (now - dt.timedelta(days=a.days)).astimezone(dt.timezone.utc).strftime("%Y-%m-%d")
    merged = []
    for page in range(1, 6):  # 按更新时间倒序翻页，取近 N 天合并到 dev 的 PR（一页 100 个，不逐个请求）
        batch = get(f"/repos/{REPO}/pulls?state=closed&base=dev&sort=updated&direction=desc&per_page=100&page={page}")
        merged += [p for p in batch if p.get("merged_at") and p["merged_at"][:10] >= since]
        if len(batch) < 100 or batch[-1]["updated_at"][:10] < since:
            break
    open_prs = paged(f"/repos/{REPO}/pulls?state=open")
    issues = [i for i in paged(f"/repos/{REPO}/issues?state=all&since={(now - dt.timedelta(days=60)).isoformat()}") if "pull_request" not in i]
    tickets = [i for i in issues if labels_of(i) & set(LINES)]

    # 合并的 PR 按线归类（分支名前缀）
    by_line = {}
    for pr in merged:
        by_line.setdefault(line_of_branch(pr["head"]["ref"]), []).append(pr)

    md = [f"# Aroomo 进度摘要（自动生成，不用模型）", f"生成于 {now:%Y-%m-%d %H:%M}（北京时间），统计近 {a.days} 天。", ""]

    # 1. D213
    override = {}
    if os.path.exists("docs/progress/d213.json"):
        override = json.load(open("docs/progress/d213.json", encoding="utf-8"))
    rows, total = [], 0.0
    for n, name in enumerate(D213, 1):
        tagged = [i for i in issues if f"d213-{n}" in labels_of(i)]
        o = override.get(str(n), {})
        if o.get("status") in STATUS_FRAC:
            st, frac, note = o["status"], STATUS_FRAC[o["status"]], o.get("note", "")
        elif tagged:
            closed = sum(1 for i in tagged if i["state"] == "closed")
            frac = closed / len(tagged)
            st = "done" if frac == 1 else ("partial" if closed or any("status:doing" in labels_of(i) for i in tagged) else "todo")
            frac = frac if st != "partial" or frac else 0.25
            note = f"工单 {closed}/{len(tagged)} 完成"
        else:
            st, frac, note = "todo", 0.0, "还没有工单"
        total += frac
        rows.append(f"| {n} | {name} | {ICON[st]} | {note} |")
    pct = round(total / len(D213) * 100)
    done_n = sum(1 for r in rows if "✅" in r)
    md += [f"## D213 商用就绪清单：{done_n}/13 项完成，整体约 {pct}%", "", "| # | 项 | 状态 | 说明 |", "|---|---|---|---|", *rows, ""]

    # 2. 本周合并
    md += [f"## 近 {a.days} 天合并到 dev：{len(merged)} 个 PR", ""]
    for line in sorted(by_line):
        prs = by_line[line]
        md.append(f"- **{line}**（{len(prs)}）：" + "；".join(f"#{p['number']} {p['title'][:40]}" for p in prs[:8]) + ("…" if len(prs) > 8 else ""))
    md.append("")

    # 3. 待负责人审
    wait = [p for p in open_prs if "needs-leader-review" in labels_of(p) and not labels_of(p) & {"leader-approved", "leader-changes-requested"}]
    md += [f"## 待负责人审（A/A+）：{len(wait)} 个", ""]
    md += [f"- #{p['number']} {p['title'][:60]}" for p in wait] or ["- 没有"]
    md.append("")

    # 4. 工单 / HANDOFF：每条线下一步
    md += ["## 各线工单（HANDOFF：下一步）", ""]
    for lab, name in LINES.items():
        mine = [i for i in tickets if lab in labels_of(i)]
        op = sorted([i for i in mine if i["state"] == "open"], key=lambda i: i["number"])
        blocked = [i for i in op if "status:blocked" in labels_of(i)]
        closed7 = [i for i in mine if i["state"] == "closed" and i.get("closed_at", "") >= since]
        nxt = [i for i in op if "status:blocked" not in labels_of(i)][:3]
        md.append(f"- **{name}**：开放 {len(op)}（阻塞 {len(blocked)}），近 {a.days} 天完成 {len(closed7)}。下一步："
                  + ("；".join(f"#{i['number']} {i['title'][:36]}" for i in nxt) or "无"))
    md.append("")
    text = "\n".join(md)

    if a.out:
        os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
        open(a.out, "w", encoding="utf-8").write(text)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8").write(text + "\n")
    if a.update_issue:
        found = paged(f"/repos/{REPO}/issues?state=open&labels=progress-report")
        if found:
            send("PATCH", f"/repos/{REPO}/issues/{found[0]['number']}", {"body": text})
            print(f"已更新 Issue #{found[0]['number']}", file=sys.stderr)
        else:
            r = send("POST", f"/repos/{REPO}/issues", {"title": "📊 进度与商用就绪清单（自动生成）", "body": text, "labels": ["progress-report"]})
            print(f"已新建 Issue #{r['number']}", file=sys.stderr)


if __name__ == "__main__":
    main()
