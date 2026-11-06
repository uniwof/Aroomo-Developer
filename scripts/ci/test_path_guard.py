#!/usr/bin/env python3
"""path-guard.py 的回归测试（不联网、不调模型）：在临时 git 仓库里造改动，检查 A+ 判定。

运行：python3 scripts/ci/test_path_guard.py
"""
import importlib.util, os, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
spec = importlib.util.spec_from_file_location("path_guard", os.path.join(HERE, "path-guard.py"))
pg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pg)


def sh(*args, cwd):
    subprocess.run(args, cwd=cwd, check=True, capture_output=True, text=True)


class PathGuardTest(unittest.TestCase):
    def setUp(self):
        self.old = os.getcwd()
        self.d = tempfile.mkdtemp(prefix="pg-test-")
        os.makedirs(os.path.join(self.d, ".github"))
        for f in ("a-plus-paths.txt", "gemini-allowed-paths.txt"):
            shutil.copy(os.path.join(ROOT, ".github", f), os.path.join(self.d, ".github", f))
        self.write("core/src/vault/crypto.ts", "export const x = 1;\n" * 20)
        self.write("core/src/confirm/index.ts", "export const confirm = 1;\n" * 20)
        self.write("docs/a.md", "hello\n")
        sh("git", "init", "-q", "-b", "base", cwd=self.d)
        sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A", cwd=self.d)
        sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base", cwd=self.d)
        sh("git", "checkout", "-qb", "feature", cwd=self.d)
        os.chdir(self.d)

    def tearDown(self):
        os.chdir(self.old)
        shutil.rmtree(self.d, ignore_errors=True)

    def write(self, rel, text):
        p = os.path.join(self.d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)

    def commit(self):
        sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A", cwd=self.d)
        sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "change", cwd=self.d)

    def run_guard(self, head_ref="feature", labels=()):
        return pg.evaluate("base", head_ref, set(labels))

    # 必改 1：把 A+ 文件挪出 A+ 目录必须判 A+
    def test_move_aplus_file_out_of_aplus_dir_is_aplus(self):
        os.makedirs(os.path.join(self.d, "core/src/util"), exist_ok=True)
        sh("git", "mv", "core/src/vault/crypto.ts", "core/src/util/crypto.ts", cwd=self.d)
        self.commit()
        files, aplus, _, errors, _ = self.run_guard()
        self.assertIn("core/src/vault/crypto.ts", files)
        self.assertIn("core/src/util/crypto.ts", files)
        self.assertTrue(any("core/src/vault/crypto.ts" in a for a in aplus), aplus)
        self.assertTrue(errors, "没有 needs-leader-review 标签应失败")

    def test_move_aplus_dir_out_with_label_passes_but_flags(self):
        sh("git", "mv", "core/src/confirm", "core/src/oldconfirm", cwd=self.d)
        self.commit()
        _, aplus, _, errors, notes = self.run_guard(labels=["needs-leader-review"])
        self.assertTrue(any("core/src/confirm/index.ts" in a for a in aplus), aplus)
        self.assertFalse(errors)
        self.assertTrue(notes)

    def test_gemini_cannot_move_file_out_of_allowed_paths(self):
        sh("git", "mv", "docs/a.md", "core/src/a.md", cwd=self.d)
        self.commit()
        _, _, robot, errors, _ = self.run_guard(head_ref="gemini/x")
        self.assertTrue(robot)
        self.assertTrue(errors)

    # 必改 2：白名单与对抗式审查进 A+
    def test_new_aplus_entries(self):
        for f in (".github/gemini-allowed-paths.txt", ".github/workflows/adversarial-review.yml",
                  "scripts/ci/adversarial-review.py", "scripts/ci/test_path_guard.py",
                  "scripts/ci/path-guard.py", ".github/a-plus-paths.txt"):
            with self.subTest(f=f):
                self.assertTrue(pg.match(f, pg.patterns(".github/a-plus-paths.txt")), f)

    def test_adversarial_review_change_needs_label(self):
        self.write("scripts/ci/adversarial-review.py", "print('x')\n")
        self.commit()
        _, aplus, _, errors, _ = self.run_guard()
        self.assertIn("scripts/ci/adversarial-review.py", aplus)
        self.assertTrue(errors)

    def test_plain_docs_change_passes(self):
        self.write("docs/a.md", "hello world\n")
        self.commit()
        _, aplus, _, errors, _ = self.run_guard()
        self.assertEqual(aplus, [])
        self.assertEqual(errors, [])

    # #247（负责人 #187 补审必改）：名单从 base 读，PR 自己改宽的白名单 / 删掉的 A+ 条目不算数
    def write_list(self, name, extra=None, drop=None):
        p = os.path.join(self.d, ".github", name)
        with open(p, encoding="utf-8") as f:
            lines = f.read().splitlines()
        if drop:
            lines = [l for l in lines if l.strip() != drop]
        if extra:
            lines.append(extra)
        self.write(".github/" + name, "\n".join(lines) + "\n")

    def test_gemini_widening_allowlist_in_same_pr_still_fails(self):
        self.write_list("gemini-allowed-paths.txt", extra="core/**")
        self.write("core/src/confirm/index.ts", "export const confirm = 2;\n")
        self.commit()
        _, aplus, robot, errors, _ = self.run_guard(head_ref="gemini/x")
        self.assertTrue(robot)
        self.assertTrue(any("越界" in e for e in errors), errors)
        self.assertTrue(any("core/src/confirm/index.ts" in a for a in aplus), aplus)

    def test_dropping_aplus_entry_in_same_pr_still_aplus(self):
        self.write_list("a-plus-paths.txt", drop="core/src/vault/crypto.ts")
        self.write("core/src/vault/crypto.ts", "export const y = 1;\n")
        self.commit()
        _, aplus, _, errors, _ = self.run_guard()
        self.assertIn("core/src/vault/crypto.ts", aplus)
        self.assertTrue(errors, "删 A+ 条目也要按 base 判 A+，没标签应失败")

    def test_new_aplus_entry_added_by_pr_counts(self):
        self.write_list("a-plus-paths.txt", extra="docs/secret/**")
        self.write("docs/secret/a.md", "x\n")
        self.commit()
        _, aplus, _, _, _ = self.run_guard()
        self.assertIn("docs/secret/a.md", aplus)

    def test_head_given_as_ref_not_checked_out(self):
        # 工作流只检出 base，head 只 fetch 成一个 ref 用来算 diff：工作区停在 base 上也能判
        self.write("core/src/vault/crypto.ts", "export const z = 1;\n")
        self.commit()
        sh("git", "branch", "-q", "pr-head", cwd=self.d)
        sh("git", "checkout", "-q", "base", cwd=self.d)
        files, aplus, _, errors, _ = pg.evaluate("base", "feature", set(), head="pr-head")
        self.assertEqual(files, ["core/src/vault/crypto.ts"])
        self.assertTrue(errors)

    def test_robot_touching_ci_needs_human(self):
        # 临时规则（负责人 #187）：Gemini 碰 .github/ 或 scripts/ci/ 一律人工看
        self.write("scripts/ci/other.py", "print(1)\n")
        self.commit()
        _, _, _, errors, _ = self.run_guard(labels=["gemini-task"])
        self.assertTrue(errors)


class WorkflowTest(unittest.TestCase):
    """工作流不执行 head 的任何代码（#247 验收 3）。"""

    def read(self, rel):
        with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
            return f.read()

    def test_path_guard_runs_base_version(self):
        y = self.read(".github/workflows/path-guard.yml")
        self.assertIn("pull_request_target:", y)
        self.assertNotRegex(y, r"(?m)^\s+pull_request:")
        self.assertNotIn("ref: ${{ github.event.pull_request.head", y)
        self.assertNotIn("inputs.branch }}\n", y.split("checkout@")[1].split("- name")[0])
        self.assertIn("persist-credentials: false", y)

    def test_gemini_task_uses_base_guard(self):
        y = self.read(".github/workflows/gemini-task.yml")
        self.assertNotIn("python3 scripts/ci/path-guard.py", y)
        self.assertIn("git show origin/dev:scripts/ci/path-guard.py", y)
        self.assertNotIn('d="{\\"ref\\":\\"$BR\\",\\"inputs', y)


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
