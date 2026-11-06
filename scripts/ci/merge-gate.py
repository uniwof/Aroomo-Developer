#!/usr/bin/env python3
"""合并闸门（D235/D244，#189 简化版）：存在带 needs-leader-review 且没有 leader-approved 的 PR
（含已关闭/已合并）时，禁止 dev→main 合并与生产标签。hotfix 标签豁免（仅放行，事后补审）。
环境变量：GITHUB_TOKEN、GITHUB_REPOSITORY、PR_NUMBER（可空）、PR_LABELS（逗号分隔，可空）。
"""
import json, os, sys, urllib.request

API = "https://api.github.com"
REPO = os.environ.get("GITHUB_REPOSITORY", "")
TOKEN = os.environ.get("GITHUB_TOKEN", "")


def call(path, method="GET", data=None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(data).encode() if data is not None else None,
        headers={"Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"null")


def blockers(items):
    out = []
    for it in items:
        if "pull_request" not in it:
            continue
        names = {l["name"] for l in it.get("labels", [])}
        if "needs-leader-review" in names and "leader-approved" not in names:
            out.append(it["number"])
    return sorted(out)


def find_blockers():
    found, page = [], 1
    while True:
        items = call(f"/repos/{REPO}/issues?labels=needs-leader-review&state=all&per_page=100&page={page}")
        found += blockers(items)
        if len(items) < 100:
            return found
        page += 1


def main():
    labels = {x for x in os.environ.get("PR_LABELS", "").split(",") if x}
    pr = os.environ.get("PR_NUMBER", "")
    bad = find_blockers()
    if not bad:
        print("闸门通过：没有未批准的 A 类 PR")
        return 0
    if "hotfix" in labels:
        print("紧急修复豁免：事后必须补审；未批准 PR：", bad)
        if pr:
            call(f"/repos/{REPO}/issues/{pr}/comments", "POST", {"body": "紧急修复豁免：事后必须补审"})
            call(f"/repos/{REPO}/issues/{pr}/labels", "POST", {"labels": ["needs-leader-review"]})
        return 0
    print("闸门拦截：以下 PR 带 needs-leader-review 且没有 leader-approved：", ", ".join("#%d" % n for n in bad))
    return 1


if __name__ == "__main__":
    if os.environ.get("MERGE_GATE_SELFTEST"):
        sample = [
            {"number": 1, "pull_request": {}, "labels": [{"name": "needs-leader-review"}]},
            {"number": 2, "pull_request": {}, "labels": [{"name": "needs-leader-review"}, {"name": "leader-approved"}]},
            {"number": 3, "labels": [{"name": "needs-leader-review"}]},
        ]
        assert blockers(sample) == [1]
        print("ok")
        sys.exit(0)
    sys.exit(main())
