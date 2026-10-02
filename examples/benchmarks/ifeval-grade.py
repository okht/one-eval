"""Grade one saved response using the pinned official IFEval evaluator.

Argument 1 is the absolute parent of the downloaded instruction_following_eval
package. Dependencies and official source files are installed/prepared separately.
Official scorer errors exit nonzero; they must never become model score zero.
Source: https://github.com/google-research/google-research/tree/
e6890f85757dd84e27ca6df2dd30651dafad28e0/instruction_following_eval
"""

import contextlib
import importlib
import json
from pathlib import Path
import sys
import traceback


SOURCE_COMMIT = "e6890f85757dd84e27ca6df2dd30651dafad28e0"


def result_summary(result, instruction_count):
    decisions = list(result.follow_instruction_list)
    if len(decisions) != instruction_count or any(type(item) is not bool for item in decisions):
        raise ValueError("Official evaluator returned an invalid instruction verdict list.")
    if type(result.follow_all_instructions) is not bool:
        raise ValueError("Official evaluator returned a non-boolean prompt verdict.")
    if result.follow_all_instructions != all(decisions):
        raise ValueError("Official evaluator prompt and instruction verdicts disagree.")
    return {
        "follow_all_instructions": result.follow_all_instructions,
        "follow_instruction_list": decisions,
        "prompt_correct": int(result.follow_all_instructions),
        "prompt_total": 1,
        "instruction_correct": sum(decisions),
        "instruction_total": instruction_count,
    }


def grade(input_data):
    if len(sys.argv) != 2:
        raise ValueError("Expected one argument: the absolute official package parent directory.")
    package_parent = Path(sys.argv[1])
    if not package_parent.is_absolute():
        raise ValueError("The official package parent directory must be absolute.")
    package_parent = package_parent.resolve()
    evaluation_file = package_parent / "instruction_following_eval" / "evaluation_lib.py"
    if not evaluation_file.is_file():
        raise FileNotFoundError(f"Official evaluation_lib.py was not found at {evaluation_file}")

    reference = input_data.get("case", {}).get("reference")
    if reference is None:
        return {
            "status": "insufficient_evidence",
            "reason": json.dumps({"benchmark": "IFEval", "source_commit": SOURCE_COMMIT, "error": "Missing official reference row."}),
        }
    if not isinstance(reference, dict):
        raise ValueError("IFEval reference must contain the original dataset row.")
    for name in ("key", "prompt", "instruction_id_list", "kwargs"):
        if name not in reference:
            raise ValueError(f"IFEval reference is missing {name}.")
    if type(reference["key"]) is not int or not isinstance(reference["prompt"], str):
        raise ValueError("IFEval reference key/prompt have invalid types.")
    instruction_ids = reference["instruction_id_list"]
    kwargs = reference["kwargs"]
    if not isinstance(instruction_ids, list) or not instruction_ids or not all(isinstance(item, str) for item in instruction_ids):
        raise ValueError("IFEval reference must contain a nonempty instruction_id_list.")
    if not isinstance(kwargs, list) or len(kwargs) != len(instruction_ids) or not all(isinstance(item, dict) for item in kwargs):
        raise ValueError("IFEval reference kwargs must match the instruction list.")
    response = input_data.get("artifact", {}).get("output")
    if not isinstance(response, str):
        raise ValueError("GradeInput.artifact.output must be a string.")

    sys.path.insert(0, str(package_parent))
    from langdetect import DetectorFactory

    DetectorFactory.seed = 0
    evaluation_lib = importlib.import_module("instruction_following_eval.evaluation_lib")
    if Path(evaluation_lib.__file__).resolve() != evaluation_file.resolve():
        raise RuntimeError("The imported evaluator did not come from the supplied official source directory.")
    example = evaluation_lib.InputExample(
        key=reference["key"], prompt=reference["prompt"],
        instruction_id_list=instruction_ids, kwargs=kwargs,
    )
    prompt_to_response = {reference["prompt"]: response}
    strict = result_summary(
        evaluation_lib.test_instruction_following_strict(example, prompt_to_response),
        len(instruction_ids),
    )
    loose = result_summary(
        evaluation_lib.test_instruction_following_loose(example, prompt_to_response),
        len(instruction_ids),
    )
    return {
        "status": "scored",
        "score": strict["prompt_correct"],
        "reason": json.dumps({
            "benchmark": "IFEval", "source_commit": SOURCE_COMMIT,
            "key": reference["key"], "instruction_id_list": instruction_ids,
            "strict": strict, "loose": loose,
        }),
    }


if __name__ == "__main__":
    # Command graders exchange UTF-8 JSON regardless of the Windows locale.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8")
    try:
        data = json.load(sys.stdin)
        # Imports and official checkers may emit diagnostics. Reserve stdout for
        # the single GradeValue JSON object required by the command protocol.
        with contextlib.redirect_stdout(sys.stderr):
            result = grade(data)
        print(json.dumps(result))
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
