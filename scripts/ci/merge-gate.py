#!/usr/bin/env python3
"""合并闸门（不调用模型，只用默认 GITHUB_TOKEN）。落实 D235 第 4 条 / 工单 #189、#228。

规则：仓库里只要还有一个**带 needs-leader-review 且没有 leader-approved 的 PR**（开着、已关、已合并都算），
就不许把 dev 合进 main、不许发布 v* 生产标签 —— 检查失败并打印这些 PR 号。负责人审完摘标签（或加
leader-approved）即放行。「needs-leader-review 且无 leader-approved」的口径按 D244，与工单 #228 一致。

豁免：被检查的那个 PR（向 main 的 PR，或 v* 标签所指提交所属的 PR）带 hotfix 标签 → 通过，
但在该 PR 下评论「紧急修复豁免：事后必须补审」并给它加 needs-leader-review，用来跟踪补审。

被检查的 PR 自己不算进拦截名单（否则 dev→main 的 PR 一带标签就永远拦住自己）；它该不该合由
负责人/所有者在该 PR 上把关（D252：dev→main 只由所有者合）。

#171 接入点：标签发布作业要 `needs:` 本工作流的 gate 作业（或在发布脚本里先跑
`python3 scripts/ci/merge-gate.py`，非零退出就拒绝发布）；本工单不改任何部署脚本。

用法：
  merge-gate.py            CI 内判定；环境变量 GH_TOKEN、REPO、PR_NUMBER（向 main 的 PR）、
                           TAG_SHA（v* 标签指向的提交）、TAG_NAME（可选，只用于日志）
  merge-gate.py --selftest 自测，不联网（CI 每次先跑一遍）
"""
import json
import os
import sys
import unittest
import urllib.error
import urllib.request

BLOCK_LABEL = "needs-leader-review"
OK_LABEL = "leader-approved"
HOTFIX_LABEL = "hotfix"
EXEMPT_COMMENT = "紧急修复豁免：事后必须补审"
MARK = "<!-- merge-gate:hotfix-exempt -->"
API = "https://api.github.com/repos/"


def gh(path, body=None, method=None):
    req = urllib.request.Request(
        API + os.environ["REPO"] + path,
        json.dumps(body).encode() if body is not None else None,
        {"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Accept": "application/vnd.github+json",
         "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read() or b"null")


def labels_of(item):
    return {l["name"] for l in item.get("labels") or []}


def fetch_labelled_prs():
    """仓库里所有带 needs-leader-review 的 PR（含已关闭/已合并），分页取全。"""
    out = []
    for page in range(1, 31):  # 30 页 ×100 足够；真超了也只会少拦，日志里能看出条数
        batch = gh(f"/issues?labels={BLOCK_LABEL}&state=all&per_page=100&page={page}")
        for it in batch:
            if "pull_request" in it:
                out.append({"number": it["number"], "labels": labels_of(it)})
        if len(batch) < 100:
            break
    return out


def fetch_current_prs():
    """被检查的 PR：向 main 的那个 PR，或 v* 标签所指提交所属的 PR。"""
    n = os.environ.get("PR_NUMBER", "").strip()
    if n:
        pr = gh(f"/pulls/{n}")
        return [{"number": pr["number"], "labels": labels_of(pr)}]
    sha = os.environ.get("TAG_SHA", "").strip()
    if not sha:
        return []
    try:
        return [{"number": pr["number"], "labels": labels_of(pr)} for pr in gh(f"/commits/{sha}/pulls")]
    except urllib.error.HTTPError as e:
        if e.code == 404:  # 标签提交没有对应 PR（例如直接在 main 上打标签）
            return []
        raise


def evaluate(labelled_prs, current_prs):
    """纯逻辑，便于自测。返回 (blocking, exempt, errors, notes)。"""
    current_numbers = {p["number"] for p in current_prs}
    blocking = sorted(p["number"] for p in labelled_prs
                      if BLOCK_LABEL in p["labels"] and OK_LABEL not in p["labels"]
                      and p["number"] not in current_numbers)
    exempt = [p for p in current_prs if HOTFIX_LABEL in p["labels"]]
    errors, notes = [], []
    if exempt:
        notes.append("紧急修复豁免（hotfix）：PR " + ", ".join(f"#{p['number']}" for p in exempt)
                     + " 放行，已加 needs-leader-review 跟踪补审。"
                     + (f"仍有待审 PR：{', '.join('#%d' % n for n in blocking)}。" if blocking else ""))
    elif blocking:
        errors.append("还有待负责人复审的 PR（needs-leader-review 且无 leader-approved）："
                      + ", ".join(f"#{n}" for n in blocking)
                      + " —— 不许合 main、不许发 v* 生产标签。负责人审完摘标签或加 leader-approved 即放行。")
    return blocking, exempt, errors, notes


def mark_exempt(pr):
    """给豁免的 PR 留评论 + 加 needs-leader-review（同一个 PR 只评论一次）。"""
    if not any(MARK in (c.get("body") or "") for c in gh(f"/issues/{pr['number']}/comments?per_page=100")):
        gh(f"/issues/{pr['number']}/comments", {"body": f"{MARK}\n{EXEMPT_COMMENT}"})
    if BLOCK_LABEL not in pr["labels"]:
        gh(f"/issues/{pr['number']}/labels", {"labels": [BLOCK_LABEL]})


def main():
    current = fetch_current_prs()
    blocking, exempt, errors, notes = evaluate(fetch_labelled_prs(), current)
    for pr in exempt:
        mark_exempt(pr)

    what = os.environ.get("TAG_NAME") or (f"PR #{current[0]['number']}" if current else "main")
    lines = [f"### 合并闸门：{'失败' if errors else '通过'}",
             f"检查对象：{what}；待审 PR {len(blocking)} 个"]
    lines += [f"- ❌ {e}" for e in errors] + [f"- ⚠️ {n}" for n in notes]
    text = "\n".join(lines)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    for n in notes:
        print(f"::warning::{n}")
    for e in errors:
        print(f"::error::{e}")
    sys.exit(1 if errors else 0)


# ---------------- 自测（不联网，对注入的假数据做断言）----------------

def pr(number, *labels):
    return {"number": number, "labels": set(labels)}


class MergeGateTest(unittest.TestCase):
    def test_no_labelled_pr_passes(self):
        blocking, exempt, errors, _ = evaluate([], [pr(10)])
        self.assertEqual((blocking, exempt, errors), ([], [], []))

    def test_open_labelled_pr_blocks(self):
        blocking, _, errors, _ = evaluate([pr(5, BLOCK_LABEL)], [pr(10)])
        self.assertEqual(blocking, [5])
        self.assertTrue(errors and "#5" in errors[0])

    def test_merged_labelled_pr_also_blocks(self):
        # 已合并的 PR 也在 state=all 的结果里，同样拦截
        blocking, _, errors, _ = evaluate([pr(7, BLOCK_LABEL), pr(9, BLOCK_LABEL, "risk:A")], [pr(10)])
        self.assertEqual(blocking, [7, 9])
        self.assertTrue(errors)

    def test_leader_approved_does_not_block(self):
        blocking, _, errors, _ = evaluate([pr(5, BLOCK_LABEL, OK_LABEL)], [pr(10)])
        self.assertEqual((blocking, errors), ([], []))

    def test_label_removed_passes(self):
        self.assertEqual(evaluate([], [pr(10)])[2], [])

    def test_current_pr_does_not_block_itself(self):
        blocking, _, errors, _ = evaluate([pr(10, BLOCK_LABEL)], [pr(10, BLOCK_LABEL)])
        self.assertEqual((blocking, errors), ([], []))

    def test_hotfix_pr_is_exempt_and_tracked(self):
        blocking, exempt, errors, notes = evaluate([pr(5, BLOCK_LABEL)], [pr(11, HOTFIX_LABEL)])
        self.assertEqual(blocking, [5])
        self.assertEqual([p["number"] for p in exempt], [11])
        self.assertEqual(errors, [])
        self.assertTrue(notes and EXEMPT_COMMENT.split("：")[0] in notes[0])

    def test_tag_without_pr_blocked_by_pending_review(self):
        # 直接在 main 上打标签：没有所属 PR，没法豁免，照样被拦
        blocking, exempt, errors, _ = evaluate([pr(5, BLOCK_LABEL)], [])
        self.assertEqual((blocking, exempt), ([5], []))
        self.assertTrue(errors)

    def test_tag_commit_pr_with_hotfix_exempt(self):
        _, exempt, errors, _ = evaluate([pr(5, BLOCK_LABEL)], [pr(12, HOTFIX_LABEL), pr(13)])
        self.assertEqual([p["number"] for p in exempt], [12])
        self.assertEqual(errors, [])

    def test_labels_of_parses_github_shape(self):
        self.assertEqual(labels_of({"labels": [{"name": "a"}, {"name": "b"}]}), {"a", "b"})
        self.assertEqual(labels_of({}), set())


if __name__ == "__main__":
    if "--selftest" in sys.argv[1:]:
        sys.argv = sys.argv[:1]
        sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
    main()
