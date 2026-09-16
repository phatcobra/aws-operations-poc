"""Deterministic, offline unit tests for src/app.py.

No test depends on a live network connection: all HTTP and DynamoDB calls
are mocked, and time.sleep is patched so retry/backoff tests run instantly.
"""
import json
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from unittest import mock
from urllib.error import URLError

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import app  # noqa: E402


def _fake_response(body: bytes, status: int = 200):
    response = mock.MagicMock()
    response.__enter__.return_value = response
    response.__exit__.return_value = False
    response.getcode.return_value = status
    response.read.return_value = body
    return response


class FetchCurrentWeatherTests(unittest.TestCase):
    def test_success_parses_temperature(self):
        body = json.dumps({"current": {"temperature_2m": 21.5}}).encode("utf-8")
        with mock.patch("urllib.request.urlopen", return_value=_fake_response(body)):
            result = app.fetch_current_weather()
        self.assertEqual(result, {"status_code": 200, "temperature_c": 21.5})

    def test_malformed_response_missing_field_raises_value_error(self):
        body = json.dumps({"current": {"humidity": 50}}).encode("utf-8")
        with mock.patch("urllib.request.urlopen", return_value=_fake_response(body)):
            with self.assertRaises(ValueError):
                app.fetch_current_weather()

    def test_malformed_response_not_json_raises(self):
        body = b"not json"
        with mock.patch("urllib.request.urlopen", return_value=_fake_response(body)):
            with self.assertRaises(json.JSONDecodeError):
                app.fetch_current_weather()

    def test_timeout_propagates(self):
        with mock.patch("urllib.request.urlopen", side_effect=URLError("timed out")):
            with self.assertRaises(URLError):
                app.fetch_current_weather()


class TriggerAndFaultResolutionTests(unittest.TestCase):
    def test_scheduled_trigger_from_eventbridge_shape(self):
        self.assertEqual(app._trigger_type({"source": "aws.events"}), "scheduled")

    def test_manual_trigger_default(self):
        self.assertEqual(app._trigger_type({}), "manual")

    def test_explicit_trigger_type_override(self):
        self.assertEqual(app._trigger_type({"trigger_type": "test"}), "test")

    def test_fault_mode_defaults_to_none_when_disabled(self):
        self.assertIsNone(app._fault_mode({}))
        self.assertIsNone(app._fault_mode({"fault_injection": "false"}))
        self.assertIsNone(app._fault_mode({"fault_injection": False}))

    def test_fault_mode_transient_and_permanent(self):
        self.assertEqual(app._fault_mode({"fault_injection": "transient"}), "transient")
        self.assertEqual(app._fault_mode({"fault_injection": "PERMANENT"}), "permanent")


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.fake_table = mock.MagicMock()
        table_patch = mock.patch("app._table", return_value=self.fake_table)
        self.addCleanup(table_patch.stop)
        table_patch.start()

        sleep_patch = mock.patch("app.time.sleep")
        self.addCleanup(sleep_patch.stop)
        self.mock_sleep = sleep_patch.start()

    def test_normal_success_first_attempt_no_retry(self):
        body = json.dumps({"current": {"temperature_2m": 10.0}}).encode("utf-8")
        with mock.patch("urllib.request.urlopen", return_value=_fake_response(body)):
            result = app.handler({}, None)

        self.assertTrue(result["status"] == "success")
        self.assertEqual(result["attempt_number"], 1)
        self.assertEqual(result["recovery_state"], "not_needed")
        self.assertEqual(result["trigger_type"], "manual")
        self.assertEqual(result["external_request_result"], {"status_code": 200, "temperature_c": 10.0})
        self.mock_sleep.assert_not_called()
        self.fake_table.put_item.assert_called_once()
        put_item = self.fake_table.put_item.call_args.kwargs["Item"]
        self.assertEqual(put_item["status"], "success")
        self.assertIsInstance(put_item["latency_ms"], Decimal)

    def test_scheduled_trigger_recorded(self):
        body = json.dumps({"current": {"temperature_2m": 10.0}}).encode("utf-8")
        with mock.patch("urllib.request.urlopen", return_value=_fake_response(body)):
            result = app.handler({"source": "aws.events", "detail-type": "Scheduled Event"}, None)
        self.assertEqual(result["trigger_type"], "scheduled")

    def test_transient_failure_then_bounded_recovery(self):
        body = json.dumps({"current": {"temperature_2m": 15.5}}).encode("utf-8")
        with mock.patch("urllib.request.urlopen", return_value=_fake_response(body)):
            result = app.handler({"fault_injection": "transient"}, None)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["attempt_number"], 2)
        self.assertEqual(result["recovery_state"], "recovered")
        self.assertEqual(self.fake_table.put_item.call_count, 2)
        self.mock_sleep.assert_called_once()

        first_item = self.fake_table.put_item.call_args_list[0].kwargs["Item"]
        self.assertEqual(first_item["status"], "failure")
        self.assertEqual(first_item["recovery_state"], "retrying")
        self.assertEqual(first_item["attempt_number"], 1)

        second_item = self.fake_table.put_item.call_args_list[1].kwargs["Item"]
        self.assertEqual(second_item["status"], "success")
        self.assertEqual(second_item["recovery_state"], "recovered")

    def test_permanent_failure_exhausts_bounded_retries(self):
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("must not call real API")):
            result = app.handler({"fault_injection": "permanent"}, None)

        self.assertEqual(result["status"], "failure")
        self.assertEqual(result["recovery_state"], "exhausted")
        self.assertEqual(result["attempt_number"], app.MAX_ATTEMPTS)
        self.assertEqual(self.fake_table.put_item.call_count, app.MAX_ATTEMPTS)
        self.assertEqual(self.mock_sleep.call_count, app.MAX_ATTEMPTS - 1)
        for call in self.fake_table.put_item.call_args_list:
            self.assertEqual(call.kwargs["Item"]["status"], "failure")

    def test_real_timeout_error_is_bounded_and_recorded(self):
        with mock.patch("urllib.request.urlopen", side_effect=URLError("timed out")):
            result = app.handler({}, None)

        self.assertEqual(result["status"], "failure")
        self.assertEqual(result["recovery_state"], "exhausted")
        self.assertEqual(self.fake_table.put_item.call_count, app.MAX_ATTEMPTS)

    def test_malformed_response_is_treated_as_failure_and_retried(self):
        body = json.dumps({"current": {}}).encode("utf-8")
        with mock.patch("urllib.request.urlopen", return_value=_fake_response(body)):
            result = app.handler({}, None)

        self.assertEqual(result["status"], "failure")
        self.assertEqual(self.fake_table.put_item.call_count, app.MAX_ATTEMPTS)

    def test_evidence_write_failure_does_not_crash_handler(self):
        self.fake_table.put_item.side_effect = Exception("dynamodb unavailable")
        body = json.dumps({"current": {"temperature_2m": 1.0}}).encode("utf-8")
        with mock.patch("urllib.request.urlopen", return_value=_fake_response(body)):
            result = app.handler({}, None)
        self.assertEqual(result["status"], "success")

    def test_never_exceeds_max_attempts_even_when_always_failing(self):
        with mock.patch("urllib.request.urlopen", side_effect=URLError("down")):
            app.handler({}, None)
        self.assertLessEqual(self.fake_table.put_item.call_count, app.MAX_ATTEMPTS)


if __name__ == "__main__":
    unittest.main()
