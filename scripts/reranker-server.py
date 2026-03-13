#!/usr/bin/env python3
"""
BGE Reranker v2 M3 — lightweight HTTP sidecar for lobs-memory.
Takes (query, documents[]) pairs, returns relevance scores.

Endpoint: POST /rerank
Body: {"query": "...", "documents": ["...", ...]}
Response: {"scores": [3.15, -0.7, ...], "elapsed_ms": 312}

Runs on port 7421.
"""

import json
import os
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MODEL_DIR = os.path.expanduser("~/.openclaw/models/bge-reranker-v2-m3-onnx")
PORT = 7421

print(f"Loading BGE Reranker v2 M3 from {MODEL_DIR}...")
session = ort.InferenceSession(os.path.join(MODEL_DIR, "onnx/model.onnx"))
tokenizer = Tokenizer.from_file(os.path.join(MODEL_DIR, "tokenizer.json"))
tokenizer.enable_padding()
tokenizer.enable_truncation(max_length=512)
print("Reranker model loaded.")


class RerankerHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/rerank":
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            query = body.get("query", "")
            documents = body.get("documents", [])

            if not query or not documents:
                self._respond(400, {"error": "query and documents required"})
                return

            start = time.time()
            pairs = [(query, doc) for doc in documents]
            encodings = tokenizer.encode_batch(pairs)
            input_ids = np.array([e.ids for e in encodings], dtype=np.int64)
            attention_mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
            outputs = session.run(None, {"input_ids": input_ids, "attention_mask": attention_mask})
            scores = outputs[0].flatten().tolist()
            elapsed_ms = (time.time() - start) * 1000

            self._respond(200, {"scores": scores, "elapsed_ms": round(elapsed_ms)})

        elif self.path == "/health":
            self._respond(200, {"status": "ok", "model": "bge-reranker-v2-m3"})
        else:
            self._respond(404, {"error": "not found"})

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok", "model": "bge-reranker-v2-m3"})
        else:
            self._respond(404, {"error": "not found"})

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, format, *args):
        pass  # Suppress default logging


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", PORT), RerankerHandler)
    print(f"✓ Reranker server ready at http://localhost:{PORT}")
    server.serve_forever()
