# Captured native saves

These JSON rows were captured from unmodified runtimes using synthetic local accounts and
the password `fixture-password-only`. Tokens and password hashes are disposable fixture
values, not credentials for an external account. Never use them outside these test databases.

- `native-v3.json`: Open-Industries `0d10ed8de2fc3ef1026de965efc543b660fdf485`, wire v3 /
  SQLite 2. Two participants, privately inspected and collected cable, a paid processing job
  with 1,000 ms of progress at a fixed server time.
- `native-v5.json`: unchanged robot authority `5e306c2033bfdb15510f98f575f937e1578f6a3f`,
  wire v5 / SQLite 4. Two participants, completed private camera survey, an active finite
  robot collection reservation after 500 ms, and original native receipts.

Rows retain their original JSON strings and request/result receipt bytes. Tests recreate
the native account/session/match/member/receipt tables, restore the saved schema version,
and open the new runtime. The v3 history test separately installs an exact cutover checkpoint
from the captured state before upgrading. It verifies frozen old projection and current
replay without inventing older events. Captures are data, not a second simulation authority.
