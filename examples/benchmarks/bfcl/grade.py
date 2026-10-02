"""BFCL subset adapter: original upstream checking plus a strict JSON gate.

The upstream source files are downloaded at the pinned revision. Only the model
metadata registry is replaced with one prompt-mode entry. Selected official
runner helpers are compiled unchanged to avoid importing unrelated SDKs.
No model-provided code or function calls are executed.
"""
import ast
import contextlib
import importlib
import json
from pathlib import Path
import sys
import traceback
from types import ModuleType, SimpleNamespace

REVISION = "f7cf7359b7ac615a0b294831c5ba2bc95ee4a000"
MODEL_NAME = "one-eval-json"


def selected_definitions(file, names, namespace):
    """Compile exact upstream function nodes; exclude import-time SDK side effects."""
    source = ast.parse(file.read_text(encoding="utf-8"), filename=str(file))
    nodes = [node for node in source.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in nodes} != set(names) or len(nodes) != len(names):
        raise RuntimeError(f"Pinned upstream helper definitions changed: {file}")
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(file), "exec"), namespace)


def load_official(upstream):
    upstream = Path(upstream).resolve()
    if not (upstream / "bfcl_eval/eval_checker/ast_eval/ast_checker.py").is_file():
        raise FileNotFoundError("Run BFCL prepare.mjs before grading.")
    sys.path.insert(0, str(upstream))
    shim = ModuleType("bfcl_eval.constants.model_config")
    shim.MODEL_CONFIG_MAPPING = {MODEL_NAME: SimpleNamespace(underscore_to_dot=False)}
    sys.modules[shim.__name__] = shim
    enums = importlib.import_module("bfcl_eval.constants.enums")
    checker = importlib.import_module("bfcl_eval.eval_checker.ast_eval.ast_checker")
    parser = importlib.import_module("bfcl_eval.model_handler.parser.json_parser")
    for module in (enums, checker, parser):
        if not Path(module.__file__).resolve().is_relative_to(upstream):
            raise RuntimeError("An upstream module was imported from an unexpected directory.")
    namespace = {"BaseHandler": object, "Language": enums.Language, "ReturnFormat": enums.ReturnFormat,
                 "ast_checker": checker.ast_checker}
    selected_definitions(upstream / "bfcl_eval/utils.py", {"is_function_calling_format_output", "is_empty_output"}, namespace)
    selected_definitions(upstream / "bfcl_eval/eval_checker/eval_runner.py",
                         {"_evaluate_single_ast_entry", "_evaluate_single_relevance_entry"}, namespace)

    class JsonHandler:
        def decode_ast(self, result, *args, **kwargs):
            return parser.parse_json_function_call(result)

    return namespace, enums, JsonHandler()


def strict_protocol(output):
    def constant(value):
        raise ValueError(f"Non-JSON numeric constant: {value}")

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate JSON object key: {key}")
            result[key] = value
        return result

    try:
        calls = json.loads(output, parse_constant=constant, object_pairs_hook=pairs)
        if type(calls) is not list:
            raise ValueError("The response must be a JSON array.")
        for call in calls:
            if type(call) is not dict or set(call) != {"function", "parameters"}:
                raise ValueError("Each call must contain exactly function and parameters.")
            if type(call["function"]) is not str or not call["function"].strip() or type(call["parameters"]) is not dict:
                raise ValueError("Function names must be nonempty strings and parameters must be objects.")
        return True, None
    except (ValueError, TypeError, RecursionError) as error:
        return False, str(error)


def grade(input_data, upstream):
    reference = input_data.get("case", {}).get("reference")
    if not isinstance(reference, dict):
        raise ValueError("BFCL reference is required.")
    if reference.get("revision") != REVISION:
        raise ValueError("BFCL reference revision does not match the pinned evaluator.")
    category = reference.get("category")
    if category not in {"simple_python", "multiple", "irrelevance"}:
        raise ValueError("Unsupported BFCL category.")
    source = reference.get("source")
    if not isinstance(source, dict) or not isinstance(source.get("id"), str) or not isinstance(source.get("function"), list):
        raise ValueError("BFCL reference source is malformed.")
    output = input_data.get("artifact", {}).get("output")
    if not isinstance(output, str):
        raise ValueError("GradeInput.artifact.output must be a string.")
    namespace, enums, handler = load_official(upstream)
    if category == "irrelevance":
        official = namespace["_evaluate_single_relevance_entry"](handler, source["id"], output, source, MODEL_NAME, category)
    else:
        answer = json.loads(reference["answerJson"])
        if answer["id"] != source["id"]:
            raise ValueError("Ground truth ID does not match the source question.")
        official = namespace["_evaluate_single_ast_entry"](handler, source["id"], output, answer["ground_truth"], source,
                                                         MODEL_NAME, category, enums.Language.PYTHON, enums.ReturnFormat.JSON)
    if type(official.get("valid")) is not bool:
        raise RuntimeError("The official evaluator returned an invalid verdict.")
    protocol_valid, protocol_error = strict_protocol(output)
    return {
        "status": "scored", "score": int(protocol_valid and official["valid"]),
        "reason": json.dumps({
            "benchmark": "BFCL selected subset / JSON output adaptation", "source_commit": REVISION,
            "source_id": source["id"], "category": category,
            "protocol_valid": protocol_valid, "protocol_error": protocol_error,
            "official_valid": official["valid"], "official_error_type": official.get("error_type"),
            "official_errors": official.get("error", []),
            "scope": "Function-call generation only; no tools were executed.",
        }),
    }


if __name__ == "__main__":
    # Command graders exchange UTF-8 JSON regardless of the Windows locale.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    try:
        if len(sys.argv) != 2 or not Path(sys.argv[1]).is_absolute():
            raise ValueError("Supply the absolute pinned upstream source directory.")
        input_data = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            result = grade(input_data, sys.argv[1])
        print(json.dumps(result))
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
