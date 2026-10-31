#!/usr/bin/env python3
"""PR 改动路径闸门（不调用模型）。

1. 任何 PR 触及 A+ 路径（.github/a-plus-paths.txt，或迁移/数据库层新增 RLS 语句）
   却没有 needs-leader-review 标签 → 失败（防止 A+ 改动被当成 B/C 直接合并）。
2. Gemini 自动程序员的改动（分支 gemini/*，或带 gemini-task 标签）：
   只要有一个文件不在 .github/gemini-allowed-paths.txt 白名单内，或触及 A+ → 失败。

用法：path-guard.py <base-ref>   环境变量 HEAD_REF（分支名）、PR_LABELS（逗号分隔）
"""
import fnmatch, os, re, subprocess, sys

RLS_RE = re.compile(r"ROW LEVEL SECURITY|CREATE POLICY|ALTER POLICY|set_config\(\s*'app\.user_id'|app\.system_scope", re.I)
RLS_SCOPE = ("core/migrations/", "core/src/db/", "core/src/users/")


def patterns(path):
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                out.append(line)
    return out


def match(file, pats):
    for p in pats:
        if p.endswith("/**"):
            if file.startswith(p[:-2]):
                return True
        elif fnmatch.fnmatchcase(file, p):
            return True
    return False


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "origin/dev"
    head_ref = os.environ.get("HEAD_REF", "")
    labels = {l.strip() for l in os.environ.get("PR_LABELS", "").split(",") if l.strip()}
    files = [f for f in git("diff", "--name-only", f"{base}...HEAD").splitlines() if f]
    aplus_pats = patterns(".github/a-plus-paths.txt")
    allow_pats = patterns(".github/gemini-allowed-paths.txt")

    aplus = [f for f in files if match(f, aplus_pats)]
    rls_files = [f for f in files if f.startswith(RLS_SCOPE)]
    if rls_files:
        added = "\n".join(l for l in git("diff", f"{base}...HEAD", "--", *rls_files).splitlines() if l.startswith("+"))
        if RLS_RE.search(added):
            aplus.append("（RLS 语句）" + ", ".join(rls_files[:5]))

    robot = head_ref.startswith("gemini/") or "gemini-task" in labels
    errors, notes = [], []
    if robot:
        outside = [f for f in files if not match(f, allow_pats)]
        if outside:
            errors.append("Gemini 自动程序员只能改白名单路径，以下文件越界：" + ", ".join(outside[:20]))
        if aplus:
            errors.append("Gemini 自动程序员触及 A+：" + ", ".join(aplus[:20]))
    elif aplus:
        notes.append("触及 A+：" + ", ".join(aplus[:20]) + " —— 必须等负责人审，绝不兜底合并。")
        if "needs-leader-review" not in labels:
            errors.append("触及 A+ 却没有 needs-leader-review 标签：请加标签并在日志写「需要负责人审」。")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    lines = [f"### 路径闸门：{'失败' if errors else '通过'}", f"改动文件 {len(files)} 个；自动程序员={'是' if robot else '否'}"]
    lines += [f"- ❌ {e}" for e in errors] + [f"- ⚠️ {n}" for n in notes]
    text = "\n".join(lines)
    print(text)
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    for n in notes:
        print(f"::warning::{n}")
    for e in errors:
        print(f"::error::{e}")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
