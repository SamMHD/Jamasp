import pytest

from jamasp import bot, db, farsibrief

DESK = "-100"


class FakeAPI:
    def __init__(self, updates=None):
        self.updates = list(updates or [])
        self.calls = []

    def call(self, method, params, timeout=30):
        self.calls.append((method, params))
        if method == "getMe":
            return {"username": "JamaspBot"}
        if method == "getUpdates":
            off = params.get("offset", 0)
            if off == -1:
                return self.updates[-1:]
            return [u for u in self.updates if u["update_id"] >= off]
        if method == "sendMessage":
            return {"message_id": 1}
        raise AssertionError(method)

    def sent(self):
        return [p for m, p in self.calls if m == "sendMessage"]


def msg(uid, text, chat=DESK, mid=50):
    return {"update_id": uid, "message": {"message_id": mid, "chat": {"id": int(chat)},
                                          "text": text}}


@pytest.fixture
def conn(tmp_path):
    return db.connect(tmp_path / "t.db")


@pytest.mark.parametrize("text,expected", [
    ("/brief", "brief"),
    ("/brief now please", "brief"),
    ("/brief@JamaspBot", "brief"),
    ("/brief@jamaspbot", "brief"),
    ("/brief@OtherBot", None),
    ("/briefing", None),
    ("brief", None),
    ("", None),
    ("   ", None),
    (None, None),
])
def test_parse_command(text, expected):
    assert bot.parse_command(text, "JamaspBot") == expected


def test_brief_from_desk_replies_preparing_and_spawns(conn):
    api, spawned = FakeAPI(), []
    bot.handle_update(msg(1, "/brief", mid=77), conn, api, DESK, "JamaspBot", spawned.append)
    assert spawned == [77]
    assert api.sent()[0]["text"] == farsibrief.MSG_PREPARING
    assert api.sent()[0]["reply_to_message_id"] == 77


def test_brief_from_another_chat_is_ignored(conn):
    api, spawned = FakeAPI(), []
    bot.handle_update(msg(1, "/brief", chat="-999"), conn, api, DESK, "JamaspBot", spawned.append)
    assert spawned == [] and api.sent() == []


@pytest.mark.parametrize("update", [
    {"update_id": 1, "edited_message": {"chat": {"id": -100}, "text": "/brief"}},
    {"update_id": 1, "message": {"message_id": 5, "chat": {"id": -100}, "sticker": {}}},
])
def test_non_text_and_edited_updates_are_ignored(conn, update):
    api, spawned = FakeAPI(), []
    bot.handle_update(update, conn, api, DESK, "JamaspBot", spawned.append)
    assert spawned == [] and api.sent() == []


def test_busy_reply_when_a_brief_is_running(conn):
    api, spawned = FakeAPI(), []
    with farsibrief.run_lock(conn):
        bot.handle_update(msg(1, "/brief"), conn, api, DESK, "JamaspBot", spawned.append)
    assert spawned == []
    assert api.sent()[0]["text"] == farsibrief.MSG_BUSY


def test_first_start_skips_the_backlog_and_persists_the_offset(conn):
    api = FakeAPI([msg(10, "/brief"), msg(11, "/brief")])
    assert bot.initial_offset(conn, api) == 12
    assert db.get_meta(conn, bot.OFFSET_KEY) == "12"


def test_restart_resumes_from_the_stored_offset(conn):
    db.set_meta(conn, bot.OFFSET_KEY, "11")
    api = FakeAPI([msg(10, "/brief"), msg(11, "/brief")])
    assert bot.initial_offset(conn, api) == 11
    spawned = []
    new = bot.poll_once(conn, api, DESK, "JamaspBot", spawned.append, 11)
    assert new == 12 and len(spawned) == 1
    assert db.get_meta(conn, bot.OFFSET_KEY) == "12"


def test_first_start_with_no_updates_starts_at_zero(conn):
    assert bot.initial_offset(conn, FakeAPI()) == 0


def test_a_failing_update_does_not_stall_the_offset(conn):
    api = FakeAPI([msg(1, "/brief"), msg(2, "/brief")])

    def spawn(mid):
        raise OSError("fork failed")
    assert bot.poll_once(conn, api, DESK, "JamaspBot", spawn, 0) == 3


def test_run_forever_backs_off_on_errors(conn):
    class Flaky(FakeAPI):
        def call(self, method, params, timeout=30):
            if method == "getUpdates" and params.get("offset") != -1:
                raise bot.TelegramError("502")
            return super().call(method, params, timeout)
    sleeps = []
    bot.run_forever(conn, Flaky(), DESK, lambda m: None, sleep=sleeps.append,
                    stop=lambda: len(sleeps) >= 7)
    assert sleeps == [2, 4, 8, 16, 32, 60, 60]


def test_spawn_failure_after_preparing_tells_the_chat(conn):
    api = FakeAPI()

    def spawn(mid):
        raise OSError("fork failed")
    with pytest.raises(OSError):
        bot.handle_update(msg(1, "/brief", mid=8), conn, api, DESK, "JamaspBot", spawn)
    texts = [p["text"] for p in api.sent()]
    assert texts == [farsibrief.MSG_PREPARING, farsibrief.MSG_FAILED]


def test_busy_while_the_last_spawned_brief_is_still_starting(conn):
    # Two /brief in quick succession: the first child may not hold the flock
    # yet, so the listener's own "still running" view must also count.
    api, spawned = FakeAPI(), []
    bot.handle_update(msg(1, "/brief"), conn, api, DESK, "JamaspBot", spawned.append,
                      running=lambda: True)
    assert spawned == [] and api.sent()[0]["text"] == farsibrief.MSG_BUSY
