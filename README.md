# Claude Probe

A monitoring tool that verifies whether a Claude API endpoint is serving genuine Anthropic responses via AWS Bedrock, or is a counterfeit (GPT/other model wrapped to look like Claude).

## Features

- **Plugin-based checks** — modular detection system, each check is an independent file
- **Multi-model support** — probe multiple models per target simultaneously
- **Multi-target support** — monitor multiple API endpoints
- **Email alerts** — get notified when any check fails
- **Web dashboard** — tab-based UI with expandable model details and history timeline
- **Auto-retry** — configurable retry with exponential backoff
- **Transient error handling** — 502/503/429 treated as warnings, not failures

## Built-in Checks

| Check | File | What it detects |
|-------|------|-----------------|
| `bedrock_id` | `checks/bedrock_id.js` | Verifies response message ID starts with `msg_bdrk_` (AWS Bedrock backend) |
| `json_output` | `checks/json_output.js` | Tests tool_use / structured JSON output support |
| `cache_control` | `checks/cache_control.js` | Verifies `cache_control` header is processed (not silently ignored) |
| `censorship` | `checks/censorship.js` | Detects Chinese censorship filters by asking about Tiananmen 1989 |

## Verdicts

- **GENUINE** — all checks pass
- **SUSPECT** — 1 check failed
- **COUNTERFEIT** — 2+ checks failed
- **UNAVAILABLE** — all checks returned transient errors (service down)

## Setup

```bash
npm install
cp config.example.yaml config.yaml
# Edit config.yaml with your target endpoints
node server.js
```

Open `http://localhost:3210` for the dashboard.

## Configuration

```yaml
server:
  port: 3210
  interval_min: 60      # default probe interval (minutes)
  max_history: 30       # history entries per target
  max_retries: 3        # retry attempts per probe cycle

targets:
  - name: 'my-endpoint'
    base_url: 'https://api.example.com'
    api_key: 'sk-...'
    models:                    # probe multiple models
      - 'claude-opus-4-7'
      - 'claude-sonnet-4-6'
    checks:                    # select which checks to run (omit = all)
      - bedrock_id
      - json_output
      - cache_control
      - censorship
    interval_min: 10           # override interval for this target

actions:
  email:
    from: 'alert@example.com'
    to: 'you@example.com'
    smtp:
      host: 'smtp.example.com'
      port: 465
      secure: true
      user: 'alert@example.com'
      pass: 'password'
```

## Writing a New Check

Create a file in `checks/` directory:

```js
// checks/my_check.js
const { isTransientError } = require("./utils");

module.exports = {
  name: "My Custom Check",
  async run(client, model) {
    // client = Anthropic SDK instance
    // model = model string
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "test" }],
      });
      return { passed: true, detail: "OK", raw: response };
    } catch (err) {
      if (isTransientError(err)) {
        return { passed: null, detail: "Service unavailable", raw: null };
      }
      return { passed: false, detail: err.message, raw: null };
    }
  },
};
```

Then add its filename (without `.js`) to your target's `checks` list in `config.yaml`.

A check file can also export an array to register multiple checks from one file.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Web dashboard |
| `/api/status` | GET | Current status of all targets |
| `/api/history/:targetId` | GET | Full history for a target |
| `/api/probe/:targetId` | POST | Trigger immediate probe |
