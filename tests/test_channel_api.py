from __future__ import annotations

import json
import unittest
from unittest import mock

import enrollment


class FakeResponse:
    def __init__(self, payload):
        self.body = json.dumps(payload).encode()

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class ChannelApiTest(unittest.TestCase):
    def test_base_url_can_omit_v1_for_every_supported_api(self):
        self.assertEqual(
            enrollment.completion_url("https://example.test", "openai"),
            "https://example.test/v1/chat/completions",
        )
        self.assertEqual(
            enrollment.completion_url("https://example.test", "openai-responses"),
            "https://example.test/v1/responses",
        )
        self.assertEqual(
            enrollment.completion_url("https://example.test", "anthropic"),
            "https://example.test/v1/messages",
        )
        self.assertEqual(
            enrollment.models_url("https://example.test/v1/chat/completions"),
            "https://example.test/v1/models",
        )

    def test_header_presets_change_the_real_upstream_user_agent(self):
        codex = enrollment.request_headers("test-key", "openai", "codex")
        claude = enrollment.request_headers("test-key", "anthropic", "claude-code")
        self.assertEqual(codex["User-Agent"], "OpenAI/JS 6.45.0")
        self.assertEqual(claude["User-Agent"], "Anthropic/JS 0.109.0")
        self.assertEqual(claude["x-api-key"], "test-key")

    def test_model_catalog_is_loaded_from_the_normalized_channel_url(self):
        captured = []

        def opener(request, timeout):
            captured.append(request)
            return FakeResponse({"data": [{"id": "z-model"}, {"id": "a-model"}]})

        with mock.patch("urllib.request.urlopen", opener):
            models = enrollment.fetch_models("https://example.test", "test-key", "openai", "codex")
        self.assertEqual(models, ["a-model", "z-model"])
        self.assertEqual(captured[0].full_url, "https://example.test/v1/models")
        self.assertEqual(captured[0].headers["User-agent"], "OpenAI/JS 6.45.0")

    def test_responses_api_output_is_extracted(self):
        captured = []

        def opener(request, timeout):
            captured.append(request)
            return FakeResponse(
                {"status": "completed", "output": [{"content": [{"type": "output_text", "text": "ok"}]}]}
            )

        with mock.patch("urllib.request.urlopen", opener):
            text = enrollment.request_completion(
                "https://example.test",
                "test-key",
                "model-a",
                "prompt",
                None,
                "openai-responses",
                header_preset="codex",
            )
        self.assertEqual(text, "ok")
        self.assertEqual(captured[0].full_url, "https://example.test/v1/responses")
        self.assertEqual(json.loads(captured[0].data)["input"], "prompt")


if __name__ == "__main__":
    unittest.main()
