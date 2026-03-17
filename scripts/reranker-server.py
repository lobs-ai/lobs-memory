#!/usr/bin/env python3
"""
BGE Reranker v2 M3 — lightweight HTTP sidecar for lobs-memory.
Takes (query, documents[]) pairs, returns relevance scores using a cross-encoder.

Endpoints:
  GET  /health          → {"status": "ok", "model": "bge-reranker-v2-m3"}
  POST /rerank          → {"scores": [...], "elapsed_ms": 123}
  POST /rerank/batch    → {"results": [{"scores": [...], "elapsed_ms": ...}, ...]}

Body for /rerank:
  {"query": "...", "documents": ["...", ...]}

Body for /rerank/batch:
  {"pairs": [{"query": "...", "documents": ["...", ...]}, ...]}

Runs on port 7421. Uses quantized ONNX model for fast inference on CPU.
"""

import json
import os
import sys
import time
import signal
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

# Model location
MODEL_DIR = Path(os.environ.get(
    "RERANKER_MODEL_DIR",
    os.path.expanduser("~/.lobs/models/bge-reranker-v2-m3-onnx")
))
PORT = int(os.environ.get("RERANKER_PORT", "7421"))

# Try quantized first, fall back to full model
ONNX_CANDIDATES = [
    MODEL_DIR / "onnx" / "model_quantized.onnx",
    MODEL_DIR / "onnx" / "model.onnx",
]

# Load model at startup
print(f"Loading reranker from {MODEL_DIR}...")
tokenizer = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))

onnx_path = None
for candidate in ONNX_CANDIDATES:
    if candidate.exists():
        onnx_path = candidate
        break

if onnx_path is None:
    print(f"ERROR: No ONNX model found in {MODEL_DIR / 'onnx'}/")
    print(f"  Looked for: {[str(c) for c in ONNX_CANDIDATES]}")
    sys.exit(1)

# Configure ONNX Runtime for speed
opts = ort.SessionOptions()
opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
opts.intra_op_num_threads = 4
opts.inter_op_num_threads = 2
opts.enable_mem_pattern = True

session = ort.InferenceSession(str(onnx_path), opts)

# Check what inputs the model expects
input_names = [inp.name for inp in session.get_inputs()]
print(f"Model inputs: {input_names}")
print(f"Reranker model loaded ({onnx_path.name}, {onnx_path.stat().st_size / 1024 / 1024:.1f}MB)")


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def rerank(query: str, documents: list[str], max_length: int = 512) -> list[float]:
    """Score each document against the query using the cross-encoder."""
    if not documents:
        return []

    scores = []
    for doc in documents:
        # Tokenize as a pair
        encoding = tokenizer.encode(query, doc)
        ids = encoding.ids[:max_length]
        type_ids = encoding.type_ids[:max_length]
        attention = [1] * len(ids)

        # Build inputs
        inputs = {
            "input_ids": np.array([ids], dtype=np.int64),
            "attention_mask": np.array([attention], dtype=np.int64),
        }
        # Some models need token_type_ids
        if "token_type_ids" in input_names:
            inputs["token_type_ids"] = np.array([type_ids], dtype=np.int64)

        # Run inference
        outputs = session.run(None, inputs)
        logit = float(outputs[0][0][0]) if outputs[0].ndim > 1 else float(outputs[0][0])
        scores.append(logit)

    return scores


class RerankerHandler(BaseHTTPRequestHandler):
    """HTTP handler for reranker requests."""

    def log_message(self, format, *args):
        """Suppress default access logs — we do our own."""
        pass

    def _respond(self, code: int, body: dict):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_GET(self):
        if self.path in ("/health", "/healthz"):
            self._respond(200, {
                "status": "ok",
                "model": "bge-reranker-v2-m3",
                "onnx_file": onnx_path.name,
                "port": PORT,
            })
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
        except (json.JSONDecodeError, ValueError) as e:
            self._respond(400, {"error": f"Invalid JSON: {e}"})
            return

        if self.path == "/rerank":
            self._handle_rerank(body)
        elif self.path == "/rerank/batch":
            self._handle_batch(body)
        else:
            self._respond(404, {"error": "not found"})

    def _handle_rerank(self, body: dict):
        query = body.get("query", "")
        documents = body.get("documents", [])

        if not query or not documents:
            self._respond(400, {"error": "query and documents required"})
            return

        start = time.time()
        scores = rerank(query, documents)
        elapsed = round((time.time() - start) * 1000, 1)

        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] Reranked {len(documents)} docs in {elapsed}ms")

        self._respond(200, {
            "scores": scores,
            "elapsed_ms": elapsed,
        })

    def _handle_batch(self, body: dict):
        pairs = body.get("pairs", [])
        if not pairs:
            self._respond(400, {"error": "pairs array required"})
            return

        start = time.time()
        results = []
        for pair in pairs:
            pair_start = time.time()
            scores = rerank(pair.get("query", ""), pair.get("documents", []))
            results.append({
                "scores": scores,
                "elapsed_ms": round((time.time() - pair_start) * 1000, 1),
            })

        elapsed = round((time.time() - start) * 1000, 1)
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}] Batch reranked {len(pairs)} queries in {elapsed}ms")

        self._respond(200, {
            "results": results,
            "elapsed_ms": elapsed,
        })


def main():
    server = HTTPServer(("127.0.0.1", PORT), RerankerHandler)
    print(f"Reranker sidecar listening on http://localhost:{PORT}")

    def handle_shutdown(signum, frame):
        print("\nShutting down reranker...")
        server.shutdown()

    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("Reranker stopped.")


if __name__ == "__main__":
    main()
