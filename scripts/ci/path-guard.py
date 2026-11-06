#!/usr/bin/env python3
"""PR 改动路径闸门（不调用模型）。

1. 任何 PR 触及 A+ 路径（.github/a-plus-paths.txt），或改动行（新增或删除）命中下面的
   A+ 内容规则（RLS / forUser 底层、保险箱密钥、主密钥与备份加密、D207 长期授权），
   却没有 needs-leader-review 标签 → 失败（防止 A+ 改动被当成 B/C 直接合并）。
   A+ 范围以 Issue #156 第 2 条 + D207 为准（D235（原 D223）复核，2026-10-31）。
2. Gemini 自动程序员的改动（分支 gemini/*，或带 gemini-task 标签）：
   只要有一个文件不在 .github/gemini-allowed-paths.txt 白名单内，或触及 A+ → 失败。

改名/挪动：列文件和取 diff 都用 --no-renames，改名按「删旧 + 加新」处理，旧路径新路径都参与判断
（把 A+ 文件挪出 A+ 目录同样判 A+；负责人 2026-10-31 审 #187 必改 1）。
名单从 base 读（#247，负责人 #187 补审）：白名单只用 base 版；A+ 名单取「base 版 ∪ head 版」，
PR 自己改宽白名单、删 A+ 条目都不算数，PR 新增的 A+ 条目照样算。判定规则（CONTENT_RULES）就是运行的这份脚本，
工作流只运行 base 版（path-guard.yml 用 pull_request_target、只检出 base；head 只 fetch 成 ref 用来算 diff）。
测试：python3 scripts/ci/test_path_guard.py

用法：path-guard.py <base-ref> [<head-ref>，默认 HEAD]   环境变量 HEAD_REF（分支名）、PR_LABELS（逗号分隔）
"""
import fnmatch, os, re, subprocess, sys

# A+ 内容规则：(名称, 适用的路径前缀, 正则)。扫描 diff 里新增和删除的行（删掉一条策略同样是 A+）。
CONTENT_RULES = [
    ("RLS / forUser 底层（D206）", ("core/migrations/", "core/src/"),
     re.compile(r"ROW LEVEL SECURITY|CREATE POLICY|ALTER POLICY|DROP POLICY|BYPASSRLS|set_config\(\s*'app\.user_id'"
                r"|current_setting\(\s*'app\.user_id'|app\.system_scope|\bforUser\s*\??\s*[:(]\s*\(?\s*userId\s*:", re.I)),
    ("保险箱加解密 / VAULT_KEY", ("core/src/",),
     re.compile(r"VAULT_KEY|parseVaultKey|vaultFingerprint|createCipheriv|createDecipheriv")),
    ("主密钥与备份加密", ("scripts/", "deploy/", "installer/"),
     re.compile(r"AGE-SECRET-KEY|age-keygen|age-encryption\.org|AGE_RECIPIENT|AGE_IDENTITY|BACKUP_IDENTITY"
                r"|AgeRecipient|AgeIdentity|AgeKeygen|MasterKey|'masterkey'|\bage(\.exe)?\s+(-r|-d|-i|-e|--encrypt|--decrypt)\b")),
    ("D207 长期授权", ("core/migrations/", "core/src/"),
     re.compile(r"standing_grant|standingGrant|long_term_grant|longTermGrant", re.I)),
]


def parse(text):
    return [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]


def patterns(path):
    with open(path, encoding="utf-8") as f:
        return parse(f.read())


def patterns_at(ref, path):
    """某个提交里的名单（git show <ref>:<path>）；那一版没有这个文件就是空名单。"""
    r = subprocess.run(["git", "show", f"{ref}:{path}"], capture_output=True, text=True)
    return parse(r.stdout) if r.returncode == 0 else []


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


def evaluate(base, head_ref, labels, head="HEAD"):
    """返回 (files, aplus, robot, errors, notes)。head 只用来算 diff 和读它新增的 A+ 条目，不执行其中任何东西。"""
    # --no-renames：改名/挪动拆成「删除旧路径 + 新增新路径」，两边都进名单
    files = [f for f in git("diff", "--no-renames", "--name-only", f"{base}...{head}").splitlines() if f]
    base_aplus = patterns_at(base, ".github/a-plus-paths.txt")
    if not base_aplus:
        raise SystemExit(f"{base} 里读不到 .github/a-plus-paths.txt，闸门不能判定")
    aplus_pats = base_aplus + [p for p in patterns_at(head, ".github/a-plus-paths.txt") if p not in base_aplus]
    allow_pats = patterns_at(base, ".github/gemini-allowed-paths.txt")

    aplus = [f for f in files if match(f, aplus_pats)]
    for name, scope, rx in CONTENT_RULES:
        scoped = [f for f in files if f.startswith(scope) and not match(f, aplus_pats)]
        if not scoped:
            continue
        hit = set()
        cur = None
        for l in git("diff", "--no-renames", f"{base}...{head}", "--", *scoped).splitlines():
            if l.startswith("diff --git "):
                cur = l.split(" b/", 1)[-1]
                continue
            if l.startswith("+++ ") or l.startswith("--- "):
                continue
            if l[:1] in "+-" and rx.search(l[1:]) and cur:
                hit.add(cur)
        if hit:
            aplus.append(f"（{name}）" + ", ".join(sorted(hit)[:5]))

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
    return files, aplus, robot, errors, notes


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else "origin/dev"
    head = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
    head_ref = os.environ.get("HEAD_REF", "")
    labels = {l.strip() for l in os.environ.get("PR_LABELS", "").split(",") if l.strip()}
    files, aplus, robot, errors, notes = evaluate(base, head_ref, labels, head)

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
