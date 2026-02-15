from __future__ import annotations

import contextlib
import io
import json
import sys
import time
import urllib.error
import urllib.request
from typing import Any

_SAFE_BUILTINS = {
    "print": print,
    "len": len,
    "str": str,
    "int": int,
    "float": float,
    "list": list,
    "dict": dict,
    "set": set,
    "tuple": tuple,
    "bool": bool,
    "type": type,
    "isinstance": isinstance,
    "issubclass": issubclass,
    "enumerate": enumerate,
    "zip": zip,
    "map": map,
    "filter": filter,
    "sorted": sorted,
    "reversed": reversed,
    "range": range,
    "min": min,
    "max": max,
    "sum": sum,
    "abs": abs,
    "round": round,
    "any": any,
    "all": all,
    "pow": pow,
    "divmod": divmod,
    "chr": chr,
    "ord": ord,
    "hex": hex,
    "bin": bin,
    "oct": oct,
    "repr": repr,
    "ascii": ascii,
    "format": format,
    "hash": hash,
    "id": id,
    "iter": iter,
    "next": next,
    "slice": slice,
    "callable": callable,
    "hasattr": hasattr,
    "getattr": getattr,
    "setattr": setattr,
    "delattr": delattr,
    "dir": dir,
    "vars": vars,
    "bytes": bytes,
    "bytearray": bytearray,
    "memoryview": memoryview,
    "complex": complex,
    "object": object,
    "super": super,
    "property": property,
    "staticmethod": staticmethod,
    "classmethod": classmethod,
    "__import__": __import__,
    "open": open,
    "Exception": Exception,
    "BaseException": BaseException,
    "ValueError": ValueError,
    "TypeError": TypeError,
    "KeyError": KeyError,
    "IndexError": IndexError,
    "AttributeError": AttributeError,
    "FileNotFoundError": FileNotFoundError,
    "OSError": OSError,
    "IOError": IOError,
    "RuntimeError": RuntimeError,
    "NameError": NameError,
    "ImportError": ImportError,
    "StopIteration": StopIteration,
    "AssertionError": AssertionError,
    "NotImplementedError": NotImplementedError,
    "ArithmeticError": ArithmeticError,
    "LookupError": LookupError,
    "Warning": Warning,
    "input": None,
    "eval": None,
    "exec": None,
    "compile": None,
    "globals": None,
    "locals": None,
}


class ReplState:
    def __init__(self, context_payload: Any, bridge_url: str, question: str | None = None):
        self.bridge_url = bridge_url.rstrip("/")
        self.globals: dict[str, Any] = {
            "__builtins__": _SAFE_BUILTINS.copy(),
            "__name__": "__main__",
        }
        self.locals: dict[str, Any] = {}

        self.globals["FINAL_VAR"] = self.final_var
        self.globals["SHOW_VARS"] = self.show_vars
        self.globals["llm_query"] = self.llm_query
        self.globals["llm_query_batched"] = self.llm_query_batched

        if question is not None:
            self.locals["question"] = question

        self.load_context(context_payload)

    def load_context(self, context_payload: Any) -> None:
        self.locals["context_0"] = context_payload
        self.locals["context"] = context_payload

    def load_context_from_file(self, context_file_path: str) -> None:
        with open(context_file_path, "r", encoding="utf-8") as file:
            raw = file.read()
        self.load_context(raw)

    def final_var(self, variable_name: str) -> str:
        variable_name = variable_name.strip().strip("\"'")
        if variable_name in self.locals:
            return str(self.locals[variable_name])

        available = [k for k in self.locals.keys() if not k.startswith("_")]
        if available:
            return (
                f"Error: Variable '{variable_name}' not found. "
                f"Available variables: {available}. "
                "You must create and assign a variable BEFORE calling FINAL_VAR on it."
            )

        return (
            f"Error: Variable '{variable_name}' not found. "
            "No variables have been created yet. "
            "You must create and assign a variable in a REPL block BEFORE calling FINAL_VAR on it."
        )

    def show_vars(self) -> str:
        available = {k: type(v).__name__ for k, v in self.locals.items() if not k.startswith("_")}
        if not available:
            return "No variables created yet. Use ```repl``` blocks to create variables."
        return f"Available variables: {available}"

    def llm_query(self, prompt: str, model: str | None = None) -> str:
        payload: dict[str, Any] = {"prompt": prompt}
        if model:
            payload["model"] = model

        try:
            response = self._post_json("/llm_query", payload)
        except Exception as exc:
            return f"Error: LM query failed - {exc}"

        if isinstance(response, dict) and "response" in response:
            return str(response["response"])

        if isinstance(response, dict) and "error" in response:
            return f"Error: {response['error']}"

        return "Error: Invalid LM response"

    def llm_query_batched(self, prompts: list[str], model: str | None = None) -> list[str]:
        payload: dict[str, Any] = {"prompts": prompts}
        if model:
            payload["model"] = model

        try:
            response = self._post_json("/llm_query_batched", payload)
        except Exception as exc:
            return [f"Error: LM query failed - {exc}"] * len(prompts)

        if isinstance(response, dict) and isinstance(response.get("responses"), list):
            return [str(item) for item in response["responses"]]

        if isinstance(response, dict) and "error" in response:
            return [f"Error: {response['error']}"] * len(prompts)

        return ["Error: Invalid LM response"] * len(prompts)

    def execute_code(self, code: str) -> dict[str, Any]:
        started_at = time.perf_counter()
        stdout_buffer = io.StringIO()
        stderr_buffer = io.StringIO()

        with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
            try:
                combined = {**self.globals, **self.locals}
                exec(code, combined, combined)
                for key, value in combined.items():
                    if key not in self.globals and not key.startswith("_"):
                        self.locals[key] = value
            except Exception as exc:
                print(f"{type(exc).__name__}: {exc}", file=stderr_buffer)

        execution_time = time.perf_counter() - started_at
        return {
            "stdout": stdout_buffer.getvalue(),
            "stderr": stderr_buffer.getvalue(),
            "locals": self._serialize_locals(),
            "execution_time": execution_time,
        }

    def _serialize_locals(self) -> dict[str, str]:
        data: dict[str, str] = {}
        for key, value in self.locals.items():
            if key.startswith("_"):
                continue
            try:
                preview = repr(value)
            except Exception:
                preview = f"<{type(value).__name__}>"
            if len(preview) > 250:
                preview = preview[:250] + "..."
            data[key] = f"{type(value).__name__}: {preview}"
        return data

    def _post_json(self, endpoint: str, payload: dict[str, Any]) -> Any:
        url = f"{self.bridge_url}{endpoint}"
        request_data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            url=url,
            data=request_data,
            method="POST",
            headers={"Content-Type": "application/json"},
        )

        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                raw_body = response.read().decode("utf-8")
                return json.loads(raw_body) if raw_body else {}
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8")
            raise RuntimeError(f"HTTP {exc.code}: {body}")


def send_response(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    state: ReplState | None = None

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            send_response({"ok": False, "error": f"Invalid JSON: {exc}"})
            continue

        cmd = request.get("cmd")

        try:
            if cmd == "init":
                state = ReplState(
                    context_payload=request.get("context"),
                    bridge_url=str(request.get("bridge_url", "")),
                    question=request.get("question"),
                )
                context_file_path = request.get("context_file_path")
                if isinstance(context_file_path, str) and context_file_path.strip():
                    state.load_context_from_file(context_file_path)
                send_response({"ok": True})
                continue

            if cmd == "close":
                send_response({"ok": True})
                break

            if state is None:
                send_response({"ok": False, "error": "Worker not initialized"})
                continue

            if cmd == "exec":
                result = state.execute_code(str(request.get("code", "")))
                send_response({"ok": True, **result})
                continue

            if cmd == "final_var":
                value = state.final_var(str(request.get("name", "")))
                send_response({"ok": True, "value": value})
                continue

            if cmd == "show_vars":
                send_response({"ok": True, "value": state.show_vars()})
                continue

            send_response({"ok": False, "error": f"Unknown command: {cmd}"})
        except Exception as exc:
            send_response({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
