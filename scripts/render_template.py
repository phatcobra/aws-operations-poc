#!/usr/bin/env python3
"""Render infra/template.yaml by inlining src/app.py as the Lambda's ZipFile.

src/app.py is the single source of truth for the deployed Lambda code. This
script strips its docstrings/comments via ast.unparse (functionally
identical, smaller) and substitutes it into the {{LAMBDA_SOURCE}} placeholder
in infra/template.yaml, failing loudly if the result would exceed
CloudFormation's 4096-character inline ZipFile limit.

Usage: python3 scripts/render_template.py
Writes: infra/template.rendered.yaml
"""
import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_SOURCE = ROOT / "src" / "app.py"
TEMPLATE_SRC = ROOT / "infra" / "template.yaml"
TEMPLATE_OUT = ROOT / "infra" / "template.rendered.yaml"
ZIPFILE_LIMIT = 4096


def strip_docstrings(tree):
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if (
                node.body
                and isinstance(node.body[0], ast.Expr)
                and isinstance(node.body[0].value, ast.Constant)
                and isinstance(node.body[0].value.value, str)
            ):
                node.body.pop(0)
    return tree


def build_inline_source():
    source = APP_SOURCE.read_text()
    tree = ast.parse(source)
    ast.parse(source)  # fail fast on syntax errors with a clear traceback
    inlined = ast.unparse(strip_docstrings(tree))
    if len(inlined) > ZIPFILE_LIMIT:
        raise SystemExit(
            f"src/app.py inlines to {len(inlined)} chars, over the "
            f"{ZIPFILE_LIMIT}-char CloudFormation ZipFile limit by {len(inlined) - ZIPFILE_LIMIT}. "
            "Trim src/app.py or switch to S3-based packaging."
        )
    return inlined, len(inlined)


def indent(text, spaces):
    pad = " " * spaces
    return "\n".join(pad + line if line else line for line in text.splitlines())


def main():
    if not TEMPLATE_SRC.exists():
        raise SystemExit(f"missing {TEMPLATE_SRC}")
    inlined, size = build_inline_source()
    template = TEMPLATE_SRC.read_text()
    if "{{LAMBDA_SOURCE}}" not in template:
        raise SystemExit(f"{TEMPLATE_SRC} has no {{{{LAMBDA_SOURCE}}}} placeholder")
    rendered = template.replace("{{LAMBDA_SOURCE}}", indent(inlined, 10))
    TEMPLATE_OUT.write_text(rendered)
    print(f"OK: inlined src/app.py ({size}/{ZIPFILE_LIMIT} chars) -> {TEMPLATE_OUT}")


if __name__ == "__main__":
    main()
